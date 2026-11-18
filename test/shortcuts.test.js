'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shortcutMap, findConflicts, listAccelerators, normalizeAccelerator, SECTIONS } = require('../src/shortcuts');

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`no accelerator is bound twice on ${platform}`, () => {
    assert.deepEqual(findConflicts(shortcutMap(platform)), []);
  });
}

test('the shortcuts Dave asked for are there', () => {
  const keys = shortcutMap('darwin');
  assert.equal(keys.reload.accelerator, 'CmdOrCtrl+R');
  assert.equal(keys.back.accelerator, 'CmdOrCtrl+[');
  assert.equal(keys.forward.accelerator, 'CmdOrCtrl+]');
  assert.equal(keys.search.accelerator, 'CmdOrCtrl+K');
  assert.equal(keys.settings.accelerator, 'CmdOrCtrl+,');
  assert.equal(keys.zoomIn.accelerator, 'CmdOrCtrl+=');
  assert.equal(keys.zoomOut.accelerator, 'CmdOrCtrl+-');
  assert.equal(keys.resetZoom.accelerator, 'CmdOrCtrl+0');
});

test('Cmd/Ctrl+1–5 open the five main sections, in top-bar order', () => {
  const sections = shortcutMap('win32').sections;
  assert.deepEqual(
    sections.map((s) => [s.accelerator, s.path]),
    [
      ['CmdOrCtrl+1', '/'],
      ['CmdOrCtrl+2', '/all-calendars'],
      ['CmdOrCtrl+3', '/spaces'],
      ['CmdOrCtrl+4', '/messages'],
      ['CmdOrCtrl+5', '/notifications'],
    ],
  );
  for (const section of SECTIONS) assert.match(section.path, /^\/[a-z-]*$/);
});

test('search is the page’s own shortcut, never taken from it', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const { search } = shortcutMap(platform);
    assert.equal(search.ownedByPage, true);
    assert.equal(search.path, '/search');
  }
});

test('Windows and Linux keep Alt+Left/Right and F5; macOS has no such aliases', () => {
  const win = shortcutMap('win32');
  assert.equal(win.backAlt.accelerator, 'Alt+Left');
  assert.equal(win.forwardAlt.accelerator, 'Alt+Right');
  assert.equal(win.reloadAlt.accelerator, 'F5');
  assert.equal(win.fullscreen.accelerator, 'F11');
  const mac = shortcutMap('darwin');
  assert.equal(mac.backAlt, null);
  assert.equal(mac.reloadAlt, null);
  assert.equal(mac.fullscreen.accelerator, 'Ctrl+Cmd+F');
});

test('conflict detection catches the same binding spelled differently', () => {
  assert.equal(normalizeAccelerator('CmdOrCtrl+Shift+R'), normalizeAccelerator('shift+commandorcontrol+r'));
  const map = { a: { accelerator: 'CmdOrCtrl+K' }, b: { accelerator: 'CommandOrControl+k' }, sections: [] };
  assert.equal(findConflicts(map).length, 1);
  assert.equal(listAccelerators(map).length, 2);
});
