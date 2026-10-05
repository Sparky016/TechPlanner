import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordAudit } from "@/server/audit/audit";
import { getValidAccessToken } from "@/server/auth/tokens";
import type { AdfNode } from "../../atlassian/adfToText";
import {
  RUN_MARKER_PREFIX,
  SPEC_BLOCK_END,
  SPEC_BLOCK_START,
  type AdfDoc,
} from "../adf";
import type { PublishContext } from "../types";
import {
  jiraAttachStep,
  jiraCommentStep,
  jiraDescriptionStep,
  jiraLabelStep,
} from "./jiraSteps";

// Atlassian is mocked by stubbing global fetch, as in src/server/atlassian (undici is not a project dependency).

vi.mock("@/server/config", () => ({
  getConfig: () => ({ ATLASSIAN_CLOUD_ID: "cloud-123" }),
}));

vi.mock("@/server/auth/tokens", () => ({
  getValidAccessToken: vi.fn(),
  ReauthRequiredError: class ReauthRequiredError extends Error {},
}));

vi.mock("@/server/audit/audit", () => ({ recordAudit: vi.fn() }));

const fetchMock = vi.fn<typeof fetch>();
const BASE = "/ex/jira/cloud-123/rest/api/3/issue/";

interface Call {
  method: string;
  path: string;
  search: string;
  init: RequestInit | undefined;
}

const calls: Call[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

type Handler = (call: Call) => Response | Promise<Response>;

function route(handler: Handler): void {
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname.startsWith(BASE)
        ? url.pathname.slice(BASE.length)
        : url.pathname,
      search: url.search,
      init,
    };
    calls.push(call);
    return handler(call);
  });
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

function ctx(overrides: Partial<PublishContext> = {}): PublishContext {
  return {
    runId: "run-1",
    sessionId: "00000000-0000-0000-0000-000000000001",
    ticketKeys: ["ABC-1"],
    primaryTicketKey: "ABC-1",
    facilitator: { accountId: "acc-1", displayName: "Fay" },
    revisionNumber: 3,
    readinessScore: 88,
    overrideJustification: null,
    markdown: "# Spec\n",
    title: "Spec",
    confluencePageUrl: "https://example.atlassian.net/wiki/spaces/X/pages/1",
    previousResult: null,
    options: {},
    ...overrides,
  };
}

function para(t: string): AdfNode {
  return { type: "paragraph", content: [{ type: "text", text: t }] };
}

function flat(n: AdfNode): string {
  return n.type === "text" ? (n.text ?? "") : (n.content ?? []).map(flat).join("");
}

