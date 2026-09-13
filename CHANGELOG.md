# Changelog

All notable changes to Webengage Creative Studio are recorded here. This is the
single place to look for what changed and why — keep it up to date as part of the
change itself, not afterwards.

## How to use this file

- Newest release at the top. Work that is merged but unreleased goes under
  **[Unreleased]**; when it ships, rename that heading to a version and date and
  start a fresh `[Unreleased]` block.
- Group every entry under one of these headings, in this order, and omit the
  ones you do not need:
  - **Added** — new features and endpoints
  - **Changed** — behaviour changes, UI/UX changes
  - **Database** — schema and migration changes, with the migration command
  - **Fixed** — bug fixes
  - **Removed** — things taken out
  - **Breaking** — anything that needs action from a caller, an operator, or a
    teammate's local setup, spelled out with what to do
  - **Architecture** — structural decisions worth remembering later
- Write entries for the person reading in six months: what changed, where
  (`file:line` or endpoint), and the reason. Link the migration script or SQL
  file whenever the database moved.
- Versions follow [Semantic Versioning](https://semver.org): breaking change →
  major, new feature → minor, fix only → patch.

---

## [Unreleased]

### Security

- **`SESSION_SECRET` is now required in production.** It was optional, with a
  fallback written in `src/config/index.js` — so the key signing every login
  cookie was sitting in the repository, and anyone who could read the source
  could mint a token for any account id, including one whose row says
  `role = 'admin'`. A startup warning was not enough; it scrolls past in a deploy
  log and the server comes up anyway. With `NODE_ENV=production` the process now
  refuses to start, with the `openssl rand -base64 32` command in the message.

  The check runs in the **master, before it forks** (`src/server.js`). Left in
  the workers it would have been worse than useless: all of them would die on
  require and the restart handler would fork replacements forever. That handler
  now also gives up after 10 crashes in 60 seconds, so any startup failure
  surfaces its error instead of being buried under a restart loop, and it no
  longer treats a deliberate `SIGTERM` shutdown as a crash worth restarting.

- **Session cookies are encrypted, not just signed** (`src/services/sessions.js`).
  The payload was plain base64 JSON, so anything that held the cookie — a proxy
  log, a HAR file on a support ticket, someone reading devtools over a shoulder —
  exposed the account's email, name and role in readable form. It is now
  AES-256-GCM with a key derived from `SESSION_SECRET` via HKDF, which gives
  confidentiality and integrity in one pass: a tampered token simply fails to
  decrypt.

- **Sessions can be revoked.** Signing out cleared the cookie in the browser and
  nothing else, so a token that had already leaked stayed valid for its full
  seven days, and a member removed by an admin could keep saving templates and
  timers until then — `requireAuth` only checks that a session exists. Tokens now
  carry a `jti`, `POST /api/v1/auth/logout` adds it to a Redis deny-list until it
  would have expired anyway, and deleting an account withdraws every session it
  has outstanding.

  Revocation **fails open** when Redis is down, deliberately: the alternative is
  that a Redis blip signs out every user at once, and a token only reaches that
  check after decrypting correctly under the server's key.

### Added

- **"Log out everywhere"** in the profile menu, backed by
  `POST /api/v1/auth/logout-all` — withdraws every outstanding session for the
  account rather than only this browser's, for a shared machine or a cookie you
  think may have leaked. Implemented as a per-account epoch — every token issued
  before that instant is refused — so it does not have to enumerate sessions.

  The epoch is recorded in **milliseconds**, matching an `ms` claim in the token.
  At one-second resolution the tokens being revoked and the token from the user
  signing straight back in fall in the same second and cannot be told apart, and
  both ways of breaking the tie are wrong: round the epoch up and a fresh login
  is dead on arrival (the user bounces back to the login page), round it down
  and a session that was just revoked stays usable for up to a second.

### Breaking

- **Everyone is signed out once, on deploy.** Setting a real `SESSION_SECRET`
  invalidates existing cookies on its own, and tokens from the old signed-only
  scheme are rejected regardless. No action beyond signing in again.

- **`SESSION_SECRET` must be set wherever this runs with `NODE_ENV=production`,
  or the server will not start.** Generate with `openssl rand -base64 32`.

### Changed

- **Scale work: the render path no longer touches MySQL, and overload now sheds
  instead of queueing.** Six bottlenecks found by reading the hot path, fixed
  together. Measured on one dev process against `TMR-01`:

  | | before | after |
  |---|---|---|
  | MySQL queries, 300 cold concurrent opens | 300 | **1** |
  | MySQL queries, 2,000 warm concurrent opens | 2,000 | **0** |
  | Sprite bundles built, 4 workers cold | 4 (~450ms CPU each) | **1** |
  | Sprite bundles for 300 distinct recipients | 300 | **1** |
  | MySQL pool ceiling at `WORKERS=4` | 300 connections | **60** |
  | Throughput, 1,200 simultaneous opens | — | 476/s, nothing shed |

  1. **The timer row is cached** (`src/services/timers.js`). `GET
     /api/v1/timer/:id.gif` ran an uncached `SELECT` on *every email open* —
     every other layer was cached and the lookup in front of them all was not.
     Now memory → Redis → MySQL, with single-flight so a cold key costs one
     query however many opens race for it, and a negative cache so a campaign
     pointing at a deleted timer id does not put its whole audience through to
     the database (200 requests for missing ids: 200 queries → 8, one per worker
     per id).

  2. **The MySQL pool is sized for the cluster, not the process**
     (`src/config/db.js`, `DB_POOL_TOTAL`). `connectionLimit: 75` is per worker,
     so eight workers asked for 600 connections against a default
     `max_connections` of 151 — the failure mode was `ER_CON_COUNT_ERROR`, not a
     busy database. `queueLimit: 0` also meant unbounded queueing, so a spike
     became unbounded latency and unbounded memory; it is now bounded and fails
     fast.

  3. **Cache keys are built only from variables that can change a pixel**
     (`relevantVars`/`templatePlaceholders` in `src/services/render.js`,
     `cacheVars` in `src/services/countdown/index.js`). Keys hashed the entire
     query string — recipient ids, UTM tags, whatever the ESP appended — so no
     two recipients ever shared an entry and a personalised send rebuilt a
     palette and a full sprite bundle *per person* for an identical picture.
     Only `{{placeholders}}` the creative actually contains can affect output,
     which is exact rather than a heuristic. Keys are also emitted in sorted
     order, so `?a=1&b=2` and `?b=2&a=1` stop hashing differently.

  4. **GIF encoding yields the event loop** every `RENDER_YIELD_FRAMES` frames,
     and both render endpoints run under one bounded queue
     (`src/lib/limiter.js`). Sixty synchronous frame encodes in a row stalled
     every other request on the worker. Past the queue limit the server now
     answers `503` with `Retry-After` rather than accepting work whose caller
     has already timed out.

  5. **Cache invalidation uses `SCAN`, not `KEYS`** (`src/lib/redisOps.js`).
     `KEYS` blocks the entire Redis server for a full keyspace walk, and every
     part of this app shares that server.

  6. **Concurrent fetches of the same image collapse into one**
     (`src/services/images.js`). A cold cache under load meant one outbound HTTP
     request per email open to the same URL.

- **`sharp` is sized to this worker's share of the box.** `sharp.concurrency(4)`
  was flat per worker, so eight workers asked for 32 native threads on an
  eight-core machine; the libuv pool is now sized above sharp's budget rather
  than at it. The duplicated sharp/threadpool configuration block in
  `src/server.js` has also been removed.

- **`/metrics` reports the GIF endpoint, the render queue and the pool ceiling.**
  The busiest endpoint in the app was the one render path metrics could not see.
  A climbing `renderLimiter.rejected` is the signal that an instance is
  undersized for the send it is serving.

### Fixed

- **The MySQL pool's keep-alive delay was being ignored.** `keepAliveInitialDelayMs`
  is not an option mysql2 recognises — it warned on every connection that a
  future version would throw. It is `keepAliveInitialDelay`.

- **A save in one worker now invalidates every worker** (`src/lib/invalidation.js`).
  Every in-memory cache is per process and production runs one process per core,
  so editing a timer or a template fixed the worker that handled the request and
  left the others serving the old creative until their entries aged out. Saves
  now publish on a Redis channel that every worker subscribes to. It is best
  effort by design — publishing applies locally first, and the memory caches
  carry a TTL for when Redis is unavailable.

### Architecture

- **`src/lib/singleflight.js`** — collapses concurrent work for one key onto a
  single promise. Used for the timer row, the template row and image fetches;
  the sprite builder already had its own copy of this and now shares it.
- **`src/lib/redisOps.js`** — `scanDelete` (non-blocking invalidation) and
  `withRedisLock`, a cluster-wide lock so only one worker builds a sprite bundle
  every worker is about to want. Single-flight is per process and stops there.
- **`src/lib/limiter.js`** — a bounded work queue shared by both render
  endpoints, because they contend for the same thing: one event loop.
- **`src/lib/invalidation.js`** — the cross-worker invalidation channel.
- **`src/services/timers.js`** — the cached read path for a saved timer, kept
  out of the repository layer so all SQL stays in `src/repositories/`.

  New tunables are documented in `.env.example` under **Capacity** and
  **Countdown timers**; every one has a working default, so no configuration
  change is required to pick these up.

### Added

- **Countdown timers can now loop forever instead of freezing**, via
  `style`-level `loop` (Advanced → Loop forever, or `?loop=1`). The default is
  unchanged: play once, freeze, stay accurate.

  A naive infinite loop is *worse* than freezing — the animation returns to
  frame 0 and the clock jumps back up, which reads as broken where a frozen one
  reads as a static image. So looping is implemented seamlessly instead: a
  seconds column visits all sixty of its values in exactly sixty frames, so loop
  mode forces 60 frames (ignoring `frames`) and **holds every unit above seconds
  at its fetch-time value**. The wrap from the last frame to frame 0 is then an
  ordinary one-second decrement. Measured at `03:25:38` remaining:

  ```
  loop off :  frame 59 -> frame 0 :  03:24:40 -> 03:25:39    jump of +59s
  loop on  :  frame 59 -> frame 0 :  03:25:39 -> 03:25:38    steps -1s
  ```

  The trade is explicit: seconds stay *exactly* correct indefinitely, because
  `(s - k) mod 60` is what a real clock reads `k` seconds later, while minutes
  and above go stale by however long the reader watches. Looping needs the
  Seconds unit and more than 60 seconds remaining (`canLoopSeamlessly()`);
  otherwise the timer plays once as before. Responses report which happened in
  the new `X-Timer-Loop` header, and the builder explains the trade under the
  switch rather than just offering it.

- **A countdown's backing plate can now be one panel behind the whole clock or a
  tile behind each unit**, and its corner radius and padding are editable. The
  plate was previously a single on/off panel wrapping the whole
  days/hours/minutes/seconds block, with `radius` reachable only by editing the
  stored JSON. `style.plate.mode` takes `none`, `block` (the old behaviour) or
  `unit`; `radius`, `padX` and `padY` join colour and opacity in the builder's
  Clock section, and on the URL as `?plate=`, `?plateradius=`, `?plateopacity=`,
  `?platepadx=`, `?platepady=`.
  - In `unit` mode a tile wraps its group's digits **and** that group's label, so
    turning labels off leaves bare number tiles.
  - Horizontal padding in `unit` mode is clamped to half the space between two
    groups, so tiles can never overlap however wide the padding is set. Wider
    tiles come from raising `gap` or clearing the separator, which the builder
    now says under the control rather than letting Pad X look broken.
  - The expired card always falls back to a single panel, even in `unit` mode —
    four tiles behind one "SALE ENDED" headline would read as leftover furniture
    from a clock that is no longer on screen.
  - **Timers saved before this keep working untouched.** `plate.enabled` was a
    boolean; `normalizeStyle()` reads whichever of `mode`/`enabled` is present
    and maps `true` to `block`, so no migration and no re-save is needed.

- **Countdown timers — a live clock drawn on your own creative, served as an
  animated GIF for HTML email.** New tool at `/timers` (Tools → Countdown
  Timers), new public endpoint `GET /api/v1/timer/:timerId.gif`. The creative is
  a studio template or an image URL, so the artwork is designed in Dynamic
  Images and keeps its `{{placeholders}}` — a single URL can be personalised
  *and* count down. Full write-up in [`docs/countdown-timers.md`](docs/countdown-timers.md).
  - **Deadlines** are stored as wall-clock time plus an IANA zone
    (`2026-12-31 23:59:59` + `Asia/Kolkata`), resolved to an instant per request
    in `src/services/countdown/time.js`, so daylight-saving transitions are
    handled. `?tz={{user.timezone}}` merges a per-recipient zone, which is the
    only way to get one: the request comes from the client's image proxy, so the
    reader's IP and user agent are never visible.
  - **Evergreen timers** — "24 hours from your first open" — via
    `?dur=86400&uid={{user.id}}`. The first fetch records the start in Redis with
    `SET NX` so concurrent opens agree on one moment.
  - **Expired handling**: a message drawn over the creative, a different image, a
    freeze on zeros, or a transparent pixel. The clock never counts below zero,
    and it switches mid-animation if the deadline passes while someone is
    watching.
  - **The animation does not loop.** A looping countdown would jump back to its
    starting value and show the wrong time; it plays once, freezes, and the next
    open fetches a fresh one.
  - Authenticated builder endpoints: `POST /api/v1/timers/preview` (a still PNG
    of a draft, plus the measured block rectangle the UI draws its drag handle
    over), `POST /api/v1/timers/preview.gif` (the real animation, before
    saving), and CRUD at `GET|POST /api/v1/timers`,
    `GET /api/v1/timers/:timerId`, `GET /api/v1/timers/next-id`. Deleting is
    admin-only, matching the templates rule, because any live campaign pointing
    at a deleted timer starts serving nothing.
- **`src/lib/gif.js`** — a GIF89a writer with per-frame sub-rectangles. Written
  rather than taken off the shelf because no general-purpose encoder exposes the
  one thing that makes this feasible: a GIF frame carries its own
  left/top/width/height and a disposal method of "leave in place", so a frame can
  be *just the digit that changed*. Verified pixel-exact against libvips across
  palette sizes, odd dimensions and composited sub-rect frames.
- **`src/lib/quantize.js`** — median-cut colour quantisation with reserved
  colours, so the digit colour survives a palette dominated by the artwork.
- **No-store response headers** (`NO_STORE_HEADERS` in `src/config/index.js`):
  `Cache-Control: no-store, no-cache, must-revalidate, max-age=0, s-maxage=0,
  proxy-revalidate` plus `Pragma`, `Expires`, `Surrogate-Control`,
  `CDN-Cache-Control` and `Vary: *`. Without the surrogate pair a CDN configured
  to override `Cache-Control` will happily serve a stale countdown.

- **Source images and their decoded metadata are now genuinely persisted in
  Redis.** `img_buffer:<url>` holds the raw bytes and the new `img_meta:<url>`
  holds a small JSON record of the properties a render needs without touching
  the bytes — `format`, `contentType`, `width`, `height`, `size`, `space`,
  `channels`, `hasAlpha`. Metadata previously lived only in the per-process
  `metadataCache`, so every restart re-decoded every background.
- **`scripts/load-test.yml` and `scripts/load-test-processor.js`** — an Artillery
  profile for `GET /api/v1/render/:templateId`. The processor turns the
  `X-Cache` and `X-Render-Time` response headers into Artillery counters, so a
  run reports `render.cache.hit-redis` / `render.cache.miss` and the composite
  time distribution directly. Run it with `npx artillery run
  scripts/load-test.yml`. Results and analysis live in
  `docs/load-test-report.md`, which now covers four runs across two templates
  and establishes that the render endpoint is **bandwidth-bound, not
  compute-bound**: at a 525 KB response it plateaus at 164 req/s with a 23.6 s
  p99, while at a 71 KB response it sustains 1,154 req/s and holds a 4 ms p99 at
  500 req/s — a 7.0x throughput gain from a 7.4x smaller payload. All runs were
  100% render-cache hits with zero composites, so the payload, not the cache, is
  what limits this endpoint. The report's format recommendation records two
  constraints found while sizing the alternatives: the saving is
  template-dependent (WebP q82 is 6.9x smaller on a photographic creative but
  only 1.4x on a flat graphic, and JPEG is *larger* than PNG on the latter), and
  the output format must be chosen **explicitly** rather than negotiated on
  `Accept`, because email image proxies do not report the end client's
  capabilities and WebP is not decodable in Outlook desktop or iOS rich-push
  attachments.
- **Image overlays can now be stretched to any shape, so one can cover the whole
  background.** Two things were in the way:
  - The canvas only offered the four corner handles, and every corner drag
    recomputed height from the element's starting aspect ratio, so the box could
    never take a shape the image itself did not have. Image layers now carry
    eight handles: the four corners resize both axes independently, and the new
    mid-edge handles (`.resize-handle.t/.r/.b/.l` in `public/index.html`) resize
    a single axis. Hold **Shift** on a corner to keep the original ratio, which
    is the old behaviour when you want it. Text layers keep the four corners.
  - The renderer resized every overlay with `fit: inside`, which shrinks the
    image back to its own ratio inside the box, so even a full-canvas box
    rendered letterboxed. Elements now carry a **sizing mode**:
    `contain` (fit inside, the default and the previous behaviour), `cover`
    (fill the box and crop the overflow, ratio preserved) or `fill` (stretch to
    the box). Picked from the new **Sizing** select in the studio's image
    fields; `src/routes/render.routes.js` maps it onto sharp's fit and crops
    from the centre.
- **Fill background** button in the image fields: sets the selected overlay to
  `0, 0`, the full canvas size, and `cover` in one click — the fast path for a
  dynamic image that has to sit behind everything.
- The canvas preview mirrors the chosen sizing mode (`object-fit`), so what the
  workspace shows is what the renderer produces.

### Changed

- **The plate rectangle is computed in one place.** `plateRects()` and
  `plateSvg()` in `src/services/countdown/layout.js` replace the three
  near-identical copies of the same `<rect>` maths that had grown in
  `layout.js`, `sprites.js` (the expired card) and `still.js` (the builder
  preview) — so the GIF, the expired state and the preview cannot drift apart.
- **Tools page and profile menu** now list Countdown Timers alongside Dynamic
  Images, with Timer Builder and Timer Library as its two sections. New `clock`
  icon in the shared set (`public/assets/shell.js`), stroked like the rest.

- **Cached images now live for 24 hours instead of 1**, via the new
  `IMAGE_CACHE_TTL_SECONDS` (default `86400`) and `IMAGE_CACHE_REFRESH_SECONDS`
  (default `300`) in `src/config/index.js`. The template schema was already
  cached for 24 h, so the old 1 h image TTL meant a guaranteed origin fetch every
  hour for an asset that had not changed. Source URLs here are content-addressed
  (UUID filenames), so a long TTL is safe; if an image is ever replaced *at the
  same URL*, bust it with a query parameter or drop its `img_buffer:` /
  `img_meta:` keys.
- `src/routes/render.routes.js` gets background dimensions from the new
  `loadImageMetadata()` service call instead of reaching into `metadataCache`
  and hand-rolling the sharp instance, keeping the SQL-free route thin.

- **Saving a template did not drop its already-rendered PNGs.** `POST /api/v1/templates`
  only cleared `template_schema:<id>` and `templates_all`, leaving every
  `render:<id>:<varHash>` key in place, so an edited template kept serving the
  previous image from cache. The save path now purges those keys the same way
  the delete path does (`src/routes/template.routes.js`).
- **A hairline strip of background survived a full-canvas overlay.** The studio
  lays out against a 300px-tall preview, so a background of 1920x1124 has a
  canvas 512.46px wide while the width input can only hold `512` — scaled back
  up, the overlay stopped 2px short of the right edge. The renderer now snaps a
  box to the background edge when it lands within one canvas pixel of it, since
  a gap that small is rounding rather than intent. Boxes larger than the
  background are also clamped now; previously sharp refused to composite an
  oversized input and the layer was dropped from the render entirely.
- **The resized-overlay cache was keyed on the element's own width/height**, so
  the same image and box over two differently sized backgrounds could share one
  resized buffer. It is keyed on the resolved pixel size instead.

### Database

- New **`timers`** table: `timer_id` (PK, `TMR-01` style), `name`, `config` JSON,
  `created_by`, timestamps. The whole definition lives in the one JSON column, in
  exactly the shape the builder edits and the renderer reads — the same
  arrangement `templates.elements` uses, so a new styling option does not need a
  migration.

  ```
  mysql -u root -p personalize_studio < migrations/004_timers.sql
  ```

  `ensureTimerSchema()` also creates it on boot, so an existing environment
  upgrades itself on restart and the migration file is only needed for review or
  a manual run.

- One-off data fix: WEB-02's image layer (pinned at `0,0` across the whole
  canvas, i.e. a cover box by intent) was saved by the pre-fix server and had no
  `fit`, so it rendered letterboxed. Set to `cover`. No schema change and no
  migration — see below.

  `templates.elements` is JSON, so the per-element `fit` field needs no
  migration; elements saved before it existed read back as `contain`.

