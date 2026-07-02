from __future__ import annotations

import re
from typing import Iterable, List

from .config import DEFAULT_LATEX_TEMPLATE
from .models import BlockType, DocumentResult, OCRBlock, RepairSuggestion


SPECIALS = {
    "&": r"\&",
    "%": r"\%",
    "#": r"\#",
}

LATEX_COMMANDS = {
    "alpha",
    "beta",
    "gamma",
    "delta",
    "epsilon",
    "theta",
    "lambda",
    "mu",
    "pi",
    "sigma",
    "phi",
    "omega",
    "frac",
    "sqrt",
    "int",
    "sum",
    "prod",
    "lim",
    "log",
    "ln",
    "sin",
    "cos",
    "tan",
    "infty",
    "partial",
    "nabla",
    "left",
    "right",
    "begin",
    "end",
    "cdot",
    "times",
    "leq",
    "geq",
    "neq",
    "approx",
    "mathrel",
    "mathord",
    "mathrm",
    "mathbf",
    "text",
}


def escape_text(value: str) -> str:
    protected = value.replace("\\(", "\uE000").replace("\\)", "\uE001")
    protected = protected.replace("\\[", "\uE002").replace("\\]", "\uE003")
    for raw, escaped in SPECIALS.items():
        protected = protected.replace(raw, escaped)
    return (
        protected.replace("\uE000", "\\(")
        .replace("\uE001", "\\)")
        .replace("\uE002", "\\[")
        .replace("\uE003", "\\]")
    )


def normalize_table_latex(value: str) -> str:
    value = value.strip()
    if "\\begin{tabular}" in value or "\\begin{longtable}" in value:
        return value
    if re.search(r"<(?:fcel|ecel|ucel|lcel|xcel)>|<nl>", value):
        rows = paddle_table_rows(value)
        if rows:
            return tabular_from_rows(rows)
    lines = [line.strip() for line in value.splitlines() if line.strip()]
    if not lines:
        return "\\begin{tabular}{l}\n\\end{tabular}"
    rows = []
    max_cols = 1
    for line in lines:
        if "|" in line:
            parts = [part.strip() for part in line.strip("|").split("|")]
        elif "\t" in line:
            parts = [part.strip() for part in line.split("\t")]
        else:
            parts = [line]
        max_cols = max(max_cols, len(parts))
        rows.append(parts)
    return tabular_from_rows(rows)


def paddle_table_rows(value: str) -> List[List[str]]:
    rows: List[List[str]] = []
    for raw_line in re.split(r"<nl>", value):
        line = raw_line.strip()
        if not line:
            continue
        cells = re.split(r"<(?:fcel|ecel|ucel|lcel|xcel)>", line)
        cleaned = [re.sub(r"<[^>]+>", "", cell).strip() for cell in cells[1:]]
        if cleaned:
            rows.append(cleaned)
    return rows


def tabular_from_rows(rows: List[List[str]]) -> str:
    max_cols = max((len(row) for row in rows), default=1)
    spec = "l" * max_cols
    body = []
    for row in rows:
        padded = row + [""] * (max_cols - len(row))
        body.append(" & ".join(escape_text(cell) for cell in padded) + r" \\")
    return "\\begin{tabular}{" + spec + "}\n" + "\n".join(body) + "\n\\end{tabular}"


def normalize_formula_latex(value: str) -> str:
    stripped = re.sub(r"\\\\([A-Za-z]+)", r"\\\1", value.strip())
    stripped = repair_spaced_latex_commands(stripped)
    stripped = demote_grouped_required_commands(stripped)
    stripped = stripped.replace(r"\{", "{").replace(r"\}", "}").replace(r"\_", "_")
    if "\\begin{" in stripped or stripped.startswith("$$") or stripped.startswith("\\["):
        return stripped
    lines = [line.strip() for line in stripped.splitlines() if line.strip()]
    if len(lines) > 1:
        stripped = " \\\\\n".join(lines)
    return stripped


