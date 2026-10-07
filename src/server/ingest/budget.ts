// Server-only: never import from src/lib or client components.
// Context token budget (SR-2.5). No tokenizer is available, so tokens are estimated as chars / 4.

export const IMAGE_TOKENS = 1_500;

export type BudgetItemKind = 'ticket_core' | 'comment' | 'confluence_page' | 'attachment';

export interface BudgetItem {
  kind: BudgetItemKind;
  /** Stable identifier shown in the truncation list (comment id, page id, attachment filename, ...). */
  ref: string;
  text: string;
  /** Comments only: ISO creation date, used to drop the oldest first. */
  created?: string;
  /** Image attachments count a flat IMAGE_TOKENS regardless of text. */
  isImage?: boolean;
}

export interface TruncatedItem {
  kind: BudgetItemKind;
  ref: string;
  reason: 'context_budget';
}

export interface BudgetResult {
  kept: BudgetItem[];
  truncated: TruncatedItem[];
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function itemTokens(item: BudgetItem): number {
  return item.isImage ? IMAGE_TOKENS : estimateTokens(item.text);
}

function time(item: BudgetItem): number {
  const t = Date.parse(item.created ?? '');
  return Number.isNaN(t) ? 0 : t;
}

// Drops, in order: oldest comments, largest attachments, largest Confluence pages, until within `budget`.
// ticket_core is never dropped, so the result can still exceed the budget if the ticket alone does.
export function applyContextBudget(items: BudgetItem[], budget: number): BudgetResult {
  let total = items.reduce((sum, item) => sum + itemTokens(item), 0);
  const dropOrder = [
    items.filter((i) => i.kind === 'comment').sort((a, b) => time(a) - time(b)),
    items.filter((i) => i.kind === 'attachment').sort((a, b) => itemTokens(b) - itemTokens(a)),
    items.filter((i) => i.kind === 'confluence_page').sort((a, b) => itemTokens(b) - itemTokens(a)),
  ].flat();

  const dropped = new Set<BudgetItem>();
  for (const item of dropOrder) {
    if (total <= budget) break;
    dropped.add(item);
    total -= itemTokens(item);
  }

  return {
    kept: items.filter((i) => !dropped.has(i)),
    truncated: dropOrder
      .filter((i) => dropped.has(i))
      .map((i) => ({ kind: i.kind, ref: i.ref, reason: 'context_budget' as const })),
  };
}