### Fixed

- **The countdown frame builder recomputed the time breakdown once per digit
  slot** instead of once per frame — eight times the work per frame on a
  days/hours/minutes/seconds timer. `unitValues()` is now called once and the
  slots read from it (`src/services/countdown/index.js`).
- **Text layers with the same content at different positions could serve each
  other's SVG.** The `svgCache` key was built from the text and its font
  properties only, so two layers differing solely in `x`/`y` — or the same layer
  over differently sized backgrounds — collided and the second render reused the
  first one's position. The key now includes the resolved coordinates and the
  canvas size (`src/services/render.js`).

- **Redis lost its copy of every source image after an hour and never got it
  back.** `loadImageBuffer()` returns from the in-memory LRU before it reaches
  the Redis branch, and that LRU has no expiry — so once the 1 hour Redis TTL
  lapsed, the bytes were gone from Redis while the process happily kept serving
  them from memory. Nothing ever rewrote them, so Redis held *no* image binaries
  at all: every other worker, and this one after any restart, had to re-fetch
  from the origin. A memory hit now re-asserts the Redis TTL and rewrites the
  entry if it has expired (`touchRedisCopy()` in
  `src/services/images.js`), throttled to at most once per key per
  `IMAGE_CACHE_REFRESH_SECONDS` so the fast path does not pay a round trip on
  every render.

