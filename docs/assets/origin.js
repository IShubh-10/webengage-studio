/**
 * The one place that knows where this app is deployed.
 *
 * Every URL the UI hands a user to paste elsewhere — a render link, a timer
 * GIF in an email — has to work from outside this browser. `location.origin`
 * does not: on a developer machine it is `http://localhost:3000`, which renders
 * nothing in anyone else's inbox, and copying that into a campaign is a silent
 * failure that only shows up after the send.
 *
 * So links are built from PUBLIC_ORIGIN instead. Load this before any other
 * script on the page and build copyable URLs with `publicUrl()`.
 */

(function () {
  /** The deployed service. Change this here and nowhere else if it moves. */
  var PUBLIC_ORIGIN = 'https://webengage-studio.onrender.com';

  /**
   * Absolute, shareable URL for an app-relative path.
   * `publicUrl('/api/v1/timer/42.gif')` → `https://…onrender.com/api/v1/timer/42.gif`
   */
  function publicUrl(path) {
    if (!path) return PUBLIC_ORIGIN;
    return PUBLIC_ORIGIN + (path.charAt(0) === '/' ? path : '/' + path);
  }

  window.PUBLIC_ORIGIN = PUBLIC_ORIGIN;
  window.publicUrl = publicUrl;
})();
