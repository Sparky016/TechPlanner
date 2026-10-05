// Server-only: never import from src/lib or client components.
// Converts Atlassian Document Format into readable plain text / light markdown for session creation and the AI context.

export interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function children(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? node.content : [];
}

function inline(nodes: AdfNode[]): string {
  return nodes.map(inlineNode).join('');
}

function inlineNode(node: AdfNode): string {
  switch (node.type) {
    case 'text': {
      const text = str(node.text);
      const link = node.marks?.find((m) => m.type === 'link');
      const href = str(link?.attrs?.href);
      if (href !== '' && href !== text) return `[${text}](${href})`;
      if (node.marks?.some((m) => m.type === 'code')) return `\`${text}\``;
      return text;
    }
    case 'hardBreak':
      return '\n';
    case 'mention':
      return str(node.attrs?.text) || `@${str(node.attrs?.id)}`;
    case 'emoji':
      return str(node.attrs?.text) || str(node.attrs?.shortName);
    case 'inlineCard':
      return str(node.attrs?.url);
    case 'status':
      return `[${str(node.attrs?.text)}]`;
    case 'date': {
      const ts = Number(node.attrs?.timestamp);
      return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '';
    }
    default:
      return inline(children(node));
  }
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? line : prefix + line))
    .join('\n');
}

function listItem(item: AdfNode, marker: string): string {
  const parts = children(item)
    .map(block)
    .filter((p) => p !== '');
  if (parts.length === 0) return marker.trimEnd();
  const [first, ...rest] = parts;
  const pad = ' '.repeat(marker.length);
  const lines = [marker + first.replace(/\n/g, `\n${pad}`)];
  for (const part of rest) lines.push(indent(part, pad));
  return lines.join('\n');
}

function list(node: AdfNode, ordered: boolean): string {
  const start = Number(node.attrs?.order);
  let n = Number.isFinite(start) && start > 0 ? start : 1;
  return children(node)
    .map((item) => listItem(item, ordered ? `${n++}. ` : '- '))
    .join('\n');
}

function table(node: AdfNode): string {
  const rows = children(node).map((row) => {
    const cells = children(row).map((cell) =>
      children(cell)
        .map(block)
        .filter((p) => p !== '')
        .join(' ')
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\|/g, '\\|'),
    );
    return {
      cells,
      header: children(row).some((c) => c.type === 'tableHeader'),
    };
  });
  const lines: string[] = [];
  rows.forEach((row, i) => {
    lines.push(`| ${row.cells.join(' | ')} |`);
    if (i === 0 && row.header) lines.push(`| ${row.cells.map(() => '---').join(' | ')} |`);
  });
  return lines.join('\n');
}

function blocks(nodes: AdfNode[]): string {
  return nodes
    .map(block)
    .filter((p) => p !== '')
    .join('\n\n');
}

function block(node: AdfNode): string {
  switch (node.type) {
    case 'paragraph':
      return inline(children(node));
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
      return `${'#'.repeat(level)} ${inline(children(node))}`;
    }
    case 'bulletList':
      return list(node, false);
    case 'orderedList':
      return list(node, true);
    case 'codeBlock':
      return `\`\`\`${str(node.attrs?.language)}\n${inline(children(node))}\n\`\`\``;
    case 'blockquote':
      return indent(blocks(children(node)), '> ');
    case 'rule':
      return '---';
    case 'table':
      return table(node);
    case 'media':
      return str(node.attrs?.alt) || '[attachment]';
    case 'text':
    case 'hardBreak':
    case 'mention':
    case 'emoji':
    case 'inlineCard':
    case 'status':
    case 'date':
      return inlineNode(node);
    default:
      // panel, expand, mediaSingle, mediaGroup and unknown containers: render their children.
      return blocks(children(node));
  }
}

// Accepts the `doc` node (or null/undefined for an empty field) and returns trimmed text.
export function adfToText(adf: unknown): string {
  if (adf === null || adf === undefined) return '';
  if (typeof adf === 'string') return adf.trim();
  if (typeof adf !== 'object') return '';
  const node = adf as AdfNode;
  return (node.type === 'doc' ? blocks(children(node)) : block(node)).trim();
}