### Architecture

- **The template compositor moved out of the route and into
  `src/services/render.js`.** `render.routes.js` was holding the whole
  compositing pipeline, which the timer endpoint needed too. The route now owns
  only its cache lookup and response headers; `composeTemplate()` returns an
  unconsumed sharp pipeline so a caller decides whether it becomes a PNG or raw
  pixels. Behaviour is unchanged — the same creative renders identically as a
  still or as a timer, which is the point.
- **The expensive half of a countdown is precomputed into a cached "sprite
  bundle"** (`src/services/countdown/sprites.js`). None of it depends on the
  clock: the artwork is fixed, the plate/separators/labels never change while the
  timer runs, and there are only ten possible pictures for any one digit slot. So
  the creative, all eighty digit tiles and the expired card are quantised
  **together** into one shared palette and cached — in a per-process LRU and in
  Redis, packed as a single buffer. Serving a request is then index copying and
  LZW, with no colour work at all.

  Measured on a 600x260 creative, 60 frames, 256 colours, one core:

  | | |
  |---|---|
  | Cold request (bundle built) | 449 ms |
  | Warm request | 7.3 ms (8.1 ms CPU) |
  | Response-cache hit | ~1 ms |
  | 60-frame GIF | 46 KB — frame 0 is 19 KB of it, the other 59 average 476 bytes |

  Encoding sixty full frames instead would be ~60x the work and roughly a
  megabyte of output.
