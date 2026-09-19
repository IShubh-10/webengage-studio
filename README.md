# Webengage Creative Studio

An internal studio for building image templates once and rendering personalised
creatives from a single URL, behind email + password accounts with verified
mobile numbers.

## Running it

```bash
npm install
cp .env.example .env     # then fill in SESSION_SECRET and WEBENGAGE_API_KEY
npm start                # http://localhost:3000
npm run dev              # same, restarts on file changes
npm run migrate          # template layers -> templates.elements JSON (idempotent)
```

The server creates the tables it needs on boot, so a fresh clone or a new
environment comes up on its own.

## Repository layout

```
src/
  server.js                  process entry: env, cluster, listen, schema, shutdown
  app.js                     express wiring: middleware, static, route table
  config/
    env.js                   .env loader (must be required first)
    index.js                 every tunable, in one place
    db.js                    MySQL pool
    redis.js                 Redis client + live connection state
    s3.js                    S3 client
  lib/
    cache.js                 in-memory LRU caches
    preview.js               tells the studio's own previews from a real open
    utcTime.js               UTC timestamps as MySQL strings
    httpAgents.js            keep-alive agents for image fetches
    metrics.js               render counters behind /metrics
    gif.js                   GIF89a writer with per-frame sub-rectangles
    quantize.js              median-cut colour quantisation
  db/
    schema.js                idempotent schema the server guarantees on boot
  middleware/
    session.js               resolves the signed session cookie
    guards.js                requireAuth / requireAdmin / page guards
  services/                  business logic, no HTTP
    passwords.js             scrypt hashing
    sessions.js              HMAC session tokens + cookies
    otp.js                   4 digit codes: issue, store, verify
    webengage.js             transactional SMS campaign client
    images.js                cached image loading + dimension parsing
    render.js                the template compositor, shared by PNG and GIF
    openCounter.js           counts opens in memory, flushes in batches
    openStats.js             windows, series and the per-creative report
    countdown/
      index.js               builds the GIF: which digits changed, and where
      sprites.js             the cached, precomputed half of a countdown
      layout.js              glyph metrics and digit slot geometry
      config.js              the timer schema, and the one place it is validated
      time.js                deadlines, IANA zones, time remaining
      still.js               a single PNG frame, for the builder preview
  repositories/              all SQL lives here
    userRepository.js
    templateRepository.js
    timerRepository.js
    statsRepository.js       every open-stats query, and the batched counter write
  routes/                    HTTP only: validate, call a service, respond
    index.js                 mounts every router
    auth.routes.js           sign-up, sign-in, session, member admin
    template.routes.js       template CRUD (delete is owner-or-admin)
    render.routes.js         public PNG rendering
    timer.routes.js          public countdown GIF + the builder's endpoints
    stats.routes.js          open stats for the studio and for one creative
    page.routes.js           HTML entry points, gated by session
    health.routes.js         /health and /metrics
docs/                        the front end (no build step)
                             named "docs" because GitHub Pages publishes only
                             from a folder with exactly that name
  login.html tools.html index.html admin.html timers.html stats.html
  assets/theme.css           design tokens + primitives
  assets/shell.css           nav bar and page frame
  assets/shell.js            navigation, session handling, icon set
  assets/origin.js           the one place that knows the deployed API origin
  assets/timers.js           the countdown timer builder
  assets/stats.js            the open-stats page: windows, charts, tables
migrations/                  reviewable SQL, applied automatically on boot too
scripts/                     one-off operational scripts
documents/                   deployment, scaling and design notes — deliberately
                             not in docs/, which GitHub Pages publishes
                             (countdown-timers.md covers the timer endpoint,
                              open-stats.md covers open counting)
backups/                     JSON exports taken before destructive migrations
```

**Where to add code.** A new endpoint gets a route module (or a handler in an
existing one) that validates input and delegates; logic goes in `services/`,
SQL in `repositories/`, tunables in `config/index.js`. Routes should not contain
SQL, and services should not know about `req`/`res`.

---

# High-Performance Image Personalization Engine (P0 Specification)

> **Production Architecture Blueprint & Technical Specification**
> An ultra-low latency, stateless image personalization backend optimized for open-time email marketing campaigns. Dynamically composites dynamic text layers onto static base templates using cryptographic payload routing to ensure maximum CDN edge-cache efficiency.

