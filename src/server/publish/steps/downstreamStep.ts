import { recordAudit } from '@/server/audit/audit';
import { getConfig } from '@/server/config';
import { logger } from '@/server/observability/logger';
import type { PublishContext, PublishStep, StepResult } from '../types';
import { signPayload } from '../webhookSignature';

// Server-only: never import from src/lib or client components.
// Notifies the downstream AI Task Generator via a signed webhook (SPEC_DOC §7.4, SR-13.2 step 6). The Task Generator
// API is never called directly [D-9]; without a configured webhook the spec-published Jira label is the signal.

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_RETRY_DELAYS_MS = [1_000, 5_000, 25_000];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function attempt(url: string, body: string, headers: Record<string, string>): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    return res.status >= 200 && res.status < 300 ? null : `HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : 'network error';
  }
}

async function audit(ctx: PublishContext, result: 'success' | 'failure', details: Record<string, unknown>) {
  try {
    await recordAudit({
      action: 'downstream.triggered',
      result,
      userId: ctx.facilitator.accountId,
      userDisplayName: ctx.facilitator.displayName,
      sessionId: ctx.sessionId,
      ticketIds: ctx.ticketKeys,
      details: { runId: ctx.runId, revision: ctx.revisionNumber, ...details },
    });
  } catch (err) {
    logger.error({ err, runId: ctx.runId }, 'failed to record downstream.triggered audit');
  }
}

export const downstreamStep: PublishStep = {
  name: 'downstream',
  async run(ctx: PublishContext): Promise<StepResult> {
    const { DOWNSTREAM_WEBHOOK_URL: url, DOWNSTREAM_WEBHOOK_SECRET: secret } = getConfig();
    if (!url || !secret) {
      await audit(ctx, 'success', { mode: 'label-only' });
      return { status: 'success', result: { mode: 'label-only' } };
    }

    const body = JSON.stringify({
      event: 'spec.published',
      sessionId: ctx.sessionId,
      primaryTicket: ctx.primaryTicketKey,
      tickets: ctx.ticketKeys,
      revision: ctx.revisionNumber,
      readinessScore: ctx.readinessScore,
      override: ctx.overrideJustification !== null,
      confluencePageUrl: ctx.confluencePageUrl,
      attachmentName: `${ctx.primaryTicketKey}-spec-r${ctx.revisionNumber}.md`,
      specMarkdown: ctx.markdown,
      publishedBy: ctx.facilitator.accountId,
      publishedAt: new Date().toISOString(),
    });
    const headers = {
      'Content-Type': 'application/json',
      'X-Signature': signPayload(body, secret),
      'X-Delivery-Id': ctx.runId,
    };

    let failure = await attempt(url, body, headers);
    let retries = 0;
    while (failure !== null && retries < WEBHOOK_RETRY_DELAYS_MS.length) {
      await sleep(WEBHOOK_RETRY_DELAYS_MS[retries]);
      retries += 1;
      failure = await attempt(url, body, headers);
    }

    if (failure === null) {
      await audit(ctx, 'success', { mode: 'webhook', attempts: retries + 1 });
      return { status: 'success', result: { mode: 'webhook', attempts: retries + 1 } };
    }
    logger.warn({ runId: ctx.runId, attempts: retries + 1, failure }, 'downstream webhook failed');
    await audit(ctx, 'failure', { mode: 'webhook', attempts: retries + 1, failure });
    return { status: 'failed', error: { code: 'webhook_failed', message: failure } };
  },
};