- **Three layers of cache protect the cold path**, which is the only real risk on
  a large send: concurrent misses for the same bundle await one build instead of
  stampeding; bundles are shared across workers and restarts through Redis
  (`TIMER_SPRITE_TTL_SECONDS`, 6h); and a 2-second response cache collapses the
  thousands of opens that arrive in the same second onto a single encode. The
  response still leaves with `no-store`, so nothing downstream keeps a copy.
  Fetching the URL once before a send warms all of it.
- **`bg` is deliberately not accepted on the public GIF endpoint.** It would let
  anyone point the server at an arbitrary URL; the creative is always the one the
  signed-in author saved. `template` stays overridable because template ids are
  already public through `/api/v1/render/:id`.

### Operations

- **The server must be restarted for any of this to take effect** — a long-lived
  `npm start` process keeps the old modules in memory, and its save path will
  keep dropping the `fit` field on the floor. When that happens the symptom is
  confusing: the studio shows Cover, the database row has no sizing, and the
  render URL serves a letterboxed image (possibly a stale cached one). After
  restarting, purge `template_schema:*` and `render:*` in Redis once if any
  template was saved by the old process.

## [3.0.0] — 2026-08-31

A production-ready layout, and template deletion for admins.

### Added

- **Admins can delete templates from the library.** `POST /api/v1/templates/:templateId/delete`
  is admin-only; the studio's Templates Library shows a Delete action on each
  card for admins and nothing for members. Deleting drops the row, purges the
  template's Redis entries **including its cached PNGs** (so a render URL
  pointing at it starts returning 404 immediately), clears the in-memory caches,
  and logs a line naming the admin who did it. If the deleted template was open
  in the workspace, the workspace resets.