---

## 1. Core Architecture Design

Unlike typical image processing setups that run slow database queries or rely on unstable query strings, this architecture shifts workload left using **Deterministic Hash Routing**.

### System Architecture Data Flow

```text
[ CRM / Email Campaign ]
         │
         │ 1. Injects Encrypted Link into Email Source HTML
         ▼ (e.g., https://cdn.domain.com/v1/render/welcome_banner/{encrypted_payload}.jpg)
┌─────────────────────────────────┐
│         Edge CDN Tier           │
│ ─── 2. Cache Match? ───► [ YES ] ───► Serve Image in <20ms
└─────────────────────────────────┘
         │
         │ 3. [ NO ] Cache Miss: Forward Request to Origin Service
         ▼
┌─────────────────────────────────┐
│       API Gateway Router        │
│ ─── 4. Block raw query parameters / Check Route Sanitization
└─────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│     Personalization Engine      │
│ ─── 5. Parse Layout Coordinates from JSON Configuration Store
└─────────────────────────────────┘
         │
         ├─► 6. Decrypt Payload into plaintext strings using local secret key
         ├─► 7. Calculate text boundary scale to prevent visual overflow
         └─► 8. Execute high-speed in-memory image layer composition
         │
         ▼
[ Stream Binary Payload ] ─── 9. Return image with Immutable Cache Headers back to CDN Edge
```

### Key Architectural Benefits

* **Zero Runtime Database Lookups:** The token parameters embedded inside the URL carry all the personalization metadata. The engine decrypts it on the fly out of thin air.
* **Immutable Edge Caching:** Because every recipient gets a unique asset path string, CDNs (e.g., Cloudflare, CloudFront) treat each dynamic image as a permanent asset, ensuring massive campaign loads hit cache rates $> 98\%$.
* **Apple/Proxy Prefetch Proof:** Bypasses visual caching blind spots created by Apple Mail Privacy Protection and modern security proxy firewalls.

---

## 2. Core Functional Requirements (P0)

* **FR-1:** Accept secure URL parameters structured as `GET /v1/render/:template_id/:encrypted_payload.jpg`.
* **FR-2: Defensive Layout Engineering:** System must compute text pixel dimensions before rendering. If string length wraps or clips bounding rules, font-size must dynamically scale down incrementally.
* **FR-3: Hard Sizing Constraints:** Strings over 32 characters must be cleanly truncated with an ellipsis (`...`).
* **FR-4: Secure Cache Execution:** Malicious payload manipulation must trigger signature failures and safely drop back to fallback template values (e.g., `"Customer"`) instead of generating 500 Server Errors.

---

## 3. Engineering Implementation

### Technology Stack

* **Runtime:** Node.js + TypeScript
* **Processing Engines:** `sharp` (built on `libvips` for native C-level multi-threaded canvas composition) + `canvas` (for sub-millisecond string footprint measurement calculations).

### Core Server (`src/index.ts`)

