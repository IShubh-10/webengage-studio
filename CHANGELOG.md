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

### Added

- **Open Stats — how many times each creative has actually been opened**, at
  `/stats`, with the window presets the question is usually asked in: today,
  last 7 days, last 30 days, this month, last month, this year, last year, and
  a custom range. Opens are counted to the hour, so the page can show both the
  shape of a month and the exact date and time of the most recent open.

  Every fetch of the two public endpoints is counted —
  `GET /api/v1/render/:templateId` (dynamic images) and
  `GET /api/v1/timer/:timerId.gif` (countdown timers) — including the ones
  answered from the Redis cache, because a cached answer is still somebody
  opening the image. A render that 404s is not counted, so a request for an id
  that does not exist cannot put a row in the stats table.

  Two new endpoints, both behind a session:

  - `GET /api/v1/stats/overview?from=&to=&unit=&tzOffset=` — the headline
    total, the change against the previous window of the same length, the
    series, and a row per creative including the ones nobody opened.
  - `GET /api/v1/stats/asset/:assetType/:assetId?…` — the same window for one
    creative, plus its hour-of-day profile and its lifetime figures.

  The page itself (`docs/stats.html`, `docs/assets/stats.js`) draws a column
  chart per hour, day or month — picked from the span — with a hover tooltip,
  a "Show the numbers" table underneath for anything the chart does not serve,
  a KPI row, and a sortable-by-opens table of every creative with its share and
  its last open. Clicking a row opens that creative on its own. Both the range
  and the open creative live in the query string (`?range=thisMonth`,
  `?type=timer&id=TMR-01`), so a view can be linked to someone.

  Reached from the profile menu, from a new card on `/tools`, and from a
  **Stats** button on every card in the template library and the timer library.

### Changed

- **The studio's own previews no longer count as opens.** The template grid and
  the timer library load the same public render endpoints an email does — which
  is the point, it is how what you see is provably what the inbox gets — so
  without a marker, opening a library would have counted as an open of every
  creative in it. The UI now appends `we_preview=1` to the URLs it loads for
  itself and `src/lib/preview.js` skips counting those. It is not a security
  boundary and does not need to be: the worst case is a number that is too low.
  `we_preview` is also reserved on the timer endpoint, so it never reaches a
  creative as a template variable.

- The template library card's action row wraps instead of squeezing, now that
  it carries a fourth button.

### Database

- **New table `asset_opens`** — one row per creative per hour, not one per
  open: a campaign send is millions of image fetches, and a row each would make
  this the largest table in the database within a week. An hour is fine enough
  to draw a day's shape and coarse enough that a creative costs 24 rows a day.

  ```
  asset_type ENUM('template','timer'), asset_id VARCHAR(100),
  bucket_hour DATETIME (UTC), opens INT UNSIGNED, last_open_at DATETIME
  PRIMARY KEY (asset_type, asset_id, bucket_hour)
  ```

  Created automatically on boot by `ensureStatsSchema()` in `src/db/schema.js`;
  the matching SQL is `migrations/005_asset_opens.sql` for a manual run. No
  backfill is possible — counting starts the first time the new build serves an
  image.

  Deleting a template or a timer now deletes its counters with it, so a removed
  creative does not sit on the stats page forever.

### Architecture

- **Counting never blocks a response.** `trackOpen()` in
  `src/services/openCounter.js` increments a number in a Map and returns; a
  timer drains the Map into one batched
  `INSERT … ON DUPLICATE KEY UPDATE opens = opens + VALUES(opens)` every
  `STATS_FLUSH_SECONDS` (15 by default), and `server.js` drains it once more
  during graceful shutdown. A worker killed mid-interval loses at most one
  interval of counts — the right trade for a figure whose job is "which
  creative is working", which is never an invoice. A failed flush goes back
  into the buffer and merges with whatever arrived meanwhile; `STATS_BUFFER_LIMIT`
  caps what an outage can accumulate.

- **The reader's calendar, not the server's.** "This month" means the month
  where the person looking at the page lives, so the browser sends the two ends
  of the window plus its UTC offset, and the stored UTC buckets are shifted by
  that offset at query time. One stored row therefore serves a reader in any
  timezone and nothing about a region is stored. Window ends are deliberately
  *not* rounded to whole hours: a bucket belongs to the local day its start
  falls in, so in a half-hour zone (IST is +5:30) rounding local midnight back
  to the previous whole UTC hour grows a stray column for a day nobody asked
  about.

