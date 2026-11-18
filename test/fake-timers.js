'use strict';

// A tiny manual clock for the pure state machines: setTimeout/clearTimeout
// that only fire when the test advances time.
function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map(); // id → { at, fn }

  const setTimeout = (fn, ms) => {
    const id = nextId++;
    pending.set(id, { at: now + Math.max(0, ms || 0), fn });
    return id;
  };
  const clearTimeout = (id) => {
    pending.delete(id);
  };

  // Run every timer due by now + ms, in order, including ones they schedule.
  const advance = (ms) => {
    const until = now + ms;
    for (;;) {
      let nextIdKey = null;
      let next = null;
      for (const [id, timer] of pending) {
        if (timer.at <= until && (!next || timer.at < next.at)) {
          next = timer;
          nextIdKey = id;
        }
      }
      if (!next) break;
      pending.delete(nextIdKey);
      now = next.at;
      next.fn();
    }
    now = until;
  };

  return { setTimeout, clearTimeout, advance, now: () => now, pendingCount: () => pending.size };
}

// Let queued promise callbacks (an async probe) run.
const flush = () => new Promise((resolve) => setImmediate(resolve));

module.exports = { createFakeTimers, flush };
