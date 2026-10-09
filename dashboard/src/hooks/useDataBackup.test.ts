// The backup export saves a file with every integration instance's secrets in plaintext, so an export
// still in flight when the operator signs out must not save it over the login form.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactNode } from 'react';
import type { useDataBackup as useDataBackupFn } from './useDataBackup.ts';
import type { ToastContext as ToastContextType } from './useToast.ts';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let useDataBackup: typeof useDataBackupFn;
let ToastContext: typeof ToastContextType;

// Answer of the export route, per test; a pending one is an export still in flight.
let exportAnswer: Promise<Response> = new Promise(() => {});
const saved: HTMLAnchorElement[] = [];
let createElementOriginal: typeof document.createElement;

function dump(): Response {
  const body = { exportedAt: '2026-10-09T10:00:00.000Z', dataDbType: 'sqlite', tables: {}, counts: {} };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  createElementOriginal = document.createElement;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return url.endsWith('/api/infra/export-data')
      ? exportAnswer
      : Promise.resolve(new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } }));
  };
  URL.createObjectURL = () => 'blob:backup';
  URL.revokeObjectURL = () => {};
  rtl = await import('@testing-library/react');
  ({ useDataBackup } = await import('./useDataBackup.ts'));
  ({ ToastContext } = await import('./useToast.ts'));
});

afterEach(() => {
  rtl.cleanup();
  saved.length = 0;
  exportAnswer = new Promise(() => {});
  window.sessionStorage.removeItem('openwa_api_key');
  document.createElement = createElementOriginal;
});

function renderBackup() {
  const noop = () => {};
  const value = {
    toasts: [],
    addToast: noop,
    removeToast: noop,
    success: noop,
    error: noop,
    warning: noop,
    info: noop,
  };
  const wrapper = ({ children }: { children: ReactNode }) => createElement(ToastContext.Provider, { value }, children);
  // Record each file the hook saves by capturing the link it clicks, instead of letting jsdom navigate.
  document.createElement = ((tag: string, options?: ElementCreationOptions) => {
    const element = createElementOriginal.call(document, tag, options);
    if (tag === 'a') (element as HTMLAnchorElement).click = () => void saved.push(element as HTMLAnchorElement);
    return element;
  }) as typeof document.createElement;
  return rtl.renderHook(() => useDataBackup(), { wrapper });
}

test('an export that completes while signed in saves the backup file', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  exportAnswer = Promise.resolve(dump());
  const { result } = renderBackup();
  await rtl.act(() => result.current.exportBackup());
  assert.deepEqual(
    saved.map(link => link.download),
    ['openwa-backup-2026-10-09.json'],
  );
});

test('an export answered after sign-out saves no file', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  let answer!: (response: Response) => void;
  exportAnswer = new Promise<Response>(resolve => (answer = resolve));
  const { result } = renderBackup();
  const exporting = rtl.act(() => result.current.exportBackup());
  window.sessionStorage.removeItem('openwa_api_key');
  answer(dump());
  await exporting;
  assert.deepEqual(saved, [], 'a backup of the whole database was saved after the sign-out');
});
