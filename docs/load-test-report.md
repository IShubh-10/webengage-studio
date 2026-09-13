# Load test — `GET /api/v1/render/:templateId`

Run on 2026-09-01 with [`scripts/load-test.yml`](../scripts/load-test.yml) and
the `X-Cache` counters in
[`scripts/load-test-processor.js`](../scripts/load-test-processor.js).

**The conclusion, proven twice over: this endpoint is bandwidth-bound, not
compute-bound.** Both templates tested served 100% of their load from the Redis
render cache without compositing a single image — yet one plateaued at 164
requests/second and the other reached 1,154. The only meaningful difference
between them is response size: 525 KB versus 71 KB. Shrink the payload and the
throughput follows almost exactly in step.

## Environment

| | |
|---|---|
| Host | macOS (Darwin 25.6.0), 8 CPUs, Node v22.12.0 |
| Load generator | Artillery 2.0.21, **on the same machine as the server** |
| Transport | loopback (`http://localhost:3000`) |
| Redis / MySQL | both local |
| Server | `node src/server.js`, single process, unless noted |

Because the generator is co-located it competes with the server for the same 8
cores, and loopback is not a real network. Treat absolute numbers as a ceiling
for *this box*; the comparisons between runs are the real signal.

### The two templates

| | `WEB-02` | `WEB-01` |
|---|---|---|
| Background | 1920×1124, 7.5 KB **WebP** (despite a `.png` URL) | 1996×996, 265 KB PNG (Cloudinary) |
| Overlays | one `cover` image (46 KB JPEG), one text layer | one `{{image}}` placeholder image at 163×126, one text layer |
| Query used | `?test=mumbai` | `?city=enter_city&image=<cloudinary url>` |
| **Response** | **PNG, 525,259 bytes** | **PNG, 71,019 bytes** |
| Cold composite | 2,910 ms | 457 ms |

Note the inversion: `WEB-01` starts from a *much larger* source image and
produces a response **7.4× smaller**. Output size is driven by the composited
content, not by the inputs.

## Results

Every run used one template and one fixed variable set, so all requests resolve
to a single `render:<id>:<varHash>` key. These runs therefore measure the
**cache-serving path**, not the compositor.

### Run 1 — `WEB-02`, 525 KB response, ramp 10 → 500/s over 60 s

| Metric | Value |
|---|---|
| Requests / HTTP 200 / failures | 15,300 / 15,300 / 0 |
| **`X-Cache: HIT-REDIS` / `MISS`** | **15,300 (100.00%) / 0** |
| Composites during run | **0** |
| Wall clock | 93.5 s for a 60 s test — 33.5 s of backlog drain |
| Sustained | **163.6 req/s** |
| Downloaded | 7.48 GB @ 82 MB/s |
| Latency | median 573 ms, p95 20,958 ms, **p99 23,630 ms**, max 24,051 ms |
| Redis egress | 8.08 GB |

### Run 2 — `WEB-02`, same profile, 8 workers (`NODE_ENV=production WORKERS=8`)

| Metric | Value |
|---|---|
| Requests / HTTP 200 / failures | 15,300 / 15,299 / 1 (`ECONNRESET`) |
| **`HIT-REDIS` / `MISS`** | **15,299 (100.00%) / 0** |
| Sustained | **160.1 req/s** |
| Downloaded | 7.48 GB @ 80 MB/s |
| Latency | median 1,864 ms, p95 20,543 ms, **p99 24,595 ms**, max 25,870 ms |

**Eight workers were no faster than one** (160 vs 164 req/s; the median got
*worse*). Not CPU-bound.

### Run 3 — `WEB-01`, 71 KB response, same ramp 10 → 500/s over 60 s

| Metric | Value |
|---|---|
| Requests / HTTP 200 / failures | 15,300 / 15,300 / **0** |
| **`X-Cache: HIT-REDIS` / `MISS`** | **15,300 (100.00%) / 0** |
| Composites during run | **0** (`/metrics` `renders` unchanged at 3) |
| Wall clock | **59.8 s for a 60 s test — no backlog whatsoever** |
| Sustained | 255.7 req/s, i.e. the entire offered profile including its 500/s peak |
| Downloaded | 1.01 GB @ 17 MB/s |
| Latency | median **1 ms**, p95 **2 ms**, **p99 4 ms**, max 29 ms, mean 0.8 ms |
| Server RSS | 30.7 MB |
| Redis egress | 1.01 GB |

