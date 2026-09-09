'use strict';

// The website brings the user back into the app with a custom URL scheme after
// a flow that had to run in the system browser (Google OAuth, for example):
//
//   move-desktop://open?path=/calendars/42
//   move-desktop://handoff/complete?return_to=/calendars/42
//
// Only a same-site relative path ever comes out of here; the app then loads
// `${appOrigin}${path}`. Pure functions so they can be unit tested.

// A path we are willing to load: absolute, single leading slash (so it can not
// smuggle a different host in via `//evil.com`), and no whitespace, control
// characters or backslashes.
const FORBIDDEN = /[\x00-\x20\x7f\\]/;

function sanitizePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (FORBIDDEN.test(value)) return null;
  return value;
}

function parseDeepLink(rawUrl, { scheme }) {
  if (typeof rawUrl !== 'string' || !rawUrl.toLowerCase().startsWith(`${scheme}:`)) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_) {
    return null;
  }
  if (url.protocol !== `${scheme}:`) return null;

  // WHATWG URL parsing of custom schemes varies: "move-desktop://open?x" gives
  // host "open"; "move-desktop:open?x" gives pathname "open". Accept both.
  const kind = (url.host || url.pathname.replace(/^\/+/, '').split('/')[0] || '').toLowerCase();
  const params = url.searchParams;

  if (kind === 'open' || kind === 'handoff') {
    const target = sanitizePath(params.get('path') || params.get('return_to') || '/');
    return target ? { path: target } : null;
  }
  return null;
}

// On Windows/Linux a deep link arrives as a command-line argument of the
// second instance. Pick the first argument that carries our scheme.
function findDeepLinkInArgv(argv, { scheme }) {
  if (!Array.isArray(argv)) return null;
  const prefix = `${scheme}:`;
  return argv.find((arg) => typeof arg === 'string' && arg.toLowerCase().startsWith(prefix)) || null;
}

module.exports = { parseDeepLink, findDeepLinkInArgv, sanitizePath };
