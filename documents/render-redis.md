# Adding Redis on Render (and finishing the deploy)

Starting point: the GitHub repository is already connected to a Render **Web
Service**, and MySQL lives on **Railway** — Render hosts Postgres and Key Value
and no MySQL, so the database stays where it is and the app reaches it over the
public internet.

This is the Redis half plus the environment the service needs to boot. The
broader deployment notes are in [deploy-render.md](deploy-render.md).

---

## 1. What Redis is doing here

It is a cache with a soft fallback: `src/config/redis.js` keeps serving from the
per-worker in-memory caches when Redis is unreachable, so a Redis outage
degrades the app rather than stopping it. What actually lives there:

| Key | Purpose | Lost if Redis empties |
| --- | --- | --- |
| Template and timer rows | Keeps the hot path off MySQL — one lookup per email open | Nothing; refetched from MySQL |
| Timer sprite bundles | Palette, quantised background, digit tiles. ~450ms to build, ~7ms to serve | Nothing; rebuilt on demand |
| Rendered GIF/PNG responses | Two opens of the same campaign in the same second get identical bytes | Nothing |
| Registration OTPs | The 4-digit code, until it is used or expires | **Yes** — a code someone is typing stops working |
| Evergreen first-open timestamps | When a recipient first opened an evergreen timer | **Yes** — their countdown restarts from full |
| Logout deny-list | Session ids revoked before their 7 days are up | **Yes** — revoked sessions work again |
| Cross-worker invalidation | Pub/sub, so a save in one worker clears the others' memory caches | Nothing |

The last one is why `src/config/redis.js` exposes `createClient()`: a connection
in subscriber mode cannot run ordinary commands, so the invalidation listener
opens a second connection of its own. Both come from the same `REDIS_URL`, so
nothing extra has to be configured for it.

## 2. Create the Key Value instance

Dashboard ▸ **New ▸ Key Value**.

| Setting | Value | Why |
| --- | --- | --- |
| Name | `webengage-studio-cache` | Referenced by `render.yaml` |
| Region | **The same region as the web service** | The internal `redis://` URL only resolves inside one region's private network |
| Plan | Starter or larger | `free` has no persistence at all — a restart empties it, taking OTPs, evergreen timestamps and the deny-list with it |
| Maxmemory policy | `allkeys-lru` | Everything stored has a TTL; when memory fills, evict the coldest key instead of refusing writes |
| IP allow list | leave **empty** | Empty means no public access — only services on this account's private network can reach it, which is all the app needs |

When it finishes provisioning, its page shows two URLs:

- **Internal** `redis://…` — use this one. Private network, no TLS needed, lower
  latency, no allow list to manage.
- **External** `rediss://…` — only for reaching it from outside Render, and only
  after adding your IP to the allow list. `src/config/redis.js` handles either.

## 3. Set the environment on the web service

Service ▸ **Environment** ▸ Add. There is no `.env` in the deploy — the file is
gitignored, which is the point; these values come from the dashboard.

```
NODE_ENV=production
NODE_VERSION=22.12.0
WORKERS=1

SESSION_SECRET=<openssl rand -base64 32>

REDIS_URL=<the internal redis:// URL from step 2>

DB_HOST=tramway.proxy.rlwy.net
DB_PORT=39120
DB_USER=root
DB_PASSWORD=<Railway ▸ MySQL ▸ Variables ▸ MYSQL_ROOT_PASSWORD>
DB_NAME=railway
DB_SSL=skip-verify
DB_POOL_TOTAL=30

WEBENGAGE_API_KEY=<from the WebEngage dashboard>

AWS_REGION=…
AWS_ACCESS_KEY_ID=…
AWS_SECRET_ACCESS_KEY=…
S3_BUCKET_NAME=…
```

Four of those are not obvious:

- **`DB_PORT`** — Railway's public proxy multiplexes every database behind one
  hostname, so the port is the only thing identifying yours. Miss it and mysql2
  silently dials 3306 and times out.
