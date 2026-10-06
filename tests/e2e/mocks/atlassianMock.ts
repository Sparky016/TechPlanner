import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
  ATLASSIAN_MOCK_PORT,
  CLIENT_ID,
  CLIENT_SECRET,
  CLOUD_ID,
  CONFLUENCE_PARENT_PAGE_ID,
  CONFLUENCE_SPACE_ID,
  CONFLUENCE_SPACE_KEY,
  LINKED_PAGE_ID,
  MOCK_USER,
  SITE_URL,
} from '../support/env';

// Local stand-in for auth.atlassian.com and api.atlassian.com (E2E only). Serves exactly the endpoints the app
// calls: the OAuth 3LO authorize redirect and token exchange (PKCE verified), accessible-resources, me, the Jira
// issue/comment/remotelink/attachment/description/label endpoints and the Confluence space/page endpoints.
// State is in memory and per-issue, so idempotency is observable. Control API under /__mock: reset, faults, state.
// Seed data reuses the task 16 Jira fixture (src/server/atlassian/__fixtures__/issue.json).

const ROOT = process.cwd();
const FIXTURE_ISSUE = JSON.parse(readFileSync(join(ROOT, 'src/server/atlassian/__fixtures__/issue.json'), 'utf8')) as {
  key: string;
  fields: Record<string, unknown>;
};
const SAMPLE_TXT = readFileSync(join(ROOT, 'src/server/ingest/__fixtures__/sample.txt'));
const SAMPLE_PNG = readFileSync(join(ROOT, 'src/server/ingest/__fixtures__/sample.png'));

interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  content: Buffer;
}

interface Comment {
  id: string;
  body: unknown;
  created: string;
  author: { displayName: string };
}

interface Issue {
  key: string;
  fields: Record<string, unknown>;
  description: unknown;
  comments: Comment[];
  attachments: Attachment[];
  labels: string[];
}

interface Page {
  id: string;
  title: string;
  spaceId: string;
  parentId: string | null;
  version: number;
  body: string;
}

interface Fault {
  method?: string;
  path: RegExp;
  status: number;
  remaining: number;
  message: string;
  /** 'after': the request takes effect, then the error is returned (a lost response). Default 'before'. */
  when: 'before' | 'after';
}

interface Call {
  method: string;
  path: string;
  query: string;
  /** Account the bearer token was issued to, or null when no valid token was sent. */
  account: string | null;
}

interface State {
  issues: Map<string, Issue>;
  pages: Map<string, Page>;
  codes: Map<string, { challenge: string; redirectUri: string }>;
  tokens: Map<string, string>;
  calls: Call[];
  faults: Fault[];
  nextId: number;
}

