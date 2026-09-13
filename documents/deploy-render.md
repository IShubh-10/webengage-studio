# Hosting Webengage Creative Studio on Render

What runs where:

| Piece | Where it goes | Why |
| --- | --- | --- |
| Node server | Render **Web Service** | The whole app — builder UI, render endpoints, timers |
| Redis | Render **Key Value** | Same account, same region, reached on the private network |
| MySQL | **Another provider** | Render hosts Postgres and Key Value only. There is no managed MySQL |
| Backgrounds | Existing S3 bucket | Unchanged; only the credentials move into Render's environment |

Redis, step by step — and the environment a service whose repository is already
connected still needs — is in [render-redis.md](render-redis.md).

[`render.yaml`](../render.yaml) at the repository root declares the web service
and the Key Value instance together, so New ▸ Blueprint sets both up and wires
`REDIS_URL` between them. The steps below are the same whether you use that or
create the services by hand.

---

## 1. The database, first

Render cannot host it, so pick a MySQL provider and create the database before
anything else — Aiven, Railway, Clever Cloud and PlanetScale all have a usable
free or cheap tier. Any of them gives you five values:

```
DB_HOST=mysql-xxxx.something.cloud
DB_PORT=39120          # managed MySQL is rarely on 3306
DB_USER=avnadmin
DB_PASSWORD=…
DB_NAME=personalize_studio
```

Two things to set on the provider's side:

- **Allow Render to connect.** Render gives every service a small set of static
  outbound IPs — the service's **Connect ▸ Outbound** panel lists them. Add them
  to the database's IP allowlist. Some providers are open to the internet by
  default; tightening this is worth the five minutes.
- **TLS.** The traffic crosses the public internet, so it has to be encrypted.
  `DB_SSL=true` verifies the certificate against the system CA store, which is
  what you want when the provider's certificate is publicly signed. Many are
  not: Railway serves the one MySQL generates for itself, so `true` fails there
  with *self-signed certificate in certificate chain* and `DB_SSL=skip-verify`
  (encrypt, do not verify) is the setting. If the provider publishes a CA
  bundle, `DB_SSL_CA=certs/mysql-ca.pem` is better than either.
- **Connect timeout.** A database behind a public TCP proxy answers a handshake
  in seconds, not milliseconds — Railway's is around 2.5s from a laptop, against
  mysql2's 10s default. `DB_CONNECT_TIMEOUT_MS` defaults to 20s for that reason;
  raise it if a cold worker's first connection is still being cut off.

Then create the schema. The server also builds it on boot
(`src/db/schema.js`), so this is optional, but doing it up front means the first
deploy fails loudly if the credentials are wrong rather than quietly starting
with no tables:

```
mysql -h $DB_HOST -P $DB_PORT -u $DB_USER -p < migrations/personalize_studio_schema.sql
```

Or open that file in MySQL Workbench against the new connection.

## 2. Key Value (Redis)

New ▸ Key Value, **same region as the web service** — the internal `redis://`
URL only resolves inside one region's private network. Leave the IP allow list
empty so nothing outside Render can reach it, and set the eviction policy to
`allkeys-lru`: everything the app stores there has a TTL, and when memory runs
out evicting the coldest key is better than refusing writes.

Reference it from the web service as `REDIS_URL` (the blueprint does this with
`fromService`; by hand, copy the **Internal Key Value URL** from its page).

**Do not use the free plan for anything real.** Free Key Value instances have no
persistence: a restart or a plan change empties them. The app survives that — it
falls back to its in-memory caches and keeps serving — but three things are lost
with the data:

- **registration OTPs** in flight, so a code someone is typing stops working;
- **evergreen timers' first-open timestamps**, so a recipient's countdown starts
  over from the full duration;
- **the logout deny-list**, so sessions revoked by signing out become valid again
  until they expire on their own.

The smallest paid plan has persistence and is the right baseline.

## 3. The web service

New ▸ Web Service, connect the repository:

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Build command | `npm ci --include=optional` |
| Start command | `npm start` |
| Health check path | `/health` |

`--include=optional` matters: sharp ships a prebuilt binary per platform as an
optional dependency, and a lockfile written on a Mac can leave Render's build
without the `linux-x64` one. The symptom is a boot error naming
`@img/sharp-linux-x64`; that flag is the fix.

`PORT` is set by Render and read in `src/config/index.js` — do not set it
yourself.

### Environment variables

| Key | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `22.12.0` (or whatever you develop on; the floor is 18) |
| `WORKERS` | `1` on starter, `2` on standard, `4` on pro |
| `SESSION_SECRET` | `openssl rand -base64 32`, or let Render generate it |
| `REDIS_URL` | internal URL of the Key Value instance |
| `DB_HOST` `DB_PORT` `DB_USER` `DB_PASSWORD` `DB_NAME` `DB_SSL` | from step 1 |
| `WEBENGAGE_API_KEY` | for registration OTP delivery |
| `AWS_REGION` `AWS_ACCESS_KEY_ID` `AWS_SECRET_ACCESS_KEY` `S3_BUCKET_NAME` | background archive |

`WORKERS` is the one that bites. With `NODE_ENV=production` and no `WORKERS`,
`src/server.js` forks `os.cpus().length` workers — and inside a container
`os.cpus()` reports the *host's* cores, so a 0.5 CPU instance tries to run eight
workers. They do not add throughput; they add context switching, eight MySQL
pools and eight copies of every in-memory cache.

`SESSION_SECRET` is not optional here: with `NODE_ENV=production` the master
refuses to start without it, deliberately (`src/server.js`), because the old
fallback was written in the repository and anyone who could read the source
could mint an admin session.

## 4. Plan sizing

Avoid the **free web service tier** for this app specifically. It spins down
after 15 idle minutes and the next request pays a cold start of roughly a
minute. That is survivable for a dashboard; it is not survivable for countdown
timers, whose whole job is to answer an image request from inside an email
client that gives up long before a container has booted.

Past that, this is CPU-bound work — GIF and PNG encoding — so scale on CPU, not
memory, and keep `WORKERS` in step with the plan's core count.

## 5. After the first deploy

```
curl https://<your-service>.onrender.com/health
curl https://<your-service>.onrender.com/metrics
```

In the deploy log, a healthy boot prints the database it connected to
(`🗄️ MySQL user@host:port/db (TLS on)`), `✅ Redis connected`, and one
`✅ … schema ready` line per table.

Common first-deploy failures:

| Symptom | Cause |
| --- | --- |
| `ETIMEDOUT` / `ECONNREFUSED` reaching MySQL | Render's outbound IPs are not on the database's allowlist, or `DB_PORT` is still 3306 |
| `HANDSHAKE_SSL_ERROR`, or a certificate error | `DB_SSL` unset on a provider that requires TLS; or a self-signed certificate needing `DB_SSL_CA` |
| `SESSION_SECRET is required` and the master exits | Variable not set on the service |
| `⚠️ Redis error` on repeat, app still serving | `REDIS_URL` points at another region, or the allow list blocks it. The app runs degraded rather than failing |
| Boot error naming `@img/sharp-linux-x64` | Build command missing `--include=optional` |

## Connecting to the hosted database locally

The same variables work from a laptop — point `.env` at the managed host, or
keep two files and switch. Nothing in `src/config/db.js` is hardcoded, so the
only difference between local and production is the environment.
