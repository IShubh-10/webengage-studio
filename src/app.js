/**
 * Express wiring: middleware, static assets, then the route table.
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const { attachUserFromSession } = require('./middleware/session');
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

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
// Resolve the signed session cookie before anything is served (helpers in section 10.5)
app.use(attachUserFromSession);

// The studio SPA is reachable only through /studio, so direct hits get routed by auth state
app.get('/index.html', (req, res) => res.redirect(req.user ? '/studio' : '/login'));

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