- **Timestamps cross the driver as explicit UTC strings, never Date objects**
  (`src/lib/utcTime.js`). The pool sets no `timezone`, so mysql2 would
  otherwise serialise a Date through the *process's* local zone and read it
  back the same way — consistent on one machine, and wrong the moment a
  deployment's TZ differs from a developer's.

### Fixed

- **An unmatched `/api` path answers with JSON, not with a page.** Express's
  default 404 is an HTML document, and every caller in this app does
  `await response.json()` — so a missing endpoint surfaced as
  `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`, which names the
  symptom and hides the cause. The cause is almost always a server running a
  build from before the endpoint existed. `src/app.js` now ends with a JSON
  404 scoped to `/api`, and the stats page reads its responses through a
  helper that says so in as many words: *"The server has no
  /api/v1/stats/overview endpoint. It is running a build from before Open
  Stats existed — restart it (npm start), or redeploy."*

### Known limits

- **Dynamic-image opens are counted per distinct URL, not per open.** The
  render endpoint answers with `Cache-Control: immutable`, so Gmail's proxy and
  every CDN in between fetch a given URL once and serve their copy to everyone
  after that. Because those URLs are personalised per recipient, the count is
  close to "recipients who opened at least once" rather than a true open count.
  Countdown timers have no such gap — they go out `no-store` by necessity, so
  every open reaches this server and is counted.

### Added

- **"Open to view" in the timer library**, so anyone can see how a timer was
  put together even when it is not theirs to change. The builder is the only
  place the full configuration is legible — deadline, timezone, units, fonts,
  backplate, expired state — so it doubles as the viewer: the card's first
  button opens the timer either way and reads `Edit` or `Open to view`
  depending on who you are.

  `setReadOnly()` in `docs/assets/timers.js` disables all 44 controls in the
  builder and hides the drag handle, leaving four that still make sense on
  someone else's timer: `New`, `Play the real GIF`, `Copy snippet` and
  `Copy URL`. A banner names the owner and says what you can still do. Leaving
  read-only hands the last word back to `syncConditionalFields()`, because some
  controls are disabled for reasons of their own — Frames is off whenever
  looping is on — and a blanket re-enable would undo that.

- **Templates are owned too, on the same rule as timers: creator or admin.**
  `POST /api/v1/templates` refuses to overwrite a template the caller did not
  create (making a new one stays open to anyone), and
  `POST /api/v1/templates/:id/delete` moves from admin-only to owner-or-admin,
  so the person who made a template can finally clean up after themselves.
  `GET /api/v1/templates` returns `created_by`, `created_by_name` and a
  computed `canEdit` per row.

  The studio goes **read-only** when you open someone else's: `setReadOnly()`
  in `docs/index.html` disables every input, select, textarea and button in the
  workspace, switches off dragging and resizing on the canvas, disables the
  per-layer buttons each time the list is rebuilt, and explains itself in a
  banner. Three controls stay live, because they still make sense on a template
  that is not yours — `+ New`, `Generate Render URL` and `Copy`. The library
  card says who made it, labels it `view only`, and its button reads
  `Open to view` instead of `Edit in Studio`.

  The list cache needed care: it is shared between users, so only the rows go
  into Redis and `canEdit` is stamped on per request afterwards. Caching the
  per-viewer answer would have handed the first caller's permissions to
  everyone else for the next five minutes. The key is versioned
  (`templates_all_v2`) because the cached shape changed when the author joined
  the row.

- **Timers are owned: the creator or an admin may change one, everyone else
  can only look.** Until now any signed-in member could overwrite any timer —
  the save is an upsert keyed on the id, so retyping somebody else's timer id
  silently replaced a creative that live campaigns were pointing at — while
  deleting was admin-only, so the person who made a timer could not clean up
  after themselves. Both ends were wrong, in opposite directions.

  `canManage(user, createdBy)` in `src/middleware/guards.js` is the one rule:
  owner, or admin. It reads the role from the database rather than the session
  for the same reason `resolveAdmin` does — a cookie issued before a promotion
  or after a demotion would otherwise carry the old answer for up to seven
  days. A row with no `created_by` predates ownership being recorded and falls
  through to the admin check, because the safe reading of "nobody claims this"
  is "not yours".

  Applied in `src/routes/timer.routes.js`: `POST /api/v1/timers` refuses to
  overwrite a timer the caller does not own (creating a new one is open to
  anyone), and `POST /api/v1/timers/:id/delete` moves from admin-only to
  owner-or-admin. The ownership lookup runs before the delete so a caller who
  may not touch the row is told so instead of getting a misleading 404.
  `GET /api/v1/timers` now returns `created_by`, `created_by_name` and a
  computed `canEdit` per row, so the browser never re-derives the rule — it is
  the same answer the write endpoints will give. The role is looked up once for
  the whole list, not once per row.

  The library hides Edit and Delete on a timer you cannot change and captions
  the card `by <name> — view only`; Copy URL stays for everyone, which is what
  "view" means for a timer. The creator is a `LEFT JOIN` so a timer outlives
  the account that made it rather than vanishing from everyone's library.

  **Templates have the same hole and are not covered by this.**
  `POST /api/v1/templates` is open to any member and the table has no
  `created_by` column, so fixing it needs a migration plus a decision about
  what the existing ownerless rows should mean.

