import './env';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as ackPOST } from '@/app/api/me/ack-data-notice/route';
import { GET as meGET } from '@/app/api/me/route';
import { SESSION_COOKIE, createSession } from '@/server/auth/session';
import { getConfig } from '@/server/config';
import { db, query, withTransaction } from '@/server/db/pool';
import { CSRF_COOKIE, CSRF_HEADER, issueCsrfToken } from '@/server/http/csrf';
import { resetDatabase } from './setup';

const CSRF = issueCsrfToken().token;
let cookie: string;

function request(method: string, path: string): NextRequest {
  return new NextRequest(`${getConfig().APP_BASE_URL}${path}`, {
    method,
    headers: {
      origin: getConfig().APP_BASE_URL,
      cookie: `${SESSION_COOKIE}=${cookie}; ${CSRF_COOKIE}=${CSRF}`,
      [CSRF_HEADER]: CSRF,
    },
  });
}

beforeAll(async () => {
  await resetDatabase();
  await query('INSERT INTO app_user (atlassian_account_id, display_name) VALUES ($1, $2)', ['acc-me', 'Me User']);
  cookie = await withTransaction((client) => createSession(client, 'acc-me'));
});

afterAll(async () => {
  await db.end();
});

describe('/api/me', () => {
  it('reports the data notice as unacknowledged, then persists the acknowledgement', async () => {
    const before = (await (await meGET(request('GET', '/api/me'), { params: Promise.resolve({}) })).json()) as Record<
      string,
      unknown
    >;
    expect(before).toMatchObject({ accountId: 'acc-me', displayName: 'Me User', dataNoticeAcknowledged: false });

    const ack = await ackPOST(request('POST', '/api/me/ack-data-notice'), { params: Promise.resolve({}) });
    expect(ack.status).toBe(200);
    const rows = await query<{ data_notice_ack_at: Date | null }>(
      'SELECT data_notice_ack_at FROM app_user WHERE atlassian_account_id = $1',
      ['acc-me'],
    );
    expect(rows[0].data_notice_ack_at).not.toBeNull();

    const after = (await (await meGET(request('GET', '/api/me'), { params: Promise.resolve({}) })).json()) as Record<
      string,
      unknown
    >;
    expect(after.dataNoticeAcknowledged).toBe(true);
  });
});
