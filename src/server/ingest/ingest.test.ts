import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getValidAccessToken } from '@/server/auth/tokens';
import { logger } from '@/server/observability/logger';
import { classifyAttachment, ingestAttachments, type AttachmentMeta } from './attachments';
import { applyContextBudget, estimateTokens, type BudgetItem } from './budget';
import { extractText } from './extract';

// Atlassian is mocked by stubbing global fetch (undici is not a project dependency).

vi.mock('@/server/config', () => ({
  getConfig: () => ({ ATLASSIAN_CLOUD_ID: 'cloud-123' }),
}));

vi.mock('@/server/auth/tokens', () => {
  class ReauthRequiredError extends Error {
    readonly code = 'reauth_required';
  }
  return { ReauthRequiredError, getValidAccessToken: vi.fn() };
});

const fixture = (name: string): Buffer => readFileSync(join(__dirname, '__fixtures__', name));
const MB = 1024 * 1024;
const fetchMock = vi.fn<typeof fetch>();

function meta(id: string, filename: string, size = 100, mimeType = 'application/octet-stream'): AttachmentMeta {
  return { id, filename, mimeType, size, contentUrl: `https://example.invalid/${id}` };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(getValidAccessToken).mockResolvedValue('token');
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('classifyAttachment (AC1, AC3)', () => {
  it('extracts text for text, pdf and docx within 10 MB', () => {
    for (const name of ['a.txt', 'a.md', 'a.json', 'a.yaml', 'a.yml', 'a.csv', 'a.pdf', 'a.docx']) {
      expect(classifyAttachment(meta('1', name, 10 * MB), true)).toEqual({ action: 'extract_text' });
    }
  });

  it('lists an 11 MB pdf as too_large', () => {
    expect(classifyAttachment(meta('1', 'a.pdf', 11 * MB), true)).toEqual({ action: 'list', reason: 'too_large' });
  });

  it('lists an .exe as unsupported_type', () => {
    expect(classifyAttachment(meta('1', 'a.exe'), true)).toEqual({ action: 'list', reason: 'unsupported_type' });
  });

  it('ingests images up to 5 MB only when images are supported', () => {
    expect(classifyAttachment(meta('1', 'a.PNG', 5 * MB), true)).toEqual({ action: 'ingest_image' });
    expect(classifyAttachment(meta('1', 'a.webp', 5 * MB + 1), true)).toEqual({ action: 'list', reason: 'too_large' });
    expect(classifyAttachment(meta('1', 'a.png'), false)).toEqual({ action: 'list', reason: 'images_not_supported' });
  });
});

describe('ingestAttachments', () => {
  it('downloads as the user and lists the 21st eligible attachment as limit_reached (AC1)', async () => {
    fetchMock.mockImplementation(async () => new Response('hello'));
    const attachments = [meta('x', 'skip.exe'), ...Array.from({ length: 21 }, (_, i) => meta(`${i}`, `f${i}.txt`))];

    const result = await ingestAttachments('user-1', attachments, true);

    expect(result.ingested).toHaveLength(20);
    expect(result.listed).toEqual([
      expect.objectContaining({ id: 'x', reason: 'unsupported_type' }),
      expect.objectContaining({ id: '20', reason: 'limit_reached' }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(20);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/attachment/content/0');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token');
  });

  it('extracts text from pdf and docx downloads (AC2)', async () => {
    fetchMock.mockImplementation(async (url) =>
      String(url).endsWith('/p')
        ? new Response(new Uint8Array(fixture('sample.pdf')))
        : new Response(new Uint8Array(fixture('sample.docx'))),
    );
    const result = await ingestAttachments('user-1', [meta('p', 'a.pdf'), meta('d', 'a.docx')], false);
    expect(result.listed).toEqual([]);
    expect(result.ingested.map((i) => (i.kind === 'text' ? i.text : ''))).toEqual([
      expect.stringContaining('Hello PDF fixture text'),
      expect.stringContaining('Hello DOCX fixture text'),
    ]);
  });

  it('lists images as images_not_supported without downloading them (AC3)', async () => {
    const result = await ingestAttachments('user-1', [meta('i', 'a.png')], false);
    expect(result.listed).toEqual([expect.objectContaining({ id: 'i', reason: 'images_not_supported' })]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ingests images as base64 when supported', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array(fixture('sample.png'))));
    const result = await ingestAttachments('user-1', [meta('i', 'a.png', 69, 'image/png')], true);
    expect(result.ingested).toEqual([
      expect.objectContaining({ kind: 'image', base64: fixture('sample.png').toString('base64') }),
    ]);
  });

  it('lists a failed download as unavailable with a reason', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
    const result = await ingestAttachments('user-1', [meta('1', 'a.txt')], true);
    expect(result.ingested).toEqual([]);
    expect(result.listed).toEqual([expect.objectContaining({ reason: 'unavailable', detail: expect.any(String) })]);
  });

  it('aborts a download whose body exceeds the limit despite small metadata', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array(5 * MB + 1)));
    const result = await ingestAttachments('user-1', [meta('1', 'a.png', 10, 'image/png')], true);
    expect(result.listed).toEqual([expect.objectContaining({ reason: 'unavailable' })]);
  });
});