const adfDoc = (...paragraphs: string[]) => ({
  type: 'doc',
  version: 1,
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

const linkedPageUrl = `${SITE_URL}/wiki/spaces/${CONFLUENCE_SPACE_KEY}/pages/${LINKED_PAGE_ID}/Export+design+notes`;

function seed(): State {
  const fixtureDescription = FIXTURE_ISSUE.fields.description as { content: unknown[] };
  const primary: Issue = {
    key: 'ABC-123',
    fields: { ...FIXTURE_ISSUE.fields },
    description: {
      ...fixtureDescription,
      content: [
        ...fixtureDescription.content,
        { type: 'paragraph', content: [{ type: 'text', text: `Design notes: ${linkedPageUrl}` }] },
      ],
    },
    comments: [
      { id: '20001', body: adfDoc('Exports must handle at least 10000 rows.'), created: '2026-09-01T10:00:00.000+0000', author: { displayName: 'Bob PM' } },
      { id: '20002', body: adfDoc('CSV must be UTF-8 with a header row.'), created: '2026-09-02T10:00:00.000+0000', author: { displayName: 'Alice Dev' } },
    ],
    attachments: [
      { id: '10001', filename: 'notes.txt', mimeType: 'text/plain', content: SAMPLE_TXT },
      { id: '10002', filename: 'mock.png', mimeType: 'image/png', content: SAMPLE_PNG },
      { id: '10003', filename: 'archive.zip', mimeType: 'application/zip', content: Buffer.from('PK\u0003\u0004') },
    ],
    labels: ['export', 'reporting'],
  };
  const secondary: Issue = {
    key: 'ABC-124',
    fields: { summary: 'Export report as XLSX', issuetype: { name: 'Story' }, status: { name: 'To Do' } },
    description: adfDoc('Original ABC-124 description that must never change.'),
    comments: [],
    attachments: [],
    labels: [],
  };
  const linked: Page = {
    id: LINKED_PAGE_ID,
    title: 'Export design notes',
    spaceId: CONFLUENCE_SPACE_ID,
    parentId: null,
    version: 3,
    body: '<h2>Design</h2><p>Stream rows to the client to keep memory flat.</p>',
  };
  return {
    issues: new Map([primary, secondary].map((i) => [i.key, i])),
    pages: new Map([[linked.id, linked]]),
    codes: new Map(),
    tokens: new Map(),
    calls: [],
    faults: [],
    nextId: 30000,
  };
}

let state = seed();

function nextId(): string {
  state.nextId += 1;
  return String(state.nextId);
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (body === undefined) {
    res.writeHead(status, headers).end();
    return;
  }
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res
    .writeHead(status, { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', ...headers })
    .end(payload);
}

function errorBody(message: string) {
  return { errorMessages: [message], message };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function json(raw: Buffer): Record<string, unknown> {
  try {
    return JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// Minimal multipart/form-data reader: the app sends exactly one file part named "file".
function parseMultipartFile(raw: Buffer, contentType: string): { filename: string; mimeType: string; content: Buffer } | null {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundary) return null;
  const delimiter = `--${boundary[1] ?? boundary[2]}`;
  const text = raw.toString('latin1');
  for (const part of text.split(delimiter)) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    if (!filename) continue;
    const mimeType = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? 'application/octet-stream';
    const content = Buffer.from(part.slice(headerEnd + 4).replace(/\r\n$/, ''), 'latin1');
    return { filename, mimeType, content };
  }
  return null;
}

function bearerAccount(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return state.tokens.get(token) ?? null;
}

function issueToken(): Record<string, unknown> {
  const accessToken = `e2e-access-${randomBytes(12).toString('hex')}`;
  state.tokens.set(accessToken, MOCK_USER.accountId);
  return {
    access_token: accessToken,
    refresh_token: `e2e-refresh-${randomBytes(12).toString('hex')}`,
    expires_in: 3600,
    scope: 'read:me read:jira-work write:jira-work offline_access',
    token_type: 'Bearer',
  };
}

// ---- auth.atlassian.com ------------------------------------------------------------------------------------------

function authorize(url: URL, res: ServerResponse): void {
  const redirectUri = url.searchParams.get('redirect_uri') ?? '';
  const stateParam = url.searchParams.get('state') ?? '';
  if (url.searchParams.get('client_id') !== CLIENT_ID || url.searchParams.get('code_challenge_method') !== 'S256') {
    send(res, 400, errorBody('invalid authorize request'));
    return;
  }
  const code = `e2e-code-${randomBytes(8).toString('hex')}`;
  state.codes.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', redirectUri });
  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  target.searchParams.set('state', stateParam);
  send(res, 302, undefined, { Location: target.toString() });
}

function token(body: Record<string, unknown>, res: ServerResponse): void {
  if (body.client_id !== CLIENT_ID || body.client_secret !== CLIENT_SECRET) {
    send(res, 401, { error: 'invalid_client' });
    return;
  }
  if (body.grant_type === 'refresh_token') {
    send(res, 200, issueToken());
    return;
  }
  const code = typeof body.code === 'string' ? state.codes.get(body.code) : undefined;
  const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  if (!code || code.challenge !== challenge || code.redirectUri !== body.redirect_uri) {
    send(res, 400, { error: 'invalid_grant' });
    return;
  }
  state.codes.delete(body.code as string);
  send(res, 200, issueToken());
}

// ---- Jira -------------------------------------------------------------------------------------------------------

function issueJson(issue: Issue) {
  return {
    key: issue.key,
    fields: {
      ...issue.fields,
      description: issue.description,
      labels: issue.labels,
      attachment: issue.attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.content.length,
        content: `${SITE_URL}/rest/api/3/attachment/content/${a.id}`,
      })),
      comment: { comments: [], total: issue.comments.length },
    },
  };
}

function jira(req: IncomingMessage, res: ServerResponse, path: string, url: URL, raw: Buffer): void {
  const method = req.method ?? 'GET';
  let m = /^\/rest\/api\/3\/attachment\/content\/([^/]+)$/.exec(path);
  if (m && method === 'GET') {
    const id = decodeURIComponent(m[1]);
    const attachment = [...state.issues.values()].flatMap((i) => i.attachments).find((a) => a.id === id);
    if (!attachment) return send(res, 404, errorBody('Attachment not found'));
    return send(res, 200, attachment.content, { 'Content-Type': attachment.mimeType });
  }

  m = /^\/rest\/api\/3\/issue\/([^/]+)(\/[a-z]+)?$/.exec(path);
  if (!m) return send(res, 404, errorBody('Unknown Jira endpoint'));
  const issue = state.issues.get(decodeURIComponent(m[1]));
  if (!issue) return send(res, 404, errorBody('Issue does not exist or you do not have permission to see it.'));
  const sub = m[2] ?? '';

  if (sub === '' && method === 'GET') return send(res, 200, issueJson(issue));
  if (sub === '' && method === 'PUT') {
    const body = json(raw) as { fields?: { description?: unknown }; update?: { labels?: { add?: string }[] } };
    if (body.fields && 'description' in body.fields) issue.description = body.fields.description;
    for (const op of body.update?.labels ?? []) {
      if (op.add && !issue.labels.includes(op.add)) issue.labels.push(op.add);
    }
    return send(res, 204);
  }
  if (sub === '/comment' && method === 'GET') {
    const startAt = Number(url.searchParams.get('startAt') ?? 0);
    const maxResults = Number(url.searchParams.get('maxResults') ?? 50);
    return send(res, 200, {
      startAt,
      maxResults,
      total: issue.comments.length,
      comments: issue.comments.slice(startAt, startAt + maxResults),
    });
  }
  if (sub === '/comment' && method === 'POST') {
    const comment: Comment = {
      id: nextId(),
      body: json(raw).body,
      created: new Date().toISOString(),
      author: { displayName: MOCK_USER.name },
    };
    issue.comments.push(comment);
    return send(res, 201, { id: comment.id });
  }
  if (sub === '/remotelink' && method === 'GET') return send(res, 200, []);
  if (sub === '/attachments' && method === 'POST') {
    if (req.headers['x-atlassian-token'] !== 'no-check') return send(res, 403, errorBody('XSRF check failed'));
    const file = parseMultipartFile(raw, req.headers['content-type'] ?? '');
    if (!file) return send(res, 400, errorBody('No file in request'));
    const attachment: Attachment = { id: nextId(), ...file };
    issue.attachments.push(attachment);
    return send(res, 200, [{ id: attachment.id, filename: attachment.filename }]);
  }
  return send(res, 404, errorBody('Unknown Jira endpoint'));
}

// ---- Confluence -------------------------------------------------------------------------------------------------

function pageJson(page: Page, withBody: boolean) {
  return {
    id: page.id,
    title: page.title,
    spaceId: page.spaceId,
    parentId: page.parentId,
    status: 'current',
    version: { number: page.version },
    _links: { webui: `/spaces/${CONFLUENCE_SPACE_KEY}/pages/${page.id}` },
    ...(withBody ? { body: { storage: { value: page.body, representation: 'storage' } } } : {}),
  };
}

function confluence(req: IncomingMessage, res: ServerResponse, path: string, url: URL, raw: Buffer): void {
  const method = req.method ?? 'GET';
  if (path === '/wiki/api/v2/spaces' && method === 'GET') {
    const keys = (url.searchParams.get('keys') ?? '').split(',');
    return send(res, 200, {
      results: keys.includes(CONFLUENCE_SPACE_KEY) ? [{ id: CONFLUENCE_SPACE_ID, key: CONFLUENCE_SPACE_KEY }] : [],
    });
  }
  if (path === '/wiki/api/v2/pages' && method === 'POST') {
    const body = json(raw) as { spaceId?: string; parentId?: string; title?: string; body?: { value?: string } };
    if (body.spaceId !== CONFLUENCE_SPACE_ID || body.parentId !== CONFLUENCE_PARENT_PAGE_ID) {
      return send(res, 400, errorBody('Unknown space or parent page'));
    }
    if ([...state.pages.values()].some((p) => p.title === body.title)) {
      return send(res, 400, errorBody('A page with this title already exists'));
    }
    const page: Page = {
      id: nextId(),
      title: body.title ?? '',
      spaceId: body.spaceId,
      parentId: body.parentId,
      version: 1,
      body: body.body?.value ?? '',
    };
    state.pages.set(page.id, page);
    return send(res, 200, pageJson(page, false));
  }
  const m = /^\/wiki\/api\/v2\/pages\/([^/]+)$/.exec(path);
  const page = m ? state.pages.get(decodeURIComponent(m[1])) : undefined;
  if (m && !page) return send(res, 404, errorBody('Page not found'));
  if (page && method === 'GET') return send(res, 200, pageJson(page, url.searchParams.get('body-format') === 'storage'));
  if (page && method === 'PUT') {
    const body = json(raw) as { title?: string; version?: { number?: number }; body?: { value?: string } };
    if (body.version?.number !== page.version + 1) return send(res, 409, errorBody('Version must be incremented'));
    page.version += 1;
    page.title = body.title ?? page.title;
    page.body = body.body?.value ?? page.body;
    return send(res, 200, pageJson(page, false));
  }
  return send(res, 404, errorBody('Unknown Confluence endpoint'));
}

// ---- control API --------------------------------------------------------------------------------------------------

function snapshot() {
  return {
    calls: state.calls,
    issues: Object.fromEntries(
      [...state.issues.values()].map((i) => [
        i.key,
        {
          description: i.description,
          labels: i.labels,
          comments: i.comments,
          attachments: i.attachments.map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mimeType, text: a.content.toString('utf8') })),
        },
      ]),
    ),
    pages: Object.fromEntries([...state.pages.values()].map((p) => [p.id, p])),
  };
}

