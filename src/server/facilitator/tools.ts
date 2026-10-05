import { query } from '@/server/db/pool';
import type { LlmToolDefinition } from '@/server/llm';
import { applyAiPatch } from '@/server/spec/workingCopyRepo';
import { SECTION_NAMES, type SectionName } from '../../lib/spec/sections';

// Server-only: never import from src/lib or client components.
// Facilitator tools (LLM-5). Arguments are schema-validated by executeToolCall before a handler runs; the only
// effects are section patches via applyAiPatch (D-5) and AI questions (LLM-6).

export const PATCH_CONTENT_MAX = 20_000;
export const QUESTION_TEXT_MAX = 500;
/** SR-3.4 / D-7. */
export const MAX_QUESTIONS_PER_TURN = 3;
export const QUESTION_LIMIT_MESSAGE = 'Question limit reached for this turn';

// JSON Schema has no built-in uuid check without ajv-formats; same pattern as sessions/repo.ts.
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export type FacilitatorEvent =
  | { type: 'token'; text: string }
  | { type: 'patch'; section: SectionName; version: number }
  | { type: 'suggestion'; suggestionId: string; section: SectionName }
  | { type: 'question'; questionId: string; text: string; section: SectionName | null }
  | { type: 'done'; messageSeq: number }
  | { type: 'error'; code: string; message: string };

export interface PatchOutcome {
  section: SectionName;
  op: 'replace' | 'append';
  disposition: 'applied' | 'suggested';
}

/** Per-turn state shared by every run of the turn (including the corrective follow-up). */
export interface FacilitatorTurnState {
  sessionId: string;
  /** Turn start: the AI read time passed to applyAiPatch. */
  aiReadAt: Date;
  clarificationEnded: boolean;
  patches: PatchOutcome[];
  questionIds: string[];
  /** Events produced by tool handlers, drained by the turn runner after every LLM event. */
  pending: FacilitatorEvent[];
}

export function createTurnState(sessionId: string, aiReadAt: Date, clarificationEnded: boolean): FacilitatorTurnState {
  return { sessionId, aiReadAt, clarificationEnded, patches: [], questionIds: [], pending: [] };
}

interface ApplySectionPatchArgs {
  section: SectionName;
  op: 'replace' | 'append';
  content: string;
}

interface AskQuestionArgs {
  text: string;
  section?: SectionName;
  issueId?: string;
}

interface MarkQuestionAnsweredArgs {
  questionId: string;
}

function applySectionPatchTool(state: FacilitatorTurnState): LlmToolDefinition {
  return {
    name: 'apply_section_patch',
    description:
      'Update one section of the Working Copy: replace its whole body, or append content to it. Use the exact section name.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['section', 'op', 'content'],
      properties: {
        section: { type: 'string', enum: [...SECTION_NAMES] },
        op: { type: 'string', enum: ['replace', 'append'] },
        content: { type: 'string', maxLength: PATCH_CONTENT_MAX },
      },
    },
    handler: async (args) => {
      const { section, op, content } = args as ApplySectionPatchArgs;
      const result = await applyAiPatch(state.sessionId, { section, op, content }, state.aiReadAt);
      state.patches.push({ section, op, disposition: result.disposition });
      if (result.disposition === 'applied') {
        state.pending.push({ type: 'patch', section, version: result.version });
        return `Applied ${op} to ${section} (working copy version ${result.version})`;
      }
      state.pending.push({ type: 'suggestion', suggestionId: result.suggestionId, section });
      return `The facilitator edited ${section} after you read it; your patch was stored as a pending suggestion for their review`;
    },
  };
}

function askQuestionTool(state: FacilitatorTurnState): LlmToolDefinition {
  return {
    name: 'ask_question',
    description: `Ask the facilitator one targeted question, optionally linked to a section and/or an open issue id. At most ${MAX_QUESTIONS_PER_TURN} per turn.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', minLength: 1, maxLength: QUESTION_TEXT_MAX },
        section: { type: 'string', enum: [...SECTION_NAMES] },
        issueId: { type: 'string', pattern: UUID_PATTERN },
      },
    },
    handler: async (args) => {
      const { text, section, issueId } = args as AskQuestionArgs;
      if (state.questionIds.length >= MAX_QUESTIONS_PER_TURN) return QUESTION_LIMIT_MESSAGE;
      let target: SectionName | null = section ?? null;
      if (issueId !== undefined) {
        const [issue] = await query<{ section: SectionName }>(
          'SELECT section FROM issue WHERE id = $1 AND session_id = $2',
          [issueId, state.sessionId],
        );
        if (!issue) return `Unknown issue id: ${issueId}`;
        target ??= issue.section;
      }
      const [row] = await query<{ id: string }>(
        "INSERT INTO ai_question (session_id, issue_id, section, text, status) VALUES ($1, $2, $3, $4, 'open') RETURNING id",
        [state.sessionId, issueId ?? null, target, text],
      );
      state.questionIds.push(row.id);
      state.pending.push({ type: 'question', questionId: row.id, text, section: target });
      return `Question recorded (id ${row.id})`;
    },
  };
}

function markQuestionAnsweredTool(state: FacilitatorTurnState): LlmToolDefinition {
  return {
    name: 'mark_question_answered',
    description: 'Mark one of the open AI questions as answered once the conversation has resolved it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['questionId'],
      properties: { questionId: { type: 'string', pattern: UUID_PATTERN } },
    },
    handler: async (args) => {
      const { questionId } = args as MarkQuestionAnsweredArgs;
      const rows = await query(
        "UPDATE ai_question SET status = 'answered' WHERE id = $1 AND session_id = $2 AND status = 'open' RETURNING id",
        [questionId, state.sessionId],
      );
      return rows.length > 0 ? `Question ${questionId} marked answered` : `No open question with id ${questionId}`;
    },
  };
}

/** SR-8.2b: once clarification has ended, ask_question is not offered at all. */
export function createFacilitatorTools(state: FacilitatorTurnState): LlmToolDefinition[] {
  return [
    applySectionPatchTool(state),
    ...(state.clarificationEnded ? [] : [askQuestionTool(state)]),
    markQuestionAnsweredTool(state),
  ];
}