- **Backplate can stop at the digits, leaving the unit labels on the creative.**
  A `Plate covers the unit labels` checkbox in the Backplate group, stored as
  `style.plate.coverLabels` and overridable per URL with `?platelabels=0`. It
  applies to both plate modes — one panel behind the whole clock, or a tile per
  unit — and defaults to true, which is the shape every existing timer already
  has, so nothing saved before this changes.

  `plateRects` in `src/services/countdown/layout.js` measures the plate to
  `layout.digitHeight` instead of `layout.height` when it is off. On its own
  that was not enough: the plate still extends `padY` past the digits, and the
  labels — measured from the digits — landed on that overhang. So `buildLayout`
  now measures the label gap from the plate's bottom edge in this mode, which
  keeps `labelGap` meaning "the space you can see" in both. Verified by
  rendering: plate height 83px covering labels, 64px not, identical when labels
  are off entirely.

- **`RATE_LIMIT_ENABLED=false` bypasses every per-IP limit, for load testing.**
  A load generator runs from one address, so it trips a per-IP limit within
  seconds and the run then measures the limiter instead of the service. The
  flag is read per request rather than at wiring time, so the middleware stays
  in the chain either way and a load test differs from production in behaviour
  only, not in route composition. The concurrency limiter
  (`RENDER_CONCURRENCY` / `RENDER_QUEUE_LIMIT`) is deliberately untouched by
  it — that is usually the thing worth measuring. Left on by accident this is
  an open door, so `src/server.js` prints a warning on every boot while it is
  set. Documented in `.env.example`.

- **Per-IP rate limiting** (`src/middleware/rateLimit.js`), counted in Redis so
  the limit is the cluster's and not each worker's, and **failing open** when
  Redis is unreachable — an outage of the counting layer must not become an
  outage of the service. Fixed windows, one `INCR` per request. Two ceilings,
  because the callers are nothing alike:

  - `GET /api/v1/timer/:id.gif` — **600 per minute** (`RATE_LIMIT_GIF`). Set
    high on purpose. Gmail fetches every recipient's copy through a small pool
    of Google addresses and a corporate network puts a whole office behind one
    address, so a single IP legitimately accounts for an entire send; a low
    limit here would throttle real campaigns long before it ever caught an
    attacker. A refusal returns **429 with a blank GIF**, never JSON — a JSON
    body renders as a broken-image icon in somebody's inbox.
  - `POST /api/v1/auth/otp/send`, `/register`, `/login` — **10 per minute**
    (`RATE_LIMIT_AUTH`). `OTP_RESEND_COOLDOWN_SECONDS` already spaced out
    resends, but it is keyed on the phone number, so a script walking a list of
    numbers never tripped it and every attempt sent a real message at real
    cost. Nothing limited password guesses at all.

  Tunable through `RATE_LIMIT_GIF`, `RATE_LIMIT_AUTH` and
  `RATE_LIMIT_WINDOW_SECONDS`. Responses carry `X-RateLimit-Limit`,
  `X-RateLimit-Remaining` and, on a 429, `Retry-After`.

### Database

- **`WEB-01` assigned to Shubham Kadam (id 7, `shubhamkadam2801@gmail.com`)**,
  its author. Worth noting for anyone reading later: there are two accounts
  under that name — id 1 on `@webengage.com`, which is the admin, and id 7 on
  gmail. This template belongs to the second. All three templates now have a
  recorded owner, so nothing falls back to the admin-only rule.

- **`WEB-02` and `WEB-03` assigned to Bhavya Gupta (id 5)**, who created them;
  `WEB-01` is still unclaimed and therefore admin-only. The cached template
  list was cleared so the change showed immediately rather than after the
  five-minute TTL.

