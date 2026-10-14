// Render test for the chat thread's write actions. The gateway answers reply, react, delete and a
// prompt-button tap only for an operator key, so a read-only key must not be offered them. It also
// checks the thread, not just the helpers, resolves an @mention in a body and in a quote.
import '../../test-helpers/register-hooks.ts';
import { test, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement, createRef } from 'react';
import type { Chat } from '../../services/api.ts';
import type { ChatMessageView } from '../../utils/chatMessages.ts';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
// Set by a test that needs the engine's answer for a focus it did not give by key press, which jsdom cannot.
let focusVisibleOverride: boolean | null = null;
let matchesOriginal: typeof Element.prototype.matches;
let ChatThread: typeof import('./ChatThread.tsx').default;
let RoleProvider: typeof import('../RoleProvider.tsx').RoleProvider;

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../RoleProvider.tsx'));
  ({ default: ChatThread } = await import('./ChatThread.tsx'));
  // jsdom answers :focus-visible from the last key or pointer event that any test fired before, so the same
  // call matched in one run and not in the next. Here it holds for the element that has focus, as for the
  // focus a key press brings, and not for a focus event on an element that is not the focused one, as for
  // the focus of a click.
  matchesOriginal = window.Element.prototype.matches;
  window.Element.prototype.matches = function (this: Element, selector: string): boolean {
    if (selector !== ':focus-visible') return matchesOriginal.call(this, selector);
    return focusVisibleOverride ?? this === document.activeElement;
  } as typeof Element.prototype.matches;
});

after(() => {
  window.Element.prototype.matches = matchesOriginal;
});

afterEach(() => {
  focusVisibleOverride = null;
  mock.restoreAll();
  rtl.cleanup();
  window.sessionStorage.removeItem('openwa_user_role');
});

const CHAT: Chat = {
  id: '15551234567@c.us',
  name: 'Alice',
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 1_700_000_000,
  archived: false,
  pinned: false,
  muted: false,
};

const PROMPT: ChatMessageView = {
  id: 'db-1',
  waMessageId: 'wamid.1',
  chatId: CHAT.id,
  from: CHAT.id,
  to: 'me',
  body: 'Confirm?',
  type: 'text',
  direction: 'incoming',
  status: 'delivered',
  timestamp: 1_700_000_000,
  createdAt: new Date(1_700_000_000_000).toISOString(),
  metadata: { buttons: [{ id: 'y', text: 'Yes' }] },
};

function renderThread(
  role: string,
  messages: ChatMessageView[] = [PROMPT],
  activeChat: Chat = CHAT,
): { clicks: string[]; container: HTMLElement; rerenderWith: (next: ChatMessageView[]) => void } {
  window.sessionStorage.setItem('openwa_user_role', role);
  const clicks: string[] = [];
  const noop = () => {};
  const containerRef = createRef<HTMLDivElement>();
  const tree = (list: ChatMessageView[]) =>
    createElement(
      RoleProvider,
      null,
      createElement(ChatThread, {
        sessionId: 's1',
        activeChat,
        messages: list,
        loadingMessages: false,
        messagesError: false,
        messagesContainerRef: containerRef,
        hasMoreMessages: false,
        loadingOlderMessages: false,
        onLoadOlderMessages: noop,
        onMediaLoad: noop,
        measureMedia: noop,
        onOpenImage: noop,
        onReply: noop,
        onReact: noop,
        onDelete: noop,
        onClickButton: async (_message, button) => {
          clicks.push(button.id);
        },
      }),
    );
  const { container, rerender } = rtl.render(tree(messages));
  return { clicks, container, rerenderWith: next => rerender(tree(next)) };
}

test('a read-only key sees prompt choices disabled and no reply, react or delete actions', () => {
  const { clicks, container } = renderThread('viewer');
  const yes = rtl.screen.getByRole('button', { name: 'Yes' });
  assert.equal(yes.matches(':disabled'), true);
  rtl.fireEvent.click(yes);
  assert.deepEqual(clicks, []);
  assert.ok(!container.querySelector('.message-actions-menu'));
});

test('an operator key can tap a prompt choice and gets the message actions', async () => {
  const { clicks, container } = renderThread('operator');
  const yes = rtl.screen.getByRole('button', { name: 'Yes' });
  assert.equal(yes.matches(':disabled'), false);
  rtl.fireEvent.click(yes);
  await rtl.waitFor(() => assert.deepEqual(clicks, ['y']));
  assert.ok(container.querySelector('.message-actions-menu'));
});

test('an optimistic bubble with no WhatsApp id yet offers no reply, react or delete', () => {
  // Every action addresses the message by its WhatsApp id; a pending or failed placeholder only has
  // its local temp_ id, which the gateway can never resolve.
  for (const status of ['pending', 'failed'] as const) {
    const { container } = renderThread('operator', [
      { ...PROMPT, id: 'temp_1', waMessageId: undefined, direction: 'outgoing', status, metadata: undefined },
    ]);
    assert.ok(!container.querySelector('.message-actions-menu'), `a ${status} placeholder offered actions`);
    rtl.cleanup();
  }
});

test('an @mention of a participant who posted in the thread shows their first name, in the body and the quote', () => {
  const GROUP: Chat = { ...CHAT, id: '120363000000000000@g.us', name: 'Team', isGroup: true, kind: 'group' };
  const fromBob: ChatMessageView = {
    ...PROMPT,
    id: 'db-bob',
    waMessageId: 'wamid.bob',
    chatId: GROUP.id,
    from: GROUP.id,
    author: '15551230000@c.us',
    chatName: 'Bob Smith',
    body: 'hello',
    metadata: undefined,
  };
  const mentioning: ChatMessageView = {
    ...fromBob,
    id: 'db-mention',
    waMessageId: 'wamid.mention',
    author: '15559990000@c.us',
    chatName: 'Ann',
    body: 'thanks @15551230000',
    timestamp: 1_700_000_001,
    metadata: { quotedMessage: { id: 'wamid.bob', body: 'ping @15551230000' } },
  };
  const { container } = renderThread('viewer', [fromBob, mentioning], GROUP);
  const body = [...container.querySelectorAll('.message-text')].find(el => el.textContent?.startsWith('thanks'));
  assert.equal(body?.querySelector('bdi')?.textContent, '@Bob');
  assert.equal(container.querySelector('.quote-body bdi')?.textContent, '@Bob');
});

