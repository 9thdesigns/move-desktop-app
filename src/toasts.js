'use strict';

// Shell-native toasts: update notices, the offline banner, errors.
//
// The main process owns one queue per window (src/toast-queue.js decides what
// is visible and for how long); src/preload.js draws whatever list it is sent.
// Only pages the shell trusts get toasts: the site itself and the bundled
// offline page. A provider's sign-in page loaded for an OAuth round trip never
// does — `show()` returns false there and the caller falls back to a dialog.

const { createToastQueue } = require('./toast-queue');

const CHANNEL_RENDER = 'move:toasts';
const CHANNEL_EVENT = 'move:toast-event';

const queues = new WeakMap(); // webContents → queue
let isToastPage = () => false;

function queueFor(contents) {
  let queue = queues.get(contents);
  if (queue) return queue;
  queue = createToastQueue({
    onRender: (list) => {
      if (contents.isDestroyed() || !isToastPage(contents.getURL())) return;
      contents.send(CHANNEL_RENDER, list);
    },
  });
  queues.set(contents, queue);
  // A full page load wipes the drawing; the queue (and its timers) live on
  // here, so put it back as soon as the new document can take it.
  contents.on('dom-ready', () => queue.rerender());
  contents.once('destroyed', () => queues.delete(contents));
  return queue;
}

function install({ ipcMain, isToastPage: predicate }) {
  isToastPage = predicate;
  ipcMain.on(CHANNEL_EVENT, (event, payload) => {
    const queue = queues.get(event.sender);
    if (!queue || !payload || typeof payload.id !== 'string') return;
    if (!isToastPage(event.sender.getURL())) return;
    switch (payload.type) {
      case 'dismiss':
        queue.dismiss(payload.id);
        break;
      case 'pause':
        queue.pause(payload.id);
        break;
      case 'resume':
        queue.resume(payload.id);
        break;
      case 'action':
        if (typeof payload.actionId === 'string') queue.action(payload.id, payload.actionId);
        break;
      default:
        break;
    }
  });
}

// Show a toast in `win`. Returns the toast id, or null when this window cannot
// show one right now (no window, or it is on a page that is not ours).
function show(win, options) {
  if (!win || win.isDestroyed()) return null;
  const contents = win.webContents;
  if (!contents || contents.isDestroyed() || !isToastPage(contents.getURL())) return null;
  return queueFor(contents).show(options);
}

function dismissKey(win, key) {
  if (!win || win.isDestroyed()) return false;
  const queue = queues.get(win.webContents);
  return queue ? queue.dismissKey(key) : false;
}

module.exports = { install, show, dismissKey, CHANNEL_RENDER, CHANNEL_EVENT };
