'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const badge = require('../src/badge');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

function fakes({ empty = false } = {}) {
  const calls = { counts: [], overlays: [] };
  return {
    calls,
    app: { setBadgeCount: (n) => calls.counts.push(n) },
    win: {
      isDestroyed: () => false,
      setOverlayIcon: (image, description) => calls.overlays.push([image, description]),
    },
    nativeImage: { createFromDataURL: (url) => ({ url, isEmpty: () => empty }) },
  };
}

test('a count from the page is normalised before it reaches the OS', () => {
  assert.equal(badge.normalizeCount(7), 7);
  assert.equal(badge.normalizeCount('12'), 12);
  assert.equal(badge.normalizeCount(3.7), 3);
  assert.equal(badge.normalizeCount(0), 0);
  assert.equal(badge.normalizeCount(-4), 0);
  assert.equal(badge.normalizeCount('lots'), 0);
  assert.equal(badge.normalizeCount(undefined), 0);
  assert.equal(badge.normalizeCount(Infinity), 0);
});

test('macOS gets the number and no overlay', () => {
  const { app, win, nativeImage, calls } = fakes();
  assert.equal(badge.apply({ app, win, nativeImage, platform: 'darwin', count: 5 }), 5);
  assert.deepEqual(calls.counts, [5]);
  assert.equal(calls.overlays.length, 0);
});

test('Windows gets the drawn overlay, and loses it at zero', () => {
  const { app, win, nativeImage, calls } = fakes();
  badge.apply({ app, win, nativeImage, platform: 'win32', count: 3, overlayDataUrl: PNG });
  assert.equal(calls.overlays[0][0].url, PNG);
  assert.equal(calls.overlays[0][1], '3 unread items');

  badge.apply({ app, win, nativeImage, platform: 'win32', count: 0, overlayDataUrl: PNG });
  assert.deepEqual(calls.overlays[1], [null, '']);
});

test('the taskbar is cleared rather than left saying the wrong number', () => {
  // Anything that is not a PNG data URL we could have drawn, and an image the
  // OS refused to decode, both clear — a stale badge is worse than none.
  for (const overlayDataUrl of ['data:image/svg+xml,<svg/>', 'https://example.com/x.png', 'x'.repeat(badge.MAX_OVERLAY_CHARS + 1), null]) {
    const { app, win, nativeImage, calls } = fakes();
    badge.apply({ app, win, nativeImage, platform: 'win32', count: 2, overlayDataUrl });
    assert.deepEqual(calls.overlays, [[null, '']]);
  }

  const { app, win, nativeImage, calls } = fakes({ empty: true });
  badge.apply({ app, win, nativeImage, platform: 'win32', count: 2, overlayDataUrl: PNG });
  assert.deepEqual(calls.overlays, [[null, '']]);
});

test('one unread item is not "1 unread items"', () => {
  assert.equal(badge.describeCount(1), '1 unread item');
  assert.equal(badge.describeCount(2), '2 unread items');
});

test('a closed window is not badged', () => {
  const { app, nativeImage, calls } = fakes();
  const win = { isDestroyed: () => true, setOverlayIcon: () => calls.overlays.push('nope') };
  badge.apply({ app, win, nativeImage, platform: 'win32', count: 4, overlayDataUrl: PNG });
  assert.equal(calls.overlays.length, 0);
});
