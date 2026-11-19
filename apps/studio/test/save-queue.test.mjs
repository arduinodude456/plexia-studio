import test from 'node:test';
import assert from 'node:assert/strict';
import { LatestSaveQueue } from '../src/lib/saveQueue.ts';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('serializes writes and keeps the newest edit when flushes overlap', async () => {
  const first = deferred();
  const writes = [];
  let concurrent = 0, peak = 0;
  const queue = new LatestSaveQueue(async (value) => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    writes.push(value);
    if (value === 'first') await first.promise;
    concurrent--;
  });
  queue.enqueue('deck', 'first');
  const one = queue.flush();
  queue.enqueue('deck', 'middle');
  queue.enqueue('deck', 'latest');
  const two = queue.flush();
  const three = queue.flush();
  first.resolve();
  await Promise.all([one, two, three]);
  assert.deepEqual(writes, ['first', 'latest']);
  assert.equal(peak, 1);
  assert.equal(queue.busy, false);
});

test('retains newer edits after a failed save and succeeds on retry', async () => {
  const first = deferred();
  const writes = [];
  const queue = new LatestSaveQueue(async (value) => {
    writes.push(value);
    if (value === 'old') await first.promise;
  });
  queue.enqueue('deck', 'old');
  const failed = queue.flush();
  queue.enqueue('deck', 'new');
  first.reject(new Error('offline'));
  await assert.rejects(failed, /offline/);
  assert.equal(queue.hasPending, true);
  await queue.flush();
  assert.deepEqual(writes, ['old', 'new']);
  assert.equal(queue.busy, false);
});

test('failed saves without newer edits are retained for retry', async () => {
  let attempts = 0;
  const queue = new LatestSaveQueue(async () => {
    if (++attempts === 1) throw new Error('offline');
  });
  queue.enqueue('deck', 'only version');
  await assert.rejects(queue.flush(), /offline/);
  assert.equal(queue.hasPending, true);
  await queue.flush();
  assert.equal(attempts, 2);
  assert.equal(queue.busy, false);
});