beforeEach(() => {
  calls.length = 0;
  fetchMock.mockReset();
  vi.mocked(getValidAccessToken).mockResolvedValue("token");
  vi.mocked(recordAudit).mockReset();
  vi.mocked(recordAudit).mockResolvedValue({ id: "1", hash: "h" });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("jiraAttachStep", () => {
  it("uploads once per ticket and a rerun with the existing filename uploads nothing (AC1)", async () => {
    const attachments: { id: string; filename: string }[] = [
      { id: "old", filename: "ABC-1-spec-r2.md" },
    ];
    route((c) => {
      if (c.method === "GET") return json({ fields: { attachment: attachments } });
      const file = (c.init?.body as FormData).get("file") as File;
      attachments.push({ id: "att-9", filename: file.name });
      return json([{ id: "att-9", filename: file.name }]);
    });

    const first = await jiraAttachStep.run(ctx());
    expect(first).toEqual({
      status: "success",
      result: { "ABC-1": { status: "success", id: "att-9" } },
    });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe("ABC-1/attachments");
    expect(new Headers(posts[0].init?.headers).get("X-Atlassian-Token")).toBe("no-check");
    const file = (posts[0].init?.body as FormData).get("file") as File;
    expect(file.name).toBe("ABC-1-spec-r3.md");
    expect(await file.text()).toBe("# Spec\n");
    expect(calls[0].search).toBe("?fields=attachment");

    // A fresh run (no previousResult) finds the filename and skips the upload.
    calls.length = 0;
    const second = await jiraAttachStep.run(ctx());
    expect(second.status).toBe("success");
    expect(second.result).toEqual({ "ABC-1": { status: "success", id: "att-9" } });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(attachments.filter((a) => a.filename === "ABC-1-spec-r3.md")).toHaveLength(1);
  });
});

describe("jiraDescriptionStep", () => {
  it("preserves all original ADF nodes and has exactly one spec block after two runs (AC2)", async () => {
    const original: AdfNode[] = [
      para("Original intro"),
      { type: "bulletList", content: [{ type: "listItem", content: [para("item")] }] },
      para("Original outro"),
    ];
    let description: AdfDoc = { type: "doc", version: 1, content: original };
    route((c) => {
      if (c.method === "GET") return json({ fields: { description } });
      description = (bodyOf(c).fields as { description: AdfDoc }).description;
      return noContent();
    });

    expect((await jiraDescriptionStep.run(ctx())).status).toBe("success");
    expect((await jiraDescriptionStep.run(ctx({ revisionNumber: 4 }))).status).toBe("success");

    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[1].path).toBe("ABC-1");
    expect(calls[0].search).toBe("?fields=description");
    const content = (bodyOf(puts[1]).fields as { description: AdfDoc }).description.content;
    expect(content.slice(0, original.length)).toEqual(original);
    const texts = content.map(flat);
    expect(texts.filter((t) => t === SPEC_BLOCK_START)).toHaveLength(1);
    expect(texts.filter((t) => t === SPEC_BLOCK_END)).toHaveLength(1);
    expect(texts).toContain("Revision: 4");
    expect(texts).not.toContain("Revision: 3");
    expect(texts.some((t) => t.includes("https://example.atlassian.net/wiki/spaces/X/pages/1"))).toBe(true);
  });

  it("fails without any Jira call when the Confluence URL is missing", async () => {
    route(() => json({}));
    const res = await jiraDescriptionStep.run(ctx({ confluencePageUrl: null }));
    expect(res.status).toBe("failed");
    expect(res.error?.code).toBe("confluence_url_missing");
    expect(calls).toHaveLength(0);
  });
});

describe("jiraCommentStep", () => {
  it("skips when a comment with the run marker exists (AC3)", async () => {
    route((c) => {
      if (c.method === "GET")
        return json({
          startAt: 0,
          maxResults: 100,
          total: 2,
          comments: [
            { id: "c1", body: { type: "doc", version: 1, content: [para(`${RUN_MARKER_PREFIX}run-10`)] } },
            { id: "c2", body: { type: "doc", version: 1, content: [para("hi"), para(`${RUN_MARKER_PREFIX}run-1`)] } },
          ],
        });
      return json({ id: "new" }, 201);
    });

    const res = await jiraCommentStep.run(ctx());
    expect(res).toEqual({ status: "success", result: { "ABC-1": { status: "success", id: "c2" } } });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("posts a comment with the override justification and run marker when none exists (AC3)", async () => {
    route((c) => {
      if (c.method === "GET")
        return json({
          startAt: 0,
          maxResults: 100,
          total: 1,
          comments: [{ id: "c1", body: { type: "doc", version: 1, content: [para(`${RUN_MARKER_PREFIX}run-10`)] } }],
        });
      return json({ id: "c-new" }, 201);
    });

    const res = await jiraCommentStep.run(ctx({ overrideJustification: "Deadline agreed with PM" }));
    expect(res).toEqual({ status: "success", result: { "ABC-1": { status: "success", id: "c-new" } } });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("ABC-1/comment");
    const texts = (bodyOf(post!).body as AdfDoc).content.map(flat);
    expect(texts).toContain("Override justification: Deadline agreed with PM");
    expect(texts).toContain(`${RUN_MARKER_PREFIX}run-1`);
  });
});

describe("jiraLabelStep", () => {
  it("sends an add operation, not a replace of labels (AC4)", async () => {
    route(() => noContent());
    const res = await jiraLabelStep.run(ctx());
    expect(res.status).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].path).toBe("ABC-1");
    const body = bodyOf(calls[0]);
    expect(body.fields).toBeUndefined();
    expect(body).toEqual({ update: { labels: [{ add: "spec-published" }] } });
  });
});

describe("per-ticket results and retries", () => {
  it("fails the step when one ticket fails, skips the successful ticket on retry and audits per ticket (AC5)", async () => {
    let failB = true;
    route((c) => {
      if (c.path === "ABC-2" && failB)
        return json({ errorMessages: ["You do not have permission"] }, 403);
      return noContent();
    });
    const tickets = { ticketKeys: ["ABC-1", "ABC-2"] };

    const first = await jiraLabelStep.run(ctx(tickets));
    expect(first.status).toBe("failed");
    expect(first.error?.code).toBe("jira_ticket_failed");
    expect(first.result).toEqual({
      "ABC-1": { status: "success" },
      "ABC-2": {
        status: "failed",
        error: { code: "atlassian_403", message: "You do not have permission" },
      },
    });
    expect(vi.mocked(recordAudit)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(recordAudit).mock.calls.map(([a]) => [a.action, a.result, a.ticketIds])).toEqual([
      ["jira.updated", "success", ["ABC-1"]],
      ["jira.updated", "failure", ["ABC-2"]],
    ]);
    expect(vi.mocked(recordAudit).mock.calls[0][0]).toMatchObject({
      userId: "acc-1",
      sessionId: "00000000-0000-0000-0000-000000000001",
      details: { step: "jira_label", runId: "run-1" },
    });

    calls.length = 0;
    vi.mocked(recordAudit).mockClear();
    failB = false;
    const retry = await jiraLabelStep.run(ctx({ ...tickets, previousResult: first.result ?? null }));
    expect(retry).toEqual({
      status: "success",
      result: { "ABC-1": { status: "success" }, "ABC-2": { status: "success" } },
    });
    expect(calls.map((c) => c.path)).toEqual(["ABC-2"]);
    expect(vi.mocked(recordAudit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordAudit).mock.calls[0][0].ticketIds).toEqual(["ABC-2"]);
  });

  it("uses the facilitator's own token for every call", async () => {
    route(() => noContent());
    await jiraLabelStep.run(ctx());
    expect(vi.mocked(getValidAccessToken)).toHaveBeenCalledWith("acc-1");
  });
});
