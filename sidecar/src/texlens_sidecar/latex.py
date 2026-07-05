from __future__ import annotations

import re
from typing import Any, Dict, List

from .config import DEFAULT_LATEX_TEMPLATE
from .models import DocumentResult


TEXT_SPECIALS = {
    "\\": r"\textbackslash{}",
    "&": r"\&",
    "%": r"\%",
    "#": r"\#",
    "_": r"\_",
    "$": r"\$",
    "{": r"\{",
    "}": r"\}",
    "^": r"\textasciicircum{}",
    "~": r"\textasciitilde{}",
}

LATEX_COMMANDS = {
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
}

INNER_MATH_ENVIRONMENTS = {
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
}

DISPLAY_MATH_ENVIRONMENTS = {
    "equation",
    "equation*",
    "align",
    "align*",
    "gather",
    "gather*",
    "multline",
    "multline*",
}

AUTO_WRAP_FORMULA_LINE_LENGTH = 140
AUTO_WRAP_FORMULA_LOOKAHEAD = 24
AUTO_WRAP_FORMULA_MIN_SEGMENT = 28

RELATION_BREAK_COMMANDS = {
    r"\approx",
    r"\equiv",
    r"\ge",
    r"\geq",
    r"\le",
    r"\leq",
    r"\leftarrow",
    r"\Leftarrow",
    r"\leftrightarrow",
    r"\mapsto",
    r"\neq",
    r"\propto",
    r"\rightarrow",
    r"\Rightarrow",
    r"\sim",
    r"\to",
}

FACTOR_BREAK_COMMANDS = {
    r"\beta",
    r"\frac",
    r"\left",
    r"\sqrt",
}


def escape_text(value: str) -> str:
    return "".join(TEXT_SPECIALS.get(char, char) for char in value)


def text_or_latex_fragment(value: str) -> str:
    stripped = value.strip()
    if contains_standalone_formula_line(stripped):
        return prose_to_latex(stripped)
    if looks_like_latex_fragment(stripped):
        return stripped
    return escape_text(stripped)


def looks_like_latex_fragment(value: str) -> bool:
    if not value:
        return False
    if has_display_math_delimiters(value) or "\\(" in value or "\\)" in value:
        return True
    if re.search(r"\\(?:begin|end)\{", value):
        return True
    commands = re.findall(r"\\([A-Za-z]+)\*?", value)
    return any(command in LATEX_COMMANDS for command in commands)


def looks_like_prose(value: str) -> bool:
    stripped = value.strip()
    if not stripped:
        return False
    if top_level_environment(stripped):
        return looks_like_prose(unwrap_math_text_container(stripped))

    outside_math = re.sub(r"\\\((.*?)\\\)", " ", stripped, flags=re.S)
    outside_math = re.sub(r"\$(?!\$)(.*?)(?<!\\)\$", " ", outside_math, flags=re.S)
    outside_math = re.sub(r"\\\[(.*?)\\\]", " ", outside_math, flags=re.S)
    outside_math = re.sub(r"\$\$(.*?)\$\$", " ", outside_math, flags=re.S)
    outside_math = re.sub(r"\\[A-Za-z]+\*?(?:\[[^\]]*\])?(?:\{[^{}]*\})?", " ", outside_math)
    words = re.findall(r"[A-Za-z]{2,}", outside_math)
    has_sentence_punctuation = bool(re.search(r"[,.，。;；:：]", outside_math))
    return len(words) >= 6 and (has_sentence_punctuation or len(words) >= 10)


def unwrap_math_text_container(value: str) -> str:
    stripped = value.strip()
    while True:
        environment = top_level_environment(stripped)
        if not environment:
            return stripped
        name, inner = environment
        if name not in DISPLAY_MATH_ENVIRONMENTS and name not in INNER_MATH_ENVIRONMENTS:
            return stripped
        stripped = inner.strip()