```typescript
import express, { Request, Response } from 'express';
import sharp from 'sharp';
import crypto from 'crypto';
import { createCanvas } from 'canvas';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;

// Symmetric key must be exactly 32 bytes long for authenticated AES-256-GCM
const ENCRYPTION_KEY = process.env.CRYPTO_KEY || 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';

interface TextLayer {
  variableKey: string;
  defaultValue: string;
  x: number;
  y: number;
  baseFontSize: number;
  maxWidth: number;
  fontFamily: string;
  fontColor: string;
}

interface TemplateConfig {
  baseImagePath: string;
  width: number;
  height: number;
  layers: TextLayer[];
}

// Fixed-In-Memory P0 Structural Configurations Matrix
const templateStore: Record<string, TemplateConfig> = {
  'welcome_banner': {
    baseImagePath: path.join(__dirname, '../assets/welcome_bg.png'),
    width: 600,
    height: 400,
    layers: [
      {
        variableKey: 'name',
        defaultValue: 'Valued Customer',
        x: 300,
        y: 180,
        baseFontSize: 42,
        maxWidth: 520,
        fontFamily: 'sans-serif',
        fontColor: '#FFFFFF'
      }
    ]
  }
};

/**
 * Iteratively measures string footprint against canvas width constraints.
 * Protects layout bounds from unexpected long string text-wrapping.
 */
function getDefensiveFontSize(text: string, fontName: string, baseSize: number, maxWidth: number): number {
  const canvas = createCanvas(100, 100);
  const ctx = canvas.getContext('2d');
  let currentSize = baseSize;

  while (currentSize > 12) {
    ctx.font = `bold ${currentSize}px ${fontName}`;
    const metrics = ctx.measureText(text);
    if (metrics.width <= maxWidth) {
      return currentSize;
    }
    currentSize -= 2;
  }
  return currentSize;
}

/**
 * Decrypts URL target payloads safely using authenticated AES-256-GCM.
 */
function decryptPayload(encryptedToken: string): Record<string, string> {
  try {
    const totalBuffer = Buffer.from(encryptedToken, 'hex');

    const iv = totalBuffer.subarray(0, 12);
    const authTag = totalBuffer.subarray(12, 28);
    const encryptedData = totalBuffer.subarray(28);

    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY), iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedData, undefined, 'utf8');
    decrypted += decipher.final('utf8');

    return JSON.parse(decrypted);
  } catch (error) {
    return {}; // Graceful default isolation path fallback
  }
}

app.get('/v1/render/:template_id/:encrypted_payload.jpg', async (req: Request, res: Response): Promise<any> => {
  try {
    const { template_id, encrypted_payload } = req.params;
    const template = templateStore[template_id];

    if (!template) {
      return res.status(404).send('Template Layout Configuration Mismatch');
    }

    const extractedVariables = decryptPayload(encrypted_payload);

    const svgOverlays = template.layers.map(layer => {
      let rawText = extractedVariables[layer.variableKey] || layer.defaultValue;
      if (rawText.length > 32) rawText = rawText.substring(0, 29) + '...';

      const adjustedSize = getDefensiveFontSize(
        rawText,
        layer.fontFamily,
        layer.baseFontSize,
        layer.maxWidth
      );

      const svgString = `
        <svg width="${template.width}" height="${template.height}">
          <style>
            .title {
              fill: ${layer.fontColor};
              font-size: ${adjustedSize}px;
              font-family: ${layer.fontFamily};
              font-weight: bold;
              text-anchor: middle;
              dominant-baseline: middle;
            }
          </style>
          <text x="${layer.x}" y="${layer.y}" class="title">${rawText}</text>
        </svg>
      `;
      return { input: Buffer.from(svgString), top: 0, left: 0 };
    });

    const processedBuffer = await sharp(template.baseImagePath)
      .composite(svgOverlays)
      .jpeg({ quality: 85, progressive: true })
      .toBuffer();

    // Enforce permanent cache policies across down-stream CDNs
    res.set({
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff'
    });

    return res.send(processedBuffer);

  } catch (err) {
    console.error('Critical Core Loop Render Failure: ', err);
    return res.status(500).send('Service Degraded');
  }
});

app.listen(PORT, () => console.log(`P0 Image personalization engine listening on port: ${PORT}`));
```

---

## 4. Operational CRM Companion (Link Compiler Script)

This internal method script should be introduced directly inside outbound messaging loops, email marketing handlers, or ETL platforms to safely compile subscriber links without executing network traffic bottlenecks.

```javascript
const crypto = require('crypto');
const ENCRYPTION_KEY = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'; // Must perfectly match server runtime configurations

function generatePersonalizedToken(dataObject) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY), iv);

  let encrypted = cipher.update(JSON.stringify(dataObject), 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}${authTag}${encrypted}`;
}

// Example compilation output for CRM distribution template injections
const payload = { name: "Christopher", discount: "SAVE30" };
const token = generatePersonalizedToken(payload);
console.log(`https://yourdomain.com/v1/render/welcome_banner/${token}.jpg`);
```

---

## 5. Deployment Checklist

1. **System Fonts:** Pre-load selected custom standard Linux font distributions (`ttf-dejavu`, `fonts-inter`) inside the service base container Dockerfile. Never attempt runtime downloads over network pipes.
2. **Auto-Scaling Metrics:** Target CPU Utilization metrics at 65% for scaling threshold configurations, as `libvips` processing execution threads scale heavily on compute rather than runtime memory allocations.
3. **Enable Origin Shielding:** Ensure CDN caching policies feature integrated region origin shields to deduplicate simultaneously hitting cache-miss traffic waves safely.
