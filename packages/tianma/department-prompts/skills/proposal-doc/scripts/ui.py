# -*- coding: utf-8 -*-
"""界面原型绘制组件（浅色 Web 端 / 深色大屏）。"""
from PIL import Image, ImageDraw
from dkit import F, canvas

NAVY = "#16222E"
BG = "#F2F5F9"
CARD = "#FFFFFF"
BR = "#E6EBF2"
TX = "#1B2838"
SUB = "#7B8B9C"
ACC = "#1F5FA8"
GREEN = "#1C8467"
ORANGE = "#B0621B"
RED = "#B23A3A"


def mix(c1, c2, t):
    a = tuple(int(c1[i:i + 2], 16) for i in (1, 3, 5))
    b = tuple(int(c2[i:i + 2], 16) for i in (1, 3, 5))
    return "#%02X%02X%02X" % tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def chrome(d, W, H, active, items, user="园区运营中心 · 张工"):
    d.rectangle((0, 0, W, 56), fill=NAVY)
    d.rounded_rectangle((16, 16, 34, 40), radius=5, fill="#2E7DD1")
    d.text((44, 28), "冷链智控", font=F("hei", 19), fill="#FFFFFF", anchor="lm")
    d.text((152, 29), "智慧运营平台", font=F("yahei", 15), fill="#8FA6BF", anchor="lm")
    d.text((W - 20, 28), user, font=F("yahei", 14), fill="#C9D6E4", anchor="rm")
    d.rectangle((0, 56, 168, H), fill=CARD)
    d.line([(168, 56), (168, H)], fill=BR, width=1)
    y = 78
    for it in items:
        if it == active:
            d.rounded_rectangle((10, y - 6, 158, y + 30), radius=8, fill="#EAF1FA")
            d.rounded_rectangle((10, y + 2, 13, y + 22), radius=2, fill=ACC)
            d.text((32, y + 12), it, font=F("yahei", 16), fill=ACC, anchor="lm")
        else:
            d.text((32, y + 12), it, font=F("yahei", 16), fill="#55677A", anchor="lm")
        y += 44


def kpi(d, x, y, w, h, label, value, unit, delta, trend="up"):
    d.rounded_rectangle((x, y, x + w, y + h), radius=10, fill=CARD, outline=BR, width=1)
    d.text((x + 16, y + 14), label, font=F("yahei", 14), fill=SUB, anchor="la")
    d.text((x + 15, y + 38), value, font=F("times_b", 34), fill=TX, anchor="la")
    vw = d.textlength(value, font=F("times_b", 34))
    d.text((x + 20 + vw, y + 52), unit, font=F("yahei", 13), fill=SUB, anchor="la")
    d.text((x + w - 16, y + 46), delta, font=F("yahei", 13),
           fill=GREEN if trend == "up" else RED, anchor="ra")


def card(d, x, y, w, h, title=None, sub=None):
    d.rounded_rectangle((x, y, x + w, y + h), radius=10, fill=CARD, outline=BR, width=1)
    if title:
        d.text((x + 18, y + 16), title, font=F("hei", 16), fill=TX, anchor="la")
    if sub:
        d.text((x + w - 18, y + 20), sub, font=F("yahei", 12), fill=SUB, anchor="ra")


def line_chart(d, box, vals, ymin, ymax, color, fillc=None, grid=4, lw=3, last_dot=True):
    x0, y0, x1, y1 = box
    for i in range(grid + 1):
        yy = y0 + (y1 - y0) * i / grid
        d.line([(x0, yy), (x1, yy)], fill="#EEF2F7", width=1)
    n = len(vals)
    pts = []
    for i, v in enumerate(vals):
        x = x0 + (x1 - x0) * i / (n - 1)
        y = y1 - (v - ymin) / float(ymax - ymin) * (y1 - y0)
        pts.append((x, y))
    if fillc:
        d.polygon(pts + [(x1, y1), (x0, y1)], fill=fillc)
    d.line(pts, fill=color, width=lw, joint="curve")
    if last_dot:
        d.ellipse((pts[-1][0] - 5, pts[-1][1] - 5, pts[-1][0] + 5, pts[-1][1] + 5), fill=CARD, outline=color, width=3)
    return pts


def bar_chart(d, box, vals, color, grid=3, lw=1):
    x0, y0, x1, y1 = box
    for i in range(grid + 1):
        yy = y0 + (y1 - y0) * i / grid
        d.line([(x0, yy), (x1, yy)], fill="#EEF2F7", width=1)
    mx = max(vals) * 1.15
    n = len(vals)
    slot = (x1 - x0) / n
    bw = slot * 0.46
    for i, v in enumerate(vals):
        cx = x0 + slot * (i + 0.5)
        h = (v / mx) * (y1 - y0)
        d.rounded_rectangle((cx - bw / 2, y1 - h, cx + bw / 2, y1), radius=4, fill=color)


def table(d, box, headers, rows, widths, fs=13, rh=30, hh=32, aligns=None, colors=None):
    x0, y0, x1, y1 = box
    aligns = aligns or ["l"] * len(headers)
    d.rectangle((x0, y0, x1, y0 + hh), fill="#F7F9FC")
    x = x0
    for i, htxt in enumerate(headers):
        ax = x + 10 if aligns[i] == "l" else (x + widths[i] / 2 if aligns[i] == "c" else x + widths[i] - 10)
        anchor = {"l": "lm", "c": "mm", "r": "rm"}[aligns[i]]
        d.text((ax, y0 + hh / 2), htxt, font=F("yahei", fs), fill=SUB, anchor=anchor)
        x += widths[i]
    y = y0 + hh
    for r, row in enumerate(rows):
        x = x0
        for i, cell in enumerate(row):
            ax = x + 10 if aligns[i] == "l" else (x + widths[i] / 2 if aligns[i] == "c" else x + widths[i] - 10)
            anchor = {"l": "lm", "c": "mm", "r": "rm"}[aligns[i]]
            col = TX
            if colors and (r, i) in colors:
                col = colors[(r, i)]
            d.text((ax, y + rh / 2), cell, font=F("yahei", fs), fill=col, anchor=anchor)
            x += widths[i]
        y += rh
        if y < y1 - 4:
            d.line([(x0, y), (x1, y)], fill="#F0F3F7", width=1)


def badge(d, x, y, text, fill, color, fs=12, h=22):
    w = d.textlength(text, font=F("yahei", fs)) + 18
    d.rounded_rectangle((x, y, x + w, y + h), radius=6, fill=fill)
    d.text((x + w / 2, y + h / 2 + 1), text, font=F("yahei", fs), fill=color, anchor="mm")
    return w
