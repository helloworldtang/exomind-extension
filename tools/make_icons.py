#!/usr/bin/env python3
"""生成扩展图标（纯几何绘制，不依赖字体文件）。

用法:
    /Users/tangcheng/.workbuddy/binaries/python/versions/3.13.12/bin/python3 \
        tools/make_icons.py

产出 icons/icon-{16,32,48,128}.png —— 蓝底 + 白色「存入」箭头（竖杆 + 箭头 + 收件横线）。
改品牌色只需改 BG。
"""

from pathlib import Path

from PIL import Image, ImageDraw

BG = (59, 110, 246, 255)  # #3B6EF6
FG = (255, 255, 255, 255)
SIZES = (16, 32, 48, 128)
CANVAS = 512
OUT = Path(__file__).resolve().parent.parent / "icons"


def draw(size: int) -> Image.Image:
    s = CANVAS / size  # 缩放到 512 画布的系数
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角矩形背景（半径按 22% 边长）
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=size * 0.22, fill=BG)

    def px(*pts):
        return [(x / s, y / s) for x, y in pts]

    # 竖杆
    d.rectangle(px((236, 108), (276, 292)), fill=FG)
    # 箭头头部
    d.polygon(px((210, 264), (302, 264), (256, 336)), fill=FG)
    # 收件横线
    d.rectangle(px((152, 364), (360, 400)), fill=FG)
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        img = draw(size)
        path = OUT / f"icon-{size}.png"
        img.save(path, "PNG")
        print(f"wrote {path} ({size}x{size})")


if __name__ == "__main__":
    main()
