'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import {
  type ActiveTurn,
  type TurnError,
  useActiveTurn,
  useWorkspace,
  useWorkspaceEvents,
} from '@/components/workspace/WorkspaceProvider';
import { ApiError, apiFetch } from '@/lib/api/client';

// Facilitator ↔ AI conversation with the streamed AI turn rendered token by token (SR-3.5). Notes and system
// messages are shown inline but visually distinct. All text is rendered as plain text (never as HTML).

interface Message {
  seq: number;
  role: 'facilitator' | 'ai' | 'note' | 'system';
  content: string;
  createdAt: string;
  /** Set when the message answers an AI question (GI-20). */
  questionId?: string | null;
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

const QUESTION_LABEL_MAX = 120;

function truncate(text: string): string {
  return text.length > QUESTION_LABEL_MAX ? `${text.slice(0, QUESTION_LABEL_MAX - 1).trimEnd()}…` : text;
}

function MessageBubble({ role, content, answerTo }: { role: Message['role']; content: string; answerTo?: string }) {
  return (
    <li data-role={role} className={`rounded border px-2 py-1 text-sm ${ROLE_CLASS[role] ?? ''}`}>
      {answerTo !== undefined ? (
        <p className="text-xs font-medium not-italic text-slate-600">Answer to: {answerTo}</p>
      ) : null}
      <p className="text-xs font-medium not-italic text-slate-500">{ROLE_LABEL[role] ?? role}</p>
      <p className="whitespace-pre-wrap break-words">{content}</p>
    </li>
  );
}

const OPEN_KEY_PREFIX = 'techplanner.discuss-open.';

function readStoredOpen(sessionId: string): boolean | null {
  try {
    const v = window.localStorage.getItem(OPEN_KEY_PREFIX + sessionId);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

function storeOpen(sessionId: string, open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY_PREFIX + sessionId, open ? '1' : '0');
  } catch {
    // Storage unavailable: the choice just is not remembered.
  }
}

export function Conversation() {
  const { sessionId, readOnly, runTurn, turnInProgress, detail } = useWorkspace();
  const notIngested = detail?.session?.intakeState === 'not_ingested';
  const [questions, setQuestions] = useState<{ id: string; text: string }[] | null>(null);
  // null = no explicit choice yet: collapsed once any question exists, expanded otherwise.
  const [choice, setChoice] = useState<boolean | null>(null);
  useEffect(() => {
    setChoice(readStoredOpen(sessionId));
  }, [sessionId]);
  const activeTurn = useActiveTurn();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [text, setText] = useState('');
  const [turnError, setTurnError] = useState<TurnError | null>(null);
  // The last streamed turn stays on screen until the reload that follows it has the persisted messages.
  const [settling, setSettling] = useState<ActiveTurn | null>(null);
  const pending = activeTurn ?? settling;

  useEffect(() => {
    // Only a started turn is followed by a reload (conversation_changed); a rejected one just disappears.
    if (activeTurn?.started) setSettling(activeTurn);
  }, [activeTurn]);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ messages: Message[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
      setMessages(data.messages);
      setSettling(null);
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof ApiError ? err : new ApiError('Could not load the conversation', 0, undefined, undefined, null),
      );
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadQuestions = useCallback(async () => {
    try {
      const data = await apiFetch<{
        questions?: { id: string; text: string }[];
      }>(`/api/sessions/${encodeURIComponent(sessionId)}/questions`);
      setQuestions(Array.isArray(data?.questions) ? data.questions : []);
    } catch {
      // The 'Answer to:' labels fall back to a generic text; QuestionsList shows the load error.
    }
  }, [sessionId]);

  useEffect(() => {
    void loadQuestions();
  }, [loadQuestions]);

  useWorkspaceEvents((e) => {
    if (e.type === 'conversation_changed' || e.type === 'done') void load();
    if (e.type === 'question' || e.type === 'done') void loadQuestions();
  });

  // A turn started from any panel expands the discussion so its stream is visible.
  useEffect(() => {
    if (activeTurn) setChoice(true);
  }, [activeTurn === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = !notIngested && (choice ?? (questions === null || questions.length === 0));
  const questionText = new Map((questions ?? []).map((q) => [q.id, q.text]));

  function toggle() {
    const next = !open;
    setChoice(next);
    storeOpen(sessionId, next);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const prompt = text;
    if (prompt.trim() === '' || turnInProgress) return;
    setTurnError(null);
    setText('');
    // The server persists the facilitator message (and any AI reply); runTurn publishes conversation_changed after
    // a started turn, which reloads the list rather than trusting local text.
    const result = await runTurn({
      path: '/messages',
      body: { text: prompt },
      label: 'Discussion',
      prompt,
    });
    if (result.error) setTurnError(result.error);
    // A request rejected before streaming (e.g. 409 turn_in_progress) persisted nothing: give the text back.
    if (!result.started && !result.ok) setText((t) => (t === '' ? prompt : t));
  }

  const aiUnavailable = turnError?.code === 'ai_unavailable';

  return (
    <section aria-label="Discuss with AI" className="shrink-0 space-y-2">
      <h2 className="text-sm font-medium">
        <button
          type="button"
          onClick={toggle}
          disabled={notIngested}
          aria-expanded={open}
          aria-controls="discuss-panel"
          className="flex w-full items-center justify-between rounded border border-slate-300 px-3 py-1.5 text-left text-sm font-medium hover:bg-slate-100 disabled:opacity-60"
        >
          Discuss with AI
          <span aria-hidden="true">{open ? '−' : '+'}</span>
        </button>
      </h2>
      {notIngested ? <p className="text-sm text-slate-600">Ingest the ticket to start the discussion.</p> : null}
      <div id="discuss-panel" hidden={!open} className="space-y-2">
        {loadError ? <ErrorBanner message={loadError.message} correlationId={loadError.correlationId} /> : null}
        <ol aria-label="Messages" aria-live="polite" className="max-h-80 space-y-2 overflow-y-auto">
          {messages.map((m) => (
            <MessageBubble
              key={m.seq}
              role={m.role}
              content={m.content}
              answerTo={m.questionId ? truncate(questionText.get(m.questionId) ?? 'a question') : undefined}
            />
          ))}
          {pending ? (
            <>
              {pending.prompt !== undefined ? <MessageBubble role="facilitator" content={pending.prompt} /> : null}
              <li
                data-role="ai"
                data-testid="streaming-reply"
                className={`rounded border px-2 py-1 text-sm ${ROLE_CLASS.ai}`}
              >
                <p className="text-xs font-medium text-slate-500">AI</p>
                <p className="whitespace-pre-wrap break-words">{pending.reply || '…'}</p>
              </li>
            </>
          ) : null}
        </ol>
        {turnError ? (
          <ErrorBanner
            message={
              aiUnavailable
                ? `AI unavailable: ${turnError.message} You can keep editing the specification.`
                : turnError.message
            }
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
            disabled={readOnly || turnInProgress || text.trim() === ''}
            className="rounded bg-blue-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {turnInProgress ? 'AI is responding…' : 'Send'}
          </button>
        </form>
      </div>
    </section>
  );
}
