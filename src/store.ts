import { create } from "zustand";
import type { DocumentResult, EnvironmentReport, ObservabilitySnapshot } from "./types";

const textSpecials: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "&": "\\&",
  "%": "\\%",
  "#": "\\#",
  "_": "\\_",
  "$": "\\$",
  "{": "\\{",
  "}": "\\}",
  "^": "\\textasciicircum{}",
  "~": "\\textasciitilde{}",
};

const latexCommands = new Set([
  "Alpha",
  "Beta",
  "Gamma",
  "Delta",
  "Theta",
  "Lambda",
  "Xi",
  "Pi",
  "Sigma",
  "Phi",
  "Psi",
  "Omega",
  "alpha",
  "beta",
  "gamma",
  "delta",
  "varepsilon",
  "epsilon",
  "zeta",
  "eta",
  "theta",
  "vartheta",
  "iota",
  "kappa",
  "lambda",
  "mu",
  "nu",
  "xi",
  "pi",
  "rho",
  "varrho",
  "sigma",
  "varsigma",
  "tau",
  "upsilon",
  "phi",
  "varphi",
  "chi",
  "psi",
  "omega",
  "binom",
  "frac",
  "dfrac",
  "tfrac",
  "sqrt",
  "int",
  "oint",
  "sum",
  "prod",
  "lim",
  "sup",
  "inf",
  "min",
  "max",
  "log",
  "ln",
  "exp",
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "infty",
  "partial",
  "nabla",
  "left",
  "right",
  "big",
  "Big",
  "bigg",
  "Bigg",
  "begin",
  "end",
  "tag",
  "label",
  "ref",
  "eqref",
  "cite",
  "emph",
  "url",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "item",
  "includegraphics",
  "cdot",
  "times",
  "div",
  "pm",
  "mp",
  "leq",
  "geq",
  "le",
  "ge",
  "neq",
  "equiv",
  "approx",
  "sim",
  "propto",
  "to",
  "rightarrow",
  "leftarrow",
  "Rightarrow",
  "Leftarrow",
  "leftrightarrow",
  "mapsto",
  "mathrel",
  "mathord",
  "mathrm",
  "mathbf",
  "mathit",
  "mathcal",
  "operatorname",
  "text",
  "quad",
  "qquad",
]);

const innerMathEnvironments = [
  "aligned",
  "gathered",
  "split",
  "cases",
  "array",
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
  "smallmatrix",
];

const displayMathEnvironments = new Set([
  "equation",
  "equation*",
  "align",
  "align*",
  "gather",
  "gather*",
  "multline",
  "multline*",
]);

interface AppState {
  activeDocument?: DocumentResult;
  environment?: EnvironmentReport;
  observability?: ObservabilitySnapshot;
  history: DocumentResult[];
  busy: boolean;
  error?: string;
  setActiveDocument: (document: DocumentResult) => void;
  updateActiveDocumentBody: (body: string) => void;
  setEnvironment: (environment: EnvironmentReport) => void;
  setObservability: (observability: ObservabilitySnapshot) => void;
  setHistory: (history: DocumentResult[]) => void;
  setBusy: (busy: boolean) => void;
  setError: (error?: string) => void;
}

export const defaultLatexTemplate = [
  "\\documentclass[UTF8]{ctexart}",
  "\\usepackage{amsmath,amssymb}",
  "\\usepackage{booktabs,longtable,array,graphicx}",
  "\\usepackage[margin=2.5cm]{geometry}",
  "\\title{{title}}",
  "\\date{}",
  "\\begin{document}",
  "\\maketitle",
  "",
  "{body}",
  "",
  "\\end{document}",
  "",
].join("\n");

export function extractLatexBody(source: string): string {
  const match = /\\begin\{document\}([\s\S]*?)\\end\{document\}/.exec(source);
  const body = match ? match[1] : source;
  return body.replace(/^\s*\\maketitle\s*/, "").trim();
}

