from texlens_sidecar.latex import (
    extract_latex_body,
    latex_body_from_raw,
    normalize_formula_latex,
    normalize_latex_document,
    normalize_table_latex,
    ocr_item_to_latex,
    render_latex_template,
    wrap_latex_body,
)
from texlens_sidecar.models import DocumentResult
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


def test_raw_items_become_document_body_without_public_pages():
    body = latex_body_from_raw(
        {
            "blocks": [
                {"type": "formula", "latex": "a &= b \\\\ c &= d", "bbox": [0, 0.5, 1, 1]},
                {"type": "title", "text": "标题", "bbox": [0, 0, 1, 0.2]},
            ]
        }
    )
    full_source = wrap_latex_body(body, "测试")

    assert "\\section*{标题}" in body
    assert "\\begin{equation}" in body
    assert "\\begin{aligned}" in body
    assert "\\documentclass[UTF8]{ctexart}" in full_source
    assert "\\title{测试}" in full_source
    assert "\\[" not in full_source


def test_document_result_has_body_but_no_pages_field():
    now = datetime.now(timezone.utc)
    document = DocumentResult(
        id="doc",
        title="sample",
        source_type="image",
        created_at=now,
        updated_at=now,
        body="hello",
        latex=wrap_latex_body("hello", "sample"),
    )

    payload = document.model_dump()
    assert payload["body"] == "hello"
    assert "pages" not in payload


def test_extract_latex_body_removes_document_wrapper_and_maketitle():
    body = extract_latex_body(
        "\\documentclass{article}\n\\begin{document}\n\\maketitle\n\nVisible\n\\end{document}\n"
    )
    assert body == "Visible"


def test_custom_latex_template_replaces_title_and_body():
    rendered = render_latex_template("TITLE={title}\nBODY\n{body}\n", "Doc", "x=y")
    assert rendered == "TITLE=Doc\nBODY\nx=y\n"


def test_formula_item_normalizes_multiline_commands():
    latex = ocr_item_to_latex(
        {
            "type": "formula",
            "latex": "E &= mc^2\n\\int_0^\\\\infty e^{-x^2} dx &= y",
        }
    )
    assert "\\int_0^\\infty" in latex
    assert "mc^2 \\\\\n\\int" in latex
    assert "\\begin{equation}" in latex
    assert "\\begin{aligned}" in latex


def test_formula_item_converts_align_to_equation_aligned():
    latex = ocr_item_to_latex(
        {
            "type": "formula",
            "latex": r"\begin{align*}a &= b \\ c &= d\end{align*}",
        }
    )

    assert "\\begin{equation}" in latex
    assert "\\begin{aligned}" in latex
    assert "\\begin{align*}" not in latex


def test_inline_formula_item_becomes_equation_with_tag():
    latex = ocr_item_to_latex(
        {
            "type": "formula",
            "latex": r"\(\Phi'' + \frac{3}{7}\Phi' + k^2 \Phi_k = S_k,\) (8)",
        }
    )

    assert r"\(" not in latex
    assert r"\)" not in latex
    assert r"\tag{8}" in latex
    assert "\\begin{equation}" in latex


def test_formula_typed_prose_keeps_standalone_display_formula_as_equation():
    source = (
        r"The probability is well fitted by \(\beta \simeq 0.05556\sigma_H^5(M)\). "
        "One can define the fraction of PBHs in the cold dark matter at present as\n\n"
        r"f(M) \equiv \frac{\Omega_{PBH}(M)}{\Omega_{CDM}} \approx 1.5 \times 10^{13} "
        r"\beta \left(\frac{k}{k_{rh}}\right)^{\frac{6w}{1+3w}} "
        r"\left(\frac{T_{rh}}{GeV}\right) "
        r"\left(\frac{g_{*s}(T_{rh})}{106.75}\right)^{-1} "
        r"\left(\frac{g_{*r}(T_{rh})}{106.75}\right) \tag{5}"
        "\n\n"
        r"where \(g_{*r}\) and \(g_{*s}\) are the effective degrees of freedom."
    )

    latex = ocr_item_to_latex({"type": "formula", "latex": source})

    assert "The probability is well fitted" in latex
    assert "\\begin{equation}" in latex
    assert "\\begin{split}" not in latex
    assert "\\begin{aligned}" not in latex
    assert r"\frac{\Omega_{PBH}(M)}{\Omega_{CDM}}" in latex
    assert r"\tag{5}" in latex
    assert r"\textbackslash{}frac" not in latex
    assert r"where \(g_{*r}\)" in latex


def test_escaped_standalone_formula_line_is_restored_before_compile():
    source = (
        r"The fraction is"
        "\n\n"
        r"f(M) \textbackslash{}equiv \textbackslash{}frac\{\textbackslash{}Omega\_\{PBH\}(M)\}"
        r"\{\textbackslash{}Omega\_\{CDM\}\} \textbackslash{}approx 1.5 \textbackslash{}times "
        r"10\textasciicircum{}\{13\} \textbackslash{}beta \textbackslash{}tag\{5\}"
        "\n\n"
        r"where \(g_{*r}\) and \(g_{*s}\) are effective degrees of freedom."
    )

    latex = normalize_latex_document(source)

    assert "\\begin{equation}" in latex
    assert r"\equiv" in latex
    assert r"\frac{\Omega_{PBH}(M)}{\Omega_{CDM}}" in latex
    assert r"10^{13}" in latex
    assert r"\tag{5}" in latex
    assert r"\textbackslash{}" not in latex


def test_existing_equation_wrapped_prose_is_unwrapped_before_compile():
    source = (
        "\\begin{equation}\n"
        r"For a cosmic background fluid with a constant equation of state \(w\), "
        r"the scale factor evolves as \(a \propto \tau^{2/(1+3w)}\), and therefore "
        r"\(V_i \sim \tau^{\frac{3(-1+w)}{1+3w}}\). Thus, the vector mode decays "
        r"with the cosmic expansion for \(w < 1\), but retains constant during a "
        r"post-inflationary stiff or kination phase with"
        "\n\\end{equation}"
    )

    latex = normalize_latex_document(source)

    assert "\\begin{equation}" not in latex
    assert "\\end{equation}" not in latex
    assert r"\(w\)" in latex
    assert "For a cosmic background fluid" in latex


def test_text_items_escape_latex_specials():
    latex = ocr_item_to_latex(
        {
            "type": "paragraph",
            "latex": r"50% of a_b & {x} # $ ^ ~ \path",
        }
    )

    assert r"50\%" in latex
    assert r"a\_b" in latex
    assert r"\&" in latex
    assert r"\{x\}" in latex
    assert r"\#" in latex
    assert r"\$" in latex
    assert r"\textasciicircum{}" in latex
    assert r"\textasciitilde{}" in latex
    assert r"\textbackslash{}path" in latex


def test_normalize_formula_latex_repairs_spaced_backslash_commands():
    latex = normalize_formula_latex(r"\backslash f r a c {1}{2}")
    assert r"\frac" in latex
