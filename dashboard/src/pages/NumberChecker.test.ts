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
let defaultFetch: typeof fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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
  defaultFetch = (() =>
    Promise.resolve(
      jsonResponse([
        {
          id: 'test-session-1',
          name: 'Primary Session',
          status: 'ready',
          phone: '919876543210',
        },
      ]),
    )) as typeof fetch;
  globalThis.fetch = defaultFetch;

  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ MemoryRouter } = await import('react-router-dom'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ NumberChecker } = await import('./NumberChecker.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  globalThis.fetch = defaultFetch;
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

test('NumberChecker: a rejected lookup is recorded as failed with error status, not as unregistered', async () => {
  const recordedDownloads: Blob[] = [];
  const realCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = (blob: Blob) => {
    recordedDownloads.push(blob);
    return 'blob:mock-csv';
  };

  try {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/contacts/check/919999999999')) {
        return Promise.resolve(jsonResponse({ message: 'Rate limit exceeded (HTTP 429)' }, 429));
      }
      return Promise.resolve(
        jsonResponse([
          {
            id: 'test-session-1',
            name: 'Primary Session',
            status: 'ready',
            phone: '919876543210',
          },
        ]),
      );
    }) as typeof fetch;

    renderComponent();

    // Switch to bulk tab
    const bulkTab = rtl.screen.getByRole('button', { name: /Bulk/i });
    rtl.fireEvent.click(bulkTab);

    // Wait for session to be selected
    await rtl.screen.findByRole('option', { name: /Primary Session/ });

    // Enter phone number
    const textarea = rtl.screen.getByPlaceholderText(/9612345678/i);
    rtl.fireEvent.change(textarea, { target: { value: '919999999999' } });

    // Start batch
    const startBtn = rtl.screen.getByRole('button', { name: /Start Batch Check/i });
    rtl.fireEvent.click(startBtn);

    // Verify row displays Failed status and the error message
    const failedBadge = await rtl.screen.findByText('Failed', { selector: '.nc-status-badge' });
    assert.ok(failedBadge);
    assert.ok(rtl.screen.getByText('Rate limit exceeded (HTTP 429)'));

    // Verify "Not Registered" count is 0 and "Failed" count is 1
    const notRegBox = rtl.screen.getByText('Not Registered').parentElement;
    assert.ok(notRegBox?.textContent?.includes('0'));

    const failedBox = rtl.screen.getByText('Failed', { selector: '.nc-stat-label' }).parentElement;
    assert.ok(failedBox?.textContent?.includes('1'));

    // Export CSV and verify Error status is retained
    const exportBtn = rtl.screen.getByRole('button', { name: /Export Results/i });
    rtl.fireEvent.click(exportBtn);

    assert.equal(recordedDownloads.length, 1);
    const csvContent = await recordedDownloads[0].text();
    assert.ok(csvContent.includes('"919999999999","Error","","Rate limit exceeded (HTTP 429)"'));
    assert.ok(!csvContent.includes('"919999999999","No"'));
  } finally {
    URL.createObjectURL = realCreateObjectURL;
  }
});

test('NumberChecker: Stop followed by Start while lookup is pending cancels earlier run and prevents overwriting', async () => {
  let resolveFirstLookup!: (res: Response) => void;
  const firstLookupPromise = new Promise<Response>(resolve => {
    resolveFirstLookup = resolve;
  });

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/contacts/check/911111111111')) {
      return firstLookupPromise;
    }
    if (url.includes('/contacts/check/912222222222')) {
      return Promise.resolve(jsonResponse({ number: '912222222222', exists: true, whatsappId: '912222222222@c.us' }));
    }
    return Promise.resolve(
      jsonResponse([
        {
          id: 'test-session-1',
          name: 'Primary Session',
          status: 'ready',
          phone: '919876543210',
        },
      ]),
    );
  }) as typeof fetch;

  renderComponent();

  // Switch to bulk tab
  const bulkTab = rtl.screen.getByRole('button', { name: /Bulk/i });
  rtl.fireEvent.click(bulkTab);

  await rtl.screen.findByRole('option', { name: /Primary Session/ });

  const textarea = rtl.screen.getByPlaceholderText(/9612345678/i);

  // Run 1: Start checking 911111111111
  rtl.fireEvent.change(textarea, { target: { value: '911111111111' } });
  const startBtn = rtl.screen.getByRole('button', { name: /Start Batch Check/i });
  rtl.fireEvent.click(startBtn);

  // Stop while lookup 1 is pending
  const stopBtn = await rtl.screen.findByRole('button', { name: /Stop Checking/i });
  rtl.fireEvent.click(stopBtn);

  // Run 2: Start checking 912222222222
  rtl.fireEvent.change(textarea, { target: { value: '912222222222' } });
  const startBtnAgain = await rtl.screen.findByRole('button', { name: /Start Batch Check/i });
  rtl.fireEvent.click(startBtnAgain);

  // Late resolution of Run 1's pending lookup
  resolveFirstLookup(jsonResponse({ number: '911111111111', exists: false, whatsappId: null }));

  // Wait for Run 2 to finish
  const registeredRow = await rtl.screen.findByText('+912222222222');
  assert.ok(registeredRow);

  // Ensure Run 1's late resolution did NOT overwrite or get appended to Run 2's results
  assert.equal(rtl.screen.queryByText('+911111111111'), null);

  const checkedBox = rtl.screen.getByText('Checked', { selector: '.nc-stat-label' }).parentElement;
  assert.ok(checkedBox?.textContent?.includes('1'));

  const regBox = rtl.screen.getByText('Registered', { selector: '.nc-stat-label' }).parentElement;
  assert.ok(regBox?.textContent?.includes('1'));
});