def prose_to_latex(value: str) -> str:
    stripped = unwrap_math_text_container(value)
    chunks: List[str] = []
    prose_lines: List[str] = []

    def flush_prose() -> None:
        if not any(line.strip() for line in prose_lines):
            prose_lines.clear()
            return
        chunks.append(prose_text_to_latex("\n".join(prose_lines)))
        prose_lines.clear()

    for raw_line in stripped.splitlines():
        line = raw_line.strip()
        if looks_like_standalone_formula_line(line):
            flush_prose()
            chunks.append(standalone_formula_to_latex(restore_escaped_latex_fragment(line)))
        else:
            prose_lines.append(raw_line)

    flush_prose()
    if chunks:
        return re.sub(r"\n{3,}", "\n\n", "\n\n".join(chunk for chunk in chunks if chunk.strip())).strip()
    return prose_text_to_latex(stripped)


def prose_text_to_latex(value: str) -> str:
    pieces = []
    cursor = 0
    inline_math_pattern = re.compile(r"\\\((.*?)\\\)|(?<!\$)\$(?!\$)(.*?)(?<!\\)\$(?!\$)", re.S)
    for match in inline_math_pattern.finditer(value):
        pieces.append(escape_prose_text(value[cursor : match.start()]))
        body = match.group(1) if match.group(1) is not None else match.group(2)
        pieces.append(r"\(" + balance_unescaped_braces((body or "").strip()) + r"\)")
        cursor = match.end()
    pieces.append(escape_prose_text(value[cursor:]))
    return tidy_prose_latex("".join(pieces))


def contains_standalone_formula_line(value: str) -> bool:
    return any(looks_like_standalone_formula_line(line.strip()) for line in value.splitlines())


def looks_like_standalone_formula_line(value: str) -> bool:
    restored = restore_escaped_latex_fragment(value.strip())
    if not restored:
        return False
    if has_complete_display_math_delimiters(restored):
        return True
    if r"\(" in restored or r"\)" in restored:
        return False
    commands = re.findall(r"\\([A-Za-z]+)\*?", restored)
    known_commands = [command for command in commands if command in LATEX_COMMANDS]
    has_relation = bool(
        re.search(
            r"(?:[=<>]|\\(?:approx|equiv|geq?|leq?|neq|propto|sim|tag|to|rightarrow|leftarrow|Rightarrow|Leftarrow))",
            restored,
        )
    )
    has_formula_command = any(
        command
        in {
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
        }
        for command in known_commands
    )
    if has_relation and r"\tag{" in restored and has_formula_command:
        return True
    if looks_like_prose(restored):
        return False
    return has_relation and (has_formula_command or len(known_commands) >= 2)


def restore_escaped_latex_fragment(value: str) -> str:
    restored = value
    replacements = [
        (r"\textbackslash{}", "\\"),
        (r"\textasciicircum{}", "^"),
        (r"\textasciitilde{}", "~"),
        (r"\_", "_"),
        (r"\{", "{"),
        (r"\}", "}"),
    ]
    for source, target in replacements:
        restored = restored.replace(source, target)
    return restored


def has_complete_display_math_delimiters(value: str) -> bool:
    stripped = value.strip()
    return (stripped.startswith(r"\[") and stripped.endswith(r"\]") and len(stripped) > 4) or (
        stripped.startswith("$$") and stripped.endswith("$$") and len(stripped) > 4
    )


def escape_prose_text(value: str) -> str:
    value = re.sub(r"\\\\(?:\[[^\]]*\])?", "\n\n", value)
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"[ \t]*\n[ \t]*", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return escape_text(value)