test('a document sent by URL opens in a new tab instead of navigating the dashboard away', () => {
  // Browsers ignore `download` on a cross-origin link, so a plain click would unload the dashboard.
  const doc = (id: string, data: string): ChatMessageView => ({
    ...PROMPT,
    id,
    waMessageId: `wamid.${id}`,
    body: '',
    type: 'document',
    metadata: { media: { mimetype: 'application/pdf', filename: `${id}.pdf`, data } },
  });
  const { container } = renderThread('operator', [
    doc('remote', 'https://files.example.com/remote.pdf'),
    doc('inline', 'JVBERi0='),
  ]);
  const [remote, inline] = Array.from(container.querySelectorAll<HTMLAnchorElement>('a.chat-document-media'));
  assert.equal(remote.getAttribute('target'), '_blank');
  assert.equal(remote.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(inline.getAttribute('target'), null);
  assert.equal(inline.getAttribute('download'), 'inline.pdf');
});

test('archive-only media previews inline from the media route; a plain omitted marker and a document keep the button', async () => {
  // MESSAGE_INLINE_MEDIA=archive leaves `{ omitted, archived }` on the row: the image rendered inline
  // before, so it must still. The over-budget marker (no `archived`) must not fetch on render, and a
  // document has nothing to preview.
  const media = (id: string, type: ChatMessageView['type'], archived: boolean): ChatMessageView => ({
    ...PROMPT,
    id,
    waMessageId: `wamid.${id}`,
    body: '',
    type,
    metadata: { media: { mimetype: 'image/jpeg', filename: `${id}.jpg`, omitted: true, sizeBytes: 10, archived } },
  });
  const fetched: string[] = [];
  const fetchOriginal = globalThis.fetch;
  const createOriginal = URL.createObjectURL;
  const revokeOriginal = URL.revokeObjectURL;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response(new Blob(['x'], { type: 'image/jpeg' }), { status: 200 });
  }) as typeof fetch;
  URL.createObjectURL = () => 'blob:archived';
  URL.revokeObjectURL = () => {};
  try {
    const { container } = renderThread('viewer', [
      media('arch', 'image', true),
      media('plain', 'image', false),
      media('doc', 'document', true),
    ]);
    const img = await rtl.waitFor(() => {
      const found = container.querySelector('[data-wa-message-id="wamid.arch"] img.chat-image-media');
      assert.ok(found, 'the archived image did not preview');
      return found;
    });
    assert.equal(img.getAttribute('src'), 'blob:archived');
    assert.equal(fetched.length, 1, 'only the archived image is fetched on render');
    assert.match(fetched[0], /\/messages\/.+\/wamid\.arch\/media$/);
    assert.ok(container.querySelector('[data-wa-message-id="wamid.plain"] button.message-media-omitted'));
    assert.ok(container.querySelector('[data-wa-message-id="wamid.doc"] button.message-media-omitted'));
  } finally {
    globalThis.fetch = fetchOriginal;
    URL.createObjectURL = createOriginal;
    URL.revokeObjectURL = revokeOriginal;
  }
});

test('an archived image is observed against the thread scroller and saved under its own name, or one unique to its message', async () => {
  // ArchivedMediaPreview is covered on its own; this pins what the thread hands it. The scroll container
  // as observer root keeps the lazy-load lead from being clipped to the container's own box, the stored
  // file name is what a named photo saves under, and the row id keeps nameless photos apart.
  const image = (id: string, filename?: string): ChatMessageView => ({
    ...PROMPT,
    id,
    waMessageId: `wamid.${id}`,
    body: '',
    type: 'image',
    metadata: { media: { mimetype: 'image/jpeg', filename, omitted: true, sizeBytes: 10, archived: true } },
  });
  const roots: unknown[] = [];
  class IntersectingObserver {
    callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.callback = callback;
      roots.push(options?.root);
    }
    // Reports the placeholder as inside the margin at once, so the preview fetches.
    observe(target: Element): void {
      const entry = { isIntersecting: true, target } as IntersectionObserverEntry;
      this.callback([entry], this as unknown as IntersectionObserver);
    }
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  const downloads: string[] = [];
  // The viewer saves through a detached <a download> it clicks with dispatchEvent.
  const anchorProto = HTMLAnchorElement.prototype as { dispatchEvent?: unknown };
  const observerTarget = globalThis as { IntersectionObserver?: unknown };
  const fetchOriginal = globalThis.fetch;
  const createOriginal = URL.createObjectURL;
  const revokeOriginal = URL.revokeObjectURL;
  observerTarget.IntersectionObserver = IntersectingObserver;
  globalThis.fetch = (async () =>
    new Response(new Blob(['x'], { type: 'image/jpeg' }), { status: 200 })) as typeof fetch;
  URL.createObjectURL = () => 'blob:archived';
  URL.revokeObjectURL = () => {};
  anchorProto.dispatchEvent = function (this: HTMLAnchorElement, event: Event): boolean {
    if (event.type === 'click') downloads.push(this.download);
    return true;
  };
  try {
    for (const message of [image('db-named', 'holiday.jpg'), image('db-nameless')]) {
      const { container } = renderThread('viewer', [message]);
      const img = await rtl.waitFor(() => {
        const found = container.querySelector('img.chat-image-media');
        assert.ok(found, 'the archived image did not preview');
        return found;
      });
      // A boolean, not assert.equal: a failed equality would inspect a whole jsdom tree.
      const scroller = container.querySelector('.room-messages');
      assert.ok(scroller && roots.at(-1) === scroller, 'the observer is not rooted at the thread scroller');
      rtl.fireEvent.click(img);
      rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Download' }));
      await rtl.act(() => new Promise(resolve => setTimeout(resolve, 50)));
      rtl.cleanup();
    }
    assert.deepEqual(downloads, ['holiday.jpg', 'image-db-nameless.jpg']);
  } finally {
    delete observerTarget.IntersectionObserver;
    delete anchorProto.dispatchEvent;
    globalThis.fetch = fetchOriginal;
    URL.createObjectURL = createOriginal;
    URL.revokeObjectURL = revokeOriginal;
  }
});

