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
  assert.equal(action('javascript:alert(1)'), 'deny');
  assert.equal(action('file:///etc/passwd'), 'deny');
  assert.equal(action('ms-msdt:/id'), 'deny');
  assert.equal(action('about:blank'), 'deny');
  assert.equal(action('not a url'), 'deny');
  assert.equal(isOpenableExternally('https://example.com'), true);
  assert.equal(isOpenableExternally('javascript:1'), false);
});

test('mailto: links go to the mail client', () => {
  assert.equal(action('mailto:hi@example.com'), 'external');
  assert.equal(action('mailto:hi@example.com?subject=Hello%20there'), 'external');
  assert.equal(action('mailto:'), 'deny');
});

test('the external allowlist is http, https and mailto only', () => {
  for (const ok of ['https://example.com/', 'http://example.com/a?b=c', 'mailto:hi@example.com', 'mailto:a@b.c?subject=x']) {
    assert.equal(isOpenableExternally(ok), true, ok);
  }
  for (const bad of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hi',
    'ms-msdt:/id PCWDiagnostic',
    'smb://evil/share',
    'vbscript:x',
    'move-desktop://open?path=/',
    'tel:+15551234567',
    'mailto:',
    'https://',
    'https://user:pass@example.com/',
    'https://example.com/\nx',
    ' https://example.com/',
    'https://exa mple.com/',
    `https://example.com/${'a'.repeat(5000)}`,
    '',
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(isOpenableExternally(bad), false, String(bad));
  }
});

test('a development origin makes localhost the app host', () => {
  const dev = createPolicy({ appOrigin: 'http://localhost:3000' });
  assert.equal(dev.classify('http://localhost:3000/welcome').action, 'app');
  assert.equal(dev.classify('https://m0ve.app/').action, 'external');
  assert.equal(dev.isAppUrl('http://localhost:3000/x'), true);
});

// The in-app file viewer's "Open in new tab": the site's guarded file route
// redirects a signed-in viewer to a signed storage URL, which opens in the
// app window instead of a blank window plus the system browser.
test('one redirect hop from the site\'s file routes to the storage host stays in-app', () => {
  const redirect = (from, to) => policy.classifyRedirect(from, to);
  const s3 = 'https://move-uploads.s3.us-west-2.amazonaws.com/abc?response-content-disposition=inline&X-Amz-Signature=x';
  for (const from of [
    'https://m0ve.app/rails/active_storage/blobs/redirect/eyJfcmFpbHMi/contract.pdf?disposition=inline',
    'https://m0ve.app/rails/active_storage/blobs/proxy/eyJfcmFpbHMi/contract.pdf',
    'https://m0ve.app/rails/active_storage/representations/redirect/eyJ/eyJ/photo.png',
  ]) {
    assert.deepEqual(redirect(from, s3), { action: 'app', reason: 'storage-redirect' }, from);
  }
  assert.equal(redirect('https://m0ve.app/rails/active_storage/blobs/redirect/x/f.pdf', 'https://d111.cloudfront.net/f.pdf?Signature=x').action, 'app');
});

test('every other redirect is judged as before', () => {
  const redirect = (from, to) => policy.classifyRedirect(from, to).action;
  const s3 = 'https://move-uploads.s3.us-west-2.amazonaws.com/abc';
  // Not from a file route, or not from the site at all.
  assert.equal(redirect('https://m0ve.app/messages/12', s3), 'external');
  assert.equal(redirect('https://m0ve.app/rails/active_storage/direct_uploads', s3), 'external');
  assert.equal(redirect('https://m0ve.app/go?to=/rails/active_storage/blobs/x', s3), 'external');
  assert.equal(redirect('https://evil.com/rails/active_storage/blobs/redirect/x', s3), 'external');
  assert.equal(redirect(undefined, s3), 'external');
  // Only https storage URLs without credentials; other schemes are still dropped.
  const from = 'https://m0ve.app/rails/active_storage/blobs/redirect/x/f.pdf';
  assert.equal(redirect(from, 'http://move-uploads.s3.amazonaws.com/abc'), 'external');
  assert.equal(redirect(from, 'https://user:pw@evil.com/abc'), 'external');
  assert.equal(redirect(from, 'file:///etc/passwd'), 'deny');
  assert.equal(redirect(from, 'javascript:alert(1)'), 'deny');
  // Site and OAuth targets keep their own verdicts.
  assert.equal(redirect(from, 'https://m0ve.app/rails/active_storage/disk/x/f.pdf'), 'app');
  assert.equal(redirect('https://m0ve.app/messages', 'https://accounts.google.com/o/oauth2/auth'), 'app');
});
