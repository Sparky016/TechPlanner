import { describe, expect, it } from 'vitest';
import { toPgPlaceholders } from './placeholders';

describe('toPgPlaceholders', () => {
  it('numbers placeholders in order of appearance', () => {
    expect(toPgPlaceholders('SELECT * FROM t WHERE a = ? AND b IN (?, ?)')).toEqual({
      text: 'SELECT * FROM t WHERE a = $1 AND b IN ($2, $3)',
      count: 3,
    });
  });

  it('gives a repeated parameter its own number each time', () => {
    expect(toPgPlaceholders('SELECT ? AS x WHERE (?::bigint IS NULL OR id < ?)')).toEqual({
      text: 'SELECT $1 AS x WHERE ($2::bigint IS NULL OR id < $3)',
      count: 3,
    });
  });

  it('leaves a statement without placeholders unchanged', () => {
    const sql = "CREATE TABLE t (id int);\nINSERT INTO t VALUES (1)";
    expect(toPgPlaceholders(sql)).toEqual({ text: sql, count: 0 });
    expect(toPgPlaceholders('')).toEqual({ text: '', count: 0 });
  });

  it('skips ? inside single-quoted literals, including doubled quotes', () => {
    expect(toPgPlaceholders("SELECT 'why?', 'it''s ?', ? FROM t WHERE c = '?'")).toEqual({
      text: "SELECT 'why?', 'it''s ?', $1 FROM t WHERE c = '?'",
      count: 1,
    });
  });

  it('skips ? inside quoted identifiers', () => {
    expect(toPgPlaceholders('SELECT "a?b", "x""?" FROM t WHERE id = ?').text).toBe(
      'SELECT "a?b", "x""?" FROM t WHERE id = $1',
    );
  });

  it('skips ? inside line and block comments', () => {
    const sql = 'SELECT a -- keep ?\n  , b /* and ? here */ FROM t WHERE id = ? /* tail ? */';
    expect(toPgPlaceholders(sql)).toEqual({
      text: 'SELECT a -- keep ?\n  , b /* and ? here */ FROM t WHERE id = $1 /* tail ? */',
      count: 1,
    });
  });

  it('skips ? and $n inside dollar-quoted bodies', () => {
    const sql = 'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT $1 WHERE ? $$; SELECT $tag$ ? $tag$, ?';
    expect(toPgPlaceholders(sql)).toEqual({
      text: 'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT $1 WHERE ? $$; SELECT $tag$ ? $tag$, $1',
      count: 1,
    });
  });

  it('treats an unterminated literal or comment as running to the end', () => {
    expect(toPgPlaceholders("SELECT ? WHERE a = 'open ?").text).toBe("SELECT $1 WHERE a = 'open ?");
    expect(toPgPlaceholders('SELECT ? /* open ?').text).toBe('SELECT $1 /* open ?');
  });

  it('rejects a statement that still uses $n placeholders', () => {
    expect(() => toPgPlaceholders('SELECT * FROM t WHERE id = $1')).toThrow(/\? placeholders/);
    expect(() => toPgPlaceholders('SELECT ?, $2')).toThrow(/\? placeholders/);
  });

  it('allows $n inside literals and comments, and $ inside identifiers', () => {
    expect(toPgPlaceholders("SELECT '$1', a$1 FROM t -- $2\nWHERE id = ?").text).toBe(
      "SELECT '$1', a$1 FROM t -- $2\nWHERE id = $1",
    );
  });
});
