import { LockBanner, WorkspaceProvider } from '@/components/workspace/WorkspaceProvider';
import { Conversation } from '@/components/workspace/left/Conversation';
import { NotesInput } from '@/components/workspace/left/NotesInput';
import { QuestionsList } from '@/components/workspace/left/QuestionsList';
import { SessionHeader } from '@/components/workspace/left/SessionHeader';

// Rendered per request (the (app) layout is force-dynamic for the CSP nonce).
export const dynamic = 'force-dynamic';

// Three-panel session workspace (§6). The left panel is here; the center (specification editor, task 34) and
// right (readiness/issues, task 35) panels mount into the marked slots inside the same WorkspaceProvider.
export default async function SessionWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <WorkspaceProvider sessionId={id}>
      {/* Full-bleed: break out of the app shell's max-w-5xl main so the grid can reach its 1280 px minimum. */}
      <div className="relative left-1/2 -my-6 w-screen -translate-x-1/2 overflow-x-auto">
        <LockBanner />
        <div className="grid h-[calc(100vh-7rem)] min-w-[1280px] grid-cols-[minmax(340px,1fr)_minmax(560px,2fr)_minmax(340px,1fr)] divide-x divide-slate-200">
          <aside aria-label="Session and conversation" className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
            <SessionHeader />
            <QuestionsList />
            <Conversation />
            <NotesInput />
          </aside>
          <section aria-label="Specification" data-slot="workspace-center" className="min-h-0 overflow-y-auto p-4" />
          <section aria-label="Readiness" data-slot="workspace-right" className="min-h-0 overflow-y-auto p-4" />
        </div>
      </div>
    </WorkspaceProvider>
  );
}
