import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadArchivedMedia } from './archivedMediaLoad.ts';

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
});

const status = (code: number) => Object.assign(new Error(`HTTP ${code}`), { status: code });

test('a burst of loads starts at least 100 ms apart, under the gateway per-second throttle', async () => {
  const starts: number[] = [];
  const { signal } = new AbortController();
  await Promise.all(
    Array.from({ length: 4 }, () =>
      loadArchivedMedia(signal, async () => {
        starts.push(Date.now());
        return 'x';
      }),
    ),
  );
  assert.equal(starts.length, 4);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(
      starts[i] - starts[i - 1] >= 100,
      `loads ${i - 1} and ${i} started ${starts[i] - starts[i - 1]} ms apart`,
    );
  }
});

test('a load aborted while it waits for its turn never starts', async () => {
  // Three loads ahead of it keep the next turn a few hundred milliseconds away.
  const ahead = Array.from({ length: 3 }, () => loadArchivedMedia(new AbortController().signal, async () => 'x'));
  const controller = new AbortController();
  let ran = false;
  const waiting = loadArchivedMedia(controller.signal, async () => {
    ran = true;
    return 'x';
  });
  controller.abort();
  await assert.rejects(waiting);
  await Promise.all(ahead);
  assert.equal(ran, false);
});

test('a throttled load is retried and then resolves', async () => {
  let calls = 0;
  const value = await loadArchivedMedia(
    new AbortController().signal,
    async () => {
      calls += 1;
      if (calls === 1) throw status(429);
      return 'bytes';
    },
    5,
  );
  assert.equal(value, 'bytes');
  assert.equal(calls, 2);
});

test('any other failure is not retried', async () => {
  let calls = 0;
  await assert.rejects(
    loadArchivedMedia(
      new AbortController().signal,
      async () => {
        calls += 1;
        throw status(404);
      },
      5,
    ),
  );
  assert.equal(calls, 1);
});
