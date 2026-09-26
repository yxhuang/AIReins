#!/usr/bin/env python3
"""生成 PWA 图标：深色底 + 三家身份色竖条。运行：python3 frontend/scripts/make-icons.py"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public"
BG = "#1F1E1D"  # 深色主题背景
BARS = ["#D97757", "#10A37F", "#1A73E8"]  # claude / codex / kimi 身份色（见 styles.css 顶部注释）


def icon(size: int) -> Image.Image:
    image = Image.new("RGB", (size, size), BG)  # 不透明：iOS 会把透明区域填成黑色
    draw = ImageDraw.Draw(image)
    bar_w, gap = size * 0.16, size * 0.08
    left = (size - 3 * bar_w - 2 * gap) / 2
    for i, color in enumerate(BARS):
        x = left + i * (bar_w + gap)
        draw.rounded_rectangle([x, size * 0.25, x + bar_w, size * 0.75], radius=bar_w / 2, fill=color)
    return image


OUT.mkdir(exist_ok=True)
for name, size in [("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)]:
    icon(size).save(OUT / name)
    print(OUT / name)
