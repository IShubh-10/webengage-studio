/**
 * The boot summary, printed once when a worker is ready.
 *
 * It exists to answer a question the old scattered log could not: which of
 * these things did this process actually start? `npm start` printed a Redis
 * line and a MySQL line among its own, and they read as though the server had
 * launched a cache and a database. It had not — it connected to two services
 * that were already running, one of which is a separate EC2 instance in the
 * deployment and a Homebrew service on a laptop.
 *
 * So the report has two halves and the heading is the whole point:
 *
 *   - `startedHere()`   — this process owns its lifetime. It came up with the
 *                         process and it goes away when the process does.
 *   - `connectedTo()`   — a dependency running somewhere else. Stopping this
 *                         process does not stop it; stopping it does not stop
 *                         this process, which is what the in-memory fallbacks
 *                         are for.
 *
 * Failures are deliberately NOT collected here. A warning folded into a tidy
 * block printed later is a warning nobody reads at the moment it matters, so
 * every module keeps printing its own errors as they happen; `note()` is only
 * for the standing conditions worth repeating underneath the summary.
 */

const started = [];
const connected = [];
const notes = [];

/** Something this process runs. */
function startedHere(line) {
  if (line) started.push(line);
}

/**
 * Something running elsewhere that this process talks to.
 * `detail` lines are indented under the label.
 */
function connectedTo(label, ...detail) {
  connected.push({ label, detail: detail.filter(Boolean) });
}

/** A standing condition to repeat under the summary (not an error). */
function note(line) {
  if (line) notes.push(line);
}

function print(title) {
  const lines = ['', `🚀 ${title}`];

  if (started.length) {
    lines.push('', '   Started by this process');
    started.forEach((line) => lines.push(`   · ${line}`));
  }

  if (connected.length) {
    lines.push('', '   Connected to (running elsewhere)');

    const width = Math.max(...connected.map(({ label }) => label.length));
    connected.forEach(({ label, detail }) => {
      lines.push(`   · ${label.padEnd(width)}  ${detail[0] || ''}`);
      // Continuation lines sit under the first one, past the label column.
      detail.slice(1).forEach((line) => lines.push(`     ${' '.repeat(width)}  ${line}`));
    });
  }

  if (notes.length) {
    lines.push('');
    notes.forEach((line) => lines.push(`   ${line}`));
  }

  lines.push('');
  console.log(lines.join('\n'));

  // A worker reports once. Clearing means a re-report after a reconnect would
  // be empty rather than a duplicate of everything said at boot.
  started.length = 0;
  connected.length = 0;
  notes.length = 0;
}

module.exports = { startedHere, connectedTo, note, print };
