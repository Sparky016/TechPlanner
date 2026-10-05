import { atlassianFetch } from '@/server/atlassian/client';
import type { JiraIssueSnapshot } from '@/server/atlassian/jira';
import { logger } from '@/server/observability/logger';
import { detectFileKind, extractText } from './extract';

// Server-only: never import from src/lib or client components.
// Decides which Jira attachments are ingested vs. listed (SR-2.4), downloads and extracts them.

export type AttachmentMeta = JiraIssueSnapshot['attachments'][number];

export type ListedReason = 'unsupported_type' | 'too_large' | 'images_not_supported' | 'limit_reached' | 'unavailable';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_INGESTED_ATTACHMENTS = 20;

export type Classification = { action: 'extract_text' | 'ingest_image' } | { action: 'list'; reason: ListedReason };

export interface IngestedText {
  kind: 'text';
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  text: string;
}

export interface IngestedImage {
  kind: 'image';
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  base64: string;
}

export interface ListedAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  reason: ListedReason;
  /** Why a download or extraction failed ('unavailable' only). */
  detail?: string;
}

export interface IngestResult {
  ingested: (IngestedText | IngestedImage)[];
  listed: ListedAttachment[];
}

// Pure, per-attachment rules. The 20-attachment cap is applied by ingestAttachments.
export function classifyAttachment(meta: AttachmentMeta, supportsImages: boolean): Classification {
  const kind = detectFileKind(meta.mimeType, meta.filename);
  if (kind === 'unsupported') return { action: 'list', reason: 'unsupported_type' };
  if (kind === 'image') {
    if (!supportsImages) return { action: 'list', reason: 'images_not_supported' };
    if (meta.size > MAX_IMAGE_BYTES) return { action: 'list', reason: 'too_large' };
    return { action: 'ingest_image' };
  }
  if (meta.size > MAX_DOCUMENT_BYTES) return { action: 'list', reason: 'too_large' };
  return { action: 'extract_text' };
}

class DownloadError extends Error {}

// Reads the body but gives up as soon as it exceeds `limit`, whatever the metadata claimed.
async function readLimited(res: Response, limit: number): Promise<Buffer> {
  const declared = Number(res.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel();
    throw new DownloadError('file exceeds the size limit');
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel();
      throw new DownloadError('file exceeds the size limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function download(userId: string, meta: AttachmentMeta, limit: number): Promise<Buffer> {
  // Built from the attachment id rather than contentUrl so a crafted URL can never receive the user's token.
  const path = `/rest/api/3/attachment/content/${encodeURIComponent(meta.id)}`;
  const res = await atlassianFetch(userId, 'jira', path, { headers: { Accept: '*/*' } });
  return readLimited(res, limit);
}

function describeError(err: unknown): string {
  return err instanceof Error && err.message !== '' ? err.message : 'unknown error';
}

// Walks `attachments` in Jira order. The first 20 eligible ones are downloaded as `userId`; the rest are listed.
export async function ingestAttachments(
  userId: string,
  attachments: AttachmentMeta[],
  supportsImages: boolean,
): Promise<IngestResult> {
  const result: IngestResult = { ingested: [], listed: [] };
  let eligible = 0;

  for (const meta of attachments) {
    const base = { id: meta.id, filename: meta.filename, mimeType: meta.mimeType, size: meta.size };
    const cls = classifyAttachment(meta, supportsImages);
    if (cls.action === 'list') {
      result.listed.push({ ...base, reason: cls.reason });
      continue;
    }
    if (eligible >= MAX_INGESTED_ATTACHMENTS) {
      result.listed.push({ ...base, reason: 'limit_reached' });
      continue;
    }
    eligible++;

    try {
      const isImage = cls.action === 'ingest_image';
      const buffer = await download(userId, meta, isImage ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES);
      if (isImage) {
        result.ingested.push({ kind: 'image', ...base, base64: buffer.toString('base64') });
        continue;
      }
      const text = await extractText(buffer, meta.mimeType, meta.filename);
      if (text.trim() === '') throw new Error('no extractable text');
      result.ingested.push({ kind: 'text', ...base, text });
    } catch (err) {
      logger.warn({ attachmentId: meta.id, err: describeError(err) }, 'Attachment could not be ingested');
      result.listed.push({ ...base, reason: 'unavailable', detail: describeError(err) });
    }
  }
  return result;
}
