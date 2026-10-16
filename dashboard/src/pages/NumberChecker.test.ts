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
let RoleProvider: typeof import('../components/RoleProvider.tsx').RoleProvider;
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

function renderComponent(role = 'operator') {
  sessionStorage.setItem('openwa_user_role', role);
  const queryClient = createTestQueryClient();
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        RoleProvider,
        null,
        createElement(ToastProvider, null, createElement(MemoryRouter, null, createElement(NumberChecker))),
      ),
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
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ NumberChecker } = await import('./NumberChecker.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  globalThis.fetch = defaultFetch;
  sessionStorage.clear();
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

for (const [raw, autoPrefix, expected] of [
  ['+65 8123 4567', true, '6581234567'],
  ['0065 8123 4567', true, '6581234567'],
  ['09876543210', false, '09876543210'],
  ['9109876543210', false, '9109876543210'],
  ['9876543210', true, '919876543210'],
  ['09876543210', true, '919876543210'],
] as const) {
  test(`NumberChecker: checks ${raw} as ${expected} with auto-prefix ${autoPrefix}`, async () => {
    const lookups: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/contacts/check/')) {
        const number = url.split('/contacts/check/')[1];
        lookups.push(number);
        return Promise.resolve(jsonResponse({ number, exists: false, whatsappId: null }));
      }
      return defaultFetch(input);
    }) as typeof fetch;

    const { container } = renderComponent();
    await rtl.screen.findByRole('option', { name: /Primary Session/ });
    if (!autoPrefix) rtl.fireEvent.click(rtl.screen.getByRole('checkbox'));
    rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9876543210/), { target: { value: raw } });
    if (raw.startsWith('+') || raw.startsWith('00')) {
      assert.ok(!container.querySelector('.nc-format-preview')?.textContent?.includes('auto-prefixed'));
    }
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Check' }));
    await rtl.screen.findByText('Not Registered', { selector: '.nc-status-badge' });
    assert.deepEqual(lookups, [expected]);
  });
}

test('NumberChecker: bulk parsing deduplicates explicit international numbers without adding +91', async () => {
  const lookups: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/contacts/check/')) {
      const number = url.split('/contacts/check/')[1];
      lookups.push(number);
      return Promise.resolve(jsonResponse({ number, exists: false, whatsappId: null }));
    }
    return defaultFetch(input);
  }) as typeof fetch;

  renderComponent();
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Bulk/i }));
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9612345678/i), {
    target: { value: '+65 8123 4567\n0065 8123 4567' },
  });
  assert.match(rtl.screen.getByText(/ten-digit/).textContent ?? '', /0 ten-digit/);
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Start Batch Check/i }));
  await rtl.screen.findByText('+6581234567');
  assert.deepEqual(lookups, ['6581234567']);
});

test('NumberChecker: viewers cannot start single or bulk lookups, including with Enter', async () => {
  const lookups: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/contacts/check/')) {
      lookups.push(url);
      return Promise.resolve(jsonResponse({ number: '919876543210', exists: false, whatsappId: null }));
    }
    return defaultFetch(input);
  }) as typeof fetch;

  renderComponent('viewer');
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  const input = rtl.screen.getByPlaceholderText(/9876543210/);
  rtl.fireEvent.change(input, { target: { value: '9876543210' } });
  assert.equal((rtl.screen.getByRole('button', { name: 'Check' }) as HTMLButtonElement).disabled, true);
  await rtl.act(async () => rtl.fireEvent.keyDown(input, { key: 'Enter' }));
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Bulk/i }));
  rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9612345678/i), { target: { value: '9876543210' } });
  assert.equal((rtl.screen.getByRole('button', { name: /Start Batch Check/i }) as HTMLButtonElement).disabled, true);
  assert.deepEqual(lookups, []);
});

test('NumberChecker: CSV export neutralizes error formulas and releases its object URL', async t => {
  const downloads: Blob[] = [];
  t.mock.method(URL, 'createObjectURL', (blob: Blob) => {
    downloads.push(blob);
    return 'blob:number-checker-csv';
  });
  const revoke = t.mock.method(URL, 'revokeObjectURL');
  t.mock.method(HTMLAnchorElement.prototype, 'click', () => {});
  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (String(input).includes('/contacts/check/')) {
      return Promise.resolve(jsonResponse({ message: '=HYPERLINK("https://example.com","lookup")' }, 500));
    }
    return defaultFetch(input);
  }) as typeof fetch;

  renderComponent();
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Bulk/i }));
  await rtl.screen.findByRole('option', { name: /Primary Session/ });
  rtl.fireEvent.change(rtl.screen.getByPlaceholderText(/9612345678/i), { target: { value: '919999999999' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Start Batch Check/i }));
  await rtl.screen.findByText('Failed', { selector: '.nc-status-badge' });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Export Results/i }));

  assert.equal(downloads.length, 1);
  assert.ok((await downloads[0].text()).includes(`"'=HYPERLINK(""https://example.com"",""lookup"")"`));
  assert.equal(revoke.mock.callCount(), 1);
  assert.deepEqual(revoke.mock.calls[0].arguments, ['blob:number-checker-csv']);
  assert.equal(document.querySelector('a[download]'), null);
});

test('NumberChecker: a rejected lookup is recorded as failed with error status, not as unregistered', async t => {
  t.mock.method(HTMLAnchorElement.prototype, 'click', () => {});
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
    assert.ok(csvContent.includes('919999999999,Error,,Rate limit exceeded (HTTP 429),'));
    assert.ok(!csvContent.includes('919999999999,No,'));
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
