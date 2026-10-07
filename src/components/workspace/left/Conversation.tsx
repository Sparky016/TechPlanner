'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { useWorkspace, useWorkspaceEvents } from '@/components/workspace/WorkspaceProvider';
import { ApiError, apiFetch } from '@/lib/api/client';
import { streamMessage } from '@/lib/api/sse';

// Facilitator ↔ AI conversation with the streamed AI turn rendered token by token (SR-3.5). Notes and system
// messages are shown inline but visually distinct. All text is rendered as plain text (never as HTML).

interface Message {
  seq: number;
  role: 'facilitator' | 'ai' | 'note' | 'system';
  content: string;
  createdAt: string;
}

interface TurnError {
  code?: string;
  message: string;
  correlationId?: string;
}

const ROLE_LABEL: Record<Message['role'], string> = {
  facilitator: 'You',
  ai: 'AI',
  note: 'Note · context only',
  system: 'System',
};

const ROLE_CLASS: Record<Message['role'], string> = {
  facilitator: 'ml-6 bg-blue-50 border-blue-200',
  ai: 'mr-6 bg-white border-slate-200',
  note: 'border-dashed border-slate-400 bg-slate-50 italic',
  system: 'border-slate-200 bg-slate-100 text-xs text-slate-700',
};

function MessageBubble({ role, content }: { role: Message['role']; content: string }) {
  return (
    <li data-role={role} className={`rounded border px-2 py-1 text-sm ${ROLE_CLASS[role] ?? ''}`}>
      <p className="text-xs font-medium not-italic text-slate-500">{ROLE_LABEL[role] ?? role}</p>
      <p className="whitespace-pre-wrap break-words">{content}</p>
    </li>
  );
}

export function Conversation() {
  const { sessionId, readOnly, publish } = useWorkspace();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [pending, setPending] = useState<{ prompt: string; reply: string } | null>(null);
  const [turnError, setTurnError] = useState<TurnError | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ messages: Message[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
      setMessages(data.messages);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err : new ApiError('Could not load the conversation', 0, undefined, undefined, null));
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useWorkspaceEvents((e) => {
    if (e.type === 'conversation_changed') void load();
  });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const prompt = text;
    if (prompt.trim() === '' || streaming) return;
    setStreaming(true);
    setTurnError(null);
    setPending({ prompt, reply: '' });
    setText('');
    let failed = false;
    let started = false;
    try {
      for await (const ev of streamMessage(sessionId, prompt)) {
        started = true;
        if (ev.type === 'token') {
          setPending((p) => (p ? { ...p, reply: p.reply + ev.text } : p));
        } else if (ev.type === 'error') {
          failed = true;
          setTurnError({ code: ev.code, message: ev.message, correlationId: ev.correlationId });
          publish(ev);
        } else {
          publish(ev);
        }
      }
    } catch (err) {
      failed = true;
      const apiErr = err instanceof ApiError ? err : null;
      setTurnError({
        code: apiErr?.code,
        message: apiErr?.message ?? 'The AI turn failed',
        correlationId: apiErr?.correlationId,
      });
    } finally {
      // The server persists the facilitator message (and any AI reply) itself; reload rather than trust local text.
      await load();
      setPending(null);
      setStreaming(false);
      // A request rejected before streaming (e.g. 409 turn_in_progress) persisted nothing: give the text back.
      if (failed && !started) setText((t) => (t === '' ? prompt : t));
    }
  }

  const aiUnavailable = turnError?.code === 'ai_unavailable';

  return (
    <section aria-label="Conversation" className="flex min-h-0 flex-1 flex-col gap-2">
      <h2 className="text-sm font-medium">Conversation</h2>
      {loadError ? <ErrorBanner message={loadError.message} correlationId={loadError.correlationId} /> : null}
      <ol aria-label="Messages" aria-live="polite" className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {messages.map((m) => (
          <MessageBubble key={m.seq} role={m.role} content={m.content} />
        ))}
        {pending ? (
          <>
            <MessageBubble role="facilitator" content={pending.prompt} />
            <li data-role="ai" data-testid="streaming-reply" className={`rounded border px-2 py-1 text-sm ${ROLE_CLASS.ai}`}>
              <p className="text-xs font-medium text-slate-500">AI</p>
              <p className="whitespace-pre-wrap break-words">{pending.reply || '…'}</p>
            </li>
          </>
        ) : null}
      </ol>
      {turnError ? (
        <ErrorBanner
          message={aiUnavailable ? `AI unavailable: ${turnError.message} You can keep editing the specification.` : turnError.message}
          correlationId={turnError.correlationId}
        />
      ) : null}
      <form onSubmit={(e) => void onSubmit(e)} className="space-y-1">
        <label htmlFor="message-input" className="block text-sm font-medium">
          Message
        </label>
        <textarea
          id="message-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={readOnly}
          rows={3}
          className="w-full rounded border border-slate-300 px-2 py-1 text-sm disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={readOnly || streaming || text.trim() === ''}
          className="rounded bg-blue-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-60"
        >
          {streaming ? 'AI is responding…' : 'Send'}
        </button>
      </form>
    </section>
  );
}