- `npm run dev` (watch mode) and `npm run migrate` scripts, plus an `engines`
  field pinning Node >= 18.
- A "Repository layout" and "Running it" section at the top of the README,
  including where new code belongs.

### Changed

- **The single 1,800-line `server.js` was split into a layered `src/` tree**:
  `config/`, `lib/`, `db/`, `middleware/`, `services/`, `repositories/` and
  `routes/`. Routes now validate and delegate, services hold the logic, and all
  SQL lives in repositories. Behaviour is unchanged — the URL surface is
  identical because each router keeps absolute paths.
- Inline SQL in the auth handlers moved behind `userRepository`, and the
  template queries behind `templateRepository`.
- The Redis client and its connection flag are now a shared state object rather
  than two module-level variables, so every module sees the live status.
- `ensureAuthSchema()` / `ensureTemplateSchema()` are self-guarding: callers just
  await them instead of checking a flag first.
- Repository reorganisation: `sql/` → `migrations/`, and `studio.md` +
  `scaling_improvements.md` → `docs/`.

### Breaking

- **The entry point moved from `server.js` to `src/server.js`.** `npm start`
  already points at it; any process manager, Dockerfile, systemd unit or PM2
  config that runs `node server.js` needs updating to `node src/server.js`.

### Architecture

- Layer boundaries are the point: an endpoint's HTTP concerns, its logic and its
  SQL are now in three different files, so a change to one rarely touches the
  others, and each piece can be read without scrolling past the rest of the app.

