// Server-only: never import from src/lib or client components.
// LLM-6: delimiters for untrusted data shown to the model (source material, repository content).

export const UNTRUSTED_TAG = 'untrusted_source_data';

/** Prevents untrusted text from closing its own block. */
export function neutralise(text: string): string {
  return text.replace(new RegExp(`<(/?)${UNTRUSTED_TAG}`, 'gi'), '<$1untrusted-source-data');
}

export function attr(value: string | null): string {
  return (value ?? '').replace(/["<>\n\r]/g, ' ');
}