function control(req: IncomingMessage, res: ServerResponse, path: string, raw: Buffer): void {
  if (path === '/__mock/health') return send(res, 200, { ok: true });
  if (path === '/__mock/state') return send(res, 200, snapshot());
  if (path === '/__mock/reset' && req.method === 'POST') {
    state = seed();
    return send(res, 200, { ok: true });
  }
  if (path === '/__mock/faults' && req.method === 'POST') {
    const body = json(raw) as {
      method?: string;
      path?: string;
      status?: number;
      times?: number;
      message?: string;
      when?: 'before' | 'after';
    };
    state.faults.push({
      when: body.when === 'after' ? 'after' : 'before',
      method: body.method,
      path: new RegExp(body.path ?? '.*'),
      status: body.status ?? 500,
      remaining: body.times ?? Number.POSITIVE_INFINITY,
      message: body.message ?? 'Injected failure',
    });
    return send(res, 200, { ok: true });
  }
  if (path === '/__mock/faults' && req.method === 'DELETE') {
    state.faults = [];
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'unknown control endpoint' });
}

function takeFault(method: string, path: string): Fault | null {
  const fault = state.faults.find((f) => f.remaining > 0 && (!f.method || f.method === method) && f.path.test(path));
  if (!fault) return null;
  fault.remaining -= 1;
  return fault;
}