## [2.2.2] — 2026-08-31

### Changed

- **UI/UX: the save/confirm action colour joined the blue scheme.** `--success`
  moved from green `#10b981` to azure `#0b6fc4`, with `--success-hover` at
  `#0a5798`. It is lighter than the navy `--primary` (`#0154a5`), so a save
  action still reads as distinct from a primary one, and both carry white text
  comfortably (5.14:1 and 7.42:1 against white, AA). Affects the studio's Save
  and Add Element buttons, the layer and template card actions, and
  `.btn.success` everywhere.
- The studio's default button hover pointed at `--primary`, which after the
  recolour would have sat at nearly the same depth as its rest state; it now
  hovers to `--success-hover` so the feedback stays visible.

Status colours were left alone on purpose: success alerts and the "Live" badge
still use the green `--ok` family, which is conventional for feedback rather
than for actions.

## [2.2.1] — 2026-08-31

### Fixed

- **Registration OTPs are now delivered.** The cause was configuration, not
  code: `WEBENGAGE_API_KEY` was unset, so the send endpoint returned
  `delivered: false` with a note and only logged the code. The key now lives in
  a local `.env` (gitignored, `chmod 600`), and startup confirms delivery is
  configured. Verified with a live send: WebEngage accepted the trigger and the
  endpoint returned `delivered: true`.

- The API key is read from `.env` only. A hardcoded fallback that had been
  added to `server.js`, and a filled-in value in the committed `.env.example`,
  were both removed — those files are committed, so a key in them would leak.

### Changed

- The transactional campaign is now triggered against a **fixed WebEngage user
  id** (`shubham01`, overridable with `WEBENGAGE_OTP_USER_ID`), matching the
  campaign's own sample cURL. It previously passed the recipient's E.164 number
  as `userId`; the recipient is taken from `overrideData.phone` either way, so
  the id does not need to identify the person signing up.

## [2.2.0] — 2026-08-31

### Changed

- **UI/UX: navigation moved out of the nav bar and into the profile menu.** The
  bar is now deliberately subtle — logo on the left, profile on the right, and
  nothing else. Opening the profile shows the signed-in user, then every
  destination, then Log out:
  - **Studio** — All Tools, and Dynamic Images with Studio Workspace and
    Templates Library nested beneath it on a connecting rail, so the
    tool-to-section relationship is still visible.
  - **Administration** — Members, revealed only once `/api/v1/auth/me` confirms
    an admin.
  - The current tool and section stay highlighted, and a section that is a view
    inside the open page still switches in place rather than reloading.
- The nav bar's own dropdown triggers, hover menus and the narrow-screen nav
  sheet are gone with the items they carried; the profile menu closes on outside
  click or Escape and scrolls if it ever outgrows the viewport.

## [2.1.0] — 2026-08-31

Navigation moved into a horizontal nav bar, the neumorphic theme was reverted,
and OTP delivery is now configurable through a `.env` file.

### Added

- **`.env` support with no new dependency.** `server.js` reads `KEY=VALUE` lines
  from a `.env` file beside it at startup (real environment variables still
  win), so `WEBENGAGE_API_KEY` and `SESSION_SECRET` no longer have to be
  exported by hand. [.env.example](.env.example) documents every variable.
- A startup line that states whether OTP delivery is configured, and names the
  campaign URL when it is. Previously a missing API key was only visible as
  `delivered: false` in an API response.
- `.gitignore`, so `.env` and `backups/` are never committed.

### Changed

- **UI/UX: the sidebar is gone, replaced by a horizontal nav bar** in the style
  of the WebEngage dashboard: logo on the left, the tool hierarchy as dropdown
  menus beside it (Dynamic Images → Studio Workspace, Templates Library; Admin →
  Members), and the signed-in user on the right with a menu holding their
  identity, role and **Log out**. Menus close on outside click or Escape, and
  fold into a sheet under the bar on narrow screens.
- **UI/UX: the neumorphic theme was reverted** to the previous flat look — white
  panels on a light slate canvas, hairline borders, restrained shadows, the blue
  brand wordmark, the green save action, and the blue gradient panel on the
  sign-in screen. `theme.css` now carries those tokens and primitives
  (`.btn`, `.icon-btn`, `.badge`), and the Inter webfont was dropped in favour
  of the families the app used before.
