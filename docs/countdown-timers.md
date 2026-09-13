# Countdown timers

A live countdown inside an HTML email, served as an animated GIF that is drawn
at the moment the message is opened.

```html
<img src="https://studio.example.com/api/v1/timer/TMR-01.gif" width="600" alt="Countdown" />
```

The creative is yours. You design it in **Dynamic Images** exactly as you would
any other personalised image — background, layers, `{{placeholders}}` — and the
timer tool draws the clock on top of it. Nothing about the artwork is fixed by
this feature.

---

## Why it has to be an image

HTML email has no JavaScript, no `<canvas>`, and no reliable CSS animation. The
only thing every client renders is an image. So a live clock can only be an
image that the server redraws on every fetch — and a fetch happens when the
message is opened.

That leaves three things the server has to get right:

1. **Draw the right time.** The countdown is computed from `Date.now()` at the
   top of the request, not from anything baked into the URL.
2. **Move.** A single still would be a screenshot. Sixty frames at one frame per
   second give the reader a minute of visible motion.
3. **Never be cached.** If anything between the server and the inbox keeps a
   copy, the reader sees the countdown from whenever the image was *first*
   fetched. This is the failure mode that makes most home-grown attempts look
   broken.

---

## The endpoint

```
GET /api/v1/timer/:timerId.gif
```

Public and unauthenticated, because it has to load in an inbox. `.gif` is in the
path rather than the query string because some clients and link scanners decide
whether to fetch something by its extension.

The response always carries:

```
Content-Type:       image/gif
Cache-Control:      no-store, no-cache, must-revalidate, max-age=0, s-maxage=0, proxy-revalidate
Pragma:             no-cache
Expires:            0
Surrogate-Control:  no-store
CDN-Cache-Control:  no-store
Vary:               *
```

`Pragma` and `Expires` are there for HTTP/1.0-era intermediaries; the
`Surrogate-Control` and `CDN-Cache-Control` pair is for Fastly/Cloudflare-class
caches, which ignore `Cache-Control` when they have been configured to override
it.

It also sets `X-Timer-Remaining`, `X-Timer-Expired`, `X-Timer-Frames`,
`X-Cache` and `X-Render-Time`, which are useful when debugging a live send.

### A note on Gmail

Gmail proxies images through `googleusercontent.com` and caches aggressively.
The headers above are what it honours, and in practice it re-fetches on each
open — which is why this approach works at all. But treat it as best-effort:
if a reader opens the same message twice within a few seconds, they may see the
same GIF. That is a cosmetic issue, not a correctness one.

### Query parameters

Anything not in this list is passed through to the creative as a template
variable, exactly as `/api/v1/render/:templateId` does — so the artwork can be
personalised *and* count down.

| Parameter | Effect |
|---|---|
| `end` | Deadline for this send. Epoch seconds/ms, an ISO string with an offset, or `2026-12-31 23:59:59`. |
| `tz` | Read `end` as wall-clock time in this IANA zone (`Asia/Kolkata`) or fixed offset (`+05:30`). |
| `dur` | Evergreen window in seconds. See below. |
| `uid` | Recipient key for an evergreen timer. |
| `template` | Render a different studio template as the creative. |
| `w`, `bgcolor`, `colors`, `frames` | Canvas width, flatten colour, palette size, animation length. |
| `loop` | `1` to loop forever instead of playing once. See below. |
| `x`, `y`, `size`, `weight`, `font`, `color`, `sep`, `gap`, `units` | Clock placement and styling. |
| `labels`, `labelcolor`, `labelsize` | Unit labels. |
| `plate` | Backing plate: `none`, `block` (one panel behind the whole clock) or `unit` (a tile per unit). |
| `platecolor`, `plateopacity`, `plateradius`, `platepadx`, `platepady` | How that plate looks. |
| `expired`, `expiredmode`, `expiredcolor`, `expiredimage` | What is shown once the deadline passes. |

`bg` is **not** accepted here. It would let anyone point the server at an
arbitrary URL, so the creative is always whichever one the signed-in author
saved. (`template` is allowed because template ids are already public through
the render endpoint.)

### Per-recipient time zones

There is no way to know the reader's time zone server-side — the request comes
from the email client's image proxy, so the IP and user agent belong to Google,
not to the person reading. Merge it in from your own data instead:

```html
<img src="https://studio.example.com/api/v1/timer/TMR-01.gif?tz={{user.timezone}}" />
```

### Evergreen timers

"24 hours from when *you* first opened this":

```html
<img src="https://studio.example.com/api/v1/timer/TMR-01.gif?dur=86400&uid={{user.id}}" />
```

The first fetch for a given `uid` records the moment in Redis (`SET NX`, so
concurrent opens agree on one start); later fetches count down from it. Without
a `uid` there is nothing to key on, so every open would restart the clock — in
that case the timer simply shows the full window.

