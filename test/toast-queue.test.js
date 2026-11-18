'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createToastQueue, resolveDuration, AUTO_CLOSE_MS, MAX_VISIBLE } = require('../src/toast-queue');
const { createFakeTimers } = require('./fake-timers');

function setup() {
  const timers = createFakeTimers();
  const renders = [];
  const actions = [];
  const dismissed = [];
  const queue = createToastQueue({
    timers,
    now: timers.now,
    onRender: (list) => renders.push(list),
    onAction: (toast, id) => actions.push([toast.title, id]),
    onDismiss: (toast, why) => dismissed.push([toast.title, why]),
  });
  const titles = () => queue.list().map((t) => t.title);
  return { queue, timers, renders, actions, dismissed, titles };
}

test('durations follow the reference: success/info 4 s, error/warning and actions sticky', () => {
  assert.equal(AUTO_CLOSE_MS, 4000);
  assert.equal(resolveDuration({ variant: 'success', actions: [] }), 4000);
  assert.equal(resolveDuration({ variant: 'info', actions: [] }), 4000);
  assert.equal(resolveDuration({ variant: 'error', actions: [] }), 0);
  assert.equal(resolveDuration({ variant: 'warning', actions: [] }), 0);
  assert.equal(resolveDuration({ variant: 'success', actions: [{ id: 'x', label: 'X' }] }), 0);
  assert.equal(resolveDuration({ variant: 'error', actions: [], durationMs: 8000 }), 8000);
});

test('a success toast closes itself after 4 s', () => {
  const { queue, timers, titles, dismissed } = setup();
  queue.show({ variant: 'success', title: 'Saved' });
  timers.advance(3999);
  assert.deepEqual(titles(), ['Saved']);
  timers.advance(1);
  assert.deepEqual(titles(), []);
  assert.deepEqual(dismissed, [['Saved', 'timeout']]);
});

test('errors and warnings stay until dismissed', () => {
  const { queue, timers, titles } = setup();
  const id = queue.show({ variant: 'error', title: 'Nope' });
  queue.show({ variant: 'warning', title: 'Careful' });
  timers.advance(60000);
  assert.deepEqual(titles(), ['Nope', 'Careful']);
  queue.dismiss(id);
  assert.deepEqual(titles(), ['Careful']);
});

test('hover pauses the countdown and leaving resumes with the time left', () => {
  const { queue, timers, titles } = setup();
  const id = queue.show({ variant: 'info', title: 'Hi' });
  timers.advance(3000);
  assert.equal(queue.pause(id), true);
  timers.advance(20000);
  assert.deepEqual(titles(), ['Hi'], 'held while hovered');
  assert.equal(queue.resume(id), true);
  timers.advance(999);
  assert.deepEqual(titles(), ['Hi']);
  timers.advance(1);
  assert.deepEqual(titles(), []);
});

test('pause/resume are no-ops on sticky toasts and unknown ids', () => {
  const { queue } = setup();
  const id = queue.show({ variant: 'error', title: 'x' });
  assert.equal(queue.pause(id), false);
  assert.equal(queue.resume(id), false);
  assert.equal(queue.pause('nope'), false);
});

test('at most three are visible; a fourth pushes the oldest out', () => {
  const { queue, titles, dismissed } = setup();
  assert.equal(MAX_VISIBLE, 3);
  for (const t of ['a', 'b', 'c', 'd']) queue.show({ variant: 'error', title: t });
  assert.deepEqual(titles(), ['b', 'c', 'd']);
  assert.deepEqual(dismissed, [['a', 'overflow']]);
});

test('the same key replaces in place instead of stacking', () => {
  const { queue, timers, titles, dismissed } = setup();
  queue.show({ variant: 'error', title: 'first' });
  queue.show({ key: 'connectivity', variant: 'warning', title: 'You’re offline' });
  queue.show({ variant: 'error', title: 'last' });
  queue.show({ key: 'connectivity', variant: 'success', title: 'Back online' });
  assert.deepEqual(titles(), ['first', 'Back online', 'last']);
  assert.deepEqual(dismissed, [], 'replaced, not dismissed');
  timers.advance(4000);
  assert.deepEqual(titles(), ['first', 'last'], 'the replacement got its own timer');
});

test('an action runs its handler and closes the toast', () => {
  const { queue, actions, titles } = setup();
  let ran = null;
  const id = queue.show({
    variant: 'info',
    title: 'Update ready',
    actions: [{ id: 'restart', label: 'Restart' }],
    onAction: (actionId) => {
      ran = actionId;
    },
  });
  assert.equal(queue.list()[0].dismissible, false, 'action toasts have no ✕ unless asked');
  assert.equal(queue.action(id, 'bogus'), false);
  assert.equal(queue.action(id, 'restart'), true);
  assert.equal(ran, 'restart');
  assert.deepEqual(actions, [['Update ready', 'restart']]);
  assert.deepEqual(titles(), []);
});

test('onDismiss handlers run for dismiss, timeout and overflow', () => {
  const { queue, timers } = setup();
  const why = [];
  queue.show({ variant: 'success', title: 't', onDismiss: (w) => why.push(w) });
  timers.advance(4000);
  const id = queue.show({ variant: 'error', title: 'd', onDismiss: (w) => why.push(w) });
  queue.dismiss(id);
  queue.show({ variant: 'error', title: 'o', onDismiss: (w) => why.push(w) });
  queue.show({ variant: 'error', title: '2' });
  queue.show({ variant: 'error', title: '3' });
  queue.show({ variant: 'error', title: '4' });
  assert.deepEqual(why, ['timeout', 'dismissed', 'overflow']);
});

test('input is cleaned: unknown variants become info, text is clipped, actions capped', () => {
  const { queue } = setup();
  queue.show({
    variant: 'purple',
    title: `  ${'x'.repeat(500)}  `,
    detail: 'a\n\nb',
    actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }, { label: 'no id' }],
  });
  const [toast] = queue.list();
  assert.equal(toast.variant, 'info');
  assert.equal(toast.title.length, 160);
  assert.equal(toast.detail, 'a b');
  assert.deepEqual(toast.actions.map((a) => a.id), ['a', 'b']);
  assert.equal(toast.role, 'status');
  queue.show({ variant: 'error', title: '' });
  assert.equal(queue.list()[1].title, 'Move');
  assert.equal(queue.list()[1].role, 'alert');
});

test('every change renders the full list, and rerender re-sends it', () => {
  const { queue, renders } = setup();
  queue.show({ variant: 'error', title: 'a' });
  queue.show({ variant: 'error', title: 'b' });
  queue.rerender();
  assert.deepEqual(renders.map((list) => list.map((t) => t.title)), [['a'], ['a', 'b'], ['a', 'b']]);
});

test('dismissKey and clear', () => {
  const { queue, timers, titles } = setup();
  queue.show({ key: 'k', variant: 'info', title: 'keyed' });
  queue.show({ variant: 'info', title: 'other' });
  assert.equal(queue.dismissKey('k'), true);
  assert.equal(queue.dismissKey('k'), false);
  queue.clear();
  assert.deepEqual(titles(), []);
  assert.equal(timers.pendingCount(), 0);
});