def repair_spaced_latex_commands(value: str) -> str:
    commands_with_required_groups = {"frac", "sqrt", "begin", "end", "mathrm", "mathbf", "text"}

    def compact_command(raw: str) -> str | None:
        command = re.sub(r"\s+", "", raw)
        if command in LATEX_COMMANDS:
            return "\\" + command
        for length in range(len(command) - 1, 1, -1):
            prefix = command[:length]
            if prefix in LATEX_COMMANDS:
                suffix = command[length:]
                return "\\" + prefix + (" " + suffix if suffix else "")
        return None

    def replace_backslash_command(match: re.Match[str]) -> str:
        replacement = compact_command(match.group(1))
        if not replacement:
            return match.group(0)
        command = replacement[1:].split(" ", 1)[0]
        before = value[match.start() - 1] if match.start() > 0 else ""
        after = value[match.end() :].lstrip()
        if command in commands_with_required_groups and before == "{" and after.startswith("}"):
            return match.group(0)
        return replacement

    repaired = re.sub(r"\\backslash\s+((?:[A-Za-z]\s*){2,})", replace_backslash_command, value)

    def replace_slash_command(match: re.Match[str]) -> str:
        return compact_command(match.group(1)) or match.group(0)

    return re.sub(r"\\\s+((?:[A-Za-z]\s*){2,})", replace_slash_command, repaired)


def demote_grouped_required_commands(value: str) -> str:
    def demote(match: re.Match[str]) -> str:
        return r"\backslash{" + " ".join(match.group(1)) + "}"

    return re.sub(r"\{\\(frac|sqrt|begin|end|mathrm|mathbf|text)\}", demote, value)


def block_to_latex(block: OCRBlock) -> str:
    source = block.latex or block.text
    if block.block_type == BlockType.title:
        return f"\\section*{{{escape_text(source.strip())}}}"
    if block.block_type == BlockType.formula:
        stripped = normalize_formula_latex(source)
        if "\\begin{" in stripped or stripped.startswith("$$") or stripped.startswith("\\["):
            return stripped
        if "\n" in stripped or "&" in stripped:
            return "\\begin{align*}\n" + stripped + "\n\\end{align*}"
        return "\\[\n" + stripped + "\n\\]"
    if block.block_type == BlockType.table:
        return normalize_table_latex(source)
    if block.block_type == BlockType.image:
        return "% Image placeholder: " + (block.crop_path or block.text or block.id)
    return escape_text(source.strip())


def assemble_latex_document(document: DocumentResult, template: str = DEFAULT_LATEX_TEMPLATE) -> str:
    body: List[str] = []
    for page in sorted(document.pages, key=lambda item: item.page):
        if len(document.pages) > 1:
            body.append(f"% Page {page.page}")
        ordered = sorted(page.blocks, key=lambda item: (item.bbox[1], item.bbox[0]))
        body.extend(block_to_latex(block) for block in ordered)

    title = escape_text(document.title or "TeXLens OCR Document")
    content = "\n\n".join(part for part in body if part.strip())
    return render_latex_template(template, title, content)


def render_latex_template(template: str, title: str, body: str) -> str:
    source = template if "{body}" in template else DEFAULT_LATEX_TEMPLATE
    rendered = source.replace("{title}", title).replace("{body}", body)
    if not rendered.endswith("\n"):
        rendered += "\n"
    return rendered


def conservative_repair(latex: str, compiler_log: str = "") -> RepairSuggestion:
    repaired = latex
    changes: List[str] = []

    begin_doc = repaired.count("\\begin{document}")
    end_doc = repaired.count("\\end{document}")
    if begin_doc > end_doc:
        repaired += "\n\\end{document}\n"
        changes.append("Added a missing \\end{document}.")

    def balance_environment(text: str, environment: str) -> str:
        nonlocal changes
        begin = text.count(f"\\begin{{{environment}}}")
        end = text.count(f"\\end{{{environment}}}")
        if begin > end:
            changes.append(f"Added missing \\end{{{environment}}}.")
            return text + ("\n" + f"\\end{{{environment}}}") * (begin - end)
        return text

    for env in ["align", "align*", "tabular", "longtable", "equation", "equation*"]:
        repaired = balance_environment(repaired, env)

    if "Misplaced alignment tab character &" in compiler_log:
        lines = []
        for line in repaired.splitlines():
            if "&" in line and not re.search(r"\\begin\{(tabular|longtable|align\*?|array)\}", line):
                lines.append(line.replace("&", r"\&"))
                changes.append("Escaped a text ampersand outside table/formula environments.")
            else:
                lines.append(line)
        repaired = "\n".join(lines)

    if repaired == latex:
        changes.append("No conservative automatic repair was available.")

    return RepairSuggestion(original=latex, repaired=repaired, changes=changes)


def flatten_blocks(document: DocumentResult) -> Iterable[OCRBlock]:
    for page in document.pages:
        yield from page.blocks
