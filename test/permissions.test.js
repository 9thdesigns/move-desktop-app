'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPolicy } = require('../src/navigation');
const permissions = require('../src/permissions');

function installed() {
  const handlers = {};
  const session = {
    setPermissionRequestHandler: (fn) => { handlers.request = fn; },
    setPermissionCheckHandler: (fn) => { handlers.check = fn; },
  };
  permissions.install(session, { isAppUrl: createPolicy({ appOrigin: 'https://m0ve.app' }).isAppUrl });
  const request = (permission, requestingUrl, extra = {}) => {
    let granted;
    handlers.request(null, permission, (value) => { granted = value; }, { requestingUrl, ...extra });
    return granted;
  };
  const check = (permission, origin) => handlers.check(null, permission, origin, {});
  return { request, check };
}

test('the site may use the camera (QR scanning) and keeps the microphone (huddles)', () => {
  const { request, check } = installed();
  assert.equal(request('media', 'https://m0ve.app/share', { mediaTypes: ['video'] }), true);
  assert.equal(request('media', 'https://m0ve.app/huddles/1', { mediaTypes: ['audio', 'video'] }), true);
  assert.equal(check('media', 'https://m0ve.app'), true);
});

test('other origins never get the camera or microphone', () => {
  const { request, check } = installed();
  assert.equal(request('media', 'https://evil.com/', { mediaTypes: ['video'] }), false);
  assert.equal(request('media', 'https://m0ve.app.evil.com/', { mediaTypes: ['video'] }), false);
  assert.equal(request('media', 'https://accounts.google.com/o/oauth2/auth', { mediaTypes: ['video'] }), false);
  assert.equal(check('media', 'https://evil.com'), false);
});

test('copy-link clipboard writes are allowed on the site only', () => {
  const { request, check } = installed();
  assert.equal(check('clipboard-sanitized-write', 'https://m0ve.app'), true);
  assert.equal(request('clipboard-sanitized-write', 'https://m0ve.app/share'), true);
  assert.equal(check('clipboard-sanitized-write', 'https://evil.com'), false);
});

test('permissions outside the allow-list are denied even for the site', () => {
  const { request, check } = installed();
  assert.equal(request('midi', 'https://m0ve.app/'), false);
  assert.equal(check('clipboard-read', 'https://m0ve.app'), false);
});