test('a media download answered after sign-out saves no file', async () => {
  // Logout cancels nothing in flight: a download the operator started just before it would otherwise
  // land in the downloads folder with the login form already showing.
  const message: ChatMessageView = {
    ...PROMPT,
    id: 'big',
    waMessageId: 'wamid.big',
    body: '',
    type: 'document',
    metadata: { media: { mimetype: 'application/pdf', filename: 'report.pdf', omitted: true, sizeBytes: 10 } },
  };
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  const fetchOriginal = globalThis.fetch;
  const createOriginal = URL.createObjectURL;
  const revokeOriginal = URL.revokeObjectURL;
  const createElementOriginal = document.createElement;
  const saved: string[] = [];
  let answer!: (response: Response) => void;
  globalThis.fetch = (() => new Promise<Response>(resolve => (answer = resolve))) as typeof fetch;
  URL.createObjectURL = () => 'blob:report';
  URL.revokeObjectURL = () => {};
  document.createElement = ((tag: string, options?: ElementCreationOptions) => {
    const element = createElementOriginal.call(document, tag, options);
    if (tag === 'a')
      (element as HTMLAnchorElement).click = () => void saved.push((element as HTMLAnchorElement).download);
    return element;
  }) as typeof document.createElement;
  try {
    const { container } = renderThread('viewer', [message]);
    const button = container.querySelector('[data-wa-message-id="wamid.big"] button.message-media-omitted');
    assert.ok(button, 'the over-budget document did not render its download button');
    rtl.fireEvent.click(button);
    await rtl.waitFor(() => assert.ok(answer, 'the download did not start'));
    window.sessionStorage.removeItem('openwa_api_key');
    answer(new Response(new Blob(['x']), { status: 200 }));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(saved, [], 'the media file was saved after the sign-out');
  } finally {
    globalThis.fetch = fetchOriginal;
    URL.createObjectURL = createOriginal;
    URL.revokeObjectURL = revokeOriginal;
    document.createElement = createElementOriginal;
    window.sessionStorage.removeItem('openwa_api_key');
  }
});

test('poll messages display exact choices, including outgoing and legacy polls', () => {
  const poll = { name: 'Where?', options: [' Park ', '<script>Beach</script>'], allowMultipleAnswers: false };
  const { container } = renderThread('viewer', [
    { ...PROMPT, type: 'poll', body: 'Where?', metadata: { poll } },
    {
      ...PROMPT,
      id: 'out',
      waMessageId: 'out',
      type: 'poll',
      direction: 'outgoing',
      body: 'Where?',
      metadata: { poll },
    },
    { ...PROMPT, id: 'legacy', waMessageId: 'legacy', type: 'poll', body: 'Legacy question', metadata: undefined },
  ]);
  assert.deepEqual(
    Array.from(container.querySelectorAll('li bdi')).map(node => node.textContent),
    [...poll.options, ...poll.options],
  );
  assert.equal(container.querySelector('script'), null);
  assert.ok(container.textContent?.includes('Legacy question'));
});

test('a poll whose body is empty shows the question from its metadata', () => {
  // whatsapp-web.js hands a poll over with an empty body and its name only in metadata.poll.
  const poll = { name: 'Where shall we meet?', options: ['Park', 'Beach'], allowMultipleAnswers: false };
  const { container } = renderThread('viewer', [{ ...PROMPT, type: 'poll', body: '', metadata: { poll } }]);
  assert.ok(container.textContent?.includes('Where shall we meet?'));
});

test('an archived sticker previews as an image and an archived voice note as audio', async () => {
  const media = (id: string, type: ChatMessageView['type'], mimetype: string): ChatMessageView => ({
    ...PROMPT,
    id,
    waMessageId: `wamid.${id}`,
    body: '',
    type,
    metadata: { media: { mimetype, filename: `${id}.bin`, omitted: true, sizeBytes: 10, archived: true } },
  });
  const fetchOriginal = globalThis.fetch;
  const createOriginal = URL.createObjectURL;
  const revokeOriginal = URL.revokeObjectURL;
  globalThis.fetch = (async () => new Response(new Blob(['x']), { status: 200 })) as typeof fetch;
  URL.createObjectURL = () => 'blob:archived';
  URL.revokeObjectURL = () => {};
  try {
    const { container } = renderThread('viewer', [
      media('stk', 'sticker', 'image/webp'),
      media('vn', 'voice', 'audio/ogg; codecs=opus'),
    ]);
    await rtl.waitFor(() => {
      assert.ok(container.querySelector('[data-wa-message-id="wamid.stk"] img.chat-image-media'));
      assert.ok(container.querySelector('[data-wa-message-id="wamid.vn"] audio'));
    });
  } finally {
    globalThis.fetch = fetchOriginal;
    URL.createObjectURL = createOriginal;
    URL.revokeObjectURL = revokeOriginal;
  }
});

