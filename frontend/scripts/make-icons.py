#!/usr/bin/env python3
"""从单一矢量源 frontend/public/icon.svg 生成 PWA / Windows 图标。

运行：uv run --offline --no-project --with pillow python frontend/scripts/make-icons.py
每个尺寸独立对齐像素并以 4× 超采样绘制，不从大图缩小生成其他 ICO 帧。
"""
from math import ceil, floor
from pathlib import Path
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public"
DEPLOY = OUT.parent.parent / "deploy"
SVG = OUT / "icon.svg"
ICO_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 96, 128, 256]
SUPERSAMPLE = 4


def read_geometry():
    """颜色、位置、宽高和半径全部读 SVG，Python 不维护另一套设计比例。"""
    root = ET.parse(SVG).getroot()
    viewbox = tuple(map(float, root.attrib["viewBox"].split()))
    if viewbox[:2] != (0, 0) or viewbox[2] != viewbox[3]:
        raise ValueError("图标需要从 (0, 0) 起的正方形 viewBox")
    rectangles = []
    for rect in root.findall("{http://www.w3.org/2000/svg}rect"):
        shape = {key: float(rect.get(key, "0")) for key in ("x", "y", "width", "height", "rx")}
        shape["fill"] = rect.attrib["fill"]
        rectangles.append(shape)
    if len(rectangles) != 4:
        raise ValueError("图标需要一个底板和三个竖条")
    return viewbox[2], rectangles


VIEW_SIZE, SHAPES = read_geometry()


def pixel_bounds(shape, size):
    scale = size / VIEW_SIZE
    # 四舍五入，而非 Python round() 的偶数舍入；所有边都对齐目标像素。
    snap = lambda value: floor(value * scale + 0.5)
    bars = SHAPES[1:]
    if shape not in bars:
        return (snap(shape["x"]), snap(shape["y"]),
                snap(shape["x"] + shape["width"]), snap(shape["y"] + shape["height"]))
    # 竖条各边分别取整会让三根条宽差 1px；改为节距、间隙各取整一次，等宽等距、整体居中。
    pitch = snap(bars[1]["x"] - bars[0]["x"])
    gap = max(1, floor(pitch * (bars[1]["x"] - bars[0]["x"] - bars[0]["width"])
                       / (bars[1]["x"] - bars[0]["x"]) + 0.5))
    width = pitch - gap
    left = floor((size - (2 * pitch + width)) / 2 + 0.5) + bars.index(shape) * pitch
    return (left, snap(shape["y"]), left + width, snap(shape["y"] + shape["height"]))


def rounded_mask(size, bounds, radius):
    left, top, right, bottom = bounds
    radius = min(radius, (right - left) / 2, (bottom - top) / 2)
    high = Image.new("L", (size * SUPERSAMPLE, size * SUPERSAMPLE))
    ImageDraw.Draw(high).rounded_rectangle(
        [left * SUPERSAMPLE, top * SUPERSAMPLE,
         right * SUPERSAMPLE - 1, bottom * SUPERSAMPLE - 1],
        radius=radius * SUPERSAMPLE, fill=255,
    )
    sampled = high.resize((size, size), Image.Resampling.LANCZOS)
    # Lanczos 会在直边附近混色；裁掉边界外的振铃，再把直边覆盖区设成全实色。
    # 只有四个圆角区域保留超采样的过渡，避免小图标竖条边缘发虚。
    mask = Image.new("L", (size, size))
    mask.paste(sampled.crop(bounds), (left, top))
    draw = ImageDraw.Draw(mask)
    margin = ceil(radius)
    if bottom - top > 2 * margin:
        draw.rectangle([left, top + margin, right - 1, bottom - margin - 1], fill=255)
    if right - left > 2 * margin:
        draw.rectangle([left + margin, top, right - margin - 1, bottom - 1], fill=255)
    return mask.point(lambda alpha: 0 if alpha <= 3 else alpha)


def icon(size):
    image = Image.new("RGBA", (size, size))
    for shape in SHAPES:
        mask = rounded_mask(size, pixel_bounds(shape, size), shape["rx"] * size / VIEW_SIZE)
        layer = Image.new("RGBA", (size, size), shape["fill"])
        layer.putalpha(mask)
        image = Image.alpha_composite(image, layer)
    return image


def apple_icon(size):
    # 保留原有 iOS 图标：不透明直角底板，iOS 自己裁圆角；几何仍来自同一 SVG。
    image = Image.new("RGB", (size, size), SHAPES[0]["fill"])
    draw = ImageDraw.Draw(image)
    scale = size / VIEW_SIZE
    for shape in SHAPES[1:]:
        draw.rounded_rectangle(
            [shape["x"] * scale, shape["y"] * scale,
             (shape["x"] + shape["width"]) * scale, (shape["y"] + shape["height"]) * scale],
            radius=shape["rx"] * scale, fill=shape["fill"],
        )
    return image


def main():
    OUT.mkdir(exist_ok=True)
    for size in (192, 512):
        path = OUT / f"icon-{size}.png"
        icon(size).save(path)
        print(path)
    apple_icon(180).save(OUT / "apple-touch-icon.png")
    print(OUT / "apple-touch-icon.png")

    DEPLOY.mkdir(exist_ok=True)
    frames = {size: icon(size) for size in ICO_SIZES}
    path = DEPLOY / "workbench.ico"
    frames[256].save(
        path, sizes=[(size, size) for size in ICO_SIZES],
        append_images=[frames[size] for size in ICO_SIZES if size != 256],
    )
    # 不仅检查尺寸存在，还逐像素核对每帧，确认 Pillow 没用大图替代单独绘制的版本。
    with Image.open(path) as saved:
        if saved.ico.sizes() != {(size, size) for size in ICO_SIZES}:
            raise ValueError("ICO 缺少请求的尺寸")
        for size, frame in frames.items():
            if saved.ico.getimage((size, size)).convert("RGBA").tobytes() != frame.tobytes():
                raise ValueError(f"ICO {size}px 与独立渲染结果不一致")
    print(f"{path}: {', '.join(map(str, ICO_SIZES))} px（读回核对通过）")


if __name__ == "__main__":
    main()
