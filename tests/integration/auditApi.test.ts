import { resetDatabase } from './setup';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as auditGET } from '@/app/api/sessions/[id]/audit/route';
import { GET as exportGET } from '@/app/api/sessions/[id]/audit/export/route';
import { recordAudit } from '@/server/audit/audit';
import { SESSION_COOKIE, createSession } from '@/server/auth/session';
import { getConfig } from '@/server/config';
import { encryptSecret } from '@/server/crypto/secrets';
import { db, query, withTransaction } from '@/server/db/pool';
import { clearAccessCacheForTests } from '@/server/sessions/access';

// Atlassian is mocked by stubbing global fetch (undici is not a direct dependency of this project).
const ISSUE_PREFIX = `https://api.atlassian.com/ex/jira/${getConfig().ATLASSIAN_CLOUD_ID}/rest/api/3/issue/`;
const ALICE = { accountId: 'acc-alice', displayName: 'Alice' };
const BOB = { accountId: 'acc-bob', displayName: 'Bob' };

// Per-user issue key -> HTTP status Jira returns; unlisted keys return 200.
let jiraStatus: Record<string, Record<string, number>>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(ISSUE_PREFIX)) {
    const auth = new Headers(init?.headers).get('Authorization');
    const user = auth?.replace('Bearer token-', '') ?? '';
    const key = decodeURIComponent(url.slice(ISSUE_PREFIX.length).split('?')[0]);
    const status = jiraStatus[user]?.[key] ?? 200;
    if (status === 200) return json({ key, fields: { summary: 'Summary' } });
    return json({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }, status);
  }
  return json({ error: 'unexpected request' }, 599);
}

async function seedUser(user: { accountId: string; displayName: string }): Promise<void> {
  await query('INSERT INTO app_user (atlassian_account_id, display_name) VALUES ($1, $2)', [
    user.accountId,
    user.displayName,
  ]);
  await query(
    `INSERT INTO oauth_token (user_id, enc_access_token, enc_refresh_token, expires_at, scopes)
     VALUES ($1, $2, NULL, now() + interval '1 hour', ARRAY['read:jira-work'])`,
    [user.accountId, encryptSecret(`token-${user.accountId}`)],
  );
}

async function createPlanningSession(primaryKey: string): Promise<string> {
  const rows = await query<{ id: string }>(
    'INSERT INTO planning_session (primary_ticket_key, ticket_keys) VALUES ($1, ARRAY[$1, $2]) RETURNING id',
    [primaryKey, `${primaryKey}-LINKED`],
  );
  return rows[0].id;
}

async function sessionCookieFor(userId: string): Promise<string> {
  return withTransaction((client) => createSession(client, userId));
}

function get(path: string, cookie: string): NextRequest {
  const headers: Record<string, string> = {
    cookie: `${SESSION_COOKIE}=${cookie}`,
  };
  return new NextRequest(`${getConfig().APP_BASE_URL}${path}`, { method: 'GET', headers });
}