// The message actions appear on hover, so a keyboard user reaches them through the bubble: one tab stop
// for the thread (the focused message, else the newest) and the arrow keys between messages.
test('the thread is one tab stop and the arrow keys move between messages that carry actions', () => {
  const second: ChatMessageView = {
    ...PROMPT,
    id: 'db-2',
    waMessageId: 'wamid.2',
    body: 'Second',
    metadata: undefined,
  };
  const noActions: ChatMessageView = {
    ...PROMPT,
    id: 'db-3',
    waMessageId: undefined,
    body: 'Third',
    direction: 'outgoing',
    status: 'pending',
    metadata: undefined,
  };
  const { container } = renderThread('operator', [PROMPT, second, noActions]);
  const stops = (): Array<string | null> =>
    [...container.querySelectorAll<HTMLElement>('[data-roving-message]')].map(el => el.getAttribute('tabindex'));

  // The bubble without a WhatsApp id offers no action, so it is no stop at all.
  assert.equal(container.querySelectorAll('[data-roving-message]').length, 2);
  // Nothing focused yet: the newest message that carries actions holds the tab stop.
  assert.deepEqual(stops(), ['-1', '0']);

  const bubbles = container.querySelectorAll<HTMLElement>('[data-roving-message]');
  bubbles[1].focus();
  rtl.fireEvent.keyDown(bubbles[1], { key: 'ArrowUp' });
  assert.equal(document.activeElement, bubbles[0]);
  assert.deepEqual(stops(), ['0', '-1']);

  rtl.fireEvent.keyDown(bubbles[0], { key: 'ArrowDown' });
  assert.equal(document.activeElement, bubbles[1]);
  rtl.fireEvent.keyDown(bubbles[1], { key: 'Home' });
  assert.equal(document.activeElement, bubbles[0]);
  rtl.fireEvent.keyDown(bubbles[0], { key: 'End' });
  assert.equal(document.activeElement, bubbles[1]);
});

test('a key pressed inside a message action keeps its own meaning', () => {
  const { container } = renderThread('operator', [PROMPT, { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2' }]);
  const bubbles = container.querySelectorAll<HTMLElement>('[data-roving-message]');
  const reply = bubbles[1].querySelector<HTMLElement>('.action-btn');
  assert.ok(reply);
  reply.focus();
  rtl.fireEvent.keyDown(reply, { key: 'ArrowUp' });
  assert.equal(document.activeElement, reply);
});

const bubblesOf = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-roving-message]'),
];

/**
 * Where focus is, as text: the id of the message whose bubble or control holds it, 'body' when it fell to
 * the page, 'elsewhere' for any other element. A failed assert.equal on two DOM nodes spends minutes
 * printing them, so focus is compared by name.
 */
const focusedMessage = (): string =>
  document.activeElement === document.body
    ? 'body'
    : (document.activeElement?.closest('[data-wa-message-id]')?.getAttribute('data-wa-message-id') ?? 'elsewhere');

// A bubble is the one tab stop of the thread; what is inside it (a link, a preview, a button) is a stop
// of its own, and landing on it must not make its bubble the stop as well, or Shift+Tab visits both.
test('focus on a link inside a message does not move the thread tab stop', () => {
  const linked: ChatMessageView = { ...PROMPT, id: 'db-0', waMessageId: 'wamid.0', body: 'see https://example.org/a' };
  const newest: ChatMessageView = {
    ...PROMPT,
    id: 'db-9',
    waMessageId: 'wamid.9',
    body: 'Newest',
    metadata: undefined,
  };
  const { container } = renderThread('operator', [linked, newest]);
  const stops = (): Array<string | null> => bubblesOf(container).map(el => el.getAttribute('tabindex'));
  assert.deepEqual(stops(), ['-1', '0']);

  const link = container.querySelector<HTMLElement>('[data-wa-message-id="wamid.0"] a[href]');
  assert.ok(link, 'the body links its URL');
  rtl.act(() => link.focus());

  assert.deepEqual(stops(), ['-1', '0']);
});

test('arrow keys, Home and End are consumed and reach the stops from the middle of three', () => {
  const messages = ['a', 'b', 'c'].map((id): ChatMessageView => ({
    ...PROMPT,
    id: `db-${id}`,
    waMessageId: `wamid.${id}`,
    metadata: undefined,
  }));
  const { container } = renderThread('operator', messages);
  const bubbles = bubblesOf(container);
  bubbles[1].focus();

  // fireEvent returns false when the handler called preventDefault.
  assert.equal(rtl.fireEvent.keyDown(bubbles[1], { key: 'Home' }), false);
  assert.equal(document.activeElement, bubbles[0]);
  bubbles[1].focus();
  assert.equal(rtl.fireEvent.keyDown(bubbles[1], { key: 'End' }), false);
  assert.equal(document.activeElement, bubbles[2]);
  bubbles[1].focus();
  assert.equal(rtl.fireEvent.keyDown(bubbles[1], { key: 'ArrowUp' }), false);
  assert.equal(document.activeElement, bubbles[0]);
  bubbles[1].focus();
  assert.equal(rtl.fireEvent.keyDown(bubbles[1], { key: 'ArrowDown' }), false);
  assert.equal(document.activeElement, bubbles[2]);
  // A key the thread does not use is left alone.
  assert.equal(rtl.fireEvent.keyDown(bubbles[1], { key: 'a' }), true);
});

// Deleting removes the buttons that hold focus, so focus would fall to the page and the next Tab would
// land in the composer.
test('keyboard focus stays in the thread when the focused message is deleted', () => {
  const first: ChatMessageView = { ...PROMPT, id: 'db-1', waMessageId: 'wamid.1', metadata: undefined };
  const second: ChatMessageView = { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2', metadata: undefined };
  const { container, rerenderWith } = renderThread('operator', [first, second]);
  const bubbles = bubblesOf(container);
  const del = bubbles[1].querySelector<HTMLElement>('[aria-label][class*="action"], .action-btn:last-of-type');
  assert.ok(del, 'the newest message offers its actions');
  del.focus();
  assert.equal(document.activeElement, del);

  rerenderWith([first, { ...second, type: 'revoked', body: '' }]);

  const active = document.activeElement;
  assert.ok(active && active !== document.body, 'focus fell to the page');
  assert.ok(container.contains(active), 'focus left the thread');
});

test('keyboard focus returns without scrolling, and to the stop that took the place of the deleted message', () => {
  const [a, b, c, d]: ChatMessageView[] = ['1', '2', '3', '4'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c, d]);
  const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  del.focus();
  const original = HTMLElement.prototype.focus;
  const calls: Array<{ id: string | null; options?: FocusOptions }> = [];
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    calls.push({ id: this.closest('[data-wa-message-id]')?.getAttribute('data-wa-message-id') ?? null, options });
    original.call(this, options);
  };
  try {
    rerenderWith([a, { ...b, type: 'revoked', body: '' }, c, d]);
  } finally {
    HTMLElement.prototype.focus = original;
  }

  // The message after the deleted one now holds its place among the stops (not the newest one), and
  // nothing scrolls.
  assert.deepEqual(calls, [{ id: 'wamid.3', options: { preventScroll: true } }]);
  assert.equal(focusedMessage(), 'wamid.3');
});