export function wrapLatexBody(body: string, title = "TeXLens OCR Document"): string {
  const normalizedBody = normalizeLatexSource(extractLatexBody(body)).trim();
  const escapedTitle = escapeTextForLatex(title || "TeXLens OCR Document");
  return [
    "\\documentclass[UTF8]{ctexart}",
    "\\usepackage{amsmath,amssymb}",
    "\\usepackage{booktabs,longtable,array,graphicx}",
    "\\usepackage[margin=2.5cm]{geometry}",
    `\\title{${escapedTitle}}`,
    "\\date{}",
    "\\begin{document}",
    "\\maketitle",
    "",
    normalizedBody,
    "",
    "\\end{document}",
    "",
  ].join("\n");
}

function formulaBlockLatex(value: string): string {
  if (looksLikeStandaloneFormulaLine(value.trim())) return standaloneFormulaToLatex(restoreEscapedLatexFragment(value.trim()));
  if (looksLikeProse(value)) return proseToLatex(value);
  const stripped = normalizeFormulaInput(value);
  if (looksLikeProse(stripped)) return proseToLatex(stripped);
  return normalizedFormulaToLatex(stripped);
}

function standaloneFormulaToLatex(value: string): string {
  return normalizedFormulaToLatex(normalizeFormulaInput(value));
}

function normalizedFormulaToLatex(stripped: string): string {
  const environment = /^\\begin\{([A-Za-z]+\*?)\}([\s\S]*)\\end\{\1\}$/.exec(stripped);
  if (environment) {
    const [, name, inner] = environment;
    if (name === "equation" || name === "equation*") return equationEnvironment(inner);
    if (name === "align" || name === "align*") return equationEnvironment(inner);
    if (name === "aligned" || name === "array" || name === "gathered" || name === "split") {
      return equationEnvironment(stripped);
    }
    return stripped;
  }
  return equationEnvironment(stripped);
}

export function normalizeDocumentForStore(document: DocumentResult): DocumentResult {
  const body = normalizeLatexSource(document.body || extractLatexBody(document.latex || ""));
  return {
    ...document,
    body,
    latex: wrapLatexBody(body, document.title),
  };
}

export function normalizeLatexSource(value: string): string {
  let normalized = flattenNestedEquationEnvironments(normalizeStandaloneFormulaLines(value))
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_match, body: string) => formulaBlockLatex(body))
    .replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, (_match, body: string) => formulaBlockLatex(body))
    .replace(/\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/g, (_match, body: string) =>
      normalizeEquationLikeEnvironment(body),
    )
    .replace(/\\begin\{align\*?\}([\s\S]*?)\\end\{align\*?\}/g, (_match, body: string) =>
      equationEnvironment(body),
    );
  normalized = normalized.replace(/\\begin\{gather\*?\}([\s\S]*?)\\end\{gather\*?\}/g, (_match, body: string) =>
    equationEnvironment(`\\begin{gathered}\n${cleanFormulaBody(body)}\n\\end{gathered}`),
  );
  normalized = repairLatexDelimiters(normalized);
  normalized = balanceLatexEnvironments(normalized);
  normalized = wrapStandaloneMathEnvironments(normalized);
  return balanceLatexEnvironments(normalized);
}

function normalizeFormulaInput(value: string): string {
  const stripped = stripInlineFormulaDelimiters(
    stripDisplayMathDelimiters(value.trim().replace(/\\\\([A-Za-z]+)/g, "\\$1")),
  );
  const environment = /^\\begin\{([A-Za-z]+\*?)\}([\s\S]*)\\end\{\1\}$/.exec(stripped);
  if (environment) {
    const [, name, inner] = environment;
    return `\\begin{${name}}\n${cleanFormulaBody(inner)}\n\\end{${name}}`;
  }
  const lines = stripped
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 1) {
    return moveTagsToEnd(normalizeFormulaLines(lines));
  }
  return moveTagsToEnd(stripped);
}

