# -*- coding: utf-8 -*-
"""通用图元：竖版流程、横版阶段、分层架构、甘特图。

只依赖 dkit.py。每个函数接收 Python 数据结构，输出 PNG，返回路径。

    from diagrams import vflow, hflow, layers, gantt

    vflow([
        {"label": "车辆到达", "kind": "start"},
        {"label": "多模态识别", "desc": "车牌 / 货物 / 人员"},
        {"label": "与预约单匹配", "kind": "decision"},
        {"label": "地磅称重", "note": "是"},
        {"label": "放行", "kind": "end"},
    ], "img/f1.png", side=["车牌识别", "OCR", "Kafka"], loop=(4, 1, "异常回流"))
"""
import os
from dkit import (F, canvas, wrap, box, diamond, arrow, chip, save,
                  INK, INK2, MUTED, LINE, GRID, BLUE, BLUE_D, BLUE_L, BLUE_M,
                  GREEN, GREEN_L, ORANGE, ORANGE_L, WHITE)

SLATE = "#4A5B70"


def _ensure(path):
    d = os.path.dirname(os.path.abspath(path))
    if d:
        os.makedirs(d, exist_ok=True)


# ---------------------------------------------------------------- 竖版流程
def vflow(nodes, path, width=1400, node_w=520, gap=56, side=None,
          side_title="关键技术支撑", loop=None, start_y=44):
    """nodes: [{label, desc?, kind?=box|start|end|decision|accent, note?, color?}]"""
    has_side = bool(side)
    panel_w = 380 if has_side else 0
    cx = (width - panel_w) / 2.0
    x0, x1 = cx - node_w / 2.0, cx + node_w / 2.0

    heights = []
    for n in nodes:
        k = n.get("kind", "box")
        if k == "decision":
            heights.append(170)
        elif n.get("desc"):
            heights.append(112)
        else:
            heights.append(68)

    total = start_y + sum(heights) + gap * (len(nodes) - 1) + 80
    H = int(max(total, 320))
    img, d = canvas(int(width), H)

    tops = []
    y = start_y
    for h in heights:
        tops.append(y)
        y += h + gap

    for i, n in enumerate(nodes):
        k = n.get("kind", "box")
        top = tops[i]
        h = heights[i]
        label = n["label"]
        desc = n.get("desc")
        fill, outline, color = n.get("fill"), n.get("outline", BLUE), n.get("color", INK)
        if k == "decision":
            diamond(d, cx, top + h / 2.0, node_w - 40, h, label, F("hei", 22))
        else:
            if k == "start":
                fill, outline, color = fill or GREEN_L, outline or GREEN, color or "#14624C"
            elif k == "end":
                fill, outline, color = fill or "#F2F5F9", outline or SLATE, color or INK2
            elif k == "accent":
                fill, outline, color = fill or GREEN_L, outline or GREEN, color or "#14624C"
            else:
                fill, outline, color = fill or BLUE_L, outline or BLUE, color or BLUE_D
            radius = h / 2.0 if k in ("start", "end") else 10
            d.rounded_rectangle((x0, top, x1, top + h), radius=radius,
                                fill=fill, outline=outline, width=2)
            if desc:
                d.text((cx, top + 26), label, font=F("hei", 25), fill=color, anchor="mm")
                d.text((cx, top + 72), desc, font=F("yahei", 18), fill=MUTED, anchor="mm")
            else:
                d.text((cx, top + h / 2.0), label, font=F("hei", 25), fill=color, anchor="mm")

        if i < len(nodes) - 1:
            arrow(d, [(cx, top + h), (cx, top + h + gap - 4)])
            note = nodes[i + 1].get("note")
            if note:
                d.text((cx + 16, top + h + gap / 2.0), note, font=F("yahei", 18),
                       fill=GREEN, anchor="lm")

    if loop:
        a, b_, text = loop
        lx = x0 - 56
        y1 = tops[a] + heights[a] / 2.0
        y2 = tops[b_] + heights[b_] / 2.0
        arrow(d, [(x0 - 4, y1), (lx, y1), (lx, y2), (x0 - 4, y2)], LINE, 2.5, dash=True)
        d.text((lx - 10, (y1 + y2) / 2.0), text, font=F("yahei", 18), fill=MUTED, anchor="rm")

    if has_side:
        px0 = width - panel_w - 10
        d.rounded_rectangle((px0, 40, px0 + panel_w - 10, H - 40), radius=12,
                            fill="#F8FAFC", outline=GRID, width=2)
        d.text((px0 + 26, 66), side_title, font=F("hei", 24), fill=BLUE_D, anchor="la")
        d.line([(px0 + 26, 106), (px0 + panel_w - 36, 106)], fill=BLUE_M, width=2)
        for j, t in enumerate(side):
            yy = 136 + j * 118
            d.rounded_rectangle((px0 + 26, yy, px0 + panel_w - 36, yy + 76), radius=10,
                                fill=WHITE, outline=BLUE_M, width=2)
            d.text((px0 + 44, yy + 16), "%02d" % (j + 1), font=F("times_b", 20), fill=BLUE, anchor="la")
            for k2, ln in enumerate(wrap(d, t, F("yahei", 19), panel_w - 120)[:2]):
                d.text((px0 + 82, yy + 14 + k2 * 27), ln, font=F("yahei", 19), fill=INK2, anchor="la")

    _ensure(path)
    save(img, path)
    return path


