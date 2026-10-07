import mammoth from 'mammoth';
import { extractText as extractPdfText } from 'unpdf';

// Server-only: never import from src/lib or client components.
// Text extraction for the attachment types SR-2.4 ingests. Scanned PDFs are not OCR'd (out of scope).

export type FileKind = 'text' | 'pdf' | 'docx' | 'image' | 'unsupported';

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'yaml', 'yml', 'csv']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

// The filename extension decides; Jira's mime type is only a fallback for extension-less names.
export function detectFileKind(mimeType: string, filename: string): FileKind {
  const ext = extensionOf(filename);
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext !== '') return 'unsupported';
  const mime = mimeType.toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (mime === DOCX_MIME) return 'docx';
  if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif' || mime === 'image/webp') return 'image';
  if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  return 'unsupported';
}

// Extracts plain text. Throws for unsupported kinds and for corrupt files.
export async function extractText(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
  const kind = detectFileKind(mimeType, filename);
  switch (kind) {
    case 'text':
      return buffer.toString('utf8');
    case 'pdf': {
      const { text } = await extractPdfText(new Uint8Array(buffer), { mergePages: true });
      return text;
    }
    case 'docx': {
      const { value } = await mammoth.extractRawText({ buffer });
      return value;
    }
    default:
      throw new Error(`Cannot extract text from ${kind} file`);
  }
}
