#!/usr/bin/env python3
"""从单一矢量源 frontend/public/icon.svg 生成 PWA / Windows 图标。

运行：uv run --no-project --with pillow --with resvg-py python frontend/scripts/make-icons.py
每个尺寸由 resvg 直接按目标像素渲染，不从大图缩小生成其他 ICO 帧；
48px 及以下去掉缝线、加粗笔画（SMALL_CSS），避免托盘与开始菜单小图标发糊。
"""
from io import BytesIO
from pathlib import Path

from PIL import Image
import resvg_py

OUT = Path(__file__).resolve().parent.parent / "public"
DEPLOY = OUT.parent.parent / "deploy"
SVG = (OUT / "icon.svg").read_text()
ICO_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 96, 128, 256]
SMALL_MAX = 48
SMALL_CSS = ".glyph { mask: none; } .a { stroke-width: 16; } .r { stroke-width: 18; } .loop { stroke-width: 10; }"
PLATE = "#1F1E1D"


def render(size, background=None):
    css = SMALL_CSS if size <= SMALL_MAX else None
    png = resvg_py.svg_to_bytes(svg_string=SVG, width=size, height=size, style_sheet=css, background=background)
    return Image.open(BytesIO(bytes(png))).convert("RGBA")


def main():
    for size in (192, 512):
        path = OUT / f"icon-{size}.png"
        render(size).save(path)
        print(path)
    # iOS 图标保持不透明直角底板，系统自己裁圆角。
    render(180, PLATE).convert("RGB").save(OUT / "apple-touch-icon.png")
    print(OUT / "apple-touch-icon.png")

    frames = {size: render(size) for size in ICO_SIZES}
    path = DEPLOY / "aireins.ico"
    frames[256].save(
        path, sizes=[(size, size) for size in ICO_SIZES],
        append_images=[frames[size] for size in ICO_SIZES if size != 256],
    )
    # 逐像素核对每帧，确认 Pillow 没用大图替代单独渲染的版本。
    with Image.open(path) as saved:
        if saved.ico.sizes() != {(size, size) for size in ICO_SIZES}:
            raise ValueError("ICO 缺少请求的尺寸")
        for size, frame in frames.items():
            if saved.ico.getimage((size, size)).convert("RGBA").tobytes() != frame.tobytes():
                raise ValueError(f"ICO {size}px 与独立渲染结果不一致")
    print(f"{path}: {', '.join(map(str, ICO_SIZES))} px（读回核对通过）")


if __name__ == "__main__":
    main()
