import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { emptySections } from "../../lib/spec/document";
import {
  RUN_MARKER_PREFIX,
  SPEC_BLOCK_END,
  SPEC_BLOCK_START,
  buildPublishCommentAdf,
  buildSpecBlockNodes,
  upsertSpecBlock,
  type AdfDoc,
} from "./adf";
import { renderPublishedMarkdown, type PublishedMarkdownInput } from "./render";
import { markdownToConfluenceStorage } from "./toConfluenceStorage";
import type { AdfNode } from "../atlassian/adfToText";

/** Parses a storage-format fragment as XML; throws on any well-formedness error. */
function parseStorage(storage: string): Document {
  const errors: string[] = [];
  const record = (msg: string) => errors.push(msg);
  const doc = new DOMParser({
    errorHandler: { warning: record, error: record, fatalError: record },
  }).parseFromString(
    `<root xmlns:ac="http://atlassian.com/content" xmlns:ri="http://atlassian.com/resource/identifier">${storage}</root>`,
    "text/xml",
  );
  if (errors.length > 0) throw new Error(`Invalid XML: ${errors.join("; ")}`);
  return doc as unknown as Document;
}

function texts(nodes: AdfNode[]): string[] {
  const flat = (n: AdfNode): string =>
    n.type === "text" ? (n.text ?? "") : (n.content ?? []).map(flat).join("");
  return nodes.map(flat);
}

describe("upsertSpecBlock", () => {
  const original: AdfDoc = {
    type: "doc",
    version: 1,
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Context" }],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Original description." }],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "x" }] },
            ],
          },
        ],
      },
    ],
  };

  it("appends the block, leaves original nodes deep-equal, and replaces only the block on re-run", () => {
    const snapshot = structuredClone(original);
    const block1 = buildSpecBlockNodes({
      confluencePageUrl: "https://c.example/p/1",
      revisionNumber: 1,
      readinessScore: 80,
      overridden: false,
    });
    const first = upsertSpecBlock(original, block1);

    expect(original).toEqual(snapshot); // input not mutated
    expect(first.content.slice(0, 3)).toEqual(snapshot.content);
    expect(first.content.slice(3)).toEqual(block1);

    // Idempotent: same block again yields the same document.
    expect(upsertSpecBlock(first, block1)).toEqual(first);

    // Content added after the block by a human is preserved too.
    const withTrailer: AdfDoc = {
      ...first,
      content: [
        ...first.content,
        { type: "paragraph", content: [{ type: "text", text: "Later note" }] },
      ],
    };
    const block2 = buildSpecBlockNodes({
      confluencePageUrl: "https://c.example/p/1",
      revisionNumber: 2,
      readinessScore: 92,
      overridden: true,
    });
    const second = upsertSpecBlock(withTrailer, block2);
    expect(second.content.slice(0, 3)).toEqual(snapshot.content);
    expect(second.content.slice(3, 3 + block2.length)).toEqual(block2);
    expect(texts(second.content.slice(3 + block2.length))).toEqual([
      "Later note",
    ]);
    expect(
      texts(second.content).filter((t) => t === SPEC_BLOCK_START),
    ).toHaveLength(1);
  });

  it("builds a new doc containing only the block for a null description", () => {
    const block = buildSpecBlockNodes({
      confluencePageUrl: null,
      revisionNumber: 3,
      readinessScore: 70,
      overridden: false,
    });
    expect(upsertSpecBlock(null, block)).toEqual({
      type: "doc",
      version: 1,
      content: block,
    });
  });

  it("appends rather than deleting when only the start marker exists", () => {
    const partial: AdfDoc = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: SPEC_BLOCK_START }],
        },
      ],
    };
    const block = buildSpecBlockNodes({
      confluencePageUrl: null,
      revisionNumber: 1,
      readinessScore: 50,
      overridden: false,
    });
    const out = upsertSpecBlock(partial, block);
    expect(out.content.slice(0, 1)).toEqual(partial.content);
    expect(out.content.slice(1)).toEqual(block);
  });

  it("block contains the link, revision, score and override flag between the markers", () => {
    const t = texts(
      buildSpecBlockNodes({
        confluencePageUrl: "https://c.example/p/9",
        revisionNumber: 4,
        readinessScore: 88,
        overridden: true,
      }),
    );
    expect(t[0]).toBe(SPEC_BLOCK_START);
    expect(t.at(-1)).toBe(SPEC_BLOCK_END);
    expect(t).toEqual(
      expect.arrayContaining([
        "Confluence page: https://c.example/p/9",
        "Revision: 4",
        "Readiness score: 88",
        "Override: yes",
      ]),
    );
  });
});