The same profile that buried `WEB-02` under a 23-second p99 was absorbed by
`WEB-01` with a **4 ms p99** and zero queueing. The service never came close to
its limit, so:

### Run 4 — `WEB-01` saturation probe, ramp 200 → 3,000/s over 60 s

| Metric | Value |
|---|---|
| Offered / HTTP 200 | 96,000 / 92,308 |
| Failures | 3,692 (3,685 `ETIMEDOUT`, 7 `ECONNRESET`) — at the top of the ramp |
| **`HIT-REDIS` / `MISS`** | **92,308 (100%) / 0** |
| Sustained | **1,154 req/s** |
| Downloaded | 6.11 GB @ 75 MB/s |
| Latency | median 478 ms, p95 5,379 ms, **p99 6,703 ms**, max 9,223 ms |

### Controls — isolating the constraint

| Run | Payload | Offered | Achieved | Throughput | median | p99 |
|---|---|---|---|---|---|---|
| A — `GET /health` | ~200 B | 500/s | 493 req/s (10,000/10,000) | 0.1 MB/s | 1 ms | 6 ms |
| B — 525 KB static file via `express.static` | 525 KB | 200/s | 197 req/s (6,000/6,000) | 99 MB/s | 1 ms | 60 ms |
| B2 — same static file | 525 KB | 500/s | **215 req/s** (15,000/15,000) | **108 MB/s** | 32 ms | 424 ms |

Control B2 is the decisive one: a plain static file of the same size, with no
Redis and no sharp involved, also plateaus at ~215 req/s / 108 MB/s. That is
this host's byte-shipping ceiling, and `WEB-02` at 164 req/s was already within
76% of it.

## The headline comparison

| | `WEB-02` | `WEB-01` | Ratio |
|---|---|---|---|
| Response size | 525,259 B | 71,019 B | **7.4× smaller** |
| Sustained throughput | 164 req/s | 1,154 req/s | **7.0× faster** |
| p99 at 500/s offered | 23,630 ms | 4 ms | **5,900× better** |
| Redis egress per 15,300 requests | 8.08 GB | 1.01 GB | 8.0× less |

Throughput scaled 7.0× for a 7.4× payload reduction — near-linear. That is what
a bandwidth-bound service looks like, and it is why adding workers did nothing.

## Findings

**1. The cache is working perfectly and is not the bottleneck.** Across every
run: 100.00% `HIT-REDIS`, zero misses, zero composites. The `renders` counter on
`/metrics` did not move during any load run. There is no cache work left to
optimise here.

**2. Response size *is* the performance story.** Everything above follows from
it. At 71 KB the endpoint holds a 4 ms p99 at 500 req/s on one core; at 525 KB
it cannot clear 200 req/s on eight.

**3. PNG is the wrong output format.** Re-encoding the `WEB-02` render:

| Format | Size | vs current | Encode | Implied ceiling at 108 MB/s |
|---|---|---|---|---|
| **PNG `quality:90, compressionLevel:6`** (current) | 485 KB | — | 232 ms | ~228 req/s |
| PNG `compressionLevel:9, palette:true` | 501 KB | 1.0× | 242 ms | ~221 req/s |
| **WebP `quality:82`** | **74 KB** | **6.9× smaller** | **121 ms** | **~1,494 req/s** |
| WebP `quality:90` | 131 KB | 3.9× | 135 ms | ~843 req/s |
| JPEG `quality:85` (mozjpeg) | 121 KB | 4.2× | 95 ms | ~915 req/s |

WebP is ~7× smaller *and* ~2× faster to encode. Run 4 is the empirical proof
that a ~71 KB response really does deliver the ~7× throughput this table
predicts. Also note `quality: 90` in the current `.png()` call does nothing —
sharp only honours it in palette mode.

**4. Requests queue instead of shedding.** Runs 1 and 2 spent a third of their
wall clock draining backlog, with p95 above 20 s; run 4 returned 3,685
`ETIMEDOUT` once past ~1,150 req/s. There is no concurrency limit on the
endpoint, so an overload turns into multi-second latency for everyone rather
than a fast failure for the excess.