- **`DB_SSL=skip-verify`** — the connection crosses the public internet, so it
  must be encrypted, but Railway serves the certificate MySQL generates for
  itself and no public CA signs it. `DB_SSL=true` fails there with *self-signed
  certificate in certificate chain*; `skip-verify` keeps the encryption and drops
  the verification.
- **`WORKERS`** — without it, `src/server.js` forks `os.cpus().length` workers,
  and inside a container `os.cpus()` reports the **host's** cores. On a starter
  instance that is eight workers on one shared CPU, each with its own MySQL pool
  and its own copy of every cache. Use 1 on starter, 2 on standard, 4 on pro.
- **`DB_POOL_TOTAL`** — Railway's MySQL allows 151 connections in total, and your
  laptop is using some of them. 30 for the whole Render cluster leaves room.

**`PORT` is set by Render — do not add it.** `SESSION_SECRET` is mandatory:
with `NODE_ENV=production` the master refuses to start without one, because the
old in-repo fallback let anyone who could read the source mint an admin session.

## 4. Build and start

Service ▸ Settings:

| Setting | Value |
| --- | --- |
| Build command | `npm ci --include=optional` |
| Start command | `npm start` |
| Health check path | `/health` |

`--include=optional` is not optional in practice: sharp ships one prebuilt
binary per platform as an optional dependency, and a lockfile written on a Mac
can leave Render's Linux build without `@img/sharp-linux-x64`.

## 5. Deploy and check

Push to the connected branch, or **Manual Deploy ▸ Deploy latest commit**. A
healthy boot log contains:

```
🗄️ MySQL root@tramway.proxy.rlwy.net:39120/railway (TLS on)
🗄️ MySQL pool: 30 connections per worker x 1 worker(s) = 30 max
✅ Redis connected
✅ Auth schema ready (users table)
✅ Template schema ready (templates.elements JSON)
✅ Timer schema ready (timers.config JSON)
✨ Worker standalone listening on http://localhost:10000
```

The schema lines matter: the server creates its three tables on boot, so the
Railway database does not need to be prepared by hand. (If you would rather
create them up front, import `migrations/personalize_studio_schema.sql` in MySQL
Workbench — comment out its `CREATE DATABASE` and `USE` lines first, because
Railway's database is called `railway`, not `personalize_studio`.)

Then:

```
curl https://<service>.onrender.com/health
curl https://<service>.onrender.com/metrics
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `⚠️ REDIS_URL is not set — running on in-memory caches only` once at boot, `/health` says `redis: disabled` | No Redis is configured on the service. The app runs on memory caches only — correct, but slower and with the three losses in the table above. Add `REDIS_URL` in Environment and redeploy |
| `⚠️ Redis error: ... ECONNREFUSED` at boot, then once a minute with a suppressed count | A Redis **is** configured and unreachable — wrong region, an allow list, or the instance is gone. Repeats are throttled on purpose; the count tells you it is still failing |
| `⚠️ Redis error: ... WRONGPASS` / `NOAUTH` | The external `rediss://` URL was copied without its password, or the internal one is being used from outside Render |
| Redis fine, cache hit rate near zero | Each worker has its own memory cache; check the invalidation subscriber connected (`initInvalidation()` runs right after `initRedis()` in `src/server.js`) |
| `ETIMEDOUT` connecting to MySQL | `DB_PORT` missing, so mysql2 used 3306 |
| `HANDSHAKE_SSL_ERROR: self-signed certificate in certificate chain` | `DB_SSL=true` against Railway — use `skip-verify` |
| `ER_CON_COUNT_ERROR` from MySQL | `DB_POOL_TOTAL` x workers exceeds Railway's 151 |
| Boot error naming `@img/sharp-linux-x64` | Build command missing `--include=optional` |
| First request after idle takes ~a minute | Free web service tier spun the container down. Countdown timers are fetched by email clients that will have given up — use a paid plan |
