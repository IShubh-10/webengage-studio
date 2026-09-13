/**
 * The HTML entry points, gated by session state.
 */

const path = require('path');
const express = require('express');

const router = express.Router();

const { requireAuthPage, requireAdminPage } = require('../middleware/guards');
const { PUBLIC_DIR } = require('../config');

router.get('/', (req, res) => {
  res.redirect(req.user ? '/tools' : '/login');
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/tools');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

router.get('/tools', requireAuthPage, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'tools.html'));
});

router.get('/studio', requireAuthPage, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

router.get('/admin', requireAdminPage, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

router.get('/timers', requireAuthPage, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'timers.html'));
});

/*
 * Friendly aliases so a tool can be linked by name. They redirect rather than
 * serve: a page returned from a nested path would resolve its own relative
 * asset URLs against /tools/, and the stylesheets would 404.
 */
router.get('/tools/dynamic-images', (req, res) => res.redirect('/studio'));

router.get('/tools/countdown-timers', (req, res) => res.redirect('/timers'));

module.exports = router;
