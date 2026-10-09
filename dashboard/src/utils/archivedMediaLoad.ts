import { retryThrottled } from './fetchAllPages.ts';

// The gateway answers a route 10 times a second per IP by default and refuses the rest with a 429,
// which also counts against the minute tier. A chat opened on archived media wants one fetch per
// preview near the viewport, so the fetches start 125 ms apart (8 a second) rather than all at once;
// otherwise the newest previews are the ones refused and stay download buttons for good. A 429 that
// still arrives (a lower configured limit, another tab) is retried like fetchAllPages retries a page.
const START_GAP_MS = 125;
let nextStart = 0;

function waitForTurn(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const now = Date.now();
  const startAt = Math.max(now, nextStart);
  nextStart = startAt + START_GAP_MS;
  if (startAt === now) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, startAt - now);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function loadArchivedMedia<T>(signal: AbortSignal, load: () => Promise<T>, retryDelayMs = 1000): Promise<T> {
  return retryThrottled(async () => {
    await waitForTurn(signal);
    return load();
  }, retryDelayMs);
}
