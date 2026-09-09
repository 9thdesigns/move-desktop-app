'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDeepLink, findDeepLinkInArgv, sanitizePath } = require('../src/deep-links');

const opts = { scheme: 'move-desktop' };

test('open and handoff links yield a same-site path', () => {
  assert.deepEqual(parseDeepLink('move-desktop://open?path=/calendars/42', opts), { path: '/calendars/42' });
  assert.deepEqual(parseDeepLink('move-desktop://handoff/complete?return_to=/calendars/42%3Ftab%3Dsync', opts), {
    path: '/calendars/42?tab=sync',
  });
  assert.deepEqual(parseDeepLink('MOVE-DESKTOP://open', opts), { path: '/' });
});

test('anything that could leave the site is rejected', () => {
  assert.equal(parseDeepLink('move-desktop://open?path=//evil.com/x', opts), null);
  assert.equal(parseDeepLink('move-desktop://open?path=https://evil.com', opts), null);
  assert.equal(parseDeepLink('move-desktop://open?path=/%5C%5Cevil.com', opts), null);
  assert.equal(parseDeepLink('move-desktop://other?path=/x', opts), null);
  assert.equal(parseDeepLink('https://m0ve.app/', opts), null);
  assert.equal(parseDeepLink('javascript:alert(1)', opts), null);
  assert.equal(sanitizePath('/ok/path?x=1#frag'), '/ok/path?x=1#frag');
  assert.equal(sanitizePath('relative'), null);
  assert.equal(sanitizePath('/bad path'), null);
  assert.equal(sanitizePath('/bad\tpath'), null);
});

test('a deep link is found among second-instance arguments', () => {
  const argv = ['Move.exe', '--allow-file-access', 'move-desktop://open?path=/x'];
  assert.equal(findDeepLinkInArgv(argv, opts), 'move-desktop://open?path=/x');
  assert.equal(findDeepLinkInArgv(['Move.exe'], opts), null);
  assert.equal(findDeepLinkInArgv(null, opts), null);
});
