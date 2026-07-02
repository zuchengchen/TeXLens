from texlens_sidecar.latex import (
    assemble_latex_document,
    block_to_latex,
    conservative_repair,
    normalize_formula_latex,
    normalize_table_latex,
    render_latex_template,
)
from texlens_sidecar.models import BlockType, DocumentResult, OCRBlock, PageResult
from datetime import datetime, timezone


def test_table_markdown_like_text_becomes_tabular():
    latex = normalize_table_latex("a | b\n1 | 2")
    assert "\\begin{tabular}{ll}" in latex
    assert "a & b" in latex


def test_paddle_table_tokens_become_tabular():
    latex = normalize_table_latex("<fcel>A<fcel>B<nl><fcel>1<fcel>2<nl>")
    assert "\\begin{tabular}{ll}" in latex
    assert "A & B" in latex
    assert "1 & 2" in latex


def test_assemble_uses_ctexart_and_formula_block():
    now = datetime.now(timezone.utc)
    document = DocumentResult(
        id="doc",
        title="测试",
        source_type="image",
        created_at=now,
        updated_at=now,
        pages=[
            PageResult(
                page=1,
                blocks=[
                    OCRBlock(id="b1", block_type=BlockType.title, text="标题"),
                    OCRBlock(id="b2", block_type=BlockType.formula, latex="a &= b \\\\ c &= d"),
                ],
            )
        ],
    )
    latex = assemble_latex_document(document)
    assert "\\documentclass[UTF8]{ctexart}" in latex
    assert "\\begin{align*}" in latex


def test_custom_latex_template_replaces_title_and_body():
    rendered = render_latex_template("TITLE={title}\nBODY\n{body}\n", "Doc", "x=y")
    assert rendered == "TITLE=Doc\nBODY\nx=y\n"


def test_formula_block_normalizes_multiline_commands():
    latex = block_to_latex(
        OCRBlock(
            id="b1",
            block_type=BlockType.formula,
            latex="E &= mc^2\n\\int_0^\\\\infty e^{-x^2} dx &= y",
        )
    )
    assert "\\int_0^\\infty" in latex
    assert "mc^2 \\\\\n\\int" in latex


def test_formula_normalization_repairs_spaced_command_names():
    latex = normalize_formula_latex(r"\backslash i n t_{0}^{\backslash i n f t y e} + {\backslash f r a c}")

    assert r"\int_{0}^{\infty e}" in latex
    assert r"{\backslash f r a c}" in latex


def test_formula_normalization_demotes_grouped_required_commands():
    latex = normalize_formula_latex(r"{\frac}{\mathord{\sqrt}}")

    assert r"\backslash{f r a c}" in latex
    assert r"\backslash{s q r t}" in latex
    assert r"{\frac}" not in latex


def test_formula_normalization_unescapes_macro_argument_braces():
    latex = normalize_formula_latex(r"\backslash f r a c\{\backslash s q r t\{\backslash p i\}\}\{2\}")

    assert r"\frac{\sqrt{\pi}}{2}" in latex


def test_repair_adds_missing_document_end():
    result = conservative_repair("\\begin{document}\nhello")
    assert "\\end{document}" in result.repaired
    assert result.requires_confirmation is True