// Discards a response: used to apply a request whose real response an 'after' fault replaces.
function sink(): ServerResponse {
  const fake = { headersSent: false, writeHead: () => fake, end: () => fake };
  return fake as unknown as ServerResponse;
}

function route(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer, account: string | null): void {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (path === '/authorize' && method === 'GET') return authorize(url, res);
  if (path === '/oauth/token' && method === 'POST') return token(json(raw), res);

  // Everything below is api.atlassian.com and requires a token this mock issued (SR-1.2: the user's own token).
  if (!account) return send(res, 401, errorBody('Unauthorized'));
  if (path === '/oauth/token/accessible-resources' && method === 'GET') {
    return send(res, 200, [{ id: CLOUD_ID, url: SITE_URL, name: 'E2E site', scopes: [] }]);
  }
  if (path === '/me' && method === 'GET') {
    return send(res, 200, { account_id: MOCK_USER.accountId, name: MOCK_USER.name, email: MOCK_USER.email });
  }
  const jiraPrefix = `/ex/jira/${CLOUD_ID}`;
  const confluencePrefix = `/ex/confluence/${CLOUD_ID}`;
  if (path.startsWith(`${jiraPrefix}/`)) return jira(req, res, path.slice(jiraPrefix.length), url, raw);
  if (path.startsWith(`${confluencePrefix}/`)) return confluence(req, res, path.slice(confluencePrefix.length), url, raw);
  return send(res, 404, errorBody('Unknown endpoint'));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${ATLASSIAN_MOCK_PORT}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const raw = await readBody(req);
  if (path.startsWith('/__mock/')) return control(req, res, path, raw);

  const account = bearerAccount(req);
  state.calls.push({ method, path, query: url.search, account });

  const fault = takeFault(method, path);
  if (!fault) return route(req, res, url, raw, account);
  if (fault.when === 'after') route(req, sink(), url, raw, account);
  return send(res, fault.status, errorBody(fault.message));
}

createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error('[atlassian-mock] handler error', err);
    if (!res.headersSent) send(res, 500, errorBody('mock error'));
  });
}).listen(ATLASSIAN_MOCK_PORT, () => {
  console.log(`[atlassian-mock] listening on ${ATLASSIAN_MOCK_PORT}`);
});
