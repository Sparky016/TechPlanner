// Per-tab identity (D-3): a UUID kept in sessionStorage, sent as x-tab-id. Browser-only.

const KEY = 'tp_tab_id';
let fallback: string | null = null;

export function getTabId(): string {
  try {
    const existing = window.sessionStorage.getItem(KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.sessionStorage.setItem(KEY, created);
    return created;
  } catch {
    // sessionStorage unavailable: keep one id for the life of the page.
    fallback ??= crypto.randomUUID();
    return fallback;
  }
}