### When it runs out

The countdown never displays a negative number. Four options, set per timer:

- **message** — a headline drawn over the creative ("SALE ENDED").
- **image** — a different image entirely.
- **freeze** — the clock stops at all zeros.
- **hide** — a 1×1 transparent GIF, so the image collapses out of the layout.

If the deadline passes *while someone is watching*, the animation switches to
the expired state mid-flight rather than counting into negatives.

### Playing once, or looping

By default the GIF plays once and freezes on its final frame. That is the
accurate option: every frame shows a real time, and the next open fetches a
fresh one. Its cost is that a reader watching for longer than the animation sees
the clock stop.

**A naive infinite loop is worse than that, not better.** The animation returns
to frame 0, so the clock jumps *back up* — a countdown counting upwards reads as
broken, where a frozen one just reads as a static image.

`loop` avoids that by making the loop seamless. The trick is that a seconds
column visits all sixty of its values in exactly sixty frames, so:

- the animation is forced to exactly 60 frames (`frames` is ignored), and
- **everything above seconds is held** at the value it had when the image was
  fetched.

The wrap from the last frame back to frame 0 is then an ordinary one-second
decrement, with no jump in any column. Measured on a timer at `03:25:38`:

```
loop off :  frame 59 -> frame 0 :  03:24:40 -> 03:25:39    jump of +59s
loop on  :  frame 59 -> frame 0 :  03:25:39 -> 03:25:38    steps -1s
```

What you trade for it: **the seconds stay exactly correct forever** — `(s - k)
mod 60` is what a real clock reads `k` seconds later — but minutes and above go
stale by however long the reader keeps the message open. Two minutes of staring
means two minutes of drift in the minutes column. Every new open resyncs.

Two conditions, both enforced in `canLoopSeamlessly()`:

- the timer must be **showing seconds** — without a column that completes a
  cycle there is nothing to wrap;
- more than 60 seconds must remain, so the deadline cannot pass mid-loop.

If either fails the timer plays once and freezes instead, and the response says
so in `X-Timer-Loop`.

### If you just want it to run longer

Raise `frames` (and `TIMER_MAX_FRAMES` past its 120 default). Each extra second
costs a flat ~350 bytes because only the changed digits are encoded, so 300
frames is five minutes of *fully accurate* countdown for about 145 KB. That is
often the better answer than looping.

---

## How it is built

### The libraries

| Job | What is used | Why |
|---|---|---|
| Rasterising the creative and the glyphs | **sharp** (already a dependency) | libvips is fast and already how the studio renders PNGs, so the timer's artwork is byte-identical to the still version. |
| Text layout | **sharp + SVG**, measured by `trim()` | No font-metrics library needed: render once, read the trimmed bounding box, and the numbers are correct for whatever fonts the host actually has. |
| Colour quantisation | [`src/lib/quantize.js`](../src/lib/quantize.js) | Median cut, written here so the base image and every digit tile can share one palette. |
| GIF encoding | [`src/lib/gif.js`](../src/lib/gif.js) | Written here for one specific reason — see below. |

**Why not `gifencoder`, `gifenc`, or sharp's own animated GIF output?** All of
them take a list of complete frames. That is the expensive way to build a
countdown: sixty full-canvas quantisations per email open. The encoder here
emits *partial* frames — a GIF frame carries its own `left`/`top`/`width`/
`height` and a disposal method of "leave in place", so a frame can be just the
digit that changed. Nothing off the shelf exposes that.

**Why not `node-canvas`?** It needs Cairo and Pango system libraries, and sharp
was already here. Adding a second rasteriser to render some text was not worth
the deployment cost.

### The shape of the work

The expensive parts of drawing a countdown do not depend on the time:

- the artwork is fixed;
- the plate, separators and unit labels never change while the clock runs;
- and there are only ten possible pictures for any one digit position.

So all of it is built **once per (creative + styling)** into a *sprite bundle*
([`src/services/countdown/sprites.js`](../src/services/countdown/sprites.js)):

1. Render the creative through the shared compositor
   ([`src/services/render.js`](../src/services/render.js)) and flatten it onto a
   solid colour.
2. Measure the digits, lay out the slots, and bake the static furniture into the
   background.
3. Rasterise `0`–`9` once, then build every possible tile: each slot's patch of
   background with each digit drawn on it.
4. Quantise the background, all eighty tiles, and the expired card **together**,
   so a tile can be dropped into the canvas later with no colour matching at all.
5. Pre-encode the expired card as a ready-to-append GIF frame.

Serving a request is then index copying and LZW, and nothing else.

### The frames

Per request ([`src/services/countdown/index.js`](../src/services/countdown/index.js)):

