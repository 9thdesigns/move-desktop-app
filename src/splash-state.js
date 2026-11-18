'use strict';

// The launch splash's state machine.
//
// Pure: no Electron, and time comes from injected timers, so every path —
// including the ones that take fifteen seconds in real life — is unit tested
// (test/splash-state.test.js). src/splash.js wires it to the window.
//
//   loading ──(slowAfterMs)──▶ slow          "Still loading…" + Retry
//      │  ▲                     │
//      │  └──── retry() ────────┤
//      │                        │
//      ├──── failed() ─────────▶ offline      Retry, plus an automatic retry
//      │                        │             whenever probe() says the site
//      │                        │             is reachable again
//      └──── ready() ──────────▶ ready        terminal: the splash goes away
//
// The guarantee is that the user is never left looking at a spinner with no
// way out: `loading` always becomes `slow` (with a Retry button) on a timer,
// and `offline` keeps retrying on its own as well as offering the button.

const STATES = Object.freeze(['loading', 'slow', 'offline', 'ready']);

const DEFAULTS = Object.freeze({
  slowAfterMs: 15 * 1000,
  autoRetryMs: 5 * 1000,
});

function createSplashMachine(options = {}) {
  const slowAfterMs = options.slowAfterMs ?? DEFAULTS.slowAfterMs;
  const autoRetryMs = options.autoRetryMs ?? DEFAULTS.autoRetryMs;
  const timers = options.timers || { setTimeout, clearTimeout };
  const onChange = options.onChange || (() => {});
  // Called to (re)start loading the app. The machine never loads anything itself.
  const onReload = options.onReload || (() => {});
  // Resolves true when the site answers again. Optional: without it, offline
  // only leaves through retry() (the button, or the page's `online` event).
  const probe = options.probe || null;

  let state = null;
  let reason = null;
  let attempt = 0;
  let slowTimer = null;
  let retryTimer = null;
  let probing = false;

  const snapshot = () => ({ state, reason, attempt });

  function clearTimers() {
    if (slowTimer) timers.clearTimeout(slowTimer);
    if (retryTimer) timers.clearTimeout(retryTimer);
    slowTimer = null;
    retryTimer = null;
  }

  function set(next, nextReason = null) {
    state = next;
    reason = nextReason;
    onChange(snapshot());
  }

  function enterLoading() {
    clearTimers();
    set('loading');
    slowTimer = timers.setTimeout(() => {
      slowTimer = null;
      if (state === 'loading') set('slow');
    }, slowAfterMs);
  }

  function scheduleProbe() {
    if (!probe || state !== 'offline') return;
    retryTimer = timers.setTimeout(async () => {
      retryTimer = null;
      if (state !== 'offline' || probing) return;
      probing = true;
      let reachable = false;
      try {
        reachable = Boolean(await probe());
      } catch (_) {
        reachable = false;
      } finally {
        probing = false;
      }
      if (state !== 'offline') return;
      if (reachable) retry();
      else scheduleProbe();
    }, autoRetryMs);
  }

  // Begin the first load. Calling it again is a no-op.
  function start() {
    if (state !== null) return snapshot();
    enterLoading();
    return snapshot();
  }

  // The app's content is ready: the splash can go.
  function ready() {
    if (state === 'ready') return snapshot();
    clearTimers();
    set('ready');
    return snapshot();
  }

  // The main frame failed to load (offline, DNS, TLS, 5xx page…).
  function failed(why) {
    if (state === 'ready' || state === null) return snapshot();
    clearTimers();
    set('offline', typeof why === 'string' && why ? why : null);
    scheduleProbe();
    return snapshot();
  }

  // Try again now: from the button, from the page's `online` event, or from a
  // successful probe. Ignored once ready, and while a load is already fresh.
  function retry() {
    if (state === 'ready' || state === null || state === 'loading') return snapshot();
    attempt += 1;
    enterLoading();
    onReload(snapshot());
    return snapshot();
  }

  // The window went away before the app was ready.
  function dispose() {
    clearTimers();
  }

  return {
    start,
    ready,
    failed,
    retry,
    dispose,
    get state() {
      return state;
    },
    snapshot,
  };
}

module.exports = { createSplashMachine, STATES, DEFAULTS };