def tidy_prose_latex(value: str) -> str:
    value = re.sub(r"[ \t]+\n", "\n", value)
    value = re.sub(r"\n[ \t]+", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    value = re.sub(r"[ \t]{2,}", " ", value)
    return value.strip()


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
    stripped = strip_display_math_delimiters(stripped)
    stripped = strip_inline_formula_delimiters(stripped)
    if "\\begin{" in stripped:
        environment = top_level_environment(stripped)
        if not environment:
            return stripped
        name, inner = environment
        return "\\begin{" + name + "}\n" + clean_formula_body(inner) + "\n\\end{" + name + "}"
    lines = [line.strip() for line in stripped.splitlines() if line.strip()]
    if len(lines) > 1:
        stripped = normalize_formula_lines(lines)
    return move_tags_to_end(stripped)


def strip_display_math_delimiters(value: str) -> str:
    stripped = value.strip()
    if stripped.startswith("\\[") and stripped.endswith("\\]"):
        return stripped[2:-2].strip()
    if stripped.startswith("$$") and stripped.endswith("$$"):
        return stripped[2:-2].strip()
    return stripped


def strip_inline_formula_delimiters(value: str) -> str:
    match = re.fullmatch(r"\\\((.*)\\\)\s*,?\s*(?:\(([^()\n]+)\))?", value.strip(), re.S)
    if not match:
        return value.strip()
    body = match.group(1).strip()
    tag = match.group(2)
    if tag and "\\tag{" not in body:
        body = body.rstrip(" ,") + f" \\tag{{{tag.strip()}}}"
    return body


def should_insert_formula_line_breaks(lines: List[str]) -> bool:
    content = "\n".join(lines)
    return "\\tag{" not in content


def normalize_formula_lines(lines: List[str]) -> str:
    content = "\n".join(lines)
    if "&" in content:
        lines = [strip_trailing_formula_line_break(line) for line in lines]
        joiner = " \\\\\n" if should_insert_formula_line_breaks(lines) else "\n"
        return joiner.join(lines)
    flattened = re.sub(r"\s*\\\\\s*", " ", " ".join(lines))
    flattened = re.sub(r"\s+", " ", flattened).strip()
    return flattened


def strip_trailing_formula_line_break(value: str) -> str:
    return re.sub(r"\s*\\\\\s*$", "", value).strip()


def clean_formula_body(value: str) -> str:
    stripped = normalize_display_formula_body(value)
    lines = [line.strip() for line in stripped.splitlines() if line.strip()]
    cleaned = move_tags_to_end(balance_unescaped_braces(normalize_formula_lines(lines))) or "{}"
    return wrap_long_formula_lines(cleaned)


def wrap_long_formula_lines(value: str, limit: int = AUTO_WRAP_FORMULA_LINE_LENGTH) -> str:
    return value


def wrap_long_formula_line(line: str, limit: int) -> List[str]:
    body, tag = split_trailing_formula_tag(line.strip())
    parts: List[str] = []
    remaining = body
    while len(remaining) > limit:
        break_at = choose_formula_break_position(remaining, limit)
        if break_at is None:
            break
        head = remaining[:break_at].rstrip()
        tail = remaining[break_at:].lstrip()
        if not head or not tail:
            break
        parts.append(head)
        remaining = formula_continuation_line(tail)
    if tag:
        remaining = (remaining.rstrip() + " " + tag).strip()
    parts.append(remaining)
    return parts


def split_trailing_formula_tag(value: str) -> tuple[str, str]:
    match = re.search(r"\s*(\\tag\{[^{}]*\})\s*$", value)
    if not match:
        return value, ""
    return value[: match.start()].rstrip(), match.group(1)


def choose_formula_break_position(value: str, limit: int) -> int | None:
    candidates = formula_break_candidates(value)
    lower_bound = min(AUTO_WRAP_FORMULA_MIN_SEGMENT, max(1, limit // 3))
    before_limit = [position for position in candidates if lower_bound <= position <= limit]
    if before_limit:
        return before_limit[-1]
    after_limit = [
        position
        for position in candidates
        if limit < position <= limit + AUTO_WRAP_FORMULA_LOOKAHEAD
    ]
    if after_limit:
        return after_limit[0]
    return None


def formula_break_candidates(value: str) -> List[int]:
    candidates: List[int] = []
    depth = 0
    delimiter_depth = 0
    index = 0
    while index < len(value):
        char = value[index]
        escaped = index > 0 and value[index - 1] == "\\"
        if char == "\\":
            command = re.match(r"\\[A-Za-z]+", value[index:])
            command_name = command.group(0) if command else ""
            if command_name == r"\left":
                if depth == 0 and delimiter_depth == 0 and index > 0:
                    candidates.append(index)
                delimiter_depth += 1
                index += len(command_name)
                continue
            if command_name == r"\right":
                delimiter_depth = max(0, delimiter_depth - 1)
                index += len(command_name)
                continue
            if depth == 0 and delimiter_depth == 0 and command_name in RELATION_BREAK_COMMANDS:
                end = index + len(command_name)
                candidates.append(end)
                index = end
                continue
            if depth == 0 and delimiter_depth == 0 and command_name in FACTOR_BREAK_COMMANDS and index > 0:
                candidates.append(index)
        if char == "{" and not escaped:
            depth += 1
        elif char == "}" and not escaped:
            depth = max(0, depth - 1)
        elif depth == 0 and delimiter_depth == 0:
            if char in "+-" and not is_unary_formula_operator(value, index):
                candidates.append(index)
            elif char in "=<>,":
                candidates.append(index + 1)
        index += 1
    return sorted(set(candidates))


def is_unary_formula_operator(value: str, index: int) -> bool:
    previous = value[:index].rstrip()
    if not previous:
        return True
    return previous[-1] in "([{=<>+-*/^_,"


def formula_continuation_line(value: str) -> str:
    stripped = value.lstrip()
    if not stripped:
        return stripped
    if stripped[0] in "+-=<>,":
        return "{} " + stripped
    command = re.match(r"\\[A-Za-z]+", stripped)
    if command and command.group(0) in RELATION_BREAK_COMMANDS:
        return "{} " + stripped
    return stripped


def normalize_display_formula_body(value: str) -> str:
    stripped = strip_inline_formula_delimiters(strip_display_math_delimiters(value.strip()))
    stripped = strip_inline_math_delimiters_inside_display(stripped)
    return move_trailing_equation_number_to_tag(stripped)


def strip_inline_math_delimiters_inside_display(value: str) -> str:
    stripped = value.strip()
    if r"\)" in stripped and r"\(" not in stripped:
        stripped = re.sub(r"^\s*\(", "", stripped, count=1)
    return stripped.replace(r"\(", "").replace(r"\)", "")


def move_trailing_equation_number_to_tag(value: str) -> str:
    if "\\tag{" in value:
        return value
    return re.sub(r"\s*[,.;，。]?\s*\((\d+(?:[.\-]\d+)*[A-Za-z]?)\)\s*$", r" \\tag{\1}", value.strip())


def move_tags_to_end(value: str) -> str:
    tags = re.findall(r"\\tag\{[^{}]*\}", value)
    if not tags:
        return value
    without_tags = re.sub(r"\s*\\tag\{[^{}]*\}\s*", " ", value).strip()
    without_tags = re.sub(r"[ \t]+", " ", without_tags)
    return (without_tags + " " + tags[-1]).strip()


def detach_formula_tag(value: str) -> tuple[str, str]:
    tags = re.findall(r"\\tag\{[^{}]*\}", value)
    if not tags:
        return value.strip(), ""
    without_tags = re.sub(r"[ \t]*\\tag\{[^{}]*\}[ \t]*", " ", value)
    without_tags = re.sub(r"[ \t]+\n", "\n", without_tags)
    without_tags = re.sub(r"\n[ \t]+", "\n", without_tags)
    without_tags = re.sub(r"\n{3,}", "\n\n", without_tags)
    return without_tags.strip(), tags[-1]


def equation_environment(body: str) -> str:
    content, tag = detach_formula_tag(clean_formula_body(body))
    if needs_aligned_environment(content):
        content = aligned_environment(content)
    pieces = ["\\begin{equation}", content]
    if tag:
        pieces.append(tag)
    pieces.append("\\end{equation}")
    return "\n".join(pieces)


def aligned_environment(body: str) -> str:
    content = clean_formula_body(body)
    return "\\begin{aligned}\n" + content + "\n\\end{aligned}"


def needs_aligned_environment(value: str) -> bool:
    if top_level_environment(value) or contains_math_inner_environment(value):
        return False
    return "&" in value


def contains_math_inner_environment(value: str) -> bool:
    return any(
        re.search(rf"\\begin\{{{re.escape(environment)}\}}", value)
        for environment in INNER_MATH_ENVIRONMENTS
    )


def balance_unescaped_braces(value: str) -> str:
    result = []
    depth = 0
    index = 0
    while index < len(value):
        char = value[index]
        escaped = index > 0 and value[index - 1] == "\\"
        if char == "{" and not escaped:
            depth += 1
            result.append(char)
        elif char == "}" and not escaped:
            if depth > 0:
                depth -= 1
                result.append(char)
        else:
            result.append(char)
        index += 1
    if depth > 0:
        result.append("}" * depth)
    return "".join(result)


def top_level_environment(value: str) -> tuple[str, str] | None:
    match = re.fullmatch(r"\\begin\{([A-Za-z]+\*?)\}(.*)\\end\{\1\}", value.strip(), re.S)
    if not match:
        return None
    return match.group(1), match.group(2).strip()


def formula_to_latex(value: str) -> str:
    if looks_like_standalone_formula_line(value.strip()):
        return standalone_formula_to_latex(restore_escaped_latex_fragment(value.strip()))
    if looks_like_prose(value):
        return prose_to_latex(value)
    return standalone_formula_to_latex(value)


def standalone_formula_to_latex(value: str) -> str:
    stripped = normalize_formula_latex(value)
    environment = top_level_environment(stripped)
    if environment:
        name, inner = environment
        if name in {"equation", "equation*"}:
            return equation_environment(inner)
        if name in {"align", "align*"}:
            return equation_environment(inner)
        if name in {"aligned", "array", "gathered", "split"}:
            return equation_environment(stripped)
        return stripped
    return equation_environment(stripped)


def normalize_equation_like_environment(body: str) -> str:
    body = unwrap_equation_body_containers(body)
    if looks_like_prose(body) and not contains_standalone_formula_line(body):
        return prose_to_latex(body)
    cleaned = clean_formula_body(body)
    if looks_like_prose(cleaned) and not contains_standalone_formula_line(cleaned):
        return prose_to_latex(cleaned)
    return equation_environment(body)


def unwrap_equation_body_containers(value: str) -> str:
    return re.sub(r"\\(?:begin|end)\{(?:equation\*?|split|aligned)\}", "\n", value)


def normalize_standalone_formula_lines(value: str) -> str:
    chunks: List[str] = []
    offset = 0
    for line in value.splitlines(keepends=True):
        content = line.rstrip("\r\n")
        newline = line[len(content) :]
        if looks_like_standalone_formula_line(content.strip()) and not is_inside_math_context(value, offset):
            chunks.append(standalone_formula_to_latex(restore_escaped_latex_fragment(content.strip())) + newline)
        else:
            chunks.append(line)
        offset += len(line)
    return "".join(chunks)


def flatten_nested_equation_environments(value: str) -> str:
    token_pattern = re.compile(r"\\(begin|end)\{(equation\*?)\}")
    chunks: List[str] = []
    cursor = 0
    depth = 0
    for match in token_pattern.finditer(value):
        chunks.append(value[cursor : match.start()])
        kind = match.group(1)
        if kind == "begin":
            if depth == 0:
                chunks.append(match.group(0))
            depth += 1
        elif depth <= 1:
            chunks.append(match.group(0))
            depth = max(0, depth - 1)
        else:
            depth -= 1
        cursor = match.end()
    chunks.append(value[cursor:])
    return "".join(chunks)


def normalize_latex_document(value: str) -> str:
    normalized = flatten_nested_equation_environments(normalize_standalone_formula_lines(value))
    normalized = re.sub(
        r"\\\[\s*(.*?)\s*\\\]",
        lambda match: formula_to_latex(match.group(1)),
        normalized,
        flags=re.S,
    )
    normalized = re.sub(
        r"\$\$\s*(.*?)\s*\$\$",
        lambda match: formula_to_latex(match.group(1)),
        normalized,
        flags=re.S,
    )
    normalized = re.sub(
        r"\\begin\{equation\*?\}(.*?)\\end\{equation\*?\}",
        lambda match: normalize_equation_like_environment(match.group(1)),
        normalized,
        flags=re.S,
    )
    normalized = re.sub(
        r"\\begin\{align\*?\}(.*?)\\end\{align\*?\}",
        lambda match: equation_environment(match.group(1)),
        normalized,
        flags=re.S,
    )
    normalized = re.sub(
        r"\\begin\{gather\*?\}(.*?)\\end\{gather\*?\}",
        lambda match: equation_environment("\\begin{gathered}\n" + clean_formula_body(match.group(1)) + "\n\\end{gathered}"),
        normalized,
        flags=re.S,
    )
    normalized = repair_latex_delimiters(normalized)
    normalized = balance_latex_environments(normalized)
    normalized = wrap_standalone_math_environments(normalized)
    return balance_latex_environments(normalized)


def wrap_standalone_math_environments(value: str) -> str:
    environment_pattern = "|".join(re.escape(environment) for environment in sorted(INNER_MATH_ENVIRONMENTS))
    pattern = re.compile(rf"\\begin\{{({environment_pattern})\}}(.*?)\\end\{{\1\}}", re.S)
    chunks = []
    cursor = 0
    for match in pattern.finditer(value):
        chunks.append(value[cursor : match.start()])
        fragment = match.group(0)
        if is_inside_math_context(value, match.start()):
            chunks.append(fragment)
        elif looks_like_prose(fragment):
            chunks.append(prose_to_latex(fragment))
        else:
            chunks.append(equation_environment(fragment))
        cursor = match.end()
    chunks.append(value[cursor:])
    return "".join(chunks)


def is_inside_math_context(value: str, position: int) -> bool:
    prefix = value[:position]
    env_depth = 0
    display_depth = 0
    inline_depth = 0
    dollar_display_open = False
    token_pattern = re.compile(r"\\(begin|end)\{([A-Za-z]+\*?)\}|\\\[|\\\]|\\\(|\\\)|\$\$")
    for match in token_pattern.finditer(prefix):
        token = match.group(0)
        if token == "$$":
            dollar_display_open = not dollar_display_open
        elif token == r"\[":
            display_depth += 1
        elif token == r"\]":
            display_depth = max(0, display_depth - 1)
        elif token == r"\(":
            inline_depth += 1
        elif token == r"\)":
            inline_depth = max(0, inline_depth - 1)
        else:
            kind, environment = match.group(1), match.group(2)
            if environment not in DISPLAY_MATH_ENVIRONMENTS:
                continue
            if kind == "begin":
                env_depth += 1
            else:
                env_depth = max(0, env_depth - 1)
    return env_depth > 0 or display_depth > 0 or inline_depth > 0 or dollar_display_open


def repair_latex_delimiters(value: str) -> str:
    value = value.replace(r"\[", "\\begin{equation}")
    value = value.replace(r"\]", "\\end{equation}")
    if value.count("$$") % 2 == 1:
        value = value.replace("$$", "", 1)
    return value


def balance_latex_environments(value: str) -> str:
    token_pattern = re.compile(r"\\(begin|end)\{([A-Za-z]+\*?)\}")
    chunks = []
    stack: List[str] = []
    cursor = 0
    for match in token_pattern.finditer(value):
        chunks.append(value[cursor : match.start()])
        kind, environment = match.group(1), match.group(2)
        if kind == "begin":
            stack.append(environment)
            chunks.append(match.group(0))
        elif environment in stack:
            while stack and stack[-1] != environment:
                chunks.append(f"\n\\end{{{stack.pop()}}}")
            if stack:
                stack.pop()
                chunks.append(match.group(0))
        cursor = match.end()
    chunks.append(value[cursor:])
    for environment in reversed(stack):
        chunks.append(f"\n\\end{{{environment}}}")
    return "".join(chunks)


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


def ocr_item_to_latex(item: Dict[str, Any]) -> str:
    source = str(item.get("latex") or item.get("text") or item.get("content") or "")
    item_type = str(item.get("type") or item.get("block_type") or "").lower()
    if item_type == "title":
        return f"\\section*{{{escape_text(source.strip())}}}"
    if item_type == "formula":
        if has_display_math_delimiters(source):
            return source
        return formula_to_latex(source)
    if item_type == "table":
        return normalize_table_latex(source)
    if item_type == "image":
        return "% Image placeholder"
    return text_or_latex_fragment(source)


def latex_body_from_raw(raw: Dict[str, Any], page_number: int | None = None) -> str:
    direct = raw.get("body") or raw.get("latex_body")
    if direct:
        return normalize_latex_document(extract_latex_body(str(direct))).strip()

    latex_document = raw.get("latex_document")
    if latex_document:
        return normalize_latex_document(extract_latex_body(str(latex_document))).strip()

    raw_items = raw.get("blocks")
    if isinstance(raw_items, list):
        items = [item for item in raw_items if isinstance(item, dict)]
        items.sort(key=lambda item: tuple(_bbox(item.get("bbox"))[:2]))
        content = "\n\n".join(ocr_item_to_latex(item) for item in items if ocr_item_to_latex(item).strip())
        return normalize_latex_document(content).strip()

    raw_text = str(raw.get("raw_text") or raw.get("text") or "")
    body = text_or_latex_fragment(raw_text)
    if page_number is not None and raw_text.strip():
        body = f"% Page {page_number}\n{body}"
    return normalize_latex_document(body).strip()


def assemble_latex_document(document: DocumentResult) -> str:
    return wrap_latex_body(document.body, document.title)


def has_display_math_delimiters(value: str) -> bool:
    return "\\[" in value or "\\]" in value or "$$" in value


def extract_latex_body(source: str) -> str:
    match = re.search(r"\\begin\{document\}(.*?)\\end\{document\}", source, flags=re.S)
    body = match.group(1) if match else source
    body = re.sub(r"^\s*\\maketitle\s*", "", body)
    return body.strip()


def wrap_latex_body(body: str, title: str = "TeXLens OCR Document") -> str:
    return render_latex_template(DEFAULT_LATEX_TEMPLATE, escape_text(title or "TeXLens OCR Document"), normalize_latex_document(body).strip())


def render_latex_template(template: str, title: str, body: str) -> str:
    source = template if "{body}" in template else DEFAULT_LATEX_TEMPLATE
    rendered = source.replace("{title}", title).replace("{body}", body)
    if not rendered.endswith("\n"):
        rendered += "\n"
    return rendered


def _bbox(value: object) -> List[float]:
    if isinstance(value, list) and len(value) == 4:
        try:
            coords = [float(item) for item in value]
            if max(coords) > 1.0:
                max_coord = max(coords) or 1.0
                coords = [item / max_coord for item in coords]
            return [min(1.0, max(0.0, item)) for item in coords]
        except Exception:
            pass
    return [0.0, 0.0, 1.0, 1.0]
