import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { searchTermCount } from './search-terms';

describe('searchTermCount', () => {
  it('counts a run of letters or digits as one word and punctuation as a separator', () => {
    expect(searchTermCount('hello')).toBe(1);
    expect(searchTermCount('hello world')).toBe(2);
    expect(searchTermCount('a.b.c')).toBe(3);
    expect(searchTermCount('user@example.com')).toBe(3);
    expect(searchTermCount('2024-10-14')).toBe(3);
  });

  it('counts a whitespace-separated word said again once', () => {
    expect(searchTermCount('hi hi hi')).toBe(1);
    expect(searchTermCount('a.b a.b')).toBe(2);
  });

  it('counts a word with no letter or digit as one', () => {
    expect(searchTermCount('!!!')).toBe(1);
  });

  it('keeps the words of non-Latin text whole', () => {
    expect(searchTermCount('привет мир')).toBe(2);
    expect(searchTermCount('こんにちは')).toBe(1);
  });

  it('counts a character the index splits on although it is a letter as a separator', () => {
    expect(searchTermCount('a\u1CF2'.repeat(40))).toBe(40);
  });

  describe('against the bundled SQLite', () => {
    let ds: DataSource;
    beforeAll(async () => {
      ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
      await ds.initialize();
      await ds.query('CREATE VIRTUAL TABLE probe USING fts5(body)');
    });
    afterAll(() => ds.destroy());

    it('never counts fewer words than the index splits a letter or digit into', async () => {
      const letters: number[] = [];
      for (let cp = 1; cp <= 0x10ffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        if (/[\p{L}\p{N}]/u.test(String.fromCodePoint(cp))) letters.push(cp);
      }
      for (let at = 0; at < letters.length; at += 5000) {
        const rows = letters
          .slice(at, at + 5000)
          .map(cp => `(${cp}, 'a${String.fromCodePoint(cp)}a')`)
          .join(',');
        await ds.query(`INSERT INTO probe (rowid, body) VALUES ${rows}`);
      }
      // `a<c>a` is two tokens exactly when the index treats <c> as a separator.
      const split = await ds.query<{ cp: number }[]>(`SELECT rowid AS cp FROM probe WHERE probe MATCH '"a a"'`);
      const undercounted = split
        .map(row => row.cp)
        .filter(cp => searchTermCount(`a${String.fromCodePoint(cp)}a`) < 2)
        .map(cp => cp.toString(16));
      expect(undercounted).toEqual([]);
    });
  });
});
