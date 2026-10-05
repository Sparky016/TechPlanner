// Server-only: never import from src/lib or client components.
// Shared publish contract (SR-13.2): every external publish step implements PublishStep and is driven by the
// publish runner with a PublishContext. Steps must be independent, idempotent and individually retryable [D-8, D-9].

export type PublishStepName =
  | "confluence"
  | "jira_attach"
  | "jira_description"
  | "jira_comment"
  | "jira_label"
  | "downstream";

export interface PublishContext {
  runId: string;
  sessionId: string;
  /** All session tickets; the first is the primary ticket [D-8]. */
  ticketKeys: string[];
  primaryTicketKey: string;
  facilitator: { accountId: string; displayName: string };
  revisionNumber: number;
  readinessScore: number;
  /** Set when the publish was gated by a readiness Override (SR-9.2). */
  overrideJustification: string | null;
  /** The published Markdown document (see renderPublishedMarkdown). */
  markdown: string;
  title: string;
  /** Known once the confluence step has succeeded (this run or a previous one). */
  confluencePageUrl: string | null;
  /** This step's result from a previous attempt, used for idempotent retries. */
  previousResult: Record<string, unknown> | null;
  options: { confluenceAction?: "overwrite" | "cancel" };
}

export type StepResult = {
  status: "success" | "failed" | "cancelled";
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
};

export interface PublishStep {
  name: PublishStepName;
  run(ctx: PublishContext): Promise<StepResult>;
}
