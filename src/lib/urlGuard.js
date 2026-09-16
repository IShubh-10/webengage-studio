/**
 * Deciding whether the server is allowed to fetch a URL somebody else chose.
 *
 * The render endpoint substitutes `{{placeholders}}` from the query string, and
 * a template can use one as an image source — `src: "{{image}}"`. That means
 * `?image=…` is a URL the caller picks and this process fetches. Without a
 * check that is server-side request forgery, and not the blind kind: whatever
 * comes back is composited into the PNG the caller receives, so anything
 * image-decodable on the private network is readable from the open internet.
 *
 * Two layers:
 *
 *   1. The scheme and shape of the URL — http(s) only, no embedded
 *      credentials, no absurd length.
 *   2. Where it actually resolves to. A hostname is not the target; the
 *      address behind it is, and `internal.example.com` can resolve to
 *      127.0.0.1 as easily as localhost does. Every address the name resolves
 *      to has to be a public one.
 *
 * Optionally a third: IMAGE_HOST_ALLOWLIST. When it is set only those hosts may
 * be fetched at all, which is strictly stronger than the range check and also
 * the only thing that fully closes DNS rebinding — see the note on
 * `assertFetchableUrl`.
 */

const dns = require('dns').promises;
const net = require('net');

const { LRUCache } = require('./cache');
const {
  IMAGE_HOST_ALLOWLIST,
  IMAGE_MAX_URL_LENGTH,
  IMAGE_GUARD_TTL_MS,
} = require('../config');

/*
 * The verdict for a URL, remembered briefly.
 *
 * This check has to run before the image caches are consulted rather than
 * after — otherwise a URL that was fetched once stays readable for as long as
 * its bytes are cached, whatever the rules say now. That puts a DNS lookup on
 * the hot path of every render, so the answer is memoized for a few minutes.
 *
 * Refusals are cached too: an attacker looping on blocked hosts should not be
 * able to turn this endpoint into a DNS amplifier.
 */
const verdicts = new LRUCache(1024);

function ipv4Parts(address) {
  return address.split('.').map((part) => Number(part));
}

/**
 * Addresses that must never be reachable through a user-supplied URL: this
 * machine, this network, the cloud provider's metadata service, and the ranges
 * reserved for documentation, benchmarking and multicast.
 */
function isPrivateIPv4(address) {
  const [a, b] = ipv4Parts(address);

  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, and cloud metadata at 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 protocol assignments, 192.0.2.0/24 docs
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // documentation
  if (a === 203 && b === 0) return true; // documentation
  if (a >= 224) return true; // multicast and reserved, up to 255.255.255.255

  return false;
}

/**
 * The eight 16-bit groups of an IPv6 address, with `::` expanded and any
 * trailing dotted-quad folded into the last two groups. Matching on the
 * written form does not work: the same address has many spellings, and the
 * URL parser rewrites them — `[::ffff:127.0.0.1]` comes back out of `new URL`
 * as `[::ffff:7f00:1]`, which a regex looking for dotted quads walks straight
 * past.
 */
function ipv6Groups(value) {
  let text = value;

  // A trailing IPv4 part (::ffff:127.0.0.1) is two more 16-bit groups.
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const [a, b, c, d] = ipv4Parts(tail[1]);
    const hex = [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)].join(':');
    text = text.slice(0, -tail[1].length) + hex;
  }

  const [head, rest] = text.split('::');
  const left = head ? head.split(':').filter(Boolean) : [];
  const right = rest === undefined ? [] : rest.split(':').filter(Boolean);

  if (rest === undefined) {
    return left.length === 8 ? left.map((g) => parseInt(g, 16)) : null;
  }

  const gap = 8 - left.length - right.length;
  if (gap < 0) return null;

  return [...left, ...Array(gap).fill('0'), ...right].map((g) => parseInt(g, 16));
}

