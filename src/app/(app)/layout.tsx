import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { DataNotice } from '@/components/DataNotice';
import { requireUser } from '@/server/auth/session';
import { query } from '@/server/db/pool';
import { HttpError } from '@/server/http/errors';

// Reading headers() makes every page in this group dynamic, so the per-request CSP nonce applies (task 13).
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const incoming = await headers();
  const request = new Request('http://localhost/', { headers: { cookie: incoming.get('cookie') ?? '' } });

  let user;
  try {
    user = await requireUser(request);
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) redirect('/login');
    throw err;
  }

  const rows = await query<{ data_notice_ack_at: Date | null }>(
    'SELECT data_notice_ack_at FROM app_user WHERE atlassian_account_id = $1',
    [user.accountId],
  );

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <a href="/sessions" className="font-semibold">
          Tech Planner
        </a>
        <div className="flex items-center gap-4 text-sm">
          <span>{user.displayName}</span>
          <form action="/auth/logout" method="post">
            <button type="submit" className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100">
              Log out
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-6">{children}</main>
      <DataNotice acknowledged={rows[0]?.data_notice_ack_at != null} />
    </div>
  );
}
