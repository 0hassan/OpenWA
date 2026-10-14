import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { searchTermCount } from './search-terms';

const chars = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

describe('searchTermCount', () => {
  it('counts a run of letters or digits as one word and ASCII punctuation as a separator', () => {
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

  it('counts a character the index may split on, or glue, one by one', () => {
    // A letter its tokenizer still splits on, a private-use character and an emoji its Unicode table
    // predates: each is a word of its own between separators or next to a letter.
    for (const c of [chars(0x1cf2), chars(0xe000), chars(0x1f923), chars(0x1f3fb)]) {
      expect(searchTermCount(`${c}.`.repeat(40))).toBeGreaterThanOrEqual(40);
      expect(searchTermCount(`a${c}`.repeat(40))).toBeGreaterThanOrEqual(40);
    }
  });

  describe('against the bundled SQLite', () => {
    let ds: DataSource;
    beforeAll(async () => {
      ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
      await ds.initialize();
      await ds.query('CREATE VIRTUAL TABLE glue USING fts5(body)');
      await ds.query("CREATE VIRTUAL TABLE glue_tokens USING fts5vocab(glue, 'instance')");
      await ds.query('CREATE VIRTUAL TABLE split USING fts5(body)');
      await ds.query("CREATE VIRTUAL TABLE split_tokens USING fts5vocab(split, 'instance')");
      // Every code point but the surrogates, generated inside SQLite: c.c is two tokens when the index
      // treats c as part of a word, and aca is two when it treats c as a separator.
      const codePoints = 'WITH RECURSIVE n(c) AS (SELECT 1 UNION ALL SELECT c + 1 FROM n WHERE c < 1114111)';
      await ds.query(
        `${codePoints} INSERT INTO glue (rowid, body) SELECT c, char(c) || '.' || char(c) FROM n WHERE c NOT BETWEEN 55296 AND 57343`,
      );
      await ds.query(
        `${codePoints} INSERT INTO split (rowid, body) SELECT c, 'a' || char(c) || 'a' FROM n WHERE c NOT BETWEEN 55296 AND 57343`,
      );
    }, 60_000);
    afterAll(() => ds.destroy());

    const undercounted = async (table: string, text: (c: string) => string): Promise<string[]> => {
      const tokens = await ds.query<{ cp: number; n: number }[]>(
        `SELECT doc AS cp, count(*) AS n FROM ${table} GROUP BY doc`,
      );
      // Whitespace never reaches the count inside a word: the query is split on it first.
      const notSpace = (row: { cp: number }): boolean => !/\s/u.test(String.fromCodePoint(row.cp));
      return tokens
        .filter(notSpace)
        .filter(row => searchTermCount(text(String.fromCodePoint(row.cp))) < row.n)
        .map(row => row.cp.toString(16));
    };

    it('never counts fewer words than the index finds around a character it treats as part of a word', async () => {
      expect(await undercounted('glue_tokens', c => `${c}.${c}`)).toEqual([]);
    }, 60_000);

    it('never counts fewer words than the index finds around a character it treats as a separator', async () => {
      expect(await undercounted('split_tokens', c => `a${c}a`)).toEqual([]);
    }, 60_000);
  });
});