function normalizeEquationLikeEnvironment(body: string): string {
  body = unwrapEquationBodyContainers(body);
  if (looksLikeProse(body) && !containsStandaloneFormulaLine(body)) return proseToLatex(body);
  const cleaned = cleanFormulaBody(body);
  if (looksLikeProse(cleaned) && !containsStandaloneFormulaLine(cleaned)) return proseToLatex(cleaned);
  return equationEnvironment(body);
}

function unwrapEquationBodyContainers(value: string): string {
  return value.replace(/\\(?:begin|end)\{(?:equation\*?|split|aligned)\}/g, "\n");
}

function normalizeStandaloneFormulaLines(value: string): string {
  const linePattern = /.*(?:\r?\n|$)/g;
  let normalized = "";
  for (const match of value.matchAll(linePattern)) {
    const line = match[0];
    if (!line) continue;
    const content = line.replace(/[\r\n]+$/, "");
    const newline = line.slice(content.length);
    const index = match.index ?? 0;
    if (looksLikeStandaloneFormulaLine(content.trim()) && !isInsideMathContext(value, index)) {
      normalized += standaloneFormulaToLatex(restoreEscapedLatexFragment(content.trim())) + newline;
    } else {
      normalized += line;
    }
  }
  return normalized;
}

function flattenNestedEquationEnvironments(value: string): string {
  const tokenPattern = /\\(begin|end)\{(equation\*?)\}/g;
  let flattened = "";
  let cursor = 0;
  let depth = 0;
  for (const match of value.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    flattened += value.slice(cursor, index);
    const [token, kind] = match;
    if (kind === "begin") {
      if (depth === 0) flattened += token;
      depth += 1;
    } else if (depth <= 1) {
      flattened += token;
      depth = Math.max(0, depth - 1);
    } else {
      depth -= 1;
    }
    cursor = index + token.length;
  }
  return flattened + value.slice(cursor);
}

function stripDisplayMathDelimiters(value: string): string {
  const stripped = value.trim();
  if (stripped.startsWith("\\[") && stripped.endsWith("\\]")) return stripped.slice(2, -2).trim();
  if (stripped.startsWith("$$") && stripped.endsWith("$$")) return stripped.slice(2, -2).trim();
  return stripped;
}

function stripInlineFormulaDelimiters(value: string): string {
  const match = /^\\\(([\s\S]*)\\\)\s*,?\s*(?:\(([^()\n]+)\))?$/.exec(value.trim());
  if (!match) return value.trim();
  const [, body, tag] = match;
  if (!tag || body.includes("\\tag{")) return body.trim();
  return `${body.trim().replace(/[ ,]+$/, "")} \\tag{${tag.trim()}}`;
}

function equationEnvironment(body: string): string {
  const [cleanedContent, tag] = detachFormulaTag(cleanFormulaBody(body));
  let content = cleanedContent;
  if (needsAlignedEnvironment(content)) {
    content = alignedEnvironment(content);
  }
  return ["\\begin{equation}", content, tag, "\\end{equation}"].filter(Boolean).join("\n");
}

function alignedEnvironment(body: string): string {
  return `\\begin{aligned}\n${cleanFormulaBody(body)}\n\\end{aligned}`;
}

function cleanFormulaBody(value: string): string {
  const stripped = normalizeDisplayFormulaBody(value);
  const lines = stripped
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const cleaned = normalizeFormulaLines(lines);
  return wrapLongFormulaLines(moveTagsToEnd(balanceUnescapedBraces(cleaned)) || "{}");
}