- **UI/UX: the back button was removed.** With navigation always visible in the
  nav bar there is nothing for it to do.
- The studio now spans the full window width, since the sidebar no longer takes
  a column.

### Kept

- Emoji-free interface: the stroked SVG icon set introduced in 2.0.0 stays, and
  is what the nav bar, dropdowns and cards draw from.
- Phone verification and the whole OTP flow from 2.0.0 are unchanged.

### Fixed

- **Registration OTPs were never delivered** because `WEBENGAGE_API_KEY` was not
  configured — the send endpoint reported `delivered: false` with a note, which
  was easy to miss. Setting the key in `.env` now fixes delivery, and the server
  says so at startup either way.

## [2.0.0] — 2026-08-31

Verified mobile numbers on sign-up, and a neumorphic redesign of the whole
interface.

### Added

- **Mobile number on registration, verified by a 4 digit OTP.** Sign-up is now
  two steps: details, then the code.
  - `POST /api/v1/auth/otp/send` generates the code with
    `crypto.randomInt` (never on the client, never returned in a response) and
    texts it through the WebEngage transactional campaign.
  - The code is stored as an HMAC digest under `otp:register:<phone>` in Redis
    with a 5 minute TTL, so a look at Redis hands out no live codes. Redis is
    the supported store; an in-memory fallback keeps single-worker development
    working.
  - Limits: 5 wrong attempts burns the code, 30 second resend cooldown, and a
    code is bound to the email it was requested for.
  - `POST /api/v1/auth/register` now requires `phone` and `otp`, and verifies
    the code before the account row is written.
  - Configuration: `WEBENGAGE_API_KEY` (required to actually send),
    `WEBENGAGE_OTP_URL`, `WEBENGAGE_OTP_TTL` (default 60), `OTP_TTL_SECONDS`
    (default 300), `PHONE_COUNTRY_CODE` (default `+91`). With no API key the
    code is written to the server log instead, and the sign-up screen says so.
- **Phone validation.** The form accepts 10 digits only — non-digits are
  stripped as you type and the field is capped — and the server normalises what
  people paste (`+91 98765 43210`, `098765-43210`, `9876543210` all resolve to
  the same number) before requiring exactly 10 digits. Numbers are unique per
  account and stored bare; `+91` is added when the SMS goes out.
- **Neumorphic design system** in `public/assets/theme.css`: shared tokens plus
  primitives (`.nm-btn`, `.nm-icon-btn`, `.nm-badge`, inset form fields, soft
  raised surfaces). Depth comes from a light top-left highlight and a soft
  bottom-right shadow on a same-colour surface — raised means actionable, inset
  means input or selected.
- **Line icon set** (`window.shellIcon(name)` in `shell.js`) covering
  navigation, controls and form fields.
- Mobile number column on the admin members table.

### Changed

- **UI/UX: the whole interface is neumorphic and holds to a 90/10 palette.**
  Near-white surfaces and soft shadows carry the layout; the WebEngage blue is
  spent only on the active nav item, one primary action per view, focus rings
  and small accents. Applies to the sign-in screen, tools hub, studio and admin.
- **UI/UX: every emoji is gone**, replaced by stroked SVG icons drawn in
  `currentColor` — sidebar items, tool cards, the collapse and back controls,
  and the studio's layer labels ("Image layer" / "Text layer").
- **UI/UX: Inter** is now the interface typeface, replacing the `math` and
  `fantasy` families the pages had been using, including the wordmark.
- The studio's text-colour picker no longer borrows a rainbow image from a
  third-party CDN as its background; it is a themed swatch showing the actual
  colour.

### Database

- `users.phone VARCHAR(10) NULL` with `UNIQUE KEY uniq_users_phone`
  ([migrations/003_users_phone.sql](migrations/003_users_phone.sql)), also applied on boot by
  `ensureAuthSchema()`. UNIQUE permits many NULLs in MySQL, so accounts created
  before verification existed keep working.

### Breaking

- **`POST /api/v1/auth/register` now requires `phone` and `otp`.** A caller must
  first request a code from `POST /api/v1/auth/otp/send`. Registering with only
  name, email and password returns 400.
- **Set `WEBENGAGE_API_KEY`** or no OTP is delivered: the send endpoint still
  returns success with `delivered: false` and logs the code, which is intended
  for local development only.

### Architecture

- OTP state lives in Redis rather than the database: it is short-lived, needs a
  TTL, and never has to outlive the sign-up attempt.
- Page styling is split in two — `theme.css` owns tokens and primitives,
  `shell.css` owns the app frame — so a new tool page inherits the look by
  linking two files.

## [1.0.0] — 2026-08-31

First release with accounts, an admin area, a tools hub and a single-table
template store. Before this, the studio was one unauthenticated page.

### Added

