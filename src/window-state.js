'use strict';

// Remembers where the main window was between launches.
//
// The state file lives in the app's userData directory. Saved bounds are only
// reused when they still land on a connected display, so a window that was
// last seen on an unplugged monitor does not open off-screen.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SIZE = { width: 1280, height: 820 };
const MIN_VISIBLE = 120;

function stateFile(app) {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function read(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!state || typeof state !== 'object') return null;
    const { x, y, width, height } = state;
    if (![x, y, width, height].every(isNumber)) return null;
    if (width < 400 || height < 300) return null;
    return { x, y, width, height, isMaximized: Boolean(state.isMaximized) };
  } catch (_) {
    return null;
  }
}

function overlaps(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w >= MIN_VISIBLE && h >= MIN_VISIBLE;
}

function onSomeDisplay(bounds, screen) {
  return screen.getAllDisplays().some((display) => overlaps(display.workArea, bounds));
}

// Bounds to open with: the saved ones when they are still visible, otherwise a
// sensible default centred on the primary display.
function restore({ app, screen }) {
  const saved = read(stateFile(app));
  if (saved && onSomeDisplay(saved, screen)) return saved;

  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(DEFAULT_SIZE.width, workArea.width);
  const height = Math.min(DEFAULT_SIZE.height, workArea.height);
  return {
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    isMaximized: false,
  };
}

// Persist the window's bounds as it is resized/moved (debounced) and on close.
function track(win, { app }) {
  const file = stateFile(app);
  let timer = null;

  const save = () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized() || win.isFullScreen()) return;
    const isMaximized = win.isMaximized();
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
    const state = { ...bounds, isMaximized };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state));
    } catch (_) {
      // Nothing to do: losing window placement is not worth surfacing.
    }
  };

  const scheduleSave = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };

  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('maximize', scheduleSave);
  win.on('unmaximize', scheduleSave);
  win.on('close', () => {
    clearTimeout(timer);
    save();
  });
}

module.exports = { restore, track, DEFAULT_SIZE };