- **`templates.created_by`** (`INT UNSIGNED NULL`), added by the idempotent
  migration in `src/db/schema.js` — it runs on boot, so no separate command.
  Deliberately **not backfilled**: the three rows that predate it have no
  recoverable author, and inventing one would grant edit rights nobody gave.
  `canManage` treats a null owner as admin-only, so WEB-01, WEB-02 and WEB-03
  are admin-editable until somebody claims them. To hand one to its real
  author: `UPDATE templates SET created_by = <user id> WHERE template_id = '…'`.

### Changed

- **Dragging the clock in the timer builder now moves the clock.** The preview
  is one flat image with the timer already drawn into it, so there was nothing
  to pick up: the handle slid away as an empty dashed rectangle while the timer
  stayed where it was, and you placed it blind. The handle now carries the crop
  of the preview it covers — set as its background, offset by the block's
  position — so the pixels under the cursor are the clock, complete with the
  patch of creative behind it. The image underneath is dimmed to 35% so the
  copy still drawn at the old position recedes rather than competing.

  Smoothness came from two changes: the handle moves by `transform` instead of
  `left`/`top`, so a drag composites instead of re-running layout on every
  pointer event; and the update is deferred to `requestAnimationFrame`, so a
  burst of pointermove events between two frames collapses into the one update
  that is actually seen.

  The crop, the dimming and the transform are all held from pointerup until the
  new preview lands — cleared in `renderPreview`'s `finally`, so a failed
  preview cannot leave them stuck on. Releasing them at pointerup would snap
  the clock back to its old position for the length of the round trip. The
  grabbing cursor is a separate class and reverts immediately.

- **Saving in the Dynamic Images builder now confirms with a toast**, bottom
  right, the same as the timer builder — the confirmation belongs next to the
  button you just pressed, not in a panel you may have scrolled away from. The
  inline `#alert` banner still handles loading, deleting and the rest.

  While moving it: a rejected save used to say nothing at all. Only
  `response.ok` was handled, so a 4xx left the page looking like the template
  had been stored. It now surfaces the server's error, and a network failure
  says the template was not saved rather than failing silently.

### Architecture

- **One toast, shared.** The implementation was written inline in
  `docs/timers.html` and would have had to be copied to use it anywhere else.
  The styles moved to `.toast` in `docs/assets/theme.css` and the behaviour to
  `window.toast(message, kind)` in `docs/assets/shell.js`, which creates its
  own node on demand — a page opts in by calling it, with no markup to
  remember. `docs/assets/timers.js` calls through to it and its local copy is
  gone.

### Security

- **The public render endpoint was a server-side request forgery hole.** A
  template can use a placeholder as an image source — WEB-01's second layer is
  `src: "{{image}}"` — so `?image=…` was a URL the caller chose and this server
  fetched, with no validation anywhere in that path. Not the blind kind either:
  the response is composited into the PNG the caller gets back, so anything
  image-decodable on the private network was readable from the open internet.
  Reproduced locally before the fix: `?image=http://127.0.0.1:3000/api/v1/timer/TMR-01.gif`
  returned a 108KB PNG with the internal content drawn into it, against 61KB
  for a normal render.

  New `src/lib/urlGuard.js` refuses anything that is not http(s), carries
  credentials, or resolves to a loopback, private, link-local, CGNAT,
  multicast or reserved address — every address the name resolves to, not just
  the first. IPv4-mapped IPv6 is unwrapped and checked as IPv4, which matters
  because `new URL()` rewrites `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]` and a
  regex looking for dotted quads walks straight past it. Redirects are followed
  by hand, three hops maximum, with every hop validated — a public host that
  302s to an internal one would otherwise step around a check done only on the
  URL the caller typed.

  The check runs **before the image caches, not next to the fetch**. The caches
  sit in front of the fetch, so a URL allowed once would keep being served for
  as long as its bytes lived, whatever the rules said afterwards — and anything
  cached before the guard existed would have stayed readable. Verdicts are
  memoized for `IMAGE_GUARD_TTL_MS` so this does not cost a DNS lookup per
  render, refusals included, so a loop on blocked hosts cannot turn the
  endpoint into a DNS amplifier.

  `IMAGE_HOST_ALLOWLIST` is empty by default, meaning any public host. Setting
  it is strictly stronger and is the only thing that fully closes DNS
  rebinding — the residual risk is written down at the top of `urlGuard.js`
  rather than left implicit.

- **The render endpoint had no rate limit and an unbounded cache key.** Hashing
  the whole query string meant `?junk=1`, `?junk=2`, `?junk=3` were three cache
  entries producing three identical images, so a caller could force unlimited
  fresh composites — measured at 4.5s each on the live instance — simply by
  counting, filling Redis on the way. It now keys on the placeholders the
  template actually contains, the same reduction `cacheVars` has done on the
  timer path since it was written. Junk parameters collapse onto one entry:
  `?city=d&junk=1..3` all return `HIT-REDIS` where each was a `MISS` before.
  `RATE_LIMIT_RENDER` (600/min per IP) closes the rest.

