'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSplashMachine } = require('../src/splash-state');
const { createFakeTimers, flush } = require('./fake-timers');

function setup(overrides = {}) {
  const timers = createFakeTimers();
  const states = [];
  let reloads = 0;
  const machine = createSplashMachine({
    timers,
    slowAfterMs: 15000,
    autoRetryMs: 5000,
    onChange: (snapshot) => states.push(snapshot.state),
    onReload: () => {
      reloads += 1;
    },
    ...overrides,
  });
  return { machine, timers, states, reloads: () => reloads };
}

test('starts loading and is ready the moment the app is', () => {
  const { machine, timers, states } = setup();
  machine.start();
  assert.equal(machine.state, 'loading');
  timers.advance(800);
  machine.ready();
  assert.deepEqual(states, ['loading', 'ready']);
  assert.equal(timers.pendingCount(), 0, 'no timers left behind');
});

test('a slow load turns into "Still loading…" after 15 s, never a stuck spinner', () => {
  const { machine, timers } = setup();
  machine.start();
  timers.advance(14999);
  assert.equal(machine.state, 'loading');
  timers.advance(1);
  assert.equal(machine.state, 'slow');
  // …and the app can still arrive late.
  machine.ready();
  assert.equal(machine.state, 'ready');
});

test('Retry from the slow state reloads and restarts the clock', () => {
  const { machine, timers, reloads } = setup();
  machine.start();
  timers.advance(15000);
  machine.retry();
  assert.equal(machine.state, 'loading');
  assert.equal(reloads(), 1);
  assert.equal(machine.snapshot().attempt, 1);
  timers.advance(14000);
  assert.equal(machine.state, 'loading');
  timers.advance(1000);
  assert.equal(machine.state, 'slow');
});

test('a failed load goes offline, with the reason', () => {
  const { machine } = setup();
  machine.start();
  machine.failed('ERR_INTERNET_DISCONNECTED (-106)');
  assert.deepEqual(machine.snapshot(), { state: 'offline', reason: 'ERR_INTERNET_DISCONNECTED (-106)', attempt: 0 });
});

test('offline never turns into "slow": the slow timer is cancelled', () => {
  const { machine, timers } = setup({ probe: undefined });
  machine.start();
  machine.failed('x');
  timers.advance(60000);
  assert.equal(machine.state, 'offline');
});

test('offline retries automatically once the site answers again', async () => {
  let reachable = false;
  let probes = 0;
  const { machine, timers, reloads } = setup({
    probe: async () => {
      probes += 1;
      return reachable;
    },
  });
  machine.start();
  machine.failed('offline');

  timers.advance(5000);
  await flush();
  assert.equal(probes, 1);
  assert.equal(machine.state, 'offline', 'still down: stays offline');

  timers.advance(5000);
  await flush();
  assert.equal(probes, 2);

  reachable = true;
  timers.advance(5000);
  await flush();
  assert.equal(machine.state, 'loading');
  assert.equal(reloads(), 1);

  machine.ready();
  assert.equal(machine.state, 'ready');
});

test('a probe that throws counts as unreachable and keeps probing', async () => {
  let calls = 0;
  const { machine, timers } = setup({
    probe: async () => {
      calls += 1;
      throw new Error('boom');
    },
  });
  machine.start();
  machine.failed('x');
  timers.advance(5000);
  await flush();
  timers.advance(5000);
  await flush();
  assert.equal(calls, 2);
  assert.equal(machine.state, 'offline');
});

test('the Retry button (or the page coming online) retries straight away', () => {
  const { machine, reloads } = setup();
  machine.start();
  machine.failed('x');
  machine.retry();
  assert.equal(machine.state, 'loading');
  assert.equal(reloads(), 1);
});

test('retry while a load is already fresh does nothing', () => {
  const { machine, reloads } = setup();
  machine.start();
  machine.retry();
  assert.equal(reloads(), 0);
});

test('ready is terminal: late failures, retries and timers are ignored', async () => {
  const { machine, timers, states, reloads } = setup({ probe: async () => true });
  machine.start();
  machine.ready();
  machine.failed('late');
  machine.retry();
  timers.advance(60000);
  await flush();
  assert.equal(machine.state, 'ready');
  assert.deepEqual(states, ['loading', 'ready']);
  assert.equal(reloads(), 0);
});

test('a retry that fails again goes back offline', () => {
  const { machine } = setup();
  machine.start();
  machine.failed('a');
  machine.retry();
  machine.failed('b');
  assert.equal(machine.state, 'offline');
  assert.equal(machine.snapshot().reason, 'b');
});

test('dispose cancels every timer', async () => {
  const { machine, timers } = setup({ probe: async () => true });
  machine.start();
  machine.dispose();
  assert.equal(timers.pendingCount(), 0);
  machine.failed('x');
  machine.dispose();
  assert.equal(timers.pendingCount(), 0);
});

test('events before start() are ignored', () => {
  const { machine } = setup();
  machine.failed('x');
  machine.retry();
  assert.equal(machine.state, null);
});