// The place is the bubble's position in the document when it is lost, not an index taken at focus time: an
// older page that landed in between would have made that index name a message far from it.
test('the stop that takes the place is found after an older page landed since the focus', () => {
  const [o1, o2, a, b, c]: ChatMessageView[] = ['o1', 'o2', 'a', 'b', 'c'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  del.focus();

  rerenderWith([o1, o2, a, b, c]);
  assert.equal(document.activeElement, del);
  rerenderWith([o1, o2, a, { ...b, type: 'revoked', body: '' }, c]);

  assert.equal(focusedMessage(), 'wamid.c');
});

// A message that leaves the list takes its bubble out of the document with its controls: the stop after it
// takes the focus, and the one before it when it was the last.
test('focus goes to the next stop, then the previous one, when the focused message leaves the list', () => {
  const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const reply = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn');
  assert.ok(reply);
  reply.focus();

  rerenderWith([a, c]);
  assert.equal(focusedMessage(), 'wamid.3');

  rerenderWith([a]);
  assert.equal(focusedMessage(), 'wamid.1');
});

// Only the control went away: its message is still a stop, and it keeps the focus.
test('focus stays on the bubble when a link inside it is the control that went away', () => {
  const linked: ChatMessageView = {
    ...PROMPT,
    id: 'db-2',
    waMessageId: 'wamid.2',
    body: 'see https://example.org/a',
    metadata: undefined,
  };
  const next: ChatMessageView = { ...PROMPT, id: 'db-3', waMessageId: 'wamid.3', body: 'Next', metadata: undefined };
  const { container, rerenderWith } = renderThread('operator', [linked, next]);
  const link = container.querySelector<HTMLElement>('[data-wa-message-id="wamid.2"] a[href]');
  assert.ok(link, 'the body links its URL');
  link.focus();

  rerenderWith([{ ...linked, body: 'see no link now' }, next]);

  assert.equal(focusedMessage(), 'wamid.2');
});

// A refetch after a reconnect replaces the live copy of a message with its stored row, whose id differs,
// so React remounts the bubble: the message is the same, and focus belongs on it.
test('focus goes to the same message when its bubble is remounted under another key', () => {
  const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  del.focus();

  rerenderWith([a, b, c].map(m => ({ ...m, id: `row-${m.waMessageId}` })));

  assert.equal(focusedMessage(), 'wamid.2');
});

// Firefox and WebKit leave the focused element active for a frame after it stopped being focusable, so
// the check after the commit finds focus still on the revoked bubble (jsdom never clears it): it has to be
// moved to a stop then, not left for the focusout that follows, which only forgets it.
test('a revoked bubble that still holds focus gives it to the stop that takes its place', () => {
  const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const bubble = bubblesOf(container)[1];
  bubble.focus();
  assert.equal(focusedMessage(), 'wamid.2');

  rerenderWith([a, { ...b, type: 'revoked', body: '' }, c]);

  assert.equal(focusedMessage(), 'wamid.3');
});

// The newest message has no stop after it, so the one before takes its place, and never the oldest.
test('keyboard focus goes to the stop before the deleted message when it was the newest', () => {
  const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const del = bubblesOf(container)[2].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  del.focus();

  rerenderWith([a, b, { ...c, type: 'revoked', body: '' }]);

  assert.equal(focusedMessage(), 'wamid.2');
});

// Focus the page reports as lost while the control that held it is still a stop (a disabled button, a
// browser that reports the page as active): the thread has nothing to give back, and moving focus to a
// neighbour on a later change of the list would take it from wherever the reader put it.
test('focus the page reports as lost is left alone while the control is still a stop', () => {
  const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  del.focus();
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => document.body });
  try {
    rerenderWith([a, b, { ...c, status: 'read' }]);
  } finally {
    delete (document as { activeElement?: unknown }).activeElement;
  }

  // Nothing moved focus: the button still holds it for jsdom.
  assert.ok(document.activeElement === del, 'focus was moved off the control that still holds it');
});

// What was remembered is used once. Here the only stop is gone and nothing in the thread can take the
// focus; a message that arrives later, after the place of the old bubble, does not draw it in.
test('focus is given back once, not at every later change of the list', () => {
  const [a, b]: ChatMessageView[] = ['1', '2'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a]);
  const del = bubblesOf(container)[0].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  del.focus();

  rerenderWith([{ ...a, type: 'revoked', body: '' }]);
  assert.equal(focusedMessage(), 'body');
  rerenderWith([{ ...a, type: 'revoked', body: '' }, b]);

  assert.equal(focusedMessage(), 'body');
});

