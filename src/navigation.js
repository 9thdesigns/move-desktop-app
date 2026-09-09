'use strict';

// Navigation policy: where a URL is allowed to load.
//
// Pure functions with no Electron dependency so the rules can be unit tested
// (see test/navigation.test.js). main.js applies `classify()` in
// `will-navigate`, `will-redirect` and `setWindowOpenHandler`.
//
//   'app'      – load inside the app window
//   'external' – hand to the system browser (http/https only)
//   'deny'     – drop it (unknown scheme, unparseable, file:, …)

// Hosts that may load inside the window because they are one leg of an OAuth,
// checkout or account-linking round-trip that starts on the site and has to
// come back to it with the app's cookies.
//
//   null   → every path on the host is allowed (pure auth/checkout hosts)
//   array  → only paths under one of these prefixes; anything else on that
//            host is content and opens in the system browser. Entries may be
//            strings (matched on a path-segment boundary) or RegExps.
const OAUTH_HOSTS = new Map([
  // Google — sign-in and calendar consent. Google refuses OAuth inside
  // Electron ("disallowed_useragent"), so the site hands these flows to the
  // system browser; keeping the hosts here means a leg that does render
  // in-app (an account chooser, a re-consent prompt) still works.
  ['accounts.google.com', null],
  ['accounts.youtube.com', null],
  ['myaccount.google.com', null],
  // Apple
  ['appleid.apple.com', null],
  ['idmsa.apple.com', null],
  // Microsoft (Outlook / Microsoft 365 calendars via Nylas)
  ['login.microsoftonline.com', null],
  ['login.live.com', null],
  ['login.microsoft.com', null],
  // Nylas hosted auth (Google / Outlook / iCloud calendar connections)
  ['api.us.nylas.com', ['/v3/connect']],
  ['api.eu.nylas.com', ['/v3/connect']],
  // LinkedIn
  ['www.linkedin.com', ['/oauth', '/uas', '/checkpoint', '/login']],
  ['linkedin.com', ['/oauth', '/uas', '/checkpoint', '/login']],
  // X / Twitter
  ['twitter.com', ['/i/oauth2', '/oauth', '/i/flow', '/login', '/sessions', '/account/login_verification']],
  ['x.com', ['/i/oauth2', '/oauth', '/i/flow', '/login', '/sessions', '/account/login_verification']],
  ['api.twitter.com', ['/oauth']],
  ['api.x.com', ['/oauth']],
  // Facebook / Instagram (Instagram Graph sign-in runs through Facebook Login)
  ['www.facebook.com', ['/dialog', /^\/login(?:\.php)?(?:\/|$)/, '/checkpoint', '/x/oauth', '/oauth', '/privacy/consent', /^\/v\d+(?:\.\d+)?\/dialog\//]],
  ['facebook.com', ['/dialog', /^\/login(?:\.php)?(?:\/|$)/, '/checkpoint', '/x/oauth', '/oauth', /^\/v\d+(?:\.\d+)?\/dialog\//]],
  ['m.facebook.com', ['/dialog', /^\/login(?:\.php)?(?:\/|$)/, '/checkpoint', '/x/oauth', '/oauth', /^\/v\d+(?:\.\d+)?\/dialog\//]],
  ['api.instagram.com', ['/oauth']],
  ['www.instagram.com', ['/oauth', '/accounts/login']],
  // Stripe — Connect onboarding, Checkout and the customer portal
  ['connect.stripe.com', null],
  ['checkout.stripe.com', null],
  ['billing.stripe.com', null],
  // PayPal — seller onboarding and buyer approval pages
  ['www.paypal.com', null],
  ['www.sandbox.paypal.com', null],
  // GitHub — only sign-in and OAuth authorization. Every other github.com
  // path (repos, PRs, releases) is content that 404s inside the app's empty
  // cookie jar when it is private, so it opens in the system browser.
  ['github.com', ['/login', '/session', '/sessions']],
]);

function pathMatches(pathname, rule) {
  if (rule instanceof RegExp) return rule.test(pathname);
  const prefix = rule.replace(/\/+$/, '');
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function pathAllowed(pathname, rules) {
  if (rules === null) return true;
  return rules.some((rule) => pathMatches(pathname, rule));
}

function parseUrl(value) {
  try {
    return new URL(String(value));
  } catch (_) {
    return null;
  }
}

// http(s) is the only thing we ever hand to shell.openExternal. Never pass an
// arbitrary scheme to the OS.
function isOpenableExternally(value) {
  const url = parseUrl(value);
  return Boolean(url && (url.protocol === 'https:' || url.protocol === 'http:'));
}

function createPolicy({ appOrigin }) {
  const app = new URL(appOrigin);
  const appHost = app.hostname;

  const isAppHost = (hostname) =>
    typeof hostname === 'string' && (hostname === appHost || hostname.endsWith(`.${appHost}`));

  const isAppUrl = (value) => {
    const url = parseUrl(value);
    return Boolean(url && (url.protocol === 'https:' || url.protocol === 'http:') && isAppHost(url.hostname));
  };

  function classify(value) {
    const url = parseUrl(value);
    if (!url) return { action: 'deny', reason: 'unparseable' };
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { action: 'deny', reason: 'scheme' };
    if (isAppHost(url.hostname)) return { action: 'app', reason: 'app-host' };

    const rules = OAUTH_HOSTS.get(url.hostname);
    if (rules !== undefined && pathAllowed(url.pathname, rules)) return { action: 'app', reason: 'oauth' };
    return { action: 'external', reason: rules === undefined ? 'foreign-host' : 'oauth-host-other-path' };
  }

  return { appHost, appOrigin: app.origin, isAppHost, isAppUrl, classify };
}

module.exports = { OAUTH_HOSTS, createPolicy, isOpenableExternally, pathAllowed };
