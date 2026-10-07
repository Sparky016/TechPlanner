// Server-only: never import from src/lib or client components.
// Jira publish steps (SR-13.2 steps 2–5, D-8): attach the spec markdown, upsert the delimited description block,
// add the publish comment and the spec-published label on every session ticket, as the facilitator. Each step is
// idempotent per ticket, and a retry only re-processes tickets whose previous status was not success.

import { recordAudit } from "@/server/audit/audit";
import { AtlassianApiError, atlassianJson } from "@/server/atlassian/client";
import { adfToText } from "@/server/atlassian/adfToText";
import { ReauthRequiredError } from "@/server/auth/tokens";
import {
  RUN_MARKER_PREFIX,
  buildPublishCommentAdf,
  buildSpecBlockNodes,
  upsertSpecBlock,
  type AdfDoc,
} from "../adf";
import type {
  PublishContext,
  PublishStep,
  PublishStepName,
  StepResult,
} from "../types";

export const SPEC_PUBLISHED_LABEL = "spec-published";
const COMMENT_PAGE_SIZE = 100;

export interface TicketResult {
  status: "success" | "failed";
  id?: string;
  error?: { code: string; message: string };
}

interface TicketOutcome {
  id?: string;
  /** True when the ticket already had this step's effect (idempotent skip). */
  skipped?: boolean;
}

type TicketOp = (ctx: PublishContext, key: string) => Promise<TicketOutcome>;

function issuePath(key: string): string {
  return `/rest/api/3/issue/${encodeURIComponent(key)}`;
}

function previousTicketResult(
  ctx: PublishContext,
  key: string,
): TicketResult | null {
  const prev = ctx.previousResult?.[key];
  if (typeof prev !== "object" || prev === null) return null;
  return (prev as TicketResult).status === "success"
    ? (prev as TicketResult)
    : null;
}

function toError(err: unknown): { code: string; message: string } {
  if (err instanceof AtlassianApiError)
    return { code: err.code, message: err.message };
  return {
    code: "jira_update_failed",
    message: err instanceof Error ? err.message : "Jira update failed",
  };
}

// Runs `op` for each ticket not already successful, auditing jira.updated per processed ticket.
// ReauthRequiredError is a per-user condition and propagates to the orchestrator; audit failures propagate too.
async function runPerTicket(
  name: PublishStepName,
  ctx: PublishContext,
  op: TicketOp,
): Promise<StepResult> {
  const result: Record<string, TicketResult> = {};
  const failed: string[] = [];

  for (const key of ctx.ticketKeys) {
    const prev = previousTicketResult(ctx, key);
    if (prev) {
      result[key] = prev;
      continue;
    }

    let ticket: TicketResult;
    let skipped = false;
    try {
      const outcome = await op(ctx, key);
      skipped = outcome.skipped === true;
      ticket =
        outcome.id === undefined
          ? { status: "success" }
          : { status: "success", id: outcome.id };
    } catch (err) {
      if (err instanceof ReauthRequiredError) throw err;
      ticket = { status: "failed", error: toError(err) };
      failed.push(key);
    }
    result[key] = ticket;

    await recordAudit({
      action: "jira.updated",
      result: ticket.status === "success" ? "success" : "failure",
      userId: ctx.facilitator.accountId,
      userDisplayName: ctx.facilitator.displayName,
      sessionId: ctx.sessionId,
      ticketIds: [key],
      correlationId: ctx.runId,
      details: {
        step: name,
        runId: ctx.runId,
        revisionNumber: ctx.revisionNumber,
        ...(ticket.id !== undefined ? { id: ticket.id } : {}),
        ...(skipped ? { skipped: true } : {}),
        ...(ticket.error ? { errorCode: ticket.error.code } : {}),
      },
    });
  }

  if (failed.length === 0) return { status: "success", result };
  return {
    status: "failed",
    result,
    error: {
      code: "jira_ticket_failed",
      message: `Jira ${name} failed for ${failed.join(", ")}`,
    },
  };
}

// Step 2: attach `${KEY}-spec-r${revision}.md`, unless an attachment with that filename already exists.
async function attach(ctx: PublishContext, key: string): Promise<TicketOutcome> {
  const userId = ctx.facilitator.accountId;
  const filename = `${key}-spec-r${ctx.revisionNumber}.md`;
  const issue = await atlassianJson<{
    fields?: { attachment?: { id?: string; filename?: string }[] };
  }>(userId, "jira", `${issuePath(key)}?fields=attachment`);
  const existing = (issue.fields?.attachment ?? []).find(
    (a) => a.filename === filename,
  );
  if (existing) return { id: existing.id, skipped: true };

  const form = new FormData();
  form.append(
    "file",
    new File([ctx.markdown], filename, { type: "text/markdown" }),
  );
  const created = await atlassianJson<{ id?: string }[]>(
    userId,
    "jira",
    `${issuePath(key)}/attachments`,
    {
      method: "POST",
      headers: { "X-Atlassian-Token": "no-check" },
      body: form,
    },
  );
  return { id: created[0]?.id };
}

