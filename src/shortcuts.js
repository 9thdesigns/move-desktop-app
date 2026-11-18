'use strict';

// Keyboard shortcuts the menu bar installs, per platform.
//
// Pure data and functions with no Electron dependency, so the map can be unit
// tested (test/shortcuts.test.js) and src/menu.js only has to turn it into
// menu items.
//
// Two kinds of shortcut live here:
//
//   * ones the shell owns outright (reload, back/forward, sections, settings);
//     the menu registers their accelerators normally;
//   * ones the site already implements itself. Cmd/Ctrl+K is the site's
//     global search, and on a calendar page it is that calendar's own search.
//     The shell must never swallow the keystroke before the page sees it, so
//     the menu only *displays* it. On macOS Chromium offers a key equivalent
//     to the page first and only falls back to the menu when the page did not
//     handle it; on Windows and Linux the accelerator is not registered at all
//     (`registerAccelerator: false`). Choosing the item with the mouse sends
//     the page the same keystroke (src/preload.js), with /search as the
//     fallback when nothing on the page takes it.

// The site's main sections, in the order of its top bar. Every path is a real
// route on m0ve.app (config/routes.rb in m0ve-web).
const SECTIONS = Object.freeze([
  Object.freeze({ id: 'home', label: 'Home', path: '/' }),
  Object.freeze({ id: 'calendars', label: 'Calendars', path: '/all-calendars' }),
  Object.freeze({ id: 'spaces', label: 'Spaces', path: '/spaces' }),
  Object.freeze({ id: 'messages', label: 'Messages', path: '/messages' }),
  Object.freeze({ id: 'notifications', label: 'Notifications', path: '/notifications' }),
]);

// Account settings (Devise's edit registration, mounted at the root).
const SETTINGS_PATH = '/edit';
const SEARCH_PATH = '/search';

function shortcutMap(platform = process.platform) {
  const isMac = platform === 'darwin';
  return {
    newWindow: { accelerator: 'CmdOrCtrl+N' },
    reload: { accelerator: 'CmdOrCtrl+R' },
    forceReload: { accelerator: 'CmdOrCtrl+Shift+R' },
    // F5 is what Windows users reach for; it is a second binding, not a menu row.
    reloadAlt: isMac ? null : { accelerator: 'F5' },

    back: { accelerator: 'CmdOrCtrl+[' },
    forward: { accelerator: 'CmdOrCtrl+]' },
    // The Windows / Linux browser convention, kept from earlier releases.
    backAlt: isMac ? null : { accelerator: 'Alt+Left' },
    forwardAlt: isMac ? null : { accelerator: 'Alt+Right' },
    home: { accelerator: 'CmdOrCtrl+Shift+H' },

    search: { accelerator: 'CmdOrCtrl+K', ownedByPage: true, path: SEARCH_PATH },
    settings: { accelerator: 'CmdOrCtrl+,', path: SETTINGS_PATH },

    // The zoom roles' own default (CmdOrCtrl+Plus) needs Shift on most
    // layouts; = is the key people press. Plus stays as a hidden alias.
    zoomIn: { accelerator: 'CmdOrCtrl+=' },
    zoomInAlt: { accelerator: 'CmdOrCtrl+Plus' },
    zoomOut: { accelerator: 'CmdOrCtrl+-' },
    resetZoom: { accelerator: 'CmdOrCtrl+0' },
    fullscreen: { accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11' },

    sections: SECTIONS.map((section, index) => ({ ...section, accelerator: `CmdOrCtrl+${index + 1}` })),
  };
}

// Every accelerator the map binds, flattened, for conflict checks.
function listAccelerators(map) {
  const out = [];
  for (const [name, entry] of Object.entries(map)) {
    if (name === 'sections') {
      for (const section of entry) out.push({ name: `section:${section.id}`, accelerator: section.accelerator });
    } else if (entry) {
      out.push({ name, accelerator: entry.accelerator });
    }
  }
  return out;
}

// "CmdOrCtrl+Shift+R" and "shift+cmdorctrl+r" are the same binding.
function normalizeAccelerator(accelerator) {
  return String(accelerator)
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .map((part) => (part === 'commandorcontrol' ? 'cmdorctrl' : part === 'command' ? 'cmd' : part === 'control' ? 'ctrl' : part))
    .sort()
    .join('+');
}

// Accelerators bound to more than one action. Empty is the only right answer.
function findConflicts(map) {
  const seen = new Map();
  const conflicts = [];
  for (const { name, accelerator } of listAccelerators(map)) {
    const key = normalizeAccelerator(accelerator);
    if (seen.has(key)) conflicts.push({ accelerator, names: [seen.get(key), name] });
    else seen.set(key, name);
  }
  return conflicts;
}

module.exports = { SECTIONS, SETTINGS_PATH, SEARCH_PATH, shortcutMap, listAccelerators, normalizeAccelerator, findConflicts };
