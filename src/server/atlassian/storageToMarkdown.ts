import TurndownService from 'turndown';
import { tables } from 'turndown-plugin-gfm';

// Server-only: never import from src/lib or client components.
// Converts Confluence storage format (XHTML with ac:/ri: elements) to Markdown for the AI context (SR-2.3).

const TEXT_MACROS = new Set(['panel', 'info', 'note', 'tip', 'warning', 'expand', 'quote']);

// The HTML parser treats CDATA as a comment, which would lose code bodies.
function inlineCdata(xhtml: string): string {
  return xhtml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  );
}

// Turndown collapses whitespace and drops empty elements, so code macros and page links become plain HTML first.
function rewriteCodeAndLinks(xhtml: string): string {
  return xhtml
    .replace(
      /<ac:structured-macro[^>]*ac:name="(?:code|noformat)"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g,
      (_m, inner: string) => {
        const language = /<ac:parameter[^>]*ac:name="language"[^>]*>([^<]*)<\/ac:parameter>/.exec(inner)?.[1]?.trim();
        const body = /<ac:plain-text-body>([\s\S]*?)<\/ac:plain-text-body>/.exec(inner)?.[1] ?? '';
        return `<pre><code${language ? ` class="language-${language}"` : ''}>${body}</code></pre>`;
      },
    )
    .replace(/<ac:link[^>]*>([\s\S]*?)<\/ac:link>/g, (_m, inner: string) => {
      const body = /<ac:link-body>([\s\S]*?)<\/ac:link-body>/.exec(inner)?.[1];
      const title = /ri:content-title="([^"]*)"/.exec(inner)?.[1];
      return `<span>${body ?? title ?? ''}</span>`;
    });
}

function macroName(node: HTMLElement): string {
  return node.getAttribute('ac:name') ?? 'unknown';
}

function createService(): TurndownService {
  const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  service.use(tables);

  // Macro parameters (panel titles, code language, ...) are metadata, not content.
  service.addRule('confluenceParameter', {
    filter: (node) => node.nodeName.toLowerCase() === 'ac:parameter',
    replacement: () => '',
  });

  service.addRule('confluenceMacro', {
    filter: (node) => node.nodeName.toLowerCase() === 'ac:structured-macro',
    replacement: (content, node) => {
      const el = node as HTMLElement;
      const name = macroName(el);
      if (TEXT_MACROS.has(name)) return `\n\n${content.trim()}\n\n`;
      return `[macro: ${name}]`;
    },
  });

  return service;
}

export function storageToMarkdown(xhtml: string): string {
  return createService()
    .turndown(rewriteCodeAndLinks(inlineCdata(xhtml)))
    .trim();
}