// Step 3: insert or replace the delimited spec block; content outside the markers is never changed (D-8).
async function upsertDescription(
  ctx: PublishContext,
  key: string,
): Promise<TicketOutcome> {
  const userId = ctx.facilitator.accountId;
  const issue = await atlassianJson<{ fields?: { description?: AdfDoc | null } }>(
    userId,
    "jira",
    `${issuePath(key)}?fields=description`,
  );
  const description = upsertSpecBlock(
    issue.fields?.description ?? null,
    buildSpecBlockNodes({
      confluencePageUrl: ctx.confluencePageUrl,
      revisionNumber: ctx.revisionNumber,
      readinessScore: ctx.readinessScore,
      overridden: ctx.overrideJustification !== null,
    }),
  );
  await atlassianJson<unknown>(userId, "jira", issuePath(key), {
    method: "PUT",
    body: JSON.stringify({ fields: { description } }),
  });
  return {};
}

async function hasRunComment(
  ctx: PublishContext,
  key: string,
): Promise<string | null> {
  const marker = `${RUN_MARKER_PREFIX}${ctx.runId}`;
  let seen = 0;
  for (;;) {
    const page = await atlassianJson<{
      total?: number;
      comments?: { id?: string; body?: unknown }[];
    }>(
      ctx.facilitator.accountId,
      "jira",
      `${issuePath(key)}/comment?startAt=${seen}&maxResults=${COMMENT_PAGE_SIZE}`,
    );
    const batch = page.comments ?? [];
    const match = batch.find((c) =>
      adfToText(c.body)
        .split("\n")
        .some((line) => line.trim() === marker),
    );
    if (match) return match.id ?? "";
    seen += batch.length;
    if (batch.length === 0 || seen >= (page.total ?? 0)) return null;
  }
}

// Step 4: add the publish comment unless a comment carrying this run's marker already exists.
async function addComment(
  ctx: PublishContext,
  key: string,
): Promise<TicketOutcome> {
  const existingId = await hasRunComment(ctx, key);
  if (existingId !== null)
    return existingId === ""
      ? { skipped: true }
      : { id: existingId, skipped: true };

  const body = buildPublishCommentAdf({
    runId: ctx.runId,
    publisher: ctx.facilitator,
    revisionNumber: ctx.revisionNumber,
    readinessScore: ctx.readinessScore,
    confluencePageUrl: ctx.confluencePageUrl,
    overrideJustification: ctx.overrideJustification,
  });
  const created = await atlassianJson<{ id?: string }>(
    ctx.facilitator.accountId,
    "jira",
    `${issuePath(key)}/comment`,
    { method: "POST", body: JSON.stringify({ body }) },
  );
  return { id: created.id };
}

// Step 5: add the label with an `add` operation so existing labels are never replaced.
async function addLabel(ctx: PublishContext, key: string): Promise<TicketOutcome> {
  await atlassianJson<unknown>(ctx.facilitator.accountId, "jira", issuePath(key), {
    method: "PUT",
    body: JSON.stringify({
      update: { labels: [{ add: SPEC_PUBLISHED_LABEL }] },
    }),
  });
  return {};
}

export const jiraAttachStep: PublishStep = {
  name: "jira_attach",
  run: (ctx) => runPerTicket("jira_attach", ctx, attach),
};

export const jiraDescriptionStep: PublishStep = {
  name: "jira_description",
  run: async (ctx) => {
    // The orchestrator runs this only after the Confluence step succeeded; never write a link-less block.
    if (ctx.confluencePageUrl === null) {
      return {
        status: "failed",
        error: {
          code: "confluence_url_missing",
          message: "The Confluence page URL is required for the Jira description block",
        },
      };
    }
    return runPerTicket("jira_description", ctx, upsertDescription);
  },
};

export const jiraCommentStep: PublishStep = {
  name: "jira_comment",
  run: (ctx) => runPerTicket("jira_comment", ctx, addComment),
};

export const jiraLabelStep: PublishStep = {
  name: "jira_label",
  run: (ctx) => runPerTicket("jira_label", ctx, addLabel),
};
