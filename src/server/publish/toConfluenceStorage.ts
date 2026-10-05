// Server-only: never import from src/lib or client components.
// Converts the canonical Markdown (SR-5.4) into Confluence storage format: well-formed XHTML with fenced code
// rendered as the Confluence code macro. Raw HTML in the Markdown is escaped, never passed through (stored XSS).

import { Marked, type RendererObject, type Tokens } from "marked";

/** Escapes every XML-significant character; existing entities are escaped too so output stays well-formed XML. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** CDATA cannot contain ']]>'; split it across two sections. */
function cdata(text: string): string {
  return `<![CDATA[${text.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

/** Only http(s), mailto, in-page anchors and relative paths are emitted as hrefs (no javascript:, data:, ...). */
function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^[#/]/.test(trimmed) && !trimmed.startsWith("//")) return trimmed;
  return null;
}

const renderer: RendererObject = {
  code({ text, lang }: Tokens.Code): string {
    const language = (lang ?? "").trim().split(/\s+/)[0] ?? "";
    const param =
      language === ""
        ? ""
        : `<ac:parameter ac:name="language">${escapeXml(language)}</ac:parameter>`;
    return (
      `<ac:structured-macro ac:name="code">${param}` +
      `<ac:plain-text-body>${cdata(text)}</ac:plain-text-body></ac:structured-macro>\n`
    );
  },
  html({ text, block }: Tokens.HTML | Tokens.Tag): string {
    const escaped = escapeXml(text);
    return block === true ? `<p>${escaped.trim()}</p>\n` : escaped;
  },
  hr(): string {
    return "<hr />\n";
  },
  br(): string {
    return "<br />";
  },
  checkbox({ checked }: Tokens.Checkbox): string {
    return checked ? "[x] " : "[ ] ";
  },
  codespan({ text }: Tokens.Codespan): string {
    return `<code>${escapeXml(text)}</code>`;
  },
  text(token: Tokens.Text | Tokens.Escape): string {
    if ("tokens" in token && token.tokens)
      return this.parser.parseInline(token.tokens);
    return escapeXml(token.text);
  },
  link({ href, title, tokens }: Tokens.Link): string {
    const label = this.parser.parseInline(tokens);
    const safe = safeHref(href);
    if (safe === null) return label;
    const titleAttr = title ? ` title="${escapeXml(title)}"` : "";
    return `<a href="${escapeXml(safe)}"${titleAttr}>${label}</a>`;
  },
  image({ href, text }: Tokens.Image): string {
    const safe = safeHref(href);
    if (safe === null || !/^https?:/i.test(safe)) return escapeXml(text);
    return `<ac:image ac:alt="${escapeXml(text)}"><ri:url ri:value="${escapeXml(safe)}" /></ac:image>`;
  },
  def(): string {
    return "";
  },
};

const marked = new Marked({ gfm: true, breaks: false, async: false, renderer });

export function markdownToConfluenceStorage(md: string): string {
  return (marked.parse(md, { async: false }) as string).trim();
}
