/**
 * What counts as a word, as an upper bound on how the built-in index splits a query (SQLite FTS5,
 * unicode61): a run of letters or digits is one word, and so is every other character outside ASCII,
 * since the index may treat it as part of a word (private use, a code point its Unicode table does not
 * know, among them recent emoji) or as a separator. Only ASCII punctuation is known to separate.
 *
 * The 21 letters its tokenizer still splits on are left out of the run, so they count one by one.
 * search-terms.spec.ts compares every code point with the bundled SQLite, so an upgrade that moves one
 * fails there instead of silently loosening the bound.
 */
const WORD = /(?:(?![\u19B0-\u19C0\u19C8\u19C9\u1CF2\u1CF3])[\p{L}\p{N}])+|[^\s\p{ASCII}]/gu;

/**
 * How many words a query holds: each run of letters or digits is one, so punctuation separates words as
 * whitespace does (`a.b.c` is three, and a quoted token of them is a three-word phrase to match), and
 * a symbol or emoji counts as a word of its own. A whitespace-separated word said again is run once and
 * counts once.
 */
export function searchTermCount(q: string): number {
  let count = 0;
  for (const word of new Set(q.trim().split(/\s+/))) {
    count += word.match(WORD)?.length ?? 1;
  }
  return count;
}
