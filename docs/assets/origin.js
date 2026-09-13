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

  /*
   * Where the API lives, as seen from *this* page.
   *
   * These same files are served two ways: by the Node app itself, and as a
   * static site on GitHub Pages, which has no backend at all. A bare
   * `/api/v1/...` resolves against whatever host loaded the page, so on Pages
   * it becomes `https://ishubh-10.github.io/api/...` and 404s.
   *
   * So: same-origin when the page is being served by the app (or by a
   * developer's localhost, where the API is on the same port), and the
   * deployed origin otherwise. Requests that cross an origin need
   * `credentials: 'include'` to carry the session cookie — `apiFetch` in
   * shell.js sets that for every caller.
   */
  var host = window.location.hostname;
  var servedByTheApp =
    window.location.origin === PUBLIC_ORIGIN ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '';

  var API_BASE = servedByTheApp ? '' : PUBLIC_ORIGIN;

  /**
   * URL to call the API with from this page. Same-origin where that works,
   * absolute where it does not. Use it for every request the page makes;
   * use `publicUrl()` only for a URL a user is going to paste elsewhere.
   */
  function apiUrl(path) {
    if (!path) return API_BASE || window.location.origin;
    return API_BASE + (path.charAt(0) === '/' ? path : '/' + path);
  }

  window.PUBLIC_ORIGIN = PUBLIC_ORIGIN;
  window.API_BASE = API_BASE;
  window.publicUrl = publicUrl;
  window.apiUrl = apiUrl;
})();