// A control that is not a message holds no memory: when it goes away (the jump button once the reader is at
// the bottom) React delivers no blur, and a later change of the list used to take focus to the newest
// bubble, which scrolled a reader who had gone back up to read history down to it.
test('a thread control that is removed does not make a later change of the list take focus', () => {
  const first: ChatMessageView = { ...PROMPT, id: 'db-1', waMessageId: 'wamid.1', metadata: undefined };
  const second: ChatMessageView = { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2', metadata: undefined };
  const { container, rerenderWith } = renderThread('operator', [first]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const control = document.createElement('button');
  thread.appendChild(control);
  control.focus();
  control.remove();
  assert.equal(document.activeElement, document.body);

  rerenderWith([first, second]);
  rerenderWith([first, { ...second, status: 'read' }]);

  assert.equal(focusedMessage(), 'body');
});

test('a focus a pointer brought to an action is not given back, and marks pointer use', () => {
  const first: ChatMessageView = { ...PROMPT, id: 'db-1', waMessageId: 'wamid.1', metadata: undefined };
  const second: ChatMessageView = { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2', metadata: undefined };
  const { container, rerenderWith } = renderThread('operator', [first, second]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  // A mouse click: the press, then the focusin of an element that is not the focused one, so not :focus-visible.
  rtl.fireEvent.pointerDown(del);
  rtl.fireEvent.focusIn(del);
  assert.equal(thread.hasAttribute('data-pointer'), true);

  rerenderWith([first, { ...second, type: 'revoked', body: '' }]);

  assert.equal(focusedMessage(), 'body');
});

/** Makes the thread's clock (performance.now) a number the test moves. */
function holdClock(): { advance: (ms: number) => void } {
  let now = 50_000;
  mock.method(performance, 'now', () => now);
  return {
    advance: ms => {
      now += ms;
    },
  };
}

// A script or a screen reader moves focus after a click: nothing pointed at it, so it is not pointer mode,
// and the actions of the message it lands on are shown to that reader.
test('focus moved by a script after a click is not pointer focus, and shows the actions', () => {
  const { container } = renderThread('operator', [PROMPT, { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2' }]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const clock = holdClock();
  const [first, second] = bubblesOf(container);

  rtl.fireEvent.pointerDown(first);
  rtl.fireEvent.focusIn(first);
  assert.equal(thread.hasAttribute('data-pointer'), true);

  clock.advance(1500);
  rtl.fireEvent.focusIn(second);
  assert.equal(thread.hasAttribute('data-pointer'), false);
});

// A click focuses its target in the task of its press, which is far inside the window.
test('focus a click brings keeps pointer mode, also a moment after the press', () => {
  const { container } = renderThread('operator', [PROMPT, { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2' }]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const clock = holdClock();

  rtl.fireEvent.pointerDown(bubblesOf(container)[0]);
  clock.advance(400);
  rtl.fireEvent.focusIn(bubblesOf(container)[1]);

  assert.equal(thread.hasAttribute('data-pointer'), true);
});

// The lightbox is outside the thread, and its close button gives focus back to the bubble that opened it
// as it goes away: a press anywhere in the page is the one that focus follows, not only a press in the thread.
test('focus given back after a press outside the thread is pointer focus, until the window has passed', () => {
  const { container } = renderThread('operator', [PROMPT, { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2' }]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const close = document.createElement('button');
  document.body.appendChild(close);
  const clock = holdClock();
  try {
    rtl.fireEvent.pointerDown(close);
    clock.advance(300);
    rtl.fireEvent.focusIn(bubblesOf(container)[0]);
    assert.equal(thread.hasAttribute('data-pointer'), true);

    rtl.fireEvent.pointerDown(close);
    clock.advance(1500);
    rtl.fireEvent.focusIn(bubblesOf(container)[1]);
    assert.equal(thread.hasAttribute('data-pointer'), false);
  } finally {
    close.remove();
  }
});

// A click on the controls of an audio or video element sends the page no pointer event at all.
test('focus on a media control is pointer focus without any press seen', () => {
  const voice: ChatMessageView = {
    ...PROMPT,
    id: 'db-vn',
    waMessageId: 'wamid.vn',
    type: 'voice',
    body: '',
    metadata: { media: { mimetype: 'audio/ogg', data: 'AAAA' } },
  };
  const { container } = renderThread('operator', [PROMPT, voice]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const audio = container.querySelector<HTMLElement>('audio');
  assert.ok(audio);
  holdClock();

  rtl.fireEvent.focusIn(audio);
  assert.equal(thread.hasAttribute('data-pointer'), true);

  rtl.fireEvent.focusIn(bubblesOf(container)[0]);
  assert.equal(thread.hasAttribute('data-pointer'), false);
});

// Focus nothing pointed at is held like focus a key brought: a delete reached that way still gives it back.
test('focus no pointer brought is held, and given back when the message is deleted', () => {
  const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  holdClock();

  // Not :focus-visible and no press before it: an assistive technology's focus.
  rtl.fireEvent.focusIn(del);
  rerenderWith([a, { ...b, type: 'revoked', body: '' }, c]);

  assert.equal(focusedMessage(), 'wamid.3');
});

// The confirmation of a mouse click on Delete can stay open for longer than the window. The page's focus
// coming back is not a script's: pointer mode stays, and nothing is held that a click did not bring.
test('a dialog that outlasts the pointer window does not turn a click into keyboard focus', () => {
  const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  const clock = holdClock();

  rtl.fireEvent.pointerDown(del);
  rtl.fireEvent.focusIn(del);
  whilePageUnfocused(() => rtl.fireEvent.focusOut(del));
  clock.advance(4000);
  rtl.fireEvent.focusIn(del);

  assert.equal(thread.hasAttribute('data-pointer'), true);
  rerenderWith([a, { ...b, type: 'revoked', body: '' }, c]);
  assert.equal(focusedMessage(), 'body');
});

test('focus that is moved elsewhere before a message was deleted stays there', () => {
  const first: ChatMessageView = { ...PROMPT, id: 'db-1', waMessageId: 'wamid.1', metadata: undefined };
  const second: ChatMessageView = { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2', metadata: undefined };
  const { container, rerenderWith } = renderThread('operator', [first, second]);
  const outside = document.createElement('input');
  document.body.appendChild(outside);
  try {
    bubblesOf(container)[1].focus();
    outside.focus();
    rerenderWith([first, { ...second, type: 'revoked', body: '' }]);
    assert.ok(document.activeElement === outside, 'focus was taken from the element it was moved to');
  } finally {
    outside.remove();
  }
});

// Focus that went to another control and was lost from there (the control closed, as a dialog does) is not
// the thread's to take back: what the thread remembered ended when focus left it.
test('focus that left the thread and was then lost is not taken back into it', () => {
  const first: ChatMessageView = { ...PROMPT, id: 'db-1', waMessageId: 'wamid.1', metadata: undefined };
  const second: ChatMessageView = { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2', metadata: undefined };
  const { container, rerenderWith } = renderThread('operator', [first, second]);
  const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  const outside = document.createElement('input');
  document.body.appendChild(outside);
  try {
    del.focus();
    outside.focus();
    outside.remove();
    assert.equal(focusedMessage(), 'body');

    rerenderWith([first, { ...second, type: 'revoked', body: '' }]);

    assert.equal(focusedMessage(), 'body');
  } finally {
    outside.remove();
  }
});

/** Runs `fn` with `document.hasFocus()` answering `false`, as it does while another window or a dialog has focus. */
function whilePageUnfocused(fn: () => void): void {
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
  try {
    fn();
  } finally {
    delete (document as { hasFocus?: unknown }).hasFocus;
  }
}

// A native dialog (the delete confirmation) or another window takes the page's focus: the focused control gets
// a blur with no relatedTarget while the document reports no focus, and it is the active element again when
// the page is. What was held for it must survive that, or the delete that follows finds nothing to give back
// and the next Tab lands in the composer.
test('focus held for a control survives the page losing focus, and is given back when the list changes', () => {
  const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  del.focus();

  whilePageUnfocused(() => rtl.fireEvent.focusOut(del));
  rerenderWith([a, { ...b, type: 'revoked', body: '' }, c]);

  assert.equal(focusedMessage(), 'wamid.3');
});

// What it got back with the page is not a new focus to classify: an engine that does not call it
// :focus-visible would otherwise make it one a pointer brought, and the place held for the keyboard is dropped.
test('focus given back with the page keeps what was held, whatever :focus-visible says', () => {
  const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  del.focus();

  whilePageUnfocused(() => rtl.fireEvent.focusOut(del));
  focusVisibleOverride = false;
  rtl.fireEvent.focusIn(del);
  focusVisibleOverride = null;
  rerenderWith([a, { ...b, type: 'revoked', body: '' }, c]);

  assert.equal(focusedMessage(), 'wamid.3');
  assert.equal(thread.hasAttribute('data-pointer'), false);
});

// The element the page took focus from is only forgiven for the round trip: if focus left the thread by
// another route and the element is focused again later, that is a new focus and is classified as one.
test('a later focus on a control the page once took focus from is classified again', () => {
  const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  const outside = document.createElement('input');
  document.body.appendChild(outside);
  try {
    del.focus();
    whilePageUnfocused(() => rtl.fireEvent.focusOut(del));
    // The page never gave focus back to it; the reader moved on to a control outside the thread and returned.
    outside.focus();
    del.focus();
    rerenderWith([a, { ...b, type: 'revoked', body: '' }, c]);

    assert.equal(focusedMessage(), 'wamid.3');
  } finally {
    outside.remove();
  }
});

// The round trip ends when the page gives focus back. The control it was given back to is then an ordinary one:
// moving on to another message and returning to it is a new focus, held for it like any other.
test('a control the page gave focus back to is classified again when the reader returns to it', () => {
  const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const [first, second] = bubblesOf(container);
  const del = second.querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  del.focus();

  whilePageUnfocused(() => rtl.fireEvent.focusOut(del));
  rtl.fireEvent.focusIn(del);
  first.focus();
  del.focus();
  rerenderWith([a, { ...b, type: 'revoked', body: '' }, c]);

  assert.equal(focusedMessage(), 'wamid.3');
});

// Only the one control the page took focus from is forgiven. A focus that lands on another control while the
// page is still away is a new focus: what is held moves to it, or the place given back after the next change
// of the list is the stale one.
test('a focus on another control after the page lost focus is classified, not taken for the return', () => {
  const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const [, second, third] = bubblesOf(container);
  const del = second.querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  del.focus();

  whilePageUnfocused(() => rtl.fireEvent.focusOut(del));
  third.focus();
  rerenderWith([a, b, { ...c, type: 'revoked', body: '' }]);

  assert.equal(focusedMessage(), 'wamid.2');
});

// Only the page's own loss is forgiven: the same blur while the page has focus is the focus going nowhere.
test('focus that went nowhere while the page has focus is not held', () => {
  const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  del.focus();

  rtl.fireEvent.focusOut(del);
  rerenderWith([a, { ...b, type: 'revoked', body: '' }, c]);

  assert.equal(focusedMessage(), 'body');
});

// Chats.css shows the actions while focus is inside a bubble, but a click focuses the bubble too, and
// its menu would stay drawn over the message after the pointer left. The thread marks pointer use and the
// stylesheet reveals on focus only without the mark. jsdom has no layout, so the selectors are pinned.
test('a click marks pointer use, a key press clears it, and the stylesheet reveals on keyboard focus only', () => {
  const { container } = renderThread('operator', [PROMPT, { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2' }]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  assert.equal(thread.hasAttribute('data-pointer'), false);
  rtl.fireEvent.pointerDown(bubblesOf(container)[0]);
  assert.equal(thread.hasAttribute('data-pointer'), true);
  rtl.fireEvent.keyDown(bubblesOf(container)[0], { key: 'Tab' });
  assert.equal(thread.hasAttribute('data-pointer'), false);

  const css = readFileSync(new URL('../../pages/Chats.css', import.meta.url), 'utf8');
  for (const target of [
    '.message-bubble-container:focus-within .message-actions-menu',
    '.reaction-trigger-wrapper:focus-within .reaction-quick-popover',
  ]) {
    const rule = css.split('\n').find(line => line.includes(target));
    assert.ok(rule, `${target} reveals the menu on focus`);
    assert.ok(rule.includes('.room-messages:not([data-pointer])'), `${target} is gated on keyboard modality`);
  }
});

// The button is a child of the scroller. Absolutely positioned there it moves with the content, which put it
// at the bottom of the first screen of the thread and off screen whenever it was shown. Sticky, as the last
// child, it holds to the bottom of the visible pane. jsdom has no layout, so the declarations are pinned:
// the negative margin takes back the room an in-flow button would add to the scroll height, align-self puts
// it at the logical end, and it sits below the actions menu (z-index 5) it would otherwise cover.
test('the scroll-to-bottom button is sticky inside the scroller, not absolute, and below the actions menu', () => {
  const css = readFileSync(new URL('../../pages/Chats.css', import.meta.url), 'utf8');
  const rule = /\.chats-page \.scroll-to-bottom-btn \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rule, /position:\s*sticky;/);
  assert.match(rule, /bottom:\s*1rem;/);
  assert.match(rule, /align-self:\s*flex-end;/);
  assert.match(rule, /margin-top:\s*calc\(-40px - 0\.75rem\);/);
  assert.doesNotMatch(rule, /position:\s*absolute/);
  const menu = /\.chats-page \.message-actions-menu \{([^}]*)\}/.exec(css)?.[1] ?? '';
  const level = (text: string): number => Number(/z-index:\s*(\d+);/.exec(text)?.[1]);
  assert.ok(level(rule) < level(menu), 'the jump button paints over the actions menu');
});

// An own bubble is at the end of the pane, and the react icon of its pill is a few pixels from that end: a
// popover centred on it runs past the pane, so the last emoji is clipped and the thread scrolls sideways.
test('the reaction popover of an own message grows from the end of its icon, not from its centre', () => {
  const css = readFileSync(new URL('../../pages/Chats.css', import.meta.url), 'utf8');
  const rule =
    /\.chats-page \.message-bubble-wrapper\.outgoing \.reaction-quick-popover \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rule, /inset-inline-end:\s*0;/);
  assert.match(rule, /left:\s*auto;/);
  // No centring on the icon: whatever shift it carries is the one set when it opens.
  assert.doesNotMatch(rule, /-50%/);
});

// jsdom has no layout, so the rectangles are given: a popover that opens 30 px past the start edge of the
// thread is shifted back by 30 px, one inside it is left alone, and the shift is measured again each time.
test('the reaction popover is shifted back inside the thread when it opens past an edge', () => {
  const { container } = renderThread('operator', [PROMPT, { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2' }]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const wrapper = bubblesOf(container)[0].querySelector<HTMLElement>('.reaction-trigger-wrapper');
  const popover = wrapper?.querySelector<HTMLElement>('.reaction-quick-popover');
  assert.ok(wrapper && popover);
  const rect = (left: number, right: number) => () =>
    ({ left, right, top: 0, bottom: 0, width: right - left }) as DOMRect;
  thread.getBoundingClientRect = rect(100, 700);

  popover.getBoundingClientRect = rect(70, 278);
  rtl.fireEvent.mouseEnter(wrapper);
  assert.equal(popover.style.getPropertyValue('--popover-shift'), '30px');

  popover.getBoundingClientRect = rect(500, 708);
  rtl.fireEvent.mouseEnter(wrapper);
  assert.equal(popover.style.getPropertyValue('--popover-shift'), '-8px');

  popover.getBoundingClientRect = rect(300, 508);
  rtl.fireEvent.mouseEnter(wrapper);
  assert.equal(popover.style.getPropertyValue('--popover-shift'), '');
  assert.equal(popover.hasAttribute('data-below'), false);
});

// A message at the top of the pane has no room above its icon: the popover opens below it, and is measured
// again each time, so scrolling the message down puts it back above.
test('the reaction popover opens below its icon when it would lie above the thread', () => {
  const { container } = renderThread('operator', [PROMPT, { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2' }]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const wrapper = bubblesOf(container)[0].querySelector<HTMLElement>('.reaction-trigger-wrapper');
  const popover = wrapper?.querySelector<HTMLElement>('.reaction-quick-popover');
  assert.ok(wrapper && popover);
  const rect = (top: number) => () => ({ left: 300, right: 508, top, bottom: top + 44, width: 208 }) as DOMRect;
  thread.getBoundingClientRect = () => ({ left: 100, right: 700, top: 200, bottom: 600, width: 600 }) as DOMRect;

  popover.getBoundingClientRect = rect(170);
  rtl.fireEvent.mouseEnter(wrapper);
  assert.equal(popover.hasAttribute('data-below'), true);

  popover.getBoundingClientRect = rect(260);
  rtl.fireEvent.mouseEnter(wrapper);
  assert.equal(popover.hasAttribute('data-below'), false);

  const css = readFileSync(new URL('../../pages/Chats.css', import.meta.url), 'utf8');
  assert.match(css, /\.reaction-quick-popover\[data-below\] \{[^}]*top:\s*100%;/);
});

test('the scroll-to-bottom button is the last child of the scroller and jumps without animating', async () => {
  const messages: ChatMessageView[] = ['1', '2'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container } = renderThread('operator', messages);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  Object.defineProperty(thread, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(thread, 'clientHeight', { value: 400, configurable: true });
  const jumps: ScrollToOptions[] = [];
  thread.scrollTo = ((options: ScrollToOptions) => void jumps.push(options)) as typeof thread.scrollTo;
  rtl.fireEvent.scroll(thread);

  const button = await rtl.waitFor(() => {
    const found = thread.querySelector<HTMLElement>('.scroll-to-bottom-btn');
    assert.ok(found, 'the jump button did not show');
    return found;
  });
  assert.equal(thread.lastElementChild, button);
  rtl.fireEvent.click(button);
  // A smooth jump is cancelled by an older page that lands during the animation.
  assert.deepEqual(jumps, [{ top: 2000 }]);
});

// A Tab from the sidebar into the thread is a key press the thread never sees, so a click made in the thread
// earlier left the pointer mark on, and the focused bubble showed no actions until the next key. A focus
// the browser calls keyboard focus (:focus-visible) clears the mark; the focus a click brings does not match.
test('focus that arrives by keyboard clears the pointer mark a click left, and a mouse focus does not', () => {
  const { container } = renderThread('operator', [PROMPT, { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2' }]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const bubble = bubblesOf(container)[0];

  rtl.fireEvent.pointerDown(bubble);
  // A focus event on an element that is not the focused one has no :focus-visible, as a click's does not.
  rtl.fireEvent.focusIn(bubble);
  assert.equal(thread.hasAttribute('data-pointer'), true);

  bubble.focus();
  assert.equal(thread.hasAttribute('data-pointer'), false);
});
