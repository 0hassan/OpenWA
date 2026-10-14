// Render test for the chat thread's write actions. The gateway answers reply, react, delete and a
// prompt-button tap only for an operator key, so a read-only key must not be offered them. It also
// checks the thread, not just the helpers, resolves an @mention in a body and in a quote.
import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, createRef } from 'react';
import type { Chat } from '../../services/api.ts';
import type { ChatMessageView } from '../../utils/chatMessages.ts';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
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
});

afterEach(() => {
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
): { clicks: string[]; container: HTMLElement } {
  window.sessionStorage.setItem('openwa_user_role', role);
  const clicks: string[] = [];
  const noop = () => {};
  const { container } = rtl.render(
    createElement(
      RoleProvider,
      null,
      createElement(ChatThread, {
        sessionId: 's1',
        activeChat,
        messages,
        loadingMessages: false,
        messagesError: false,
        messagesContainerRef: createRef<HTMLDivElement>(),
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
    ),
  );
  return { clicks, container };
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
