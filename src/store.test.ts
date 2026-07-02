import { describe, expect, it } from "vitest";
import { rebuildDocumentLatex } from "./store";
import type { DocumentResult } from "./types";

describe("rebuildDocumentLatex", () => {
  it("keeps ctexart and reading-order block content", () => {
    const document: DocumentResult = {
      id: "doc",
      title: "sample",
      source_type: "image",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "completed",
      raw: {},
      metrics: {},
      latex: "",
      pages: [
        {
          page: 1,
          blocks: [
            {
              id: "b2",
              page: 1,
              block_type: "formula",
              bbox: [0.1, 0.5, 0.9, 0.6],
              text: "",
              latex: "a=b",
              raw: {},
            },
            {
              id: "b1",
              page: 1,
              block_type: "paragraph",
              bbox: [0.1, 0.2, 0.9, 0.3],
              text: "hello",
              latex: "hello",
              raw: {},
            },
          ],
        },
      ],
    };

    const latex = rebuildDocumentLatex(document);

    expect(latex).toContain("\\documentclass[UTF8]{ctexart}");
    expect(latex.indexOf("hello")).toBeLessThan(latex.indexOf("a=b"));
  });
});