describe('extractText (AC2)', () => {
  it('reads plain text', async () => {
    expect(await extractText(fixture('sample.txt'), 'text/plain', 'sample.txt')).toContain('Sample text attachment.');
  });

  it('extracts the pdf fixture', async () => {
    expect(await extractText(fixture('sample.pdf'), 'application/pdf', 'sample.pdf')).toContain(
      'Hello PDF fixture text',
    );
  });

  it('extracts the docx fixture', async () => {
    expect(await extractText(fixture('sample.docx'), '', 'sample.docx')).toContain('Hello DOCX fixture text');
  });

  it('rejects unsupported kinds', async () => {
    await expect(extractText(fixture('sample.png'), 'image/png', 'sample.png')).rejects.toThrow();
  });
});

describe('applyContextBudget (AC4)', () => {
  const core: BudgetItem = { kind: 'ticket_core', ref: 'T-1', text: 'x'.repeat(400) }; // 100 tokens
  const comment = (ref: string, created: string, chars = 400): BudgetItem => ({
    kind: 'comment',
    ref,
    created,
    text: 'c'.repeat(chars),
  });
  const attachment = (ref: string, chars: number): BudgetItem => ({ kind: 'attachment', ref, text: 'a'.repeat(chars) });
  const page = (ref: string, chars: number): BudgetItem => ({ kind: 'confluence_page', ref, text: 'p'.repeat(chars) });

  it('estimates ceil(chars / 4) tokens', () => {
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });

  it('keeps everything when within budget', () => {
    const items = [core, comment('c1', '2024-01-01T00:00:00Z')];
    expect(applyContextBudget(items, 200)).toEqual({ kept: items, truncated: [] });
  });

  it('drops the oldest comments before attachments and never ticket_core', () => {
    const items = [
      core,
      comment('new', '2024-03-01T00:00:00Z'),
      comment('old', '2024-01-01T00:00:00Z'),
      attachment('big', 4000),
    ];
    const result = applyContextBudget(items, 1_200); // total 1300 -> drop 'old' (100)
    expect(result.truncated).toEqual([{ kind: 'comment', ref: 'old', reason: 'context_budget' }]);
    expect(result.kept.map((i) => i.ref)).toEqual(['T-1', 'new', 'big']);
  });

  it('then drops the largest attachments, then the largest Confluence pages', () => {
    const items = [
      core,
      comment('c', '2024-01-01T00:00:00Z'),
      attachment('small', 400),
      attachment('big', 2000),
      page('p1', 800),
      page('p2', 1600),
    ];
    const result = applyContextBudget(items, 200);
    expect(result.truncated.map((t) => t.ref)).toEqual(['c', 'big', 'small', 'p2', 'p1']);
    expect(result.kept).toEqual([core]);
  });

  it('keeps ticket_core even when it alone exceeds the budget', () => {
    const result = applyContextBudget([core, comment('c', '2024-01-01T00:00:00Z')], 10);
    expect(result.kept).toEqual([core]);
    expect(result.truncated).toEqual([{ kind: 'comment', ref: 'c', reason: 'context_budget' }]);
  });

  it('counts an image as 1500 tokens', () => {
    const image: BudgetItem = { kind: 'attachment', ref: 'img', text: '', isImage: true };
    expect(applyContextBudget([core, image], 1_000).truncated).toEqual([
      { kind: 'attachment', ref: 'img', reason: 'context_budget' },
    ]);
    expect(applyContextBudget([core, image], 1_600).truncated).toEqual([]);
  });
});