# ---------------------------------------------------------------- 横版阶段
def hflow(stages, path, width=1600, quality=True):
    """stages: [{name, period, items:[...]}] —— 顶部五段式 + 底部质控条"""
    n = len(stages)
    margin = 40
    gap = 40 if n <= 5 else 26
    w = (width - 2 * margin - gap * (n - 1)) / float(n)
    H = 560
    img, d = canvas(width, H)

    for i, st in enumerate(stages):
        x = margin + i * (w + gap)
        box(d, (x, 110, x + w, 202), st["name"], F("hei", 29), BLUE_L, BLUE, BLUE_D, radius=14)
        if st.get("period"):
            fw = F("yahei", 21)
            tw = d.textlength(st["period"], font=fw)
            d.rounded_rectangle((x + w / 2 - (tw + 34) / 2, 214, x + w / 2 + (tw + 34) / 2, 260),
                                radius=23, fill=WHITE, outline=BLUE_M, width=2)
            d.text((x + w / 2, 223), st["period"], font=fw, fill=BLUE_D, anchor="ma")
        for j, it in enumerate(st.get("items", [])):
            d.text((x + 4, 290 + j * 37), "· " + it, font=F("yahei", 21), fill=INK2, anchor="la")
        if i < n - 1:
            arrow(d, [(x + w + 5, 156), (x + w + gap - 6, 156)], LINE, 3)

    if quality:
        d.rounded_rectangle((margin, 438, width - margin, 516), radius=10,
                            fill="#F4F6F8", outline=GRID, width=2)
        d.text((margin + 26, 462), "质量控制", font=F("hei", 23), fill=ORANGE, anchor="la")
        x = margin + 150
        for t in ["阶段评审", "里程碑确认", "交付物归档", "变更受控"]:
            x += chip(d, x, 452, t, F("yahei", 20), WHITE, GRID, INK2) + 14

    _ensure(path)
    save(img, path)
    return path