- **No size cap or timeout on a fetched image.** `arrayBuffer()` buffered
  whatever arrived from a URL the caller picked, and the 10s `timeout` option
  in `images.js` was node-fetch syntax that Node's built-in fetch silently
  ignores — so there was no timeout at all and a slow remote held a render slot
  indefinitely. Now `AbortSignal.timeout`, plus `IMAGE_MAX_BYTES` checked
  against `Content-Length` and enforced again while reading, because a remote
  is under no obligation to send that header or to be honest in it.

### Removed

- **`documents/`, `migrations/`, `nodee.html` and two dead scripts are no
  longer in the repository.** `documents/` and `migrations/` are now
  git-ignored and kept local: the notes name hosts and instance plans, and the
  SQL is a record of a schema `src/db/schema.js` already creates for itself on
  boot. Nothing there is read at runtime, so a fresh clone still starts — but
  it also no longer carries the deployment write-up, which is the trade.

  Deleted outright: `nodee.html`, an unrelated "Credit Card Offers" page at the
  repo root that nothing referenced; `scripts/migrate-templates-to-json.js`,
  the one-off that emptied `template_elements` (that table is gone, and
  schema.js has its own backfill, so it could only no-op); and
  `scripts/single-thread.js`. The dead `npm run migrate` entry went with them.

  `scripts/` keeps `load-test.yml` and `load-test-processor.js`, which pair
  with the `RATE_LIMIT_ENABLED` switch.

### Fixed

- **A read-only timer could not be read.** `setReadOnly` disabled every button
  in the builder, and the collapsible section headers are buttons — so Labels,
  After it ends and Advanced, all three of which start collapsed, were sealed
  shut for exactly the person who had opened the timer to look at them. Group
  headers are disclosure rather than editing and are now left alone.

  The same pass also swapped `disabled` for `readonly` wherever the input type
  supports it — 26 of the 48 controls. A disabled field is washed out and
  cannot be focused or selected, which is the right signal for an action you
  cannot take and the wrong one for a setting you came to read; readonly keeps
  the value legible and copyable while still refusing edits. The 22 that cannot
  be readonly (selects, checkboxes, colour swatches) stay disabled but are
  styled at full contrast in read-only mode, since browsers fade them at the
  engine level.

- **Registration errors are shown on screen again.** `requestCode` in
  `docs/login.html` called `showAlert` with the server's reason and then
  `switchMode('register')`, and `switchMode` starts with `clearAlert()` — so
  the message was wiped in the same tick it was written. "An account with this
  mobile number already exists" only ever reached the network tab, and the form
  looked like it had silently done nothing. It now calls `showStep`, which
  changes the pane without touching the alert box.

- **Opening the timer library no longer flashes the builder first.**
  `view-builder` was marked active in the markup and corrected from
  `DOMContentLoaded`, so arriving at `?view=library` painted the whole builder
  before the script that knew better had run. The view is now chosen by the
  inline script in `docs/timers.html`'s head — before the body is parsed — as
  `data-view` on `<html>`, with CSS selecting on it. `switchView()` sets the
  same attribute, so the initial render and later switches share one mechanism
  and cannot disagree.

- **`trust proxy` was never set** (`src/app.js`), so `req.ip` was Render's edge
  address for every request on earth. Nothing depended on it until now, but any
  IP-keyed limit added without this would have counted the entire internet in
  one bucket and locked everybody out on the first flood. `clientIp()` prefers
  `CF-Connecting-IP`, which that edge rewrites on every request and a caller
  therefore cannot forge; `X-Forwarded-For` is only a hint, since it is
  client-supplied up to the first proxy that overwrites it.