**5. Every cache hit still costs a full-size Redis round trip.** 8.08 GB pulled
from Redis in run 1, 1.01 GB in run 3 — one `getBuffer` per request, each
materialising the whole PNG in the Node heap
([`render.routes.js:56`](../src/routes/render.routes.js#L56)). Compare control B
serving the same bytes from the OS page cache at a 60 ms p99.

## Recommendations, highest leverage first

1. **Stop returning PNG where the consumer can decode something better.** Run 4
   demonstrates the payoff: a ~71 KB response sustains ~1,150 req/s where a
   525 KB one manages 164. Two constraints shape *how* to do it:
   - **The gain is template-dependent.** Measured on the two renders above:

     | | `WEB-02` (photographic overlay) | `WEB-01` (flat graphic) |
     |---|---|---|
     | PNG (current) | 513 KB | 69 KB |
     | WebP q82 | **74 KB — 6.9× smaller** | 49 KB — 1.4× smaller |
     | WebP q90 | 131 KB — 3.9× | 65 KB — 1.1× |
     | JPEG q85 | 121 KB — 4.2× | **79 KB — *larger* than the PNG** |

     WebP never loses, but only photo-heavy creatives see anything like 7×, and
     JPEG actively inflates flat-graphic output. Do not promise a uniform
     speed-up.
   - **Do not negotiate on `Accept`.** This endpoint exists so images load in
     email and push, and there the fetch is usually made by a client-side image
     proxy (Gmail's `googleusercontent`, for one) whose `Accept` does not
     reliably describe the end client. Worse, WebP is not universally decodable
     in those channels — Outlook desktop for Windows renders via the Word engine,
     and iOS rich-push attachments take JPEG/PNG/GIF. Select the format
     **explicitly**, with a `?format=webp|jpeg|png` parameter the campaign sets
     per channel, defaulting to the safe format until the channel matrix is
     confirmed.

   Both rendered outputs were verified fully opaque (0 non-opaque pixels of
   2.1 M and 2.0 M), so a lossy format loses nothing here — but a creative that
   ever needs transparency must stay on WebP or PNG, never JPEG.
2. **Put a CDN in front of the endpoint.** The response already sets
   `Cache-Control: public, max-age=31536000, immutable`, so a CDN would absorb
   essentially all of this load.
   ⚠️ That header is currently inconsistent with the 600 s Redis TTL and with
   template edits purging the render cache — a CDN would keep serving a stale
   creative for a year. Either shorten the header to something a purge can
   match, or put the template's updated-at in the URL so a save yields a new URL.
3. **Add an in-process LRU for finished PNGs** in front of the Redis render
   cache, mirroring what `bufferCache` does for source images (finding 5). Size
   it in **bytes, not entries** — see the caveats.
4. **Cap concurrency and shed load.** A bounded in-flight counter returning 503
   past the limit is better than a 23 s p99 (findings 4).
5. **Measure the composite path separately.** Every run here was 100% cached, so
   the compositor is still unmeasured under load. The cold figures — 2,910 ms for
   `WEB-02`, 457 ms for `WEB-01` — are what a template's *first* request costs,
   and with no request coalescing in the render route, N concurrent first-hits
   composite N times.

## How to reproduce

```bash
npm start                                  # or NODE_ENV=production WORKERS=8 npm start
# warm the cache for whichever scenario the yml targets:
curl -s -o /dev/null "http://localhost:3000/api/v1/render/WEB-01?city=enter_city&image=https://res.cloudinary.com/djoqxegkb/image/upload/v1784536947/hhfqihawgcaybacowjxf.png"
ulimit -n 20000
npx artillery run scripts/load-test.yml
```

The processor turns `X-Cache` and `X-Render-Time` into Artillery counters, so the
summary reports `render.cache.hit-redis` / `render.cache.miss` and a
`render.compose_time_ms` histogram directly — that is where the cache figures
above come from. `GET /metrics` gives the server's own view (composites
performed, per-cache hit rates, RSS); under clustering it answers for whichever
worker takes the request, not the whole pool.

## Caveats

- The load generator shared the host with the server. On a real network the
  absolute ceiling would differ — though a 525 KB payload would hit a *tighter*
  limit over a real link, not a looser one.
- `LRUCache` is bounded by entry count, not bytes
  ([`lib/cache.js:32`](../src/lib/cache.js#L32)). With 525 KB objects any
  byte-blind cache is a memory-exhaustion risk; recommendation 3 must size in
  bytes.
- Runs 1, 3 and 4 used dev mode (single process); clustering in
  [`src/server.js`](../src/server.js) is gated on `NODE_ENV=production`.
- Run 4's failures are partly the co-located generator's own limit, so ~1,150
  req/s is a floor for the real ceiling, not a hard maximum.