# ---------------------------------------------------------------- 分层架构
def layers(bands, path, width=1600, right_note="安全保障体系（等保二级）· 运维监控"):
    """bands: [{name, en, color, items:[...], strip?: "一行小字", fill?, text?}]"""
    def bh(b):
        return 264 if b.get("strip") else 180

    H = 88 + sum(bh(b) for b in bands) + 40
    img, d = canvas(width, H)

    label_w = 172
    band_x0, band_x1 = 40, width - 152
    content_x0 = band_x0 + label_w + 18
    content_x1 = band_x1 - 16

    y = 88
    tops = []
    for b in bands:
        h = bh(b)
        tops.append(y)
        d.rounded_rectangle((band_x0, y, band_x1, y + h - 32), radius=12,
                            fill=WHITE, outline=GRID, width=2)
        d.rounded_rectangle((band_x0 + 16, y + 16, band_x0 + label_w, y + h - 48), radius=10,
                            fill=b["color"])
        d.text((band_x0 + 16 + (label_w - 16) / 2.0, y + h / 2.0 - 44), b["name"],
               font=F("hei", 26), fill=WHITE, anchor="mm")
        if b.get("en"):
            d.text((band_x0 + 16 + (label_w - 16) / 2.0, y + h / 2.0 - 10), b["en"],
                   font=F("times", 12), fill="#DCE6F0", anchor="mm")

        items = b["items"]
        n = len(items)
        gap = 14
        iw = (content_x1 - content_x0 - gap * (n - 1)) / float(n)
        for i, t in enumerate(items):
            x = content_x0 + i * (iw + gap)
            box(d, (x, y + 30, x + iw, y + 128), t, F("hei", 23),
                b.get("fill", WHITE), b["color"], b.get("text", INK), radius=10)
        if b.get("strip"):
            d.rounded_rectangle((content_x0, y + 142, content_x1, y + h - 40), radius=8,
                                fill="#F7FAF9", outline="#CBE3DA", width=2)
            d.text(((content_x0 + content_x1) / 2.0, y + 162), b["strip"],
                   font=F("yahei", 20), fill="#2F5D50", anchor="ma")
        y += h

    for i in range(len(bands) - 1):
        arrow(d, [(width / 2.0, tops[i] + bh(bands[i]) - 32),
                  (width / 2.0, tops[i + 1])], LINE, 2.5, size=12, halfw=7)

    if right_note:
        d.rounded_rectangle((width - 142, 88, width - 52, H - 60), radius=12,
                            fill="#F1F5F9", outline=GRID, width=2)
        vtext(img, width - 116, 150, right_note, F("hei", 20), "#44576B")

    _ensure(path)
    save(img, path)
    return path


def vtext(img, x, y, text, font, color):
    from PIL import Image, ImageDraw
    bbox = font.getbbox(text)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tmp = Image.new("RGBA", (w + 10, h + 10), (0, 0, 0, 0))
    ImageDraw.Draw(tmp).text((5 - bbox[0], 5 - bbox[1]), text, font=font, fill=color)
    rot = tmp.rotate(90, expand=True)
    img.paste(rot, (int(x), int(y)), rot)


# ---------------------------------------------------------------- 甘特图
def gantt(tasks, path, weeks=20, milestones=None, width=1600):
    """tasks: [{name, start, end, color}]；start/end 为 1 基周序号，含首尾"""
    W = width
    H = 130 + len(tasks) * 58 + 60
    img, d = canvas(W, H)
    x0 = 480
    wk = (W - 40 - x0) / float(weeks)
    months = (weeks + 3) // 4

    for m in range(months):
        if m % 2 == 0:
            d.rectangle((x0 + m * 4 * wk, 96, min(x0 + (m + 1) * 4 * wk, x0 + weeks * wk), H - 54),
                        fill="#F7F9FB")
        d.text((x0 + m * 4 * wk + 2 * wk, 119), "第 %d 月" % (m + 1),
               font=F("hei", 20), fill=INK2, anchor="mm")

    for n in range(weeks + 1):
        x = x0 + n * wk
        d.line([(x, 142), (x, H - 54)], fill=GRID if n % 5 else "#C3CED9",
               width=2 if n % 5 == 0 else 1)
        if n < weeks:
            d.text((x + wk / 2, 152), str(n + 1), font=F("times", 16), fill=MUTED, anchor="ma")

    d.line([(x0, 142), (x0 + weeks * wk, 142)], fill="#9AAABB", width=2)
    d.line([(x0, H - 54), (x0 + weeks * wk, H - 54)], fill="#9AAABB", width=2)

    for i, t in enumerate(tasks):
        y = 182 + i * 58
        d.text((60, y + 8), t["name"], font=F("hei", 21), fill=INK2, anchor="la")
        d.rounded_rectangle((x0 + (t["start"] - 1) * wk + 2, y, x0 + t["end"] * wk - 2, y + 34),
                            radius=8, fill=t.get("color", BLUE))
        d.text((x0 + (t["start"] - 1) * wk + 10, y + 17), "%d 周" % (t["end"] - t["start"] + 1),
               font=F("yahei", 14), fill=WHITE, anchor="lm")
        d.line([(60, y + 46), (x0 + weeks * wk, y + 46)], fill="#EDF1F5", width=1)

    for m in (milestones or []):
        px = x0 + m["week"] * wk
        d.polygon([(px, 68), (px + 12, 80), (px, 92), (px - 12, 80)],
                  fill=ORANGE, outline=WHITE)
        d.text((px, 62), m["label"], font=F("yahei", 17), fill="#8A4E14", anchor="mb")

    _ensure(path)
    save(img, path)
    return path