function normalizeFormulaLines(lines: string[]): string {
  const content = lines.join("\n");
  if (content.includes("&")) {
    lines = lines.map(stripTrailingFormulaLineBreak);
    return lines.join(content.includes("\\tag{") ? "\n" : " \\\\\n");
  }
  return lines
    .join(" ")
    .replace(/\s*\\\\\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTrailingFormulaLineBreak(value: string): string {
  return value.replace(/\s*\\\\\s*$/, "").trim();
}

function normalizeDisplayFormulaBody(value: string): string {
  let stripped = stripInlineFormulaDelimiters(stripDisplayMathDelimiters(value.trim()));
  stripped = stripInlineMathDelimitersInsideDisplay(stripped);
  return moveTrailingEquationNumberToTag(stripped);
}

function stripInlineMathDelimitersInsideDisplay(value: string): string {
  let stripped = value.trim();
  if (stripped.includes("\\)") && !stripped.includes("\\(")) {
    stripped = stripped.replace(/^\s*\(/, "");
  }
  return stripped.replaceAll("\\(", "").replaceAll("\\)", "");
}

function moveTrailingEquationNumberToTag(value: string): string {
  if (value.includes("\\tag{")) return value;
  return value
    .trim()
    .replace(/\s*[,.;，。]?\s*\((\d+(?:[.-]\d+)*[A-Za-z]?)\)\s*$/, (_match, label: string) => ` \\tag{${label}}`);
}

function moveTagsToEnd(value: string): string {
  const tags = value.match(/\\tag\{[^{}]*\}/g);
  if (!tags?.length) return value;
  const withoutTags = value.replace(/\s*\\tag\{[^{}]*\}\s*/g, " ").trim().replace(/[ \t]+/g, " ");
  return `${withoutTags} ${tags[tags.length - 1]}`.trim();
}

function detachFormulaTag(value: string): [string, string] {
  const tags = value.match(/\\tag\{[^{}]*\}/g);
  if (!tags?.length) return [value.trim(), ""];
  const withoutTags = value
    .replace(/[ \t]*\\tag\{[^{}]*\}[ \t]*/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return [withoutTags, tags[tags.length - 1]];
}

function wrapLongFormulaLines(value: string): string {
  return value;
}

function escapeTextForLatex(value: string): string {
  return Array.from(value)
    .map((char) => textSpecials[char] ?? char)
    .join("");
}

function looksLikeProse(value: string): boolean {
  const stripped = value.trim();
  if (!stripped) return false;
  const environment = /^\\begin\{([A-Za-z]+\*?)\}([\s\S]*)\\end\{\1\}$/.exec(stripped);
  if (environment) return looksLikeProse(unwrapMathTextContainer(stripped));

  let outsideMath = stripped
    .replace(/\\\(([\s\S]*?)\\\)/g, " ")
    .replace(/\$(?!\$)([\s\S]*?)(?<!\\)\$/g, " ")
    .replace(/\\\[([\s\S]*?)\\\]/g, " ")
    .replace(/\$\$([\s\S]*?)\$\$/g, " ");
  outsideMath = outsideMath.replace(/\\[A-Za-z]+\*?(?:\[[^\]]*\])?(?:\{[^{}]*\})?/g, " ");
  const words = Array.from(outsideMath.matchAll(/[A-Za-z]{2,}/g));
  const hasSentencePunctuation = /[,.，。;；:：]/.test(outsideMath);
  return words.length >= 6 && (hasSentencePunctuation || words.length >= 10);
}

function unwrapMathTextContainer(value: string): string {
  let stripped = value.trim();
  while (true) {
    const environment = /^\\begin\{([A-Za-z]+\*?)\}([\s\S]*)\\end\{\1\}$/.exec(stripped);
    if (!environment) return stripped;
    const [, name, inner] = environment;
    if (!displayMathEnvironments.has(name) && !innerMathEnvironments.includes(name)) return stripped;
    stripped = inner.trim();
  }
}

function proseToLatex(value: string): string {
  const stripped = unwrapMathTextContainer(value);
  const chunks: string[] = [];
  const proseLines: string[] = [];

  const flushProse = () => {
    if (!proseLines.some((line) => line.trim())) {
      proseLines.length = 0;
      return;
    }
    chunks.push(proseTextToLatex(proseLines.join("\n")));
    proseLines.length = 0;
  };

  stripped.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (looksLikeStandaloneFormulaLine(line)) {
      flushProse();
      chunks.push(standaloneFormulaToLatex(restoreEscapedLatexFragment(line)));
    } else {
      proseLines.push(rawLine);
    }
  });
  flushProse();

  if (chunks.length > 0) {
    return chunks
      .filter((chunk) => chunk.trim())
      .join("\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return proseTextToLatex(stripped);
}

function proseTextToLatex(value: string): string {
  const inlineMathPattern = /\\\(([\s\S]*?)\\\)|(?<!\$)\$(?!\$)([\s\S]*?)(?<!\\)\$(?!\$)/g;
  let cursor = 0;
  let latex = "";
  for (const match of value.matchAll(inlineMathPattern)) {
    const index = match.index ?? 0;
    latex += escapeProseText(value.slice(cursor, index));
    const body = match[1] ?? match[2] ?? "";
    latex += `\\(${balanceUnescapedBraces(body.trim())}\\)`;
    cursor = index + match[0].length;
  }
  latex += escapeProseText(value.slice(cursor));
  return tidyProseLatex(latex);
}

function containsStandaloneFormulaLine(value: string): boolean {
  return value.split(/\r?\n/).some((line) => looksLikeStandaloneFormulaLine(line.trim()));
}

function looksLikeStandaloneFormulaLine(value: string): boolean {
  const restored = restoreEscapedLatexFragment(value.trim());
  if (!restored) return false;
  if (hasCompleteDisplayMathDelimiters(restored)) return true;
  if (restored.includes("\\(") || restored.includes("\\)")) return false;
  const knownCommands = Array.from(restored.matchAll(/\\([A-Za-z]+)\*?/g))
    .map((match) => match[1])
    .filter((command) => latexCommands.has(command));
  const hasRelation =
    /(?:[=<>]|\\(?:approx|equiv|geq?|leq?|neq|propto|sim|tag|to|rightarrow|leftarrow|Rightarrow|Leftarrow))/.test(
      restored,
    );
  const hasFormulaCommand = knownCommands.some((command) =>
    [
      "binom",
      "beta",
      "frac",
      "int",
      "left",
      "lim",
      "Omega",
      "prod",
      "right",
      "sigma",
      "sqrt",
      "sum",
      "tag",
      "times",
    ].includes(command),
  );
  if (hasRelation && restored.includes("\\tag{") && hasFormulaCommand) return true;
  if (looksLikeProse(restored)) return false;
  return hasRelation && (hasFormulaCommand || knownCommands.length >= 2);
}

function restoreEscapedLatexFragment(value: string): string {
  return value
    .replaceAll("\\textbackslash{}", "\\")
    .replaceAll("\\textasciicircum{}", "^")
    .replaceAll("\\textasciitilde{}", "~")
    .replaceAll("\\_", "_")
    .replaceAll("\\{", "{")
    .replaceAll("\\}", "}");
}

function hasCompleteDisplayMathDelimiters(value: string): boolean {
  const stripped = value.trim();
  return (
    (stripped.startsWith("\\[") && stripped.endsWith("\\]") && stripped.length > 4) ||
    (stripped.startsWith("$$") && stripped.endsWith("$$") && stripped.length > 4)
  );
}

function escapeProseText(value: string): string {
  return escapeTextForLatex(
    value
      .replace(/\\\\(?:\[[^\]]*\])?/g, "\n\n")
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n"),
  );
}

function tidyProseLatex(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function needsAlignedEnvironment(value: string): boolean {
  if (/^\\begin\{([A-Za-z]+\*?)\}[\s\S]*\\end\{\1\}$/.test(value) || containsMathInnerEnvironment(value)) {
    return false;
  }
  return value.includes("&");
}

function containsMathInnerEnvironment(value: string): boolean {
  return innerMathEnvironments.some((environment) =>
    new RegExp(`\\\\begin\\{${escapeRegExp(environment)}\\}`).test(value),
  );
}

function balanceUnescapedBraces(value: string): string {
  const result: string[] = [];
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const escaped = index > 0 && value[index - 1] === "\\";
    if (char === "{" && !escaped) {
      depth += 1;
      result.push(char);
    } else if (char === "}" && !escaped) {
      if (depth > 0) {
        depth -= 1;
        result.push(char);
      }
    } else {
      result.push(char);
    }
  }
  if (depth > 0) result.push("}".repeat(depth));
  return result.join("");
}

function wrapStandaloneMathEnvironments(value: string): string {
  const environmentPattern = innerMathEnvironments.map(escapeRegExp).join("|");
  const pattern = new RegExp(`\\\\begin\\{(${environmentPattern})\\}([\\s\\S]*?)\\\\end\\{\\1\\}`, "g");
  let cursor = 0;
  let wrapped = "";
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    const fragment = match[0];
    wrapped += value.slice(cursor, index);
    if (isInsideMathContext(value, index)) {
      wrapped += fragment;
    } else if (looksLikeProse(fragment)) {
      wrapped += proseToLatex(fragment);
    } else {
      wrapped += equationEnvironment(fragment);
    }
    cursor = index + fragment.length;
  }
  return wrapped + value.slice(cursor);
}

function isInsideMathContext(value: string, position: number): boolean {
  const prefix = value.slice(0, position);
  const tokenPattern = /\\(begin|end)\{([A-Za-z]+\*?)\}|\\\[|\\\]|\\\(|\\\)|\$\$/g;
  let envDepth = 0;
  let displayDepth = 0;
  let inlineDepth = 0;
  let dollarDisplayOpen = false;
  for (const match of prefix.matchAll(tokenPattern)) {
    const token = match[0];
    if (token === "$$") {
      dollarDisplayOpen = !dollarDisplayOpen;
    } else if (token === "\\[") {
      displayDepth += 1;
    } else if (token === "\\]") {
      displayDepth = Math.max(0, displayDepth - 1);
    } else if (token === "\\(") {
      inlineDepth += 1;
    } else if (token === "\\)") {
      inlineDepth = Math.max(0, inlineDepth - 1);
    } else {
      const [, kind, environment] = match;
      if (!displayMathEnvironments.has(environment)) continue;
      if (kind === "begin") envDepth += 1;
      else envDepth = Math.max(0, envDepth - 1);
    }
  }
  return envDepth > 0 || displayDepth > 0 || inlineDepth > 0 || dollarDisplayOpen;
}

function repairLatexDelimiters(value: string): string {
  let repaired = value.replaceAll("\\[", "\\begin{equation}").replaceAll("\\]", "\\end{equation}");
  if ((repaired.match(/\$\$/g)?.length ?? 0) % 2 === 1) {
    repaired = repaired.replace("$$", "");
  }
  return repaired;
}

function balanceLatexEnvironments(value: string): string {
  const tokenPattern = /\\(begin|end)\{([A-Za-z]+\*?)\}/g;
  const stack: string[] = [];
  let cursor = 0;
  let balanced = "";
  for (const match of value.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    const [token, kind, environment] = match;
    balanced += value.slice(cursor, index);
    if (kind === "begin") {
      stack.push(environment);
      balanced += token;
    } else if (stack.includes(environment)) {
      while (stack.length > 0 && stack[stack.length - 1] !== environment) {
        balanced += `\n\\end{${stack.pop()}}`;
      }
      if (stack.length > 0) {
        stack.pop();
        balanced += token;
      }
    }
    cursor = index + token.length;
  }
  balanced += value.slice(cursor);
  while (stack.length > 0) {
    balanced += `\n\\end{${stack.pop()}}`;
  }
  return balanced;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const useAppStore = create<AppState>((set) => ({
  history: [],
  busy: false,
  setActiveDocument: (document) =>
    set({
      activeDocument: normalizeDocumentForStore(document),
      error: undefined,
    }),
  updateActiveDocumentBody: (body) =>
    set((state) => {
      if (!state.activeDocument) return state;
      return {
        activeDocument: {
          ...state.activeDocument,
          body,
          latex: wrapLatexBody(body, state.activeDocument.title),
          updated_at: new Date().toISOString(),
        },
      };
    }),
  setEnvironment: (environment) => set({ environment }),
  setObservability: (observability) => set({ observability }),
  setHistory: (history) => set({ history: history.map(normalizeDocumentForStore) }),
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),
}));
