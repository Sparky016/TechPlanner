import { describe, expect, it } from 'vitest';
import { storageToMarkdown } from './storageToMarkdown';

describe('storageToMarkdown', () => {
  it('converts headings, lists and links', () => {
    const md = storageToMarkdown(
      '<h1>Title</h1><h2>Sub</h2><p>See <a href="https://example.com/x">the docs</a></p>' +
        '<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>',
    );
    expect(md).toContain('# Title');
    expect(md).toContain('## Sub');
    expect(md).toContain('[the docs](https://example.com/x)');
    expect(md).toMatch(/-\s+one\n-\s+two/);
    expect(md).toMatch(/1\.\s+first\n2\.\s+second/);
  });

  it('converts tables to GFM tables', () => {
    const md = storageToMarkdown(
      '<table><tbody><tr><th>Name</th><th>Role</th></tr><tr><td>Ann</td><td>Dev</td></tr></tbody></table>',
    );
    expect(md).toContain('| Name | Role |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| Ann | Dev |');
  });

  it('renders the code macro body as a fenced block, keeping CDATA content', () => {
    const md = storageToMarkdown(
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts</ac:parameter>' +
        '<ac:plain-text-body><![CDATA[const a = 1 < 2;\nreturn a;]]></ac:plain-text-body></ac:structured-macro>',
    );
    expect(md).toBe('```ts\nconst a = 1 < 2;\nreturn a;\n```');
  });

  it('renders panel macro bodies as text without the title parameter', () => {
    const md = storageToMarkdown(
      '<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Heads up</ac:parameter>' +
        '<ac:rich-text-body><p>Important text</p></ac:rich-text-body></ac:structured-macro>',
    );
    expect(md).toBe('Important text');
  });

  it('replaces unknown macros with a marker', () => {
    const md = storageToMarkdown(
      '<p>Before</p><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">A-1</ac:parameter></ac:structured-macro>',
    );
    expect(md).toContain('Before');
    expect(md).toContain('[macro: jira]');
    expect(md).not.toContain('A-1');
  });

  it('renders page links by title', () => {
    const md = storageToMarkdown('<ac:link><ri:page ri:content-title="Other page" /></ac:link>');
    expect(md).toBe('Other page');
  });
});