function routeArg(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeAll(async () => {
  await resetDatabase();
  await seedUser(ALICE);
  await seedUser(BOB);
});

beforeEach(() => {
  jiraStatus = {};
  clearAccessCacheForTests();
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.end();
});

describe('GET /api/sessions/:id/audit', () => {
  it('AC1: returns records newest first with keyset pagination', async () => {
    const sessionId = await createPlanningSession('AUDIT-1');
    const cookie = await sessionCookieFor(ALICE.accountId);

    // Seed 3 audit records with different actions
    const record1 = await recordAudit({
      action: 'auth.login',
      result: 'success',
      userId: ALICE.accountId,
      userDisplayName: ALICE.displayName,
      sessionId,
      ticketIds: ['AUDIT-1'],
      details: { source: 'web' },
      correlationId: 'corr-1',
    });

    await new Promise((r) => setTimeout(r, 10)); // Ensure different timestamp

    const record2 = await recordAudit({
      action: 'draft.created',
      result: 'success',
      userId: ALICE.accountId,
      userDisplayName: ALICE.displayName,
      sessionId,
      ticketIds: ['AUDIT-1'],
      correlationId: 'corr-2',
    });

    await new Promise((r) => setTimeout(r, 10));

    const record3 = await recordAudit({
      action: 'draft.updated',
      result: 'success',
      userId: ALICE.accountId,
      userDisplayName: ALICE.displayName,
      sessionId,
      ticketIds: ['AUDIT-1'],
      correlationId: 'corr-3',
    });

    // First page: limit=2 should return newest 2 (record3, record2)
    const req1 = get(`/api/sessions/${sessionId}/audit?limit=2`, cookie);
    const res1 = await auditGET(req1, routeArg(sessionId));
    const body1 = (await res1.json()) as { records: Array<{ id: string; action: string }>; nextCursor: string | null };

    expect(body1.records).toHaveLength(2);
    expect(body1.records[0].id).toBe(record3.id);
    expect(body1.records[1].id).toBe(record2.id);
    expect(body1.nextCursor).toBe(record2.id);

    // Second page: using cursor
    const req2 = get(`/api/sessions/${sessionId}/audit?limit=2&cursor=${body1.nextCursor}`, cookie);
    const res2 = await auditGET(req2, routeArg(sessionId));
    const body2 = (await res2.json()) as { records: Array<{ id: string; action: string }>; nextCursor: string | null };

    expect(body2.records).toHaveLength(1);
    expect(body2.records[0].id).toBe(record1.id);
    expect(body2.nextCursor).toBeNull();
  });

  it('AC1: filters by action', async () => {
    const sessionId = await createPlanningSession('AUDIT-2');
    const cookie = await sessionCookieFor(ALICE.accountId);

    await recordAudit({
      action: 'auth.login',
      result: 'success',
      userId: ALICE.accountId,
      userDisplayName: ALICE.displayName,
      sessionId,
      ticketIds: ['AUDIT-2'],
    });

    await recordAudit({
      action: 'draft.created',
      result: 'success',
      userId: ALICE.accountId,
      userDisplayName: ALICE.displayName,
      sessionId,
      ticketIds: ['AUDIT-2'],
    });

    await recordAudit({
      action: 'auth.login',
      result: 'success',
      userId: ALICE.accountId,
      userDisplayName: ALICE.displayName,
      sessionId,
      ticketIds: ['AUDIT-2'],
    });

    // Query with action filter
    const req = get(`/api/sessions/${sessionId}/audit?action=auth.login`, cookie);
    const res = await auditGET(req, routeArg(sessionId));
    const body = (await res.json()) as { records: Array<{ action: string }>; nextCursor: string | null };

    expect(body.records).toHaveLength(2);
    expect(body.records.every((r) => r.action === 'auth.login')).toBe(true);
  });

  it('clamps limit to 200', async () => {
    const sessionId = await createPlanningSession('AUDIT-3');
    const cookie = await sessionCookieFor(ALICE.accountId);

    // Query with limit=999 should clamp to 200
    const req = get(`/api/sessions/${sessionId}/audit?limit=999`, cookie);
    const res = await auditGET(req, routeArg(sessionId));
    expect(res.status).toBe(200);
  });

  it('returns 404 for user without Jira access (AC3)', async () => {
    const sessionId = await createPlanningSession('AUDIT-4');
    const cookie = await sessionCookieFor(BOB.accountId);

    // Bob cannot access AUDIT-4
    jiraStatus[BOB.accountId] = { 'AUDIT-4': 404 };

    const req = get(`/api/sessions/${sessionId}/audit`, cookie);
    const res = await auditGET(req, routeArg(sessionId));

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('includes record details: id (string), ts (ISO), user, sessionId, ticketIds, action, result, correlationId, hash', async () => {
    const sessionId = await createPlanningSession('AUDIT-5');
    const cookie = await sessionCookieFor(ALICE.accountId);

    const record = await recordAudit({
      action: 'draft.updated',
      result: 'success',
      userId: ALICE.accountId,
      userDisplayName: ALICE.displayName,
      sessionId,
      ticketIds: ['AUDIT-5', 'AUDIT-5-LINKED'],
      details: { sections: ['overview'] },
      correlationId: 'corr-5',
    });

    const req = get(`/api/sessions/${sessionId}/audit`, cookie);
    const res = await auditGET(req, routeArg(sessionId));
    const body = (await res.json()) as {
      records: Array<{
        id: string;
        ts: string;
        user: { accountId: string | null; displayName: string | null };
        sessionId: string | null;
        ticketIds: string[];
        action: string;
        result: string;
        details: Record<string, unknown>;
        correlationId: string | null;
        hash: string;
      }>;
    };

    expect(body.records).toHaveLength(1);
    const r = body.records[0];
    expect(typeof r.id).toBe('string');
    expect(r.id).toBe(record.id);
    expect(typeof r.ts).toBe('string');
    expect(() => new Date(r.ts)).not.toThrow();
    expect(r.user.accountId).toBe(ALICE.accountId);
    expect(r.user.displayName).toBe(ALICE.displayName);
    expect(r.sessionId).toBe(sessionId);
    expect(r.ticketIds).toEqual(['AUDIT-5', 'AUDIT-5-LINKED']);
    expect(r.action).toBe('draft.updated');
    expect(r.result).toBe('success');
    expect(r.details.sections).toEqual(['overview']);
    expect(r.correlationId).toBe('corr-5');
    expect(typeof r.hash).toBe('string');
    expect(/^[0-9a-f]+$/.test(r.hash)).toBe(true);
  });

  it('isolates records by session_id', async () => {
    const session1 = await createPlanningSession('AUDIT-6');
    const session2 = await createPlanningSession('AUDIT-7');
    const cookie = await sessionCookieFor(ALICE.accountId);

    await recordAudit({
      action: 'auth.login',
      result: 'success',
      userId: ALICE.accountId,
      userDisplayName: ALICE.displayName,
      sessionId: session1,
      ticketIds: ['AUDIT-6'],
    });

    await recordAudit({
      action: 'draft.created',
      result: 'success',
      userId: ALICE.accountId,
      userDisplayName: ALICE.displayName,
      sessionId: session2,
      ticketIds: ['AUDIT-7'],
    });

    // Query session1 should only return its record
    const req = get(`/api/sessions/${session1}/audit`, cookie);
    const res = await auditGET(req, routeArg(session1));
    const body = (await res.json()) as { records: Array<{ sessionId: string; action: string }> };

    expect(body.records).toHaveLength(1);
    expect(body.records[0].sessionId).toBe(session1);
    expect(body.records[0].action).toBe('auth.login');
  });
});

describe('GET /api/sessions/:id/audit/export', () => {
  it('AC2: returns JSON Lines format (one JSON object per line) with correct headers', async () => {
    const sessionId = await createPlanningSession('EXPORT-1');
    const cookie = await sessionCookieFor(ALICE.accountId);

    const r1 = await recordAudit({
      action: 'auth.login',
      result: 'success',
      userId: ALICE.accountId,
      userDisplayName: ALICE.displayName,
      sessionId,
      ticketIds: ['EXPORT-1'],
      correlationId: 'corr-e1',
    });

    const r2 = await recordAudit({
      action: 'draft.created',
      result: 'success',
      userId: ALICE.accountId,
      userDisplayName: ALICE.displayName,
      sessionId,
      ticketIds: ['EXPORT-1'],
      correlationId: 'corr-e2',
    });

    const req = get(`/api/sessions/${sessionId}/audit/export`, cookie);
    const res = await exportGET(req, routeArg(sessionId));

    // Check headers
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson');
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename=audit-${sessionId}.jsonl`);
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    // Parse JSON Lines
    const text = await res.text();
    const lines = text.trim().split('\n').filter(Boolean);

    expect(lines).toHaveLength(2);
    const records = lines.map((l) => JSON.parse(l));

    // Should be oldest first (ascending id order)
    expect(records[0].id).toBe(r1.id);
    expect(records[1].id).toBe(r2.id);

    // Verify record structure
    expect(records[0]).toHaveProperty('ts');
    expect(records[0]).toHaveProperty('user');
    expect(records[0]).toHaveProperty('action');
    expect(records[0]).toHaveProperty('hash');
  });

  it('returns 404 for user without Jira access (AC3)', async () => {
    const sessionId = await createPlanningSession('EXPORT-2');
    const cookie = await sessionCookieFor(BOB.accountId);

    jiraStatus[BOB.accountId] = { 'EXPORT-2': 404 };

    const req = get(`/api/sessions/${sessionId}/audit/export`, cookie);
    const res = await exportGET(req, routeArg(sessionId));

    expect(res.status).toBe(404);
  });

  it('handles empty audit trail', async () => {
    const sessionId = await createPlanningSession('EXPORT-3');
    const cookie = await sessionCookieFor(ALICE.accountId);

    const req = get(`/api/sessions/${sessionId}/audit/export`, cookie);
    const res = await exportGET(req, routeArg(sessionId));

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('');
  });

  it('streams large result sets in batches without loading all into memory', async () => {
    const sessionId = await createPlanningSession('EXPORT-4');
    const cookie = await sessionCookieFor(ALICE.accountId);

    // Create 600 audit records (more than the 500 batch size)
    for (let i = 0; i < 600; i++) {
      await recordAudit({
        action: 'draft.updated',
        result: 'success',
        userId: ALICE.accountId,
        userDisplayName: ALICE.displayName,
        sessionId,
        ticketIds: ['EXPORT-4'],
      });
    }

    const req = get(`/api/sessions/${sessionId}/audit/export`, cookie);
    const res = await exportGET(req, routeArg(sessionId));

    const text = await res.text();
    const lines = text.trim().split('\n').filter(Boolean);

    expect(lines).toHaveLength(600);

    // Verify ordering is oldest first
    const records = lines.map((l) => JSON.parse(l));
    const ids = records.map((r) => BigInt(r.id));
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }
  });

  it('isolates records by session_id', async () => {
    const session1 = await createPlanningSession('EXPORT-5');
    const session2 = await createPlanningSession('EXPORT-6');
    const cookie = await sessionCookieFor(ALICE.accountId);

    await recordAudit({
      action: 'auth.login',
      result: 'success',
      userId: ALICE.accountId,
      userDisplayName: ALICE.displayName,
      sessionId: session1,
      ticketIds: ['EXPORT-5'],
    });

    await recordAudit({
      action: 'draft.created',
      result: 'success',
      userId: ALICE.accountId,
      userDisplayName: ALICE.displayName,
      sessionId: session2,
      ticketIds: ['EXPORT-6'],
    });

    const req = get(`/api/sessions/${session1}/audit/export`, cookie);
    const res = await exportGET(req, routeArg(session1));

    const text = await res.text();
    const lines = text.trim().split('\n').filter(Boolean);

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.sessionId).toBe(session1);
    expect(record.action).toBe('auth.login');
  });
});