- **Frame 0** is the whole canvas with the current digits on it.
- **Every frame after that** is the smallest rectangle covering the digits that
  actually changed. Fifty-nine times out of sixty that is the seconds column.

That single decision is where the performance comes from:

```
whole 60-frame GIF      46 KB
  frame 0 alone         19 KB   (4.1 ms to encode)
  the other 59 frames   27 KB   (~476 bytes each, 3.2 ms for all of them)
```

Sixty full frames would be roughly 60 × 19 KB of encoding work and a megabyte of
output.

---

## Performance

Measured on this repo, a 600×260 creative, 60 frames, 256 colours, one core:

| | |
|---|---|
| Cold request (bundle built from scratch) | **449 ms** |
| Warm request (bundle cached) | **7.3 ms**, 8.1 ms CPU |
| Response-cache hit (same second) | **~1 ms** |
| Sprite bundle in memory | 241 KB |
| Implied ceiling | **~136 opens/sec/core**, so ~1,000/sec on 8 workers |

### Where the CPU actually goes

Cold requests are the entire risk. A cold request is ~60× a warm one, and on a
large send *every* worker starts cold at the same moment. Three things address
that:

1. **In-flight de-duplication.** Concurrent misses for the same bundle await one
   build instead of stampeding.
   [`sprites.js`](../src/services/countdown/sprites.js) keys a promise map on the
   bundle hash.
2. **Redis-backed bundles.** A bundle is packed into a single buffer and shared
   across workers and across restarts (`TIMER_SPRITE_TTL_SECONDS`, 6h default).
   Only the first worker to see a new timer pays the build.
3. **A one-second response cache.** Two opens in the same second want
   byte-identical GIFs. On a send that is thousands of opens collapsing onto one
   encode. The window is `TIMER_RESPONSE_CACHE_SECONDS` (2s); the response still
   goes to the recipient with `no-store`, so nothing downstream keeps a copy.

Expired timers render the same picture forever and are cached for an hour
(`TIMER_EXPIRED_CACHE_SECONDS`).

### One reader's fetch cannot help another's

A natural idea when the animation ends is to have the server regenerate the GIF
on a schedule so everyone's image keeps running. It cannot work, and it is worth
being clear about why.

Once the image has been fetched, those bytes live in that reader's mail client.
The server has no connection to them and no way to push new ones — HTTP is
pull-only and mail clients do not poll. If reader A re-opens the message, A gets
a fresh GIF; reader B's copy is untouched, because nothing asked B's client for
anything. The only event that refreshes B's image is B opening the message.

So a cron job would burn CPU rebuilding images nobody is fetching. The thing it
is reaching for — *don't render the same GIF once per reader* — is already
handled by the response cache below: opens landing in the same second share one
encode.

### Warming before a send

The honest answer to "will this survive our biggest campaign" is: fetch the
image once before you press send.

```bash
curl -s -o /dev/null "https://studio.example.com/api/v1/timer/TMR-01.gif"
```

That builds the bundle and puts it in Redis, so every worker starts warm and the
first recipient sees a 7 ms response rather than a 450 ms one.

### The knobs that matter

| Setting | Default | What it trades |
|---|---|---|
| `TIMER_FRAMES` | 60 | Animation length against file size and encode time. |
| `TIMER_MAX_CANVAS_WIDTH` | 1200 | Frame 0 dominates both bytes and CPU, and it scales with area. 600px is the email-safe width. |
| `colors` (per timer) | 256 | Flat artwork looks identical at 64 colours and the GIF gets noticeably smaller. Leave it at 256 for photographs. |
| `TIMER_SPRITE_TTL_SECONDS` | 21600 | Memory in Redis against cold rebuilds. |
| `TIMER_RESPONSE_CACHE_SECONDS` | 2 | How wide the burst-collapsing window is. |

### If you outgrow one box

- **Bandwidth is the ceiling, not CPU.** This is the same conclusion the render
  endpoint's [load test](./load-test-report.md) reached. At 46 KB a GIF, 1,000
  opens/second is 46 MB/s. Shrink the creative before you add cores.
- **Do not put a CDN in front of the GIF endpoint.** The whole point is that it
  is uncacheable. Put the CDN in front of the *source creatives* instead — those
  are static and are fetched on every cold bundle build.
- **Scale workers, not machines, first.** The work is pure CPU with a small
  fixed memory cost per timer; `src/server.js` already forks per core.

---

## Storing user-configured timers

A saved timer is one row in `timers` ([`migrations/004_timers.sql`](../migrations/004_timers.sql)):

```
timer_id   VARCHAR(100)  PRIMARY KEY   -- TMR-01
name       VARCHAR(190)
config     JSON                        -- the whole definition
created_by INT UNSIGNED
```

