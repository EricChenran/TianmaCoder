# -*- coding: utf-8 -*-
"""绘图工具包：流程图/架构图/原型图共用的基础图元。"""
import math
import os
from PIL import Image, ImageDraw, ImageFont

FONT_DIR = r"C:\Windows\Fonts"
_FONT_FILES = {
    "hei": "simhei.ttf",
    "yahei": "msyh.ttc",
    "yahei_b": "msyhbd.ttc",
    "song": "simsun.ttc",
    "fang": "simfang.ttf",
    "kai": "simkai.ttf",
    "times": "times.ttf",
    "times_b": "timesbd.ttf",
}
_cache = {}


def F(name, size):
    key = (name, size)
    if key not in _cache:
        _cache[key] = ImageFont.truetype(os.path.join(FONT_DIR, _FONT_FILES[name]), size)
    return _cache[key]


# 色板
INK = "#16222E"
INK2 = "#324356"
MUTED = "#6B7B8C"
LINE = "#8496A8"
GRID = "#DCE3EA"
BLUE = "#1F5FA8"
BLUE_D = "#164A85"
BLUE_L = "#EAF1FA"
BLUE_M = "#D3E2F4"
GREEN = "#1C8467"
GREEN_L = "#E6F3EE"
ORANGE = "#B0621B"
ORANGE_L = "#FBEEE1"
RED = "#B23A3A"
RED_L = "#FAE9E9"
GRAY_L = "#F4F6F8"
WHITE = "#FFFFFF"


def canvas(w, h, bg=WHITE):
    img = Image.new("RGB", (w, h), bg)
    return img, ImageDraw.Draw(img)


def wrap(d, s, font, maxw):
    """按像素宽度折行，中文逐字断行，西文按空格断行。"""
    lines, cur = [], ""
    for ch in s:
        if ch == "\n":
            lines.append(cur)
            cur = ""
            continue
        if d.textlength(cur + ch, font=font) <= maxw or not cur:
            cur += ch
        else:
            lines.append(cur)
            cur = ch
    if cur:
        lines.append(cur)
    return lines


def box(d, xy, text, font, fill=WHITE, outline=BLUE, color=INK,
        radius=12, width=2, padx=16, pady=8, gap=6, align="center", shadow=False):
    x0, y0, x1, y1 = xy
    if shadow:
        d.rounded_rectangle((x0 + 2, y0 + 3, x1 + 2, y1 + 3), radius=radius, fill="#E8ECF1")
    d.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)
    lines = wrap(d, text, font, (x1 - x0) - 2 * padx)
    lh = font.size + gap
    total = len(lines) * lh - gap
    y = y0 + ((y1 - y0) - total) / 2.0
    for ln in lines:
        if align == "center":
            d.text(((x0 + x1) / 2.0, y), ln, font=font, fill=color, anchor="ma")
        else:
            d.text((x0 + padx, y), ln, font=font, fill=color, anchor="la")
        y += lh


def diamond(d, cx, cy, w, h, text, font, fill=BLUE_L, outline=BLUE, color=INK):
    pts = [(cx, cy - h / 2.0), (cx + w / 2.0, cy), (cx, cy + h / 2.0), (cx - w / 2.0, cy)]
    d.polygon(pts, fill=fill, outline=outline, width=2)
    lines = wrap(d, text, font, w * 0.56)
    lh = font.size + 4
    total = len(lines) * lh - 4
    y = cy - total / 2.0
    for ln in lines:
        d.text((cx, y), ln, font=font, fill=color, anchor="ma")
        y += lh


def _head(d, p_from, p_to, color, size=15, halfw=8):
    x1, y1 = p_from
    x2, y2 = p_to
    ang = math.atan2(y2 - y1, x2 - x1)
    pts = [(x2, y2),
           (x2 - size * math.cos(ang) + halfw * math.sin(ang),
            y2 - size * math.sin(ang) - halfw * math.cos(ang)),
           (x2 - size * math.cos(ang) - halfw * math.sin(ang),
            y2 - size * math.sin(ang) + halfw * math.cos(ang))]
    d.polygon(pts, fill=color)


def arrow(d, pts, color=LINE, width=3, head=True, size=15, halfw=8, dash=False):
    pts = [tuple(map(float, p)) for p in pts]
    for i in range(len(pts) - 1):
        if dash:
            dashed(d, pts[i], pts[i + 1], color, width)
        else:
            d.line([pts[i], pts[i + 1]], fill=color, width=int(round(width)), joint="curve")
    if head:
        _head(d, pts[-2], pts[-1], color, size, halfw)


def dashed(d, p1, p2, color, width=3, seg=14, gap=10):
    x1, y1 = p1
    x2, y2 = p2
    L = math.hypot(x2 - x1, y2 - y1)
    if L == 0:
        return
    ux, uy = (x2 - x1) / L, (y2 - y1) / L
    t = 0.0
    while t < L:
        e = min(t + seg, L)
        d.line([(x1 + ux * t, y1 + uy * t), (x1 + ux * e, y1 + uy * e)], fill=color, width=int(round(width)))
        t = e + gap


def chip(d, x, y, text, font, fill=GRAY_L, outline=GRID, color=INK2, padx=14, h=None):
    h = h or font.size + 20
    w = d.textlength(text, font=font) + 2 * padx
    d.rounded_rectangle((x, y, x + w, y + h), radius=h / 2.0, fill=fill, outline=outline, width=2)
    d.text((x + w / 2.0, y + h / 2.0), text, font=font, fill=color, anchor="mm")
    return w


def tag(d, x, y, text, font, fill=BLUE, color=WHITE, padx=10, h=None, radius=6):
    h = h or font.size + 12
    w = d.textlength(text, font=font) + 2 * padx
    d.rounded_rectangle((x, y, x + w, y + h), radius=radius, fill=fill)
    d.text((x + w / 2.0, y + h / 2.0), text, font=font, fill=color, anchor="mm")
    return w


def label(d, xy, text, font, color=MUTED, anchor="la"):
    d.text(xy, text, font=font, fill=color, anchor=anchor)


def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG")
    print("saved", path, img.size)