- **The timer URL handed to a campaign is now unique per recipient.** The embed
  snippet and both Copy URL buttons only appended `?uid={{user.id}}` for
  evergreen timers; a fixed-deadline timer went out as one bare URL for the
  whole send. Gmail does not fetch the image from this server — it fetches it
  once through `googleusercontent.com` and serves that copy to every recipient,
  keyed on the URL. One URL for a send is therefore one frozen clock for the
  send: it shows whatever the proxy happened to fetch, and it only moves when
  something forces a re-fetch, at which point it moves for everybody at once.
  `embedUrl()` in `docs/assets/timers.js` now always carries the placeholder,
  and the hint under the snippet says why it has to stay.

  This costs nothing on the server: `uid` is in `RESERVED_QUERY_KEYS` so it
  never becomes a template variable, and `renderTimer` only reads it for
  evergreen timers, so it is not part of the response cache key. Distinct
  recipients still share one encode per second — measured at 389ms for the
  first URL and 32ms for the next, which is the sprite bundle being reused.

  Note what this does *not* fix: nothing can make an email client re-fetch on
  every open. The endpoint already sends `no-store` and renders fresh bytes on
  every request (verified against the deployment: two fetches three seconds
  apart return different ETags and a lower `X-Timer-Remaining`, and a
  conditional request with a stale ETag gets a `200`, never a `304`). Clients
  that honour those headers show a live clock; Gmail's proxy applies its own
  TTL regardless. For a reader sitting on the message the animation itself is
  the answer: with `loop` on and seconds among the units, the seconds column
  runs a full 59→00 cycle and stays exactly correct no matter how long the
  cached copy is watched, because `(s - k) mod 60` is what a real clock reads
  `k` seconds later. Only minutes and above drift. See the comment on
  `buildGif` in `src/services/countdown/index.js`.

- **API calls from the GitHub Pages site reach the API.** Every request was
  written as a bare `/api/v1/...`, which resolves against whichever host loaded
  the page — so on Pages, sending a login OTP posted to
  `https://ishubh-10.github.io/api/v1/auth/otp/send`, a host with no backend
  behind it, and nothing on the site worked past the login form.
  `docs/assets/origin.js` now also exports `apiUrl(path)`, which is same-origin
  when the app itself is serving the page (or on localhost) and the deployed
  origin otherwise. Everything routes through it:
  `apiFetch` in `docs/assets/shell.js` (which covers all but four calls),
  `postJson` and the auth-status probe in `docs/login.html`, logout and
  logout-everywhere, and the template preview `<img>` in `docs/index.html`.
  Requests that cross an origin now send `credentials: 'include'` — `same-origin`
  would have dropped the session cookie.

- **The front end is served again, and its stylesheets load on GitHub Pages.**
  Two separate faults, both from the `public/` → `docs/` rename:

  1. `PUBLIC_DIR` in `src/config/index.js` still resolved to `public/`, a folder
     that no longer exists, so `express.static` had nothing to serve and every
     page and asset on the Node deployment returned 404. It now points at
     `docs/`, and that constant remains the only place the folder is named.
  2. Every page linked its assets as `/assets/theme.css` — a leading slash,
     meaning the domain root. On GitHub Pages the site lives under
     `https://ishubh-10.github.io/webengage-studio/`, so the browser asked for
     `https://ishubh-10.github.io/assets/theme.css` and got the 404 page;
     `theme.css`, `shell.css`, `shell.js`, `origin.js` and `timers.js` all
     failed together and the site rendered as unstyled HTML. Assets and
     page-to-page links are now relative (`assets/theme.css`, `tools.html`), so
     the same files work under any base path.

- **Copyable links now point at the deployed service instead of `localhost`.**
  The render URL (`public/index.html`), the generated-URL preview
  (`public/index.html`) and the timer GIF embed (`public/assets/timers.js`) were
  all built from `window.location.origin`, so anything copied from a developer
  machine read `http://localhost:3000/...`. Pasted into a campaign it renders
  nothing in the recipient's inbox — a failure that only shows up after the send.
  They now build on `publicUrl()`.

### Architecture

- **Pages link to each other by filename, and the server redirects to the
  canonical path.** `docs/*.html` and `docs/assets/shell.js` now use
  `tools.html`, `index.html`, `timers.html`, `admin.html` and `login.html`
  instead of `/tools`, `/studio` and so on, because a relative link is the only
  form that survives being served from a sub-path. `CANONICAL_PAGE_PATHS` in
  `src/app.js` maps each filename back to its guarded route (`/tools.html` →
  `/tools`), query string intact, so the pretty URLs stay canonical on the Node
  deployment.

- **No HTML page is served from a nested URL.** `/tools/dynamic-images` and
  `/tools/countdown-timers` in `src/routes/page.routes.js` used to `sendFile`
  the page directly; a page returned from a nested path resolves its relative
  asset URLs against `/tools/`, which would put the stylesheets back at 404.
  They redirect to `/studio` and `/timers` instead.

- **One place knows the public origin:** `public/assets/origin.js`, which exports
  `PUBLIC_ORIGIN` (`https://webengage-studio.onrender.com`) and `publicUrl(path)`
  on `window`. It is loaded before every other script on all five pages. If the
  service ever moves, change that one constant; do not reintroduce
  `window.location.origin` for a URL a user is meant to paste elsewhere.

