// The scroll-position hook mounted on a real container. jsdom has no layout and fires no scroll event
// when a shrinking thread clamps scrollTop, so the container below models both: scrollTop is clamped
// to the content height, and the test dispatches the scroll event a browser would.
import '../test-helpers/register-hooks.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useEffect, type MutableRefObject } from 'react';

let rtl: typeof import('@testing-library/react');
let useChatScrollPosition: (typeof import('./useChatScrollPosition.ts'))['useChatScrollPosition'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  rtl = await import('@testing-library/react');
  ({ useChatScrollPosition } = await import('./useChatScrollPosition.ts'));
});

after(() => rtl.cleanup());

const CLIENT_HEIGHT = 400;
// A loaded thread is 100 rows; a chat still loading shows one spinner row.
const LOADED_HEIGHT = 4600;
const SPINNER_HEIGHT = 400;

function Thread({ chatId, isLoaded }: { chatId: string; isLoaded: boolean }) {
  const { containerRef } = useChatScrollPosition(chatId, isLoaded, false);
  return createElement('div', { ref: containerRef, 'data-testid': 'thread' });
}

test('switching to a chat that is still loading does not save the clamped top as its position', async () => {
  const { render, screen, fireEvent } = rtl;
  let height = LOADED_HEIGHT;
  let top = 0;
  const maxTop = () => Math.max(0, height - CLIENT_HEIGHT);
  // Defined before the first commit, so the restore effects already see this geometry.
  const proto = window.HTMLDivElement.prototype;
  const saved = Object.getOwnPropertyDescriptors(proto);
  Object.defineProperties(proto, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => CLIENT_HEIGHT },
    scrollTop: {
      configurable: true,
      get: () => Math.min(top, maxTop()),
      set: (v: number) => {
        top = Math.max(0, Math.min(v, maxTop()));
      },
    },
  });
  try {
    const { rerender } = render(createElement(Thread, { chatId: 'A', isLoaded: true }));
    const el = screen.getByTestId('thread');
    assert.equal(el.scrollTop, maxTop(), 'chat A did not open at the bottom');
    fireEvent.scroll(el); // the event a browser fires for that write
    el.scrollTop = 3000; // the operator reads a little way up
    fireEvent.scroll(el);

    // Chat B is not cached: the same container swaps A's thread for the spinner, and the browser
    // clamps scrollTop to 0 and reports it as a scroll on the next frame.
    height = SPINNER_HEIGHT;
    rerender(createElement(Thread, { chatId: 'B', isLoaded: false }));
    fireEvent.scroll(el);

    height = LOADED_HEIGHT;
    rerender(createElement(Thread, { chatId: 'B', isLoaded: true }));
    assert.equal(el.scrollTop, maxTop(), 'chat B opened at its oldest message instead of the newest');
  } finally {
    for (const key of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) {
      if (saved[key]) Object.defineProperty(proto, key, saved[key]);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
  }
});

// An older page lands above the reader. Previews that swap in BELOW the reader while it is in flight grow
// the thread but move nothing on screen, so holding the reader by the thread's height delta dragged them
// down the thread by those pixels. The reader is held by the message they were on.
test('an older page holds the reader by their message, not by every pixel the thread grew', async () => {
  const { render, screen, cleanup } = rtl;
  cleanup();
  const top = { value: 0 };
  // Content-coordinate tops of the three messages the thread holds; the viewport shows 400px of them.
  const messageTops = new Map<string, number>([
    ['m1', 100],
    ['m2', 500],
    ['m3', 900],
  ]);
  let height = 1300;
  const proto = window.HTMLDivElement.prototype;
  const saved = Object.getOwnPropertyDescriptors(proto);
  const rectSaved = window.Element.prototype.getBoundingClientRect;
  Object.defineProperties(proto, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => CLIENT_HEIGHT },
    scrollTop: {
      configurable: true,
      get: () => top.value,
      set: (v: number) => {
        top.value = Math.max(0, Math.min(v, height - CLIENT_HEIGHT));
      },
    },
  });
  window.Element.prototype.getBoundingClientRect = function (this: Element) {
    const content = messageTops.get(this.getAttribute('data-id') ?? '');
    const y = content === undefined ? 0 : content - top.value;
    return { top: y, bottom: y + 300, left: 0, right: 0, width: 0, height: 300, x: 0, y } as DOMRect;
  };

  const request: MutableRefObject<(() => void) | null> = { current: null };
  function Older({ fetching }: { fetching: boolean }) {
    const { containerRef, onOlderMessagesRequested } = useChatScrollPosition('A', true, fetching);
    useEffect(() => {
      request.current = onOlderMessagesRequested;
    });
    return createElement(
      'div',
      { ref: containerRef, 'data-testid': 'thread' },
      ['m1', 'm2', 'm3'].map(id => createElement('div', { key: id, 'data-id': id, 'data-scroll-anchor': '' })),
    );
  }

  try {
    const { rerender } = render(createElement(Older, { fetching: false }));
    const el = screen.getByTestId('thread');
    // The reader is on m2 (500..800 in content, the viewport 400..800), 100px below the container's top.
    top.value = 400;
    request.current?.();
    rerender(createElement(Older, { fetching: true }));

    // The page lands: 2000px of history above, and a 230px preview swapped in below m3 meanwhile.
    for (const [id, y] of [...messageTops]) messageTops.set(id, y + 2000);
    height += 2000 + 230;
    rerender(createElement(Older, { fetching: false }));

    assert.equal(el.scrollTop, 400 + 2000, 'the reader moved by more or less than the history above them');
  } finally {
    for (const key of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) {
      if (saved[key]) Object.defineProperty(proto, key, saved[key]);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
    window.Element.prototype.getBoundingClientRect = rectSaved;
  }
});
