// Server-only: never import from src/lib or client components.
// Application SQL uses `?` placeholders, which MySQL drivers take as-is. The PostgreSQL adapter rewrites them to
// $1..$n in order of appearance. `?` inside a quoted literal, a quoted identifier, a dollar-quoted body or a
// comment is left alone. A statement that still uses $n is rejected so the two styles never mix: a parameter used
// twice is written as two `?` and passed twice.

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;
const NUMBERED = /^\$\d/;

/** Returns `sql` with each `?` replaced by $1..$n, and n. Throws when the statement contains a $n placeholder. */
export function toPgPlaceholders(sql: string): { text: string; count: number } {
  let text = '';
  let count = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    let end = i + 1;
    if (c === "'" || c === '"') {
      end = closingQuote(sql, i);
    } else if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      end = nl === -1 ? sql.length : nl;
    } else if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      end = close === -1 ? sql.length : close + 2;
    } else if (c === '$' && (i === 0 || !IDENT_CHAR.test(sql[i - 1]))) {
      const rest = sql.slice(i);
      if (NUMBERED.test(rest)) throw new Error('SQL must use ? placeholders, not $n');
      const tag = DOLLAR_TAG.exec(rest)?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        end = close === -1 ? sql.length : close + tag.length;
      }
    } else if (c === '?') {
      count += 1;
      text += `$${count}`;
      i = end;
      continue;
    }
    text += sql.slice(i, end);
    i = end;
  }
  return { text, count };
}

// Index just past the quote that closes the literal or identifier opened at `start`; a doubled quote is an escape.
function closingQuote(sql: string, start: number): number {
  const quote = sql[start];
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] !== quote) return i + 1;
      i += 2;
    } else {
      i += 1;
    }
  }
  return sql.length;
}
