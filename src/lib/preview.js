/**
 * Telling the studio looking at its own work apart from a real open.
 *
 * The template grid, the timer library and the builder's live preview all load
 * the same public render endpoints an email does — that is the point, it is
 * how what you see in the builder is provably what the inbox gets. It also
 * means that without a marker, opening the library would count as an open of
 * every creative in it, and a builder session would quietly make the timer
 * being edited look like the most popular one in the studio.
 *
 * So the UI appends `?we_preview=1` to the URLs it loads for itself, and those
 * fetches are served identically but not counted. The marker is not a security
 * boundary — anyone can append it to suppress their own count — and it does
 * not need to be: the worst case is a number that is too low, which is the
 * safe direction for a figure nobody is billed for.
 */

const { STATS_PREVIEW_PARAM } = require('../config');

/** True when this request is the studio previewing, rather than a real open. */
function isStudioPreview(query) {
  if (!query) return false;

  const flag = query[STATS_PREVIEW_PARAM];
  if (flag === undefined) return false;

  // Express hands over an array when a parameter is repeated.
  const value = Array.isArray(flag) ? flag[0] : flag;
  return String(value).toLowerCase() !== '0' && String(value).toLowerCase() !== 'false';
}

module.exports = { isStudioPreview, STATS_PREVIEW_PARAM };
