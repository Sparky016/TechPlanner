import { describe, expect, it } from 'vitest';
import { adfToText } from './adfToText';

const text = (t: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) => ({
  type: 'text',
  text: t,
  marks,
});
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });

describe('adfToText', () => {
  it('returns empty text for empty input', () => {
    expect(adfToText(null)).toBe('');
    expect(adfToText(undefined)).toBe('');
    expect(adfToText(doc())).toBe('');
  });

  it('renders headings and paragraphs (AC3)', () => {
    const out = adfToText(
      doc({ type: 'heading', attrs: { level: 2 }, content: [text('Goal')] }, para(text('First')), para(text('Second'))),
    );
    expect(out).toBe('## Goal\n\nFirst\n\nSecond');
  });

  it('renders nested bullet and ordered lists (AC3)', () => {
    const out = adfToText(
      doc({
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              para(text('parent')),
              {
                type: 'orderedList',
                content: [
                  { type: 'listItem', content: [para(text('one'))] },
                  { type: 'listItem', content: [para(text('two'))] },
                ],
              },
            ],
          },
          { type: 'listItem', content: [para(text('sibling'))] },
        ],
      }),
    );
    expect(out).toBe('- parent\n  1. one\n  2. two\n- sibling');
  });

  it('renders code blocks and inline code (AC3)', () => {
    const out = adfToText(
      doc(
        {
          type: 'codeBlock',
          attrs: { language: 'ts' },
          content: [text('const a = 1;')],
        },
        para(text('use '), text('npm test', [{ type: 'code' }])),
      ),
    );
    expect(out).toBe('```ts\nconst a = 1;\n```\n\nuse `npm test`');
  });

  it('renders tables with a header separator (AC3)', () => {
    const out = adfToText(
      doc({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [para(text('Name'))] },
              { type: 'tableHeader', content: [para(text('Value'))] },
            ],
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [para(text('a'))] },
              { type: 'tableCell', content: [para(text('1'))] },
            ],
          },
        ],
      }),
    );
    expect(out).toBe('| Name | Value |\n| --- | --- |\n| a | 1 |');
  });

  it('renders links and mentions (AC3)', () => {
    const out = adfToText(
      doc(
        para(text('see '), text('the docs', [{ type: 'link', attrs: { href: 'https://example.com' } }]), text(' cc '), {
          type: 'mention',
          attrs: { id: 'u1', text: '@Alice' },
        }),
      ),
    );
    expect(out).toBe('see [the docs](https://example.com) cc @Alice');
  });

  it('renders unknown containers through their children', () => {
    const out = adfToText(
      doc({
        type: 'panel',
        attrs: { panelType: 'info' },
        content: [para(text('note'))],
      }),
    );
    expect(out).toBe('note');
  });
});
