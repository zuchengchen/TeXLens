import { describe, expect, it } from "vitest";
import {
  extractLatexBody,
  normalizeDocumentForStore,
  normalizeLatexSource,
  useAppStore,
  wrapLatexBody,
} from "./store";
import type { DocumentResult } from "./types";

describe("source body helpers", () => {
  it("wraps edited body with the fixed TeXLens template", () => {
    const latex = wrapLatexBody("hello\n\n\\[a=b\\]", "sample");

    expect(latex).toContain("\\documentclass[UTF8]{ctexart}");
    expect(latex).toContain("\\title{sample}");
    expect(latex).toContain("\\begin{document}");
    expect(latex).toContain("\\maketitle");
    expect(latex).toContain("hello");
    expect(latex).toContain("\\begin{equation}\na=b\n\\end{equation}");
    expect(latex).toContain("\\end{document}");
    expect(latex).not.toContain("\\[");
  });

  it("extracts only body content from a complete document source", () => {
    const body = extractLatexBody(
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\maketitle",
        "",
        "Visible body",
        "\\end{document}",
      ].join("\n"),
    );

    expect(body).toBe("Visible body");
  });

  it("normalizes active documents to body plus complete source", () => {
    const document: DocumentResult = {
      id: "doc",
      title: "sample",
      source_type: "image",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "completed",
      raw: {},
      metrics: {},
      body: "",
      latex: "\\documentclass{article}\n\\begin{document}\n\\[a=b\\]\n\\end{document}\n",
    };

    const normalized = normalizeDocumentForStore(document);

    expect(normalized.body).toBe("\\begin{equation}\na=b\n\\end{equation}");
    expect(normalized.latex).toContain("\\begin{document}");
    expect(normalized.latex).toContain("\\title{sample}");
    expect(normalized.latex).not.toContain("\\[");
  });

  it("updates body edits while keeping saved source complete", () => {
    const now = new Date().toISOString();
    useAppStore.getState().setActiveDocument({
      id: "doc",
      title: "sample",
      source_type: "image",
      created_at: now,
      updated_at: now,
      status: "completed",
      raw: {},
      metrics: {},
      body: "old",
      latex: "",
    });

    useAppStore.getState().updateActiveDocumentBody("new\n\n\\[E=mc^2\\]");

    const document = useAppStore.getState().activeDocument;
    expect(document?.body).toContain("new");
    expect(document?.body).toContain("\\[E=mc^2\\]");
    expect(document?.latex).toContain("\\begin{equation}\nE=mc^2\n\\end{equation}");
    expect(document?.latex).toContain("\\begin{document}");
    expect(document?.latex).toContain("\\end{document}");
  });

  it("strips inline math delimiters inside equation environments", () => {
    const latex = normalizeLatexSource(
      "\\begin{equation}\n" +
        "\\(\\Phi'' + \\frac{3}{7}\\Phi' + k^2 \\Phi_k = S_k,\\) (8)" +
        "\n\\end{equation}",
    );

    expect(latex).toContain("\\tag{8}");
    expect(latex).not.toContain("\\(");
    expect(latex).not.toContain("\\)");
    expect(latex).not.toContain(", (8)");
  });

  it("unwraps prose paragraphs that were incorrectly placed in equation environments", () => {
    const source = [
      "\\begin{equation}",
      String.raw`For a cosmic background fluid with a constant equation of state \(w\), the scale factor evolves as \(a \propto \tau^{2/(1+3w)}\), and therefore \(V_i \sim \tau^{\frac{3(-1+w)}{1+3w}}\). Thus, the vector mode decays with the cosmic expansion for \(w < 1\), but retains constant during a post-inflationary stiff or kination phase with`,
      "\\end{equation}",
    ].join("\n");

    const latex = normalizeLatexSource(source);

    expect(latex).not.toContain("\\begin{equation}");
    expect(latex).not.toContain("\\end{equation}");
    expect(latex).toContain(String.raw`\(w\)`);
    expect(latex).toContain("For a cosmic background fluid");
  });

  it("restores escaped standalone formula lines before preview compile", () => {
    const source = [
      "The fraction is",
      "",
      String.raw`f(M) \textbackslash{}equiv \textbackslash{}frac\{\textbackslash{}Omega\_\{PBH\}(M)\}\{\textbackslash{}Omega\_\{CDM\}\} \textbackslash{}approx 1.5 \textbackslash{}times 10\textasciicircum{}\{13\} \textbackslash{}beta \textbackslash{}tag\{5\}`,
      "",
      String.raw`where \(g_{*r}\) and \(g_{*s}\) are effective degrees of freedom.`,
    ].join("\n");

    const latex = normalizeLatexSource(source);

    expect(latex).toContain("\\begin{equation}");
    expect(latex).toContain(String.raw`\equiv`);
    expect(latex).toContain(String.raw`\frac{\Omega_{PBH}(M)}{\Omega_{CDM}}`);
    expect(latex).toContain(String.raw`10^{13}`);
    expect(latex).toContain(String.raw`\tag{5}`);
    expect(latex).not.toContain(String.raw`\textbackslash{}`);
  });
});