### Security

- **The session cookie is `SameSite=None; Secure` in production, and CSRF is
  now enforced by an Origin check.** The two changes go together and neither
  should be undone alone.

  A `SameSite=Lax` cookie is not sent on a cross-site request, so a user signed
  in on the GitHub Pages site looked signed out on every call to the API. `None`
  fixes that — and switches off the CSRF protection the browser was providing
  for free. CORS does not fill the gap: it governs who may *read* a reply, not
  who may send a request, and a form post or a bodyless `fetch` is a simple
  request that is never preflighted. Two endpoints were reachable that way,
  `POST /api/v1/auth/users/:id/delete` and `/api/v1/templates/:id/delete`.

  New `requireTrustedOrigin` (`src/middleware/origin.js`, wired in
  `src/app.js` ahead of body parsing) rejects any non-`GET`/`HEAD`/`OPTIONS`
  request whose `Origin` header is set and not in `CORS_ORIGINS`. A request with
  no `Origin` is passed through: browsers always send it on a state-changing
  request, so its absence means a non-browser client, which has no cookie to
  ride on.

  `SameSite=None` requires `Secure`, which a browser will not accept over plain
  http, so `src/services/sessions.js` keeps `Lax` when `NODE_ENV` is not
  `production`. **This means the Node deployment must run with
  `NODE_ENV=production` or signing in from the Pages site will silently fail.**
  Note also that a cookie set by `onrender.com` on a request that
  `github.io` started is a third-party cookie: Safari blocks those by default,
  and Chrome's tracking protection blocks them in Incognito. Serving the front
  end from the same origin as the API avoids the whole class of problem.

- **Page filenames no longer bypass the session guards.** `express.static`
  served `docs/admin.html`, `tools.html` and `timers.html` verbatim to anyone
  who asked for the filename — only `/index.html` had a redirect in front of it —
  so the admin UI shell was reachable without a session. The
  `CANONICAL_PAGE_PATHS` redirects in `src/app.js` are registered before the
  static middleware, so each filename is now routed through `requireAuthPage` or
  `requireAdminPage`.

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

- **The Render Key Value instance's internal URL is a production fallback in
  code** (`src/config/redis.js`). `REDIS_URL` was never set on the running
  service, so nothing pointed at the cache. `RENDER_KEY_VALUE_URL`
  (`redis://red-dajaiobm8hqs73fhlnf0:6379`) now applies when `NODE_ENV=production`
  and none of `REDIS_URL` / `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` is
  set, so a service created by hand rather than from `render.yaml` still finds
  its cache. It is an internal hostname that resolves only inside this Render
  account's private network, with no public access and no password, so it is a
  location rather than a credential. Setting `REDIS_URL` in the service
  environment still overrides it, and remains the better place for it: moving
  the instance then costs a variable edit instead of a deploy. The default is
  deliberately production-only — outside it, a local `redis-server` on
  127.0.0.1 keeps working.

- **`GET /health` distinguishes a Redis that is off from one that is down**
  (`src/routes/health.routes.js`). `redis` now reports `disabled` when none was
  configured — a deliberate in-memory-only run — alongside the existing
  `connected` and `disconnected`. `disconnected` is the one worth alerting on:
  it means a Redis is configured and unreachable.

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