- **Accounts and login** (`public/login.html`, `server.js` section 10.5).
  Email + password sign-in with self-registration for new members. Passwords are
  hashed with scrypt from `node:crypto` (`scrypt$N$r$p$salt$hash`) — no new
  dependency, and no password is ever stored or logged in readable form.
  Sessions are stateless HMAC-SHA256 tokens in an httpOnly, SameSite=Lax cookie
  that lives 7 days (`secure` when `NODE_ENV=production`).
  - `POST /api/v1/auth/register`, `POST /api/v1/auth/login`,
    `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`, `GET /api/v1/auth/status`.
  - The first account to register becomes `admin`; everyone after joins as
    `member`.
  - Optional `ALLOWED_EMAIL_DOMAIN` (e.g. `webengage.com`) restricts who may
    self-register.
- **Tools hub** at `/tools` (`public/tools.html`) — the landing page after
  login. Dynamic Images is the only live tool for now, with a placeholder tile
  for the ones to come.
- **Admin area** at `/admin` (`public/admin.html`) — account totals plus a table
  of every member (name, email, role, joined, last login) with promote, demote
  and remove actions.
  - `GET /api/v1/auth/users`, `POST /api/v1/auth/users/:id/role`,
    `POST /api/v1/auth/users/:id/delete`.
  - Admins cannot change their own role or delete their own account, so the
    studio can never be left without an admin.
- **Shared app shell** (`public/assets/shell.css`, `public/assets/shell.js`)
  used by every page: sidebar navigation, the account block, the back arrow and
  session handling all live in one place. A page opts in with
  `window.STUDIO_SHELL = { active, section, back, onSection }`.
- **Sidebar tool hierarchy** with an expand/collapse pattern. Each tool is a
  group that opens to show its own sections (Dynamic Images → Studio Workspace,
  Templates Library), the whole rail collapses to icons with hover flyout
  submenus, and both the collapsed state and which groups are open persist in
  `localStorage`.
- **In-app back arrow** at the top of the sidebar, so nobody has to reach for
  the browser's back button. It steps back through app history when there is
  any, and otherwise goes up a level.
- **Linkable studio sections** — `/studio?view=templates` opens the Templates
  Library directly, and switching view keeps the URL in step.
- `migrations/001_users.sql`, `migrations/002_templates_single_table.sql` and
  `scripts/migrate-templates-to-json.js` so schema changes are reviewable and
  repeatable instead of implicit.

### Changed

- **UI/UX: the top bar is now minimal** — logo on the left, Log out on the
  right, nothing else. Navigation, the current tool's sections, and the
  signed-in user's name, email and role all moved into the sidebar.
- **UI/UX: the studio's top tabs became sidebar entries.** Studio Workspace and
  Templates Library now sit under Dynamic Images in the hierarchy, which makes
  the relationship between a tool and its sections visible.
- Template reads and writes got faster: reading the library went from `1 + N`
  queries to **one**, rendering from two queries to **one**, and saving from a
  transaction (upsert + `DELETE` + bulk `INSERT`) to **one upsert**.
- `/` now redirects by session state (`/login` or `/tools`) instead of serving
  the studio page directly, and `express.static` runs with `index: false` so
  `/index.html` cannot bypass the gate.

### Database

- **`templates` and `template_elements` collapsed into one table.** Layers now
  live in a `templates.elements` JSON array in draw order, in exactly the shape
  the studio UI and the renderer already use, so no column mapping and no
  `layer_order` column are needed.
  - `node scripts/migrate-templates-to-json.js` backfills and verifies every
    template; `--retire` writes the old rows to `backups/` as JSON and drops
    `template_elements`, leaving one table.
  - `server.js` also adds the column and backfills any `NULL` rows on boot, so a
    fresh clone or another environment upgrades itself.
  - Verified by rendering WEB-01/02/03 before and after the migration with the
    Redis caches flushed: byte-identical PNG output.
- **New `users` table** (`migrations/001_users.sql`) holding accounts and roles. Also
  created automatically on boot.

### Fixed

- The sidebar role badge stayed visible in the collapsed icon rail because the
  script set an inline `display`; visibility is a class now, so the rail's CSS
  wins.
- Shell buttons no longer inherit the studio's global `button { width: 100% }`,
  which had stretched the top bar's Log out across the header.
- The collapsed sidebar's `overflow-x: hidden` clipped its hover flyouts; the
  rail uses `overflow: visible`.

### Removed

- `template_elements` (and the interim `template_elements_legacy` backup table).
  The pre-migration rows are kept as a file in `backups/`, so the database holds
  exactly one template table.

### Breaking

- **Template management now requires a session.** `GET /api/v1/templates`,
  `POST /api/v1/templates` and `GET /api/v1/templates/next-id` return `401`
  without a valid cookie. `GET /api/v1/render/:templateId` stays **public** —
  rendered images have to load in emails and push notifications.
- **`SESSION_SECRET` must be set** in any real deployment. Without it the server
  falls back to a default that is visible in the repo, which would let anyone
  forge an admin cookie. Generate one with
  `export SESSION_SECRET="$(openssl rand -base64 32)"`. Changing the value logs
  everybody out, and every cluster worker and instance must share it.
- Anything reading `template_elements` directly must read `templates.elements`
  instead.

### Architecture

- Sessions are stateless: a signed cookie carries the user, so any cluster
  worker can verify a request with no shared session store.
- Admin checks re-read the role from the database rather than trusting the
  cookie, so a promotion or removal takes effect on the next request instead of
  whenever the 7-day cookie expires.
- Page chrome lives in two shared assets rather than being copied into each
  page, so a new tool inherits the navigation by declaring one config object.
