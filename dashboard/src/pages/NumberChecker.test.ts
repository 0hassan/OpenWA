import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let NumberChecker: typeof import('./NumberChecker.tsx').NumberChecker;
let ToastProvider: typeof import('../components/Toast.tsx').ToastProvider;
let MemoryRouter: typeof import('react-router-dom').MemoryRouter;

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function renderComponent() {
  const queryClient = createTestQueryClient();
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(MemoryRouter, null, createElement(NumberChecker))),
    ),
  );
}

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify([
          {
            id: 'test-session-1',
            name: 'Primary Session',
            status: 'ready',
            phone: '919876543210',
          },
        ]),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    )) as typeof fetch;

  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ MemoryRouter } = await import('react-router-dom'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ NumberChecker } = await import('./NumberChecker.tsx'));
});

afterEach(() => {
  rtl.cleanup();
});

test('NumberChecker: renders single check form and tabs', () => {
  const { getByText, getByPlaceholderText } = renderComponent();
  assert.ok(getByText('Check Single Account'));
  assert.ok(getByPlaceholderText('e.g. 9876543210 (10 digits) or 919876543210 (12 digits)'));
});

test('NumberChecker: switches to bulk / batch tab when clicked', () => {
  const { getByRole, getAllByText } = renderComponent();
  const bulkTab = getByRole('button', { name: /Bulk/i });
  rtl.fireEvent.click(bulkTab);
  const headings = getAllByText('Bulk Number Checker');
  assert.ok(headings.length >= 1);
});
