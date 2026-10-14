/**
 * What a word is made of, as the built-in index sees it: letters and digits, less the 21 characters
 * its tokenizer (SQLite FTS5, unicode61) still splits on although current Unicode tables class them
 * as letters. search-terms.spec.ts compares every letter and digit with the bundled SQLite, so an
 * upgrade that moves one fails there instead of silently loosening the bound.
 */
const WORD = /(?:(?![\u19B0-\u19C0\u19C8\u19C9\u1CF2\u1CF3])[\p{L}\p{N}])+/gu;

/**
 * How many words a query holds, counted as the index counts them: a run of letters or digits is one,
 * so punctuation separates words as whitespace does (`a.b.c` is three, and a quoted token of them is a
 * three-word phrase to match). A whitespace-separated word said again is run once and counts once.
 */
export function searchTermCount(q: string): number {
  let count = 0;
  for (const word of new Set(q.trim().split(/\s+/))) {
    count += word.match(WORD)?.length ?? 1;
  }
  return count;
}
