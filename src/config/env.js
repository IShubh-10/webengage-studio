/**
 * Loads .env into process.env before anything else reads it.
 * Required first by src/server.js, so every other module can rely on it.
 */

const path = require('path');
const fs = require('fs');

const ROOT_DIR = path.join(__dirname, '..', '..');

// Reads KEY=VALUE lines from a .env file next to server.js so secrets such as
// WEBENGAGE_API_KEY and SESSION_SECRET do not have to be exported by hand on
// every start. A real environment variable always wins over the file.

(function loadDotEnv() {
  try {
    const envPath = path.join(ROOT_DIR, '.env');
    if (!fs.existsSync(envPath)) return;

    let loaded = 0;

    fs.readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;

        const eq = trimmed.indexOf('=');
        if (eq < 1) return;

        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();

        // Strip one layer of matching quotes
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }

        if (process.env[key] === undefined) {
          process.env[key] = value;
          loaded += 1;
        }
      });

    if (loaded > 0) console.log(`🔑 Loaded ${loaded} value(s) from .env`);
  } catch (err) {
    console.warn('⚠️ Could not read .env:', err.message);
  }
})();

module.exports = { ROOT_DIR };
