from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


OUT = Path(__file__).parent / "generated"


def font(size: int) -> ImageFont.ImageFont:
    for name in [
        "/usr/share/fonts/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/TTF/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]:
        path = Path(name)
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def save_formula() -> None:
    image = Image.new("RGB", (900, 260), "white")
    draw = ImageDraw.Draw(image)
    draw.text((48, 42), "Complex derivation", fill=(28, 33, 30), font=font(34))
    draw.text((70, 110), "E &= mc^2", fill=(0, 0, 0), font=font(32))
    draw.text((70, 160), "\\int_0^\\infty e^{-x^2} dx &= \\frac{\\sqrt{\\pi}}{2}", fill=(0, 0, 0), font=font(28))
    image.save(OUT / "formula-derivation.png")


def save_table() -> None:
    image = Image.new("RGB", (900, 520), "white")
    draw = ImageDraw.Draw(image)
    draw.text((48, 36), "Experiment Table", fill=(28, 33, 30), font=font(34))
    x0, y0 = 70, 110
    widths = [210, 210, 210]
    heights = [60, 60, 60, 60]
    rows = [["Method", "Accuracy", "Latency"], ["OCR-VL", "96.3", "high"], ["Pix2Text", "good", "low"], ["TeXLens", "review", "local"]]
    y = y0
    for row_idx, row in enumerate(rows):
        x = x0
        for col_idx, cell in enumerate(row):
            draw.rectangle((x, y, x + widths[col_idx], y + heights[row_idx]), outline=(28, 33, 30), width=2)
            draw.text((x + 16, y + 16), cell, fill=(0, 0, 0), font=font(24))
            x += widths[col_idx]
        y += heights[row_idx]
    image.save(OUT / "table-page.png")


def save_mixed() -> None:
    image = Image.new("RGB", (1000, 720), "white")
    draw = ImageDraw.Draw(image)
    draw.text((56, 44), "中英文混合 OCR 样例", fill=(28, 33, 30), font=font(34))
    draw.text((70, 120), "TeXLens should preserve English text and 中文段落.", fill=(0, 0, 0), font=font(28))
    draw.text((70, 185), "Inline formula: a^2 + b^2 = c^2", fill=(0, 0, 0), font=font(28))
    draw.text((70, 270), "\\begin{align*}", fill=(0, 0, 0), font=font(26))
    draw.text((105, 315), "f(x) &= x^2 + 2x + 1", fill=(0, 0, 0), font=font(26))
    draw.text((105, 360), "&= (x + 1)^2", fill=(0, 0, 0), font=font(26))
    draw.text((70, 405), "\\end{align*}", fill=(0, 0, 0), font=font(26))
    image.save(OUT / "mixed-zh-en-page.png")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    save_formula()
    save_table()
    save_mixed()
    print(f"Generated samples in {OUT}")


if __name__ == "__main__":
    main()

