'use strict';

// The shell's toast queue: what is on screen, for how long, and in what order.
//
// The visual treatment and the timing rules follow the Configure My AI flash
// toasts (shared/_toast.html.erb, toast_controller.js, toast_region_controller.js
// in that repo), adapted to Move:
//
//   * a bottom-right stack, newest nearest the corner, at most 3 visible —
//     a fourth pushes the oldest out;
//   * success / info close themselves after 4 s; error / warning stay until
//     dismissed; a toast with an action button stays too, because the user
//     has to be able to reach the button;
//   * hovering or focusing a toast pauses its countdown, leaving resumes it
//     with whatever time it had left;
//   * a toast can carry a `key`: showing another with the same key replaces
//     it in place (the offline banner becoming "Back online", say) instead of
//     stacking a second one.
//
// Pure: no Electron, no DOM, injected timers (test/toast-queue.test.js).
// src/toasts.js owns one queue per window and sends `onRender`'s list to the
// page, where src/preload.js draws it.

const VARIANTS = Object.freeze(['success', 'error', 'warning', 'info']);
const MAX_VISIBLE = 3;
const AUTO_CLOSE_MS = 4000;
// The CSS animation lengths, mirrored in src/preload.js.
const ENTER_MS = 240;
const LEAVE_MS = 180;

const MAX_TITLE = 160;
const MAX_DETAIL = 400;
const MAX_ACTIONS = 2;

function clip(value, max) {
  if (value === undefined || value === null) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizeVariant(variant) {
  return VARIANTS.includes(variant) ? variant : 'info';
}

function normalizeActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions
    .filter((action) => action && typeof action.id === 'string' && action.id && action.label)
    .slice(0, MAX_ACTIONS)
    .map((action) => ({ id: action.id, label: clip(action.label, 40) }));
}

// How long a toast stays up, in ms; 0 means until dismissed.
function resolveDuration({ variant, actions, durationMs }) {
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) return durationMs;
  if (actions && actions.length > 0) return 0;
  if (variant === 'error' || variant === 'warning') return 0;
  return AUTO_CLOSE_MS;
}

function createToastQueue(options = {}) {
  const maxVisible = options.maxVisible ?? MAX_VISIBLE;
  const timers = options.timers || { setTimeout, clearTimeout };
  const now = options.now || Date.now;
  const onRender = options.onRender || (() => {});
  const onAction = options.onAction || (() => {});
  const onDismiss = options.onDismiss || (() => {});

  // Oldest first. Each: { toast, duration, deadline, remaining, timer, handlers }
  const entries = [];
  let nextId = 1;

  const find = (id) => entries.find((entry) => entry.toast.id === id);

  function render() {
    onRender(entries.map((entry) => ({ ...entry.toast, actions: entry.toast.actions.map((a) => ({ ...a })) })));
  }

  function stopTimer(entry) {
    if (entry.timer) timers.clearTimeout(entry.timer);
    entry.timer = null;
  }

  function startTimer(entry, ms) {
    stopTimer(entry);
    if (entry.duration <= 0) return;
    entry.remaining = ms;
    entry.deadline = now() + ms;
    entry.timer = timers.setTimeout(() => {
      entry.timer = null;
      remove(entry.toast.id, 'timeout');
    }, ms);
  }

  function remove(id, why) {
    const index = entries.findIndex((entry) => entry.toast.id === id);
    if (index === -1) return false;
    const [entry] = entries.splice(index, 1);
    stopTimer(entry);
    render();
    onDismiss(entry.toast, why);
    if (typeof entry.handlers.onDismiss === 'function') entry.handlers.onDismiss(why);
    return true;
  }

  // Show a toast; returns its id.
  //   { variant, title, detail?, actions?: [{ id, label }], durationMs?,
  //     dismissible?, key?, onAction?(actionId), onDismiss?(why) }
  function show(input = {}) {
    const variant = normalizeVariant(input.variant);
    const actions = normalizeActions(input.actions);
    const key = typeof input.key === 'string' && input.key ? input.key : null;
    const duration = resolveDuration({ variant, actions, durationMs: input.durationMs });
    const toast = {
      id: `t${nextId++}`,
      key,
      variant,
      title: clip(input.title, MAX_TITLE) || 'Move',
      detail: clip(input.detail, MAX_DETAIL),
      actions,
      // Matches the reference: a toast with an action has no close button
      // unless asked for, because the action (or "Later") is the way out.
      dismissible: typeof input.dismissible === 'boolean' ? input.dismissible : actions.length === 0,
      role: variant === 'error' ? 'alert' : 'status',
    };
    const entry = {
      toast,
      duration,
      deadline: null,
      remaining: duration,
      timer: null,
      paused: false,
      handlers: { onAction: input.onAction, onDismiss: input.onDismiss },
    };

    const existing = key ? entries.findIndex((e) => e.toast.key === key) : -1;
    if (existing !== -1) {
      // Replace in place: same slot, fresh content and timer. The old one is
      // superseded, not dismissed, so its onDismiss does not run.
      stopTimer(entries[existing]);
      entries[existing] = entry;
    } else {
      entries.push(entry);
      while (entries.length > maxVisible) {
        const oldest = entries.shift();
        stopTimer(oldest);
        onDismiss(oldest.toast, 'overflow');
        if (typeof oldest.handlers.onDismiss === 'function') oldest.handlers.onDismiss('overflow');
      }
    }
    startTimer(entry, duration);
    render();
    return toast.id;
  }

  function dismiss(id) {
    return remove(id, 'dismissed');
  }

  function dismissKey(key) {
    const entry = entries.find((e) => e.toast.key === key);
    return entry ? remove(entry.toast.id, 'dismissed') : false;
  }

  // Pointer or focus entered the toast: hold the countdown.
  function pause(id) {
    const entry = find(id);
    if (!entry || entry.duration <= 0 || entry.paused) return false;
    entry.paused = true;
    entry.remaining = Math.max(0, entry.deadline - now());
    stopTimer(entry);
    return true;
  }

  // …and left it: carry on with the time that was left.
  function resume(id) {
    const entry = find(id);
    if (!entry || entry.duration <= 0 || !entry.paused) return false;
    entry.paused = false;
    startTimer(entry, entry.remaining);
    return true;
  }

  // An action button was pressed. The toast closes either way.
  function action(id, actionId) {
    const entry = find(id);
    if (!entry || !entry.toast.actions.some((a) => a.id === actionId)) return false;
    onAction(entry.toast, actionId);
    if (typeof entry.handlers.onAction === 'function') entry.handlers.onAction(actionId);
    remove(id, 'action');
    return true;
  }

  function has(id) {
    return Boolean(find(id));
  }

  function list() {
    return entries.map((entry) => ({ ...entry.toast }));
  }

  // Re-send the current list (after a full page load wiped the drawing).
  function rerender() {
    render();
  }

  function clear() {
    for (const entry of entries) stopTimer(entry);
    entries.length = 0;
    render();
  }

  return { show, dismiss, dismissKey, pause, resume, action, has, list, rerender, clear };
}

module.exports = {
  createToastQueue,
  resolveDuration,
  VARIANTS,
  MAX_VISIBLE,
  AUTO_CLOSE_MS,
  ENTER_MS,
  LEAVE_MS,
};
