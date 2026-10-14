// The QR / pairing modal polls the QR route every five seconds. A poll that fails and cannot read the
// session's status either must not close the modal: the operator may be in the middle of typing a phone
// number, and the failure is the network's, not the session's.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '../services/api.ts';

let rtl: typeof import('@testing-library/react');
let useSessionPairing: (typeof import('./useSessionPairing.ts'))['useSessionPairing'];
let sessionApi: (typeof import('../services/api.ts'))['sessionApi'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ useSessionPairing } = await import('./useSessionPairing.ts'));
  ({ sessionApi } = await import('../services/api.ts'));
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  rtl.cleanup();
});

const session = { id: 's1', name: 'main', status: 'qr_ready' } as unknown as Session;

/** Opens the modal for `s1`, lets the poll run once with GET /qr failing, and answers the status read as given. */
async function pollOnce(statusRead: () => Promise<Session>): Promise<boolean> {
  const api = sessionApi as unknown as {
    getQR: () => Promise<unknown>;
    get: () => Promise<Session>;
  };
  mock.restoreAll();
  mock.timers.reset();
  mock.method(api, 'getQR', () => Promise.reject(new Error('Failed to fetch')));
  mock.method(api, 'get', statusRead);
  mock.timers.enable({ apis: ['setInterval'] });
  const sessions = [session];
  const { result } = rtl.renderHook(() =>
    useSessionPairing({ sessions, sessionsRef: { current: sessions }, reloadSessions: async () => sessions }),
  );
  await rtl.act(async () => {
    await result.current.handleShowQR('s1');
  });
  assert.ok(result.current.qrData, 'the modal did not open');
  await rtl.act(async () => {
    mock.timers.tick(5000);
    await new Promise(resolve => setImmediate(resolve));
  });
  return result.current.qrData !== null;
}

test('the modal stays open when the QR poll and the status read both fail without an answer', async () => {
  assert.equal(await pollOnce(() => Promise.reject(new TypeError('Failed to fetch'))), true);
});

test('the modal stays open when the status read is refused for rate or fails on the server', async () => {
  for (const status of [429, 502]) {
    rtl.cleanup();
    assert.equal(
      await pollOnce(() => Promise.reject(Object.assign(new Error('refused'), { status }))),
      true,
      `a ${status} closed the modal`,
    );
  }
});

test('the modal closes when the session is gone or no longer starting', async () => {
  assert.equal(await pollOnce(() => Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }))), false);
  rtl.cleanup();
  assert.equal(await pollOnce(() => Promise.resolve({ ...session, status: 'failed' } as Session)), false);
});

test('the modal stays open while the session is still initializing', async () => {
  assert.equal(await pollOnce(() => Promise.resolve({ ...session, status: 'authenticating' } as Session)), true);
});