Everything lives in one JSON column, in exactly the shape the builder UI edits
and the renderer reads, for the same reason `templates.elements` does: no column
mapping on either side, and adding a styling option does not need a migration.

```json
{
  "source":   { "templateId": "WEB-04", "backgroundUrl": "" },
  "endAt":    "2026-12-31 23:59:59",
  "timezone": "Asia/Kolkata",
  "evergreenSeconds": 0,
  "canvasWidth": 600,
  "background": "#ffffff",
  "colors": 256,
  "frames": 60,
  "style":   { "x": 0.5, "y": 0.6, "units": ["days","hours","minutes","seconds"],
               "fontFamily": "Arial", "fontSize": 52, "color": "#ffffff",
               "plate": { "mode": "unit", "color": "#000000", "opacity": 0.45,
                          "radius": 10, "padX": 18, "padY": 14 } },
  "expired": { "mode": "message", "text": "SALE ENDED" }
}
```

Two details worth copying if you build on this:

- **The deadline is stored as written, not as a UTC instant.** Together with
  `timezone` it means "midnight, wherever the sale is running", which survives a
  daylight-saving change. Resolution to an instant happens per request in
  [`time.js`](../src/services/countdown/time.js).
- **The clock's position is a fraction of the canvas, anchored on the block's
  centre.** The same timer then lands in the same place if the creative is
  re-rendered at a different width, and changing the font size grows the block
  outwards instead of dragging it across the image.

`normalizeTimer()` in
[`config.js`](../src/services/countdown/config.js) is the single validator, and
it runs over both a database row and raw query parameters. Anything
unrecognised falls back to a default rather than erroring — this endpoint lives
in an `<img>` tag, where a 400 shows up as a broken image no recipient can fix.

### If you offered this as a SaaS

The pieces that are already right: per-timer JSON config, an id-addressed public
URL, and a cache keyed on appearance rather than on timer id (so two customers
with identical styling share a bundle).

What you would add:

- An **account column** on `timers`, and the account id in the bundle cache key.
- **Signed URLs** — an HMAC of `timerId + end + uid` — so a recipient cannot
  edit `?end=` and extend their own discount.
- **Per-account rate limits** on cold bundle builds specifically, since that is
  the expensive path.
- **Open tracking** — the GIF fetch *is* an open event; the endpoint is already
  the perfect place to record one.
- **A CDN in front of the creatives**, not the GIF.

---

## The backing plate

Three modes, set per timer:

- **none** — digits straight onto the artwork.
- **block** — one rounded panel behind the whole clock. Good when the creative
  is busy underneath and the numbers need separating from it.
- **unit** — a tile behind each of days/hours/minutes/seconds, the flip-clock
  look. Each tile wraps its group's digits and that group's label.

`radius`, `color`, `opacity` and the `padX`/`padY` padding apply to whichever
mode is chosen.

In `unit` mode the horizontal padding is **clamped to half the space between two
groups**, so tiles can never overlap however wide the padding is set. That space
is `gap * 2 + the separator's width`, so the way to get fatter tiles is to widen
the gap or clear the separator — not to keep raising `padX`. The builder says so
under the control.

The expired card always falls back to a single panel, even in `unit` mode: four
unit tiles behind one "SALE ENDED" headline would read as leftover furniture
from a clock that is no longer on screen.

Geometry lives in `plateRects()` in
[`layout.js`](../src/services/countdown/layout.js), shared by the GIF renderer,
the expired card and the builder preview so all three agree on the shape.

---

## Fonts

Text is drawn by librsvg through sharp, which resolves font families through
fontconfig — so the font has to exist **on the server**, not on the reader's
machine. `Arial` on a bare Debian container silently falls back to whatever
fontconfig picks.

Install the fonts you offer, or stick to what is there:

```dockerfile
RUN apt-get update && apt-get install -y fonts-liberation fonts-dejavu-core
```

`Liberation Sans` is metric-compatible with Arial, `Liberation Serif` with Times
New Roman. The builder lists both alongside the Windows names.

The layout does not care either way: digit widths are measured from the font
that actually renders, so an unexpected substitution changes how the clock looks
but never misaligns it.

---

## Building one

**Tools → Countdown Timers**, or `/timers`.

1. Pick the creative — a studio template, or an image URL.
2. Set the deadline and its time zone, or switch to an evergreen window.
3. Drag the dashed box over the preview to place the clock, then style it.
   The **backing plate** is either one panel behind the whole clock or a tile
   behind each unit; a unit tile wraps that unit's digits *and* its label, so
   turning labels off leaves bare number tiles.
4. **Play the real GIF** renders the actual animation, the same bytes an inbox
   would receive — worth doing before you save.
5. Save, and copy the `<img>` snippet.

The preview is rendered by the server through the same layout code the animation
uses, rather than mocked up in CSS, so what you position is what gets sent.