function isPrivateIPv6(address) {
  const value = address.toLowerCase().split('%')[0]; // drop any zone index

  const groups = ipv6Groups(value);
  if (!groups || groups.some((g) => Number.isNaN(g))) return true; // unparseable: refuse

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  // Unspecified (::) and loopback (::1).
  if (groups.every((g) => g === 0)) return true;
  if (groups.slice(0, 7).every((g) => g === 0) && g7 === 1) return true;

  /*
   * IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) tunnel the
   * whole v4 problem into v6, so unwrap and apply the v4 rules. Both have
   * seven zero groups ahead of the address, bar the ffff marker.
   */
  const v4Prefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (v4Prefix && (g5 === 0xffff || g5 === 0)) {
    const a = (g6 >> 8) & 0xff;
    const b = g6 & 0xff;
    const c = (g7 >> 8) & 0xff;
    const d = g7 & 0xff;
    return isPrivateIPv4(`${a}.${b}.${c}.${d}`);
  }

  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  return false;
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true; // unparseable: refuse rather than guess
}

/** `cdn.example.com` matches an allowlist entry of `example.com`. */
function hostAllowed(hostname) {
  if (IMAGE_HOST_ALLOWLIST.length === 0) return true;

  const host = hostname.toLowerCase();
  return IMAGE_HOST_ALLOWLIST.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`)
  );
}

function refuse(message) {
  const error = new Error(message);
  error.code = 'URL_NOT_FETCHABLE';
  error.status = 400;
  return error;
}

/**
 * Throws unless this URL is one the server may fetch. Returns the parsed URL.
 *
 * Residual risk, stated rather than hidden: between this check and the socket
 * opening, a hostname the attacker controls can be re-pointed at a private
 * address — classic DNS rebinding. Closing it completely means connecting to
 * the address that was validated, which breaks TLS certificate validation for
 * https. Setting IMAGE_HOST_ALLOWLIST is the practical answer: rebinding then
 * requires control of DNS for a host you have already decided to trust.
 */
async function assertFetchableUrl(raw) {
  const value = String(raw || '');

  const remembered = verdicts.get(value);
  if (remembered && remembered.expires > Date.now()) {
    if (remembered.error) throw remembered.error;
    return remembered.url;
  }

  try {
    const url = await resolveVerdict(value);
    verdicts.set(value, { url, expires: Date.now() + IMAGE_GUARD_TTL_MS });
    return url;
  } catch (err) {
    verdicts.set(value, { error: err, expires: Date.now() + IMAGE_GUARD_TTL_MS });
    throw err;
  }
}

async function resolveVerdict(value) {

  if (!value) throw refuse('No image URL given');
  if (value.length > IMAGE_MAX_URL_LENGTH) {
    throw refuse('Image URL is too long');
  }

  let url;
  try {
    url = new URL(value);
  } catch (err) {
    throw refuse('Image URL is not a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw refuse(`Image URL must be http or https, not ${url.protocol.replace(':', '')}`);
  }

  // user:password@host is a well-worn way to make a URL read as one host to a
  // human and resolve to another; nothing legitimate here needs it.
  if (url.username || url.password) {
    throw refuse('Image URL must not contain credentials');
  }

  if (!hostAllowed(url.hostname)) {
    throw refuse(`Images may not be fetched from ${url.hostname}`);
  }

  /*
   * A literal address skips DNS entirely, so check it directly. `hostname`
   * keeps the brackets on an IPv6 literal (`[::1]`), which `net.isIP` does not
   * recognise — without stripping them the check below would fall through to a
   * DNS lookup that happens to fail, which is the right answer for the wrong
   * reason and would stop being the right answer the moment it resolved.
   */
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(literal)) {
    if (isPrivateAddress(literal)) {
      throw refuse('Image URL points at a private address');
    }
    return url;
  }

  let resolved;
  try {
    resolved = await dns.lookup(url.hostname, { all: true });
  } catch (err) {
    throw refuse(`Could not resolve ${url.hostname}`);
  }

  if (resolved.length === 0) throw refuse(`Could not resolve ${url.hostname}`);

  // Every address, not just the first: a name that resolves to one public and
  // one private address must not be reachable on a retry or a round-robin.
  const privateHit = resolved.find((entry) => isPrivateAddress(entry.address));
  if (privateHit) {
    throw refuse(`${url.hostname} resolves to a private address (${privateHit.address})`);
  }

  return url;
}

module.exports = { assertFetchableUrl, isPrivateAddress, hostAllowed };
