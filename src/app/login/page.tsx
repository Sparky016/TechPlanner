import { headers } from 'next/headers';

// Dynamic so the per-request CSP nonce applies (task 13).
export const dynamic = 'force-dynamic';

// Keys set by /auth/callback (denied, state, oauth, site) plus the generic 'auth'.
const MESSAGES: Record<string, string> = {
  site: 'Your Atlassian account does not have access to the configured Jira/Confluence site. Ask an administrator to grant access, then try again.',
  auth: 'Sign-in failed. Please try again.',
  denied: 'Sign-in was cancelled or denied. Please try again.',
  state: 'Sign-in could not be verified. Please try again.',
  oauth: 'Sign-in with Atlassian failed. Please try again.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await headers();
  const { error } = await searchParams;
  const message = error ? (MESSAGES[error] ?? MESSAGES.auth) : null;

  return (
    <main className="mx-auto mt-24 max-w-sm space-y-6 rounded border border-slate-200 bg-white p-8 shadow-sm">
      <h1 className="text-2xl font-semibold">Tech Planner</h1>
      {message ? (
        <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          {message}
        </p>
      ) : null}
      <a
        href="/auth/login"
        className="block rounded bg-blue-700 px-4 py-2 text-center text-sm font-medium text-white hover:bg-blue-800"
      >
        Sign in with Atlassian
      </a>
    </main>
  );
}
