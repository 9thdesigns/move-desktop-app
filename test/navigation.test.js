'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPolicy, isOpenableExternally } = require('../src/navigation');

const policy = createPolicy({ appOrigin: 'https://m0ve.app' });
const action = (url) => policy.classify(url).action;

test('the site and its subdomains load in-app', () => {
  assert.equal(action('https://m0ve.app/welcome'), 'app');
  assert.equal(action('https://m0ve.app/'), 'app');
  assert.equal(action('https://calendar.m0ve.app/'), 'app');
  assert.equal(action('https://docs.m0ve.app/guide'), 'app');
  assert.equal(action('http://m0ve.app/login'), 'app');
});

test('look-alike hosts are not the site', () => {
  assert.equal(action('https://m0ve.app.evil.com/'), 'external');
  assert.equal(action('https://notm0ve.app/'), 'external');
  assert.equal(action('https://evil.com/?u=https://m0ve.app'), 'external');
});

test('OAuth provider endpoints load in-app', () => {
  assert.equal(action('https://accounts.google.com/o/oauth2/auth?client_id=x'), 'app');
  assert.equal(action('https://appleid.apple.com/auth/authorize'), 'app');
  assert.equal(action('https://connect.stripe.com/setup/e/acct_1/abc'), 'app');
  assert.equal(action('https://checkout.stripe.com/c/pay/cs_test'), 'app');
  assert.equal(action('https://www.linkedin.com/oauth/v2/authorization?x=1'), 'app');
  assert.equal(action('https://x.com/i/oauth2/authorize?x=1'), 'app');
  assert.equal(action('https://api.us.nylas.com/v3/connect/auth?x=1'), 'app');
  assert.equal(action('https://www.facebook.com/v18.0/dialog/oauth?x=1'), 'app');
  assert.equal(action('https://www.facebook.com/login.php'), 'app');
});

test('content on OAuth hosts opens in the system browser', () => {
  assert.equal(action('https://www.linkedin.com/in/someone'), 'external');
  assert.equal(action('https://x.com/m0ve_status'), 'external');
  assert.equal(action('https://www.facebook.com/somepage'), 'external');
  assert.equal(action('https://www.instagram.com/m0ve/'), 'external');
});

test('github.com: only sign-in and OAuth stay in-app', () => {
  assert.equal(action('https://github.com/login'), 'app');
  assert.equal(action('https://github.com/login/oauth/authorize?client_id=x'), 'app');
  assert.equal(action('https://github.com/session'), 'app');
  assert.equal(action('https://github.com/sessions/two-factor/app'), 'app');
  assert.equal(action('https://github.com/9thdesigns/move-desktop-app'), 'external');
  assert.equal(action('https://github.com/9thdesigns/move-desktop-app/releases/latest'), 'external');
  assert.equal(action('https://github.com/login-not-really'), 'external');
  assert.equal(action('https://github.com/'), 'external');
});

test('everything else opens in the system browser', () => {
  assert.equal(action('https://calendar.google.com/calendar/r'), 'external');
  assert.equal(action('https://example.com/'), 'external');
  assert.equal(action('http://example.com/'), 'external');
});

test('non-http schemes are dropped, never handed to the OS', () => {
  assert.equal(action('mailto:hi@example.com'), 'deny');
  assert.equal(action('javascript:alert(1)'), 'deny');
  assert.equal(action('file:///etc/passwd'), 'deny');
  assert.equal(action('ms-msdt:/id'), 'deny');
  assert.equal(action('about:blank'), 'deny');
  assert.equal(action('not a url'), 'deny');
  assert.equal(isOpenableExternally('https://example.com'), true);
  assert.equal(isOpenableExternally('mailto:hi@example.com'), false);
  assert.equal(isOpenableExternally('javascript:1'), false);
});

test('a development origin makes localhost the app host', () => {
  const dev = createPolicy({ appOrigin: 'http://localhost:3000' });
  assert.equal(dev.classify('http://localhost:3000/welcome').action, 'app');
  assert.equal(dev.classify('https://m0ve.app/').action, 'external');
  assert.equal(dev.isAppUrl('http://localhost:3000/x'), true);
});