describe("markdownToConfluenceStorage", () => {
  it("produces well-formed XML with code macros, tables, lists, headings, links and emphasis", () => {
    const md = [
      "# Title",
      "",
      "Some **bold**, _em_, `a<b` and [link](https://example.com/?a=1&b=2).",
      "Line one  ",
      "line two & more",
      "",
      "- one",
      "- [x] done",
      "",
      "1. first",
      "",
      "| A | B |",
      "| --- | :-: |",
      "| x | y |",
      "",
      "---",
      "",
      "![img](https://example.com/i.png)",
      "",
      "```ts",
      'const a = 1 < 2 && "]]>";',
      "```",
      "",
      "```",
      "plain",
      "```",
    ].join("\n");
    const storage = markdownToConfluenceStorage(md);
    const doc = parseStorage(storage);

    expect(doc.getElementsByTagName("h1")[0]?.textContent).toBe("Title");
    expect(doc.getElementsByTagName("strong")).toHaveLength(1);
    expect(doc.getElementsByTagName("em")).toHaveLength(1);
    expect(doc.getElementsByTagName("a")[0]?.getAttribute("href")).toBe(
      "https://example.com/?a=1&b=2",
    );
    expect(doc.getElementsByTagName("table")).toHaveLength(1);
    expect(doc.getElementsByTagName("li").length).toBeGreaterThanOrEqual(3);
    expect(storage).toContain("<hr />");
    expect(storage).toContain("<br />");

    const macros = doc.getElementsByTagName("ac:structured-macro");
    expect(macros).toHaveLength(2);
    expect(macros[0]?.getAttribute("ac:name")).toBe("code");
    expect(
      macros[0]?.getElementsByTagName("ac:parameter")[0]?.textContent,
    ).toBe("ts");
    expect(
      macros[0]?.getElementsByTagName("ac:plain-text-body")[0]?.textContent,
    ).toBe('const a = 1 < 2 && "]]>";');
    expect(macros[1]?.getElementsByTagName("ac:parameter")).toHaveLength(0);
    expect(storage).toContain("<![CDATA[");
  });

  it("escapes raw HTML and script, and drops unsafe link protocols", () => {
    const md =
      '<script>alert(1)</script>\n\nInline <img src=x onerror="alert(2)"> text &nbsp; [x](javascript:alert(3))';
    const storage = markdownToConfluenceStorage(md);
    const doc = parseStorage(storage);

    expect(doc.getElementsByTagName("script")).toHaveLength(0);
    expect(doc.getElementsByTagName("img")).toHaveLength(0);
    expect(doc.getElementsByTagName("a")).toHaveLength(0);
    expect(storage).not.toContain("<script");
    expect(storage).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(storage).toContain("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;");
    expect(storage).not.toContain("javascript:");
  });
});

describe("renderPublishedMarkdown", () => {
  const base: PublishedMarkdownInput = {
    sections: emptySections(),
    header: {
      title: "Spec",
      tickets: [{ key: "ABC-1", url: "https://j.example/browse/ABC-1" }],
      facilitator: "Ann",
      sessionId: "sess-1",
      revision: 5,
      readinessScore: 91,
      overrideJustification: null,
    },
  };

  it("includes the SR-5.3 header without override justification when not set", () => {
    const md = renderPublishedMarkdown(base);
    expect(md).toContain("# Spec");
    expect(md).toContain(
      "| Tickets | [ABC-1](https://j.example/browse/ABC-1) |",
    );
    expect(md).toContain("| Facilitator | Ann |");
    expect(md).toContain("| Session ID | sess-1 |");
    expect(md).toContain("| Revision | 5 |");
    expect(md).toContain("| Readiness Score | 91 |");
    expect(md).not.toContain("Override justification");
    expect(
      renderPublishedMarkdown({
        ...base,
        header: { ...base.header, overrideJustification: "   " },
      }),
    ).not.toContain("Override justification");
  });

  it("includes the override justification when set", () => {
    const md = renderPublishedMarkdown({
      ...base,
      header: { ...base.header, overrideJustification: "Deadline agreed" },
    });
    expect(md).toContain("| Override justification | Deadline agreed |");
  });
});

describe("buildPublishCommentAdf", () => {
  const info = {
    runId: "run-42",
    publisher: { accountId: "acc-1", displayName: "Ann" },
    revisionNumber: 5,
    readinessScore: 91,
    confluencePageUrl: "https://c.example/p/1",
    overrideJustification: null,
  };

  it("contains publisher, revision, score, link and the run marker as the final paragraph", () => {
    const adf = buildPublishCommentAdf(info);
    expect(adf.type).toBe("doc");
    expect(adf.version).toBe(1);
    const t = texts(adf.content);
    expect(t.at(-1)).toBe(`${RUN_MARKER_PREFIX}run-42`);
    expect(t).toEqual(
      expect.arrayContaining([
        "Revision: 5",
        "Readiness score: 91",
        "Confluence page: https://c.example/p/1",
      ]),
    );
    expect(JSON.stringify(adf)).toContain('"id":"acc-1"');
    expect(t.some((s) => s.startsWith("Override justification"))).toBe(false);
  });

  it("includes the override justification when set", () => {
    const t = texts(
      buildPublishCommentAdf({
        ...info,
        overrideJustification: "Deadline agreed",
      }).content,
    );
    expect(t).toContain("Override justification: Deadline agreed");
    expect(t.at(-1)).toBe(`${RUN_MARKER_PREFIX}run-42`);
  });
});
