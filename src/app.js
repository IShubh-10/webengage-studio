/**
 * Express wiring: middleware, static assets, then the route table.
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const { attachUserFromSession } = require('./middleware/session');
const { requireTrustedOrigin } = require('./middleware/origin');
const { CORS_ORIGINS, PUBLIC_DIR } = require('./config');

const app = express();

app.use(
  cors({
    origin: CORS_ORIGINS,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

// Runs before the body is even parsed: a request from an origin we do not
// trust is refused outright rather than being read and acted on.
app.use(requireTrustedOrigin);

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
// Resolve the signed session cookie before anything is served (helpers in section 10.5)
app.use(attachUserFromSession);

/*
 * Pages link to one another by filename, not by absolute path, so that the
 * same files also work when served as a plain static site (GitHub Pages puts
 * them under /webengage-studio/, where a leading "/" would escape the app).
 * Here those filenames are redirected to their canonical, guarded paths, so a
 * filename never bypasses the session checks in page.routes.js and never
 * becomes the URL a user bookmarks. The query string is carried across.
 */
const CANONICAL_PAGE_PATHS = {
  '/index.html': '/studio',
  '/tools.html': '/tools',
  '/timers.html': '/timers',
  '/admin.html': '/admin',
  '/login.html': '/login',
};

for (const [filename, canonical] of Object.entries(CANONICAL_PAGE_PATHS)) {
  app.get(filename, (req, res) => {
    const queryString = req.originalUrl.slice(req.path.length);
    res.redirect(canonical + queryString);
  });
}

// index: false so "/" is handled by the auth-aware route in section 12 instead of index.html
app.use(express.static(PUBLIC_DIR, { index: false }));

// Add ETag support for conditional requests
app.set('etag', 'weak');

const IMAGE_FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  Referer: 'https://www.google.com/',
};

// Pre-compiled regex for placeholder replacement
const PLACEHOLDER_REGEX = /\{\{([\w\-]+)\}\}/g;

app.use(require('./routes'));

module.exports = app;