- **A missing `REDIS_URL` no longer floods the logs with `ECONNREFUSED`**
  (`src/config/redis.js`, `src/lib/invalidation.js`). With no Redis configured
  the client fell back to `127.0.0.1:6379`, and inside a container there is
  never a Redis on localhost — so every worker retried twice a second, forever,
  and the invalidation subscriber did the same on a second connection. A healthy
  deploy's log was thousands of identical `⚠️ Redis error: connect ECONNREFUSED
  127.0.0.1:6379` lines with nothing else visible between them. Three changes:

  - With `NODE_ENV=production` and none of `REDIS_URL` / `REDIS_HOST` /
    `REDIS_PORT` / `REDIS_PASSWORD` set, Redis is switched off deliberately
    rather than attempted: one warning naming the variable to set, and the app
    runs on its in-memory caches. Outside production the localhost default
    stands, because a developer running `redis-server` expects it to be tried.
  - Connection errors are logged through a throttle that prints the first of
    each distinct message and then one summary per minute with the suppressed
    count, so a genuine outage is still visible but cannot bury the log. A
    connection that drops after being up says so once.
  - The retry backoff goes to 30s instead of capping at 2s. Reconnecting twice a
    second to a host that is down buys nothing and costs a log line each time.

  `createClient()` now returns `null` while Redis is off, and `initInvalidation()`
  returns early instead of opening a doomed subscriber. Every cache read was
  already guarded by `redisState.connected`, so behaviour with Redis down is
  unchanged — only the noise is gone.

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

### Changed

- **Every MySQL connection detail now comes from the environment**
  (`src/config/index.js`, `src/config/db.js`). `db.js` had the host, user,
  database — and the password `qwer1234` — written into it as fallbacks, so the
  credential was in the repository and moving the app to another database meant
  editing source. The new `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`,
  `DB_NAME`, `DB_SSL` and `DB_SSL_CA` are read in `config/index.js` with the rest
  of the tunables and destructured by the pool.

  `DB_PORT` is the reason this came up: managed MySQL multiplexes many databases
  behind one address and rarely listens on 3306. The app now points at Railway
  (`tramway.proxy.rlwy.net:39120`, database `railway`) — with the port missing,
  mysql2 quietly dials 3306 and the pool fails with `ETIMEDOUT` while a direct
  connection on the right port works, which is a confusing way to lose an hour.

  `DB_CONNECT_TIMEOUT_MS` is new alongside it, defaulting to 20s against
  mysql2's 10s. A database behind a provider's public TCP proxy takes seconds to
  complete a handshake (Railway: ~2.5s from a laptop) where a local one takes
  milliseconds, and the slowest case is a cold worker's first connection.

  `DB_SSL` takes `true` (verify against the system CA store), `skip-verify`
  (encrypt without verifying, for self-signed certificates) or nothing at all
  for a local server; `DB_SSL_CA` points at a provider's `.pem` instead. In
  production the pool now logs which database it connected to and whether TLS is
  on.

- **Redis accepts a single `REDIS_URL`** (`src/config/redis.js`), since that is
  how every hosted instance hands over its connection — `rediss://` for TLS from
  outside the provider's network. The `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`
  trio still applies when the URL is unset, so a local install is unaffected.

### Breaking

- **A deployment with a password-protected database must now set `DB_PASSWORD`.**
  It used to fall back to the developer password baked into `src/config/db.js`;
  there is no fallback any more and the pool will simply fail to authenticate.
  Copy the MySQL block from `.env.example` into `.env` (or into the host's
  environment panel) before restarting. Treat the old `qwer1234` as public — it
  has been in the repository's history — and rotate it anywhere it is still
  in use.

### Added

- **Render deployment**: a blueprint at [`render.yaml`](render.yaml) and the
  walkthrough in [`docs/deploy-render.md`](docs/deploy-render.md). The blueprint
  declares the web service and a Key Value (Redis) instance and wires `REDIS_URL`
  between them; MySQL stays with an outside provider, because Render hosts
  Postgres and Key Value and no MySQL.

  [`docs/render-redis.md`](docs/render-redis.md) covers the Redis half on its
  own, for a service whose repository is already connected: creating the Key
  Value instance, which of the two URLs to use, the full environment list, and
  what each cached thing costs when the instance empties.

  Two things the doc exists to stop people rediscovering: `WORKERS` must be set
  explicitly, because `os.cpus()` inside a container reports the host's cores and
  the master would fork eight workers onto half a CPU; and a free Key Value
  instance has no persistence, which the app survives — it falls back to memory —
  at the cost of in-flight OTPs, evergreen timers' first-open timestamps and the
  logout deny-list.

### Database

- **Full schema dump for a one-shot import**:
  [`migrations/personalize_studio_schema.sql`](migrations/personalize_studio_schema.sql).
  The numbered migrations are incremental and assume you apply them in order,
  which is awkward when someone just wants the database standing up in MySQL
  Workbench. This file is structure-only (no rows) and carries `users`,
  `templates` and `timers` together, plus `CREATE DATABASE IF NOT EXISTS
  personalize_studio`, so it can be imported through **Server ▸ Data Import ▸
  Import from Self-Contained File** or run directly:

  ```
  mysql -u root -p < migrations/personalize_studio_schema.sql
  ```

  Every statement is `IF NOT EXISTS` rather than the `DROP TABLE` a strict
  mysqldump emits, so pointing it at an existing database is a no-op instead of
  wiping it. It also skips mysqldump's `@OLD_SQL_MODE` save/restore preamble:
  those user variables are session-scoped, so running only part of the file —
  selecting a block of statements in the Workbench SQL editor — reached the
  restore with the variable unset and failed with *Variable 'sql_mode' can't be
  set to the value of 'NULL'* (error 1231). The file is generated from
  `src/db/schema.js` by hand — keep the two in step when a table changes.

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
