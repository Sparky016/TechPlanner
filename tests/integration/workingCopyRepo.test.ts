import { resetDatabase } from './setup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, query } from '@/server/db/pool';
import { emptySections } from '@/lib/spec/document';
import {
  acceptSuggestion,
  applyAiPatch,
  getWorkingCopy,
  initWorkingCopy,
  InvalidSectionsError,
  markAiRead,
  rejectSuggestion,
  replaceAllSections,
  SuggestionNotPendingError,
  updateSectionByUser,
  VersionConflictError,
} from '@/server/spec/workingCopyRepo';

async function createSession(): Promise<string> {
  const [row] = await query<{ id: string }>(
    "INSERT INTO planning_session (primary_ticket_key, ticket_keys) VALUES ('ABC-1', ARRAY['ABC-1']) RETURNING id",
  );
  return row.id;
}

async function suggestionStatus(id: string): Promise<string> {
  const [row] = await query<{ status: string }>('SELECT status FROM pending_suggestion WHERE id = $1', [id]);
  return row.status;
}

const past = (): Date => new Date(Date.now() - 60_000);

beforeAll(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await db.end();
});

describe('initWorkingCopy / getWorkingCopy', () => {
  it('creates all sections empty at version 0', async () => {
    const sessionId = await createSession();
    const created = await initWorkingCopy(sessionId);
    expect(created.version).toBe(0);
    const wc = await getWorkingCopy(sessionId);
    expect(wc?.sections.Scope).toEqual({
      body: '',
      lastAiReadAt: null,
      lastUserEditAt: null,
    });
    expect(Object.keys(wc!.sections)).toHaveLength(27);
  });

  it('returns null for an unknown session', async () => {
    expect(await getWorkingCopy('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('updateSectionByUser', () => {
  it('sets body and lastUserEditAt and bumps the version', async () => {
    const sessionId = await createSession();
    await initWorkingCopy(sessionId);
    const version = await updateSectionByUser(sessionId, 'Scope', 'user scope', 0);
    expect(version).toBe(1);
    const wc = await getWorkingCopy(sessionId);
    expect(wc?.sections.Scope.body).toBe('user scope');
    expect(wc?.sections.Scope.lastUserEditAt).not.toBeNull();
  });

  it('AC3: throws VersionConflictError on a stale expectedVersion', async () => {
    const sessionId = await createSession();
    await initWorkingCopy(sessionId);
    await updateSectionByUser(sessionId, 'Scope', 'first', 0);
    await expect(updateSectionByUser(sessionId, 'Scope', 'second', 0)).rejects.toBeInstanceOf(VersionConflictError);
    expect((await getWorkingCopy(sessionId))?.sections.Scope.body).toBe('first');
  });
});

describe('markAiRead', () => {
  it('sets lastAiReadAt on every section without bumping the version', async () => {
    const sessionId = await createSession();
    await initWorkingCopy(sessionId);
    const at = new Date('2026-01-01T00:00:00.000Z');
    await markAiRead(sessionId, at);
    const wc = await getWorkingCopy(sessionId);
    expect(wc?.version).toBe(0);
    for (const state of Object.values(wc!.sections)) expect(state.lastAiReadAt).toBe(at.toISOString());
  });
});

describe('applyAiPatch', () => {
  it('AC1: stores a pending suggestion when the user edited after the AI read', async () => {
    const sessionId = await createSession();
    await initWorkingCopy(sessionId);
    const aiReadAt = past();
    await markAiRead(sessionId, aiReadAt);
    await updateSectionByUser(sessionId, 'Scope', 'human scope', 0);

    const result = await applyAiPatch(sessionId, { section: 'Scope', op: 'replace', content: 'ai scope' }, aiReadAt);
    expect(result.disposition).toBe('suggested');
    if (result.disposition !== 'suggested') return;
    expect(await suggestionStatus(result.suggestionId)).toBe('pending');
    const wc = await getWorkingCopy(sessionId);
    expect(wc?.sections.Scope.body).toBe('human scope');
    expect(wc?.version).toBe(1);
  });

  it('AC2: applies the patch and bumps the version when the section was not edited since the AI read', async () => {
    const sessionId = await createSession();
    await initWorkingCopy(sessionId);
    await updateSectionByUser(sessionId, 'Scope', 'human scope', 0);
    const aiReadAt = new Date(Date.now() + 1);
    await markAiRead(sessionId, aiReadAt);

    const result = await applyAiPatch(sessionId, { section: 'Scope', op: 'append', content: 'ai line' }, aiReadAt);
    expect(result).toEqual({ disposition: 'applied', version: 2 });
    expect((await getWorkingCopy(sessionId))?.sections.Scope.body).toBe('human scope\nai line');
  });

  it('applies to a never-edited section regardless of aiReadAt', async () => {
    const sessionId = await createSession();
    await initWorkingCopy(sessionId);
    await updateSectionByUser(sessionId, 'Scope', 'human scope', 0);
    const result = await applyAiPatch(sessionId, { section: 'Risks', op: 'replace', content: 'risk' }, past());
    expect(result).toEqual({ disposition: 'applied', version: 2 });
  });
});

describe('suggestions', () => {
  async function setupSuggestion(): Promise<{
    sessionId: string;
    suggestionId: string;
  }> {
    const sessionId = await createSession();
    await initWorkingCopy(sessionId);
    const aiReadAt = past();
    await updateSectionByUser(sessionId, 'Scope', 'human', 0);
    const result = await applyAiPatch(sessionId, { section: 'Scope', op: 'append', content: 'ai' }, aiReadAt);
    if (result.disposition !== 'suggested') throw new Error('expected a suggestion');
    return { sessionId, suggestionId: result.suggestionId };
  }

  it('AC4: acceptSuggestion applies the patch; accepting twice throws', async () => {
    const { sessionId, suggestionId } = await setupSuggestion();
    expect(await acceptSuggestion(suggestionId)).toBe(2);
    expect((await getWorkingCopy(sessionId))?.sections.Scope.body).toBe('human\nai');
    expect(await suggestionStatus(suggestionId)).toBe('accepted');
    await expect(acceptSuggestion(suggestionId)).rejects.toBeInstanceOf(SuggestionNotPendingError);
    expect((await getWorkingCopy(sessionId))?.sections.Scope.body).toBe('human\nai');
  });

  it('AC4: acceptSuggestion with editedContent applies the edited content', async () => {
    const { sessionId, suggestionId } = await setupSuggestion();
    await acceptSuggestion(suggestionId, 'edited');
    expect((await getWorkingCopy(sessionId))?.sections.Scope.body).toBe('human\nedited');
  });

  it('rejectSuggestion leaves the body unchanged; deciding again throws', async () => {
    const { sessionId, suggestionId } = await setupSuggestion();
    await rejectSuggestion(suggestionId);
    expect(await suggestionStatus(suggestionId)).toBe('rejected');
    expect((await getWorkingCopy(sessionId))?.sections.Scope.body).toBe('human');
    await expect(rejectSuggestion(suggestionId)).rejects.toBeInstanceOf(SuggestionNotPendingError);
    await expect(acceptSuggestion(suggestionId)).rejects.toBeInstanceOf(SuggestionNotPendingError);
  });
});

describe('replaceAllSections', () => {
  it('replaces every body and bumps the version', async () => {
    const sessionId = await createSession();
    await initWorkingCopy(sessionId);
    const sections = { ...emptySections(), Scope: 'restored scope' };
    expect(await replaceAllSections(sessionId, sections)).toBe(1);
    expect((await getWorkingCopy(sessionId))?.sections.Scope.body).toBe('restored scope');
  });

  it('rejects invalid sections without writing', async () => {
    const sessionId = await createSession();
    await initWorkingCopy(sessionId);
    await expect(replaceAllSections(sessionId, { Scope: 'x' })).rejects.toBeInstanceOf(InvalidSectionsError);
    expect((await getWorkingCopy(sessionId))?.version).toBe(0);
  });
});

describe('AC5: concurrency', () => {
  it('concurrent applyAiPatch and updateSectionByUser on the same section never lose an update', async () => {
    for (let i = 0; i < 20; i++) {
      const sessionId = await createSession();
      await initWorkingCopy(sessionId);
      const aiReadAt = past();
      await markAiRead(sessionId, aiReadAt);

      const [ai, user] = await Promise.allSettled([
        applyAiPatch(sessionId, { section: 'Scope', op: 'replace', content: 'ai' }, aiReadAt),
        updateSectionByUser(sessionId, 'Scope', 'human', 0),
      ]);
      expect(ai.status).toBe('fulfilled');
      if (ai.status !== 'fulfilled') return;
      const wc = await getWorkingCopy(sessionId);
      const suggestions = await query<{ patch: { content: string } }>(
        'SELECT patch FROM pending_suggestion WHERE session_id = $1',
        [sessionId],
      );

      if (ai.value.disposition === 'suggested') {
        // User committed first: their edit is kept and the AI content survives as a suggestion.
        expect(user.status).toBe('fulfilled');
        expect(wc?.sections.Scope.body).toBe('human');
        expect(wc?.version).toBe(1);
        expect(suggestions.map((s) => s.patch.content)).toEqual(['ai']);
      } else {
        // AI committed first: the user's stale write is rejected (never silently overwritten or lost).
        expect(user.status).toBe('rejected');
        if (user.status === 'rejected') expect(user.reason).toBeInstanceOf(VersionConflictError);
        expect(wc?.sections.Scope.body).toBe('ai');
        expect(wc?.version).toBe(1);
        expect(suggestions).toHaveLength(0);
      }
    }
  });
});
