'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const windowState = require('../src/window-state');

const PRIMARY = { workArea: { x: 0, y: 25, width: 1440, height: 875 } };

function fakeApp(saved) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'move-ws-'));
  if (saved) fs.writeFileSync(path.join(dir, 'window-state.json'), JSON.stringify(saved));
  return { getPath: () => dir };
}

const screenOf = (...displays) => ({ getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0] });

test('no saved state: the default size, centred on the primary display', () => {
  const bounds = windowState.restore({ app: fakeApp(null), screen: screenOf(PRIMARY) });
  assert.deepEqual(bounds, { width: 1280, height: 820, x: 80, y: 53, isMaximized: false });
});

test('saved bounds on a connected display come back as they were', () => {
  const saved = { x: 100, y: 80, width: 1000, height: 700, isMaximized: true };
  assert.deepEqual(windowState.restore({ app: fakeApp(saved), screen: screenOf(PRIMARY) }), saved);
});

test('bounds from an unplugged monitor fall back to the default', () => {
  const saved = { x: 3000, y: 80, width: 1000, height: 700 };
  const bounds = windowState.restore({ app: fakeApp(saved), screen: screenOf(PRIMARY) });
  assert.equal(bounds.width, 1280);
  assert.equal(bounds.x, 80);
});

test('a window saved bigger than its display shrinks to fit it', () => {
  const saved = { x: 0, y: 25, width: 2560, height: 1400 };
  const bounds = windowState.restore({ app: fakeApp(saved), screen: screenOf(PRIMARY) });
  assert.deepEqual({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, { x: 0, y: 25, width: 1440, height: 875 });
});

test('a title bar above the top of the screen is brought back down', () => {
  const fitted = windowState.fitToWorkArea({ x: 200, y: -300, width: 900, height: 700 }, PRIMARY.workArea);
  assert.equal(fitted.y, 25);
  assert.equal(fitted.x, 200);
});

test('a window parked half off the side stays where it was', () => {
  const fitted = windowState.fitToWorkArea({ x: 1100, y: 100, width: 900, height: 700 }, PRIMARY.workArea);
  assert.equal(fitted.x, 1100);
  assert.equal(fitted.width, 900);
});

test('fitting never goes below the minimum window size (unless the display is smaller)', () => {
  assert.deepEqual(windowState.MIN_SIZE, { width: 720, height: 480 });
  const fitted = windowState.fitToWorkArea({ x: 0, y: 0, width: 500, height: 300 }, PRIMARY.workArea);
  assert.equal(fitted.width, 720);
  assert.equal(fitted.height, 480);
  const tiny = windowState.fitToWorkArea({ x: 0, y: 0, width: 1000, height: 800 }, { x: 0, y: 0, width: 640, height: 400 });
  assert.equal(tiny.width, 640);
  assert.equal(tiny.height, 400);
});
