/**
 * Route table. Paths are absolute inside each router, so this mounts them all
 * at the root and the URL surface stays exactly as documented.
 */

const express = require('express');

const router = express.Router();

router.use(require('./health.routes'));
router.use(require('./auth.routes'));
router.use(require('./page.routes'));
router.use(require('./template.routes'));
router.use(require('./render.routes'));
router.use(require('./timer.routes'));
router.use(require('./stats.routes'));

module.exports = router;
