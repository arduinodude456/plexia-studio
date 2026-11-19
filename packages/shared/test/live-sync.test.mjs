import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotScheduler, updateClassSession } from '../src/backend.ts';

globalThis.window = globalThis;
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

test('a newer event invalidates an in-flight snapshot and coalesces events into one trailing read', async () => {
  const first = deferred(); const applied = []; let calls = 0;
  const scheduler = createSnapshotScheduler(async (current) => {
    const n = ++calls; if (n === 1) await first.promise;
    if (current()) applied.push(n);
  });
  scheduler.request(); scheduler.request(); scheduler.request();
  assert.equal(calls, 1); first.resolve(); await tick();
  assert.equal(calls, 2); assert.deepEqual(applied, [2]); scheduler.close();
});

test('a timer queues a trailing read without invalidating a slow snapshot', async () => {
  const first = deferred(); const applied = []; let calls = 0;
  const scheduler = createSnapshotScheduler(async (current) => {
    const n = ++calls; if (n === 1) await first.promise;
    if (current()) applied.push(n);
  });
  scheduler.request(); scheduler.request(false); first.resolve(); await tick();
  assert.deepEqual(applied, [1, 2]); scheduler.close();
});

test('closing a scheduler invalidates in-flight work and prevents trailing reads', async () => {
  const gate = deferred(); let applied = false; let calls = 0;
  const scheduler = createSnapshotScheduler(async (current) => { calls++; await gate.promise; applied = current(); });
  scheduler.request(); scheduler.request(); scheduler.close(); gate.resolve(); await tick();
  assert.equal(applied, false); assert.equal(calls, 1);
});

test('session updates use server-version CAS, never update an ended session, and surface conflicts', async () => {
  const operations = [];
  const row = { id: 's', presentation_id: 'p', status: 'live', current_slide_index: 3, activity_status: 'running', created_at: 't', updated_at: 'v2' };
  const builder = { update(v) { operations.push(['update', v]); return this; }, eq(k,v) { operations.push(['eq',k,v]); return this; }, neq(k,v) { operations.push(['neq',k,v]); return this; }, select() { return this; }, async maybeSingle() { return { data: row, error: null }; } };
  const client = { from(name) { assert.equal(name, 'class_sessions'); return builder; } };
  const updated = await updateClassSession('s', { currentSlideIndex: 3 }, 'v1', client);
  assert.equal(updated.syncUpdatedAt, 'v2');
  assert.deepEqual(operations, [['update', { current_slide_index: 3 }], ['eq','id','s'], ['eq','updated_at','v1'], ['neq','status','ended']]);
  builder.maybeSingle = async () => ({ data: null, error: null });
  await assert.rejects(updateClassSession('s', { status: 'live' }, 'v1', client), /zwischenzeitlich geändert oder beendet/);
  await assert.rejects(updateClassSession('s', { status: 'live' }, '', client), /noch abgeglichen/);
});
