#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_doc.py — 从 content.json 一步生成《需求文档》Word（合同规范版式 + 工作流程图）
用法: python gen_doc.py content.json "需求文档-系统名.docx"
依赖: python-docx, matplotlib
版式: 业内合同规范——黑体二号标题、黑体/楷体条款标题、宋体小四正文、
      1.5倍行距、每条业务流程自动绘制竖版流程图、结尾双方签署栏、
      "第 X 页 共 Y 页"页码。
"""
import json
import os
import sys
import tempfile
from datetime import date

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

BLACK = RGBColor(0, 0, 0)
GRAY = RGBColor(0x59, 0x59, 0x59)
NAVY = "#1F4E79"
SONG, HEI, KAI, FANG = "宋体", "黑体", "楷体", "仿宋"
CN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八"]
CENTER = WD_ALIGN_PARAGRAPH.CENTER
RIGHT = WD_ALIGN_PARAGRAPH.RIGHT
TEMP_FILES = []


def set_font(run, size=12, bold=False, color=None, font=SONG):
    run.font.name = font
    run._element.rPr.rFonts.set(qn("w:eastAsia"), font)
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color if color is not None else BLACK


def para(doc, runs, size=12, font=SONG, bold=False, color=None, align=None,
         before=0, after=0, indent=False, line=1.5, right_indent=None):
    """runs 为字符串或 [(text, 覆盖参数dict), ...]。"""
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(before)
    pf.space_after = Pt(after)
    pf.line_spacing = line
    if align is not None:
        p.alignment = align
    if indent:
        pf.first_line_indent = Pt(size * 2)
    if right_indent:
        pf.right_indent = Pt(right_indent)
    if isinstance(runs, str):
        runs = [(runs, {})]
    for text, ov in runs:
        set_font(p.add_run(text), ov.get("size", size), ov.get("bold", bold),
                 ov.get("color", color), ov.get("font", font))
    return p


def shade_cell(cell, hex_color):
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:fill"), hex_color)
    cell._tc.get_or_add_tcPr().append(shd)


def table_setup(table, border_color="000000"):
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    tblPr = table._tbl.tblPr
    layout = OxmlElement("w:tblLayout")
    layout.set(qn("w:type"), "fixed")
    tblPr.append(layout)
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        e = OxmlElement("w:" + edge)
        e.set(qn("w:val"), "single")
        e.set(qn("w:sz"), "4")
        e.set(qn("w:space"), "0")
        e.set(qn("w:color"), border_color)
        borders.append(e)
    tblPr.append(borders)
    mar = OxmlElement("w:tblCellMar")
    for tag, w in (("top", 60), ("left", 100), ("bottom", 60), ("right", 100)):
        e = OxmlElement("w:" + tag)
        e.set(qn("w:w"), str(w))
        e.set(qn("w:type"), "dxa")
        mar.append(e)
    tblPr.append(mar)


def write_cell(cell, text, size=10.5, bold=False, font=SONG,
               align=None, fill=None, color=None):
    if fill:
        shade_cell(cell, fill)
    lines = text if isinstance(text, list) else [text]
    first = True
    for ln in lines:
        p = cell.paragraphs[0] if first else cell.add_paragraph()
        first = False
        pf = p.paragraph_format
        pf.space_before = Pt(1)
        pf.space_after = Pt(1)
        pf.line_spacing = 1.15
        if align is not None:
            p.alignment = align
        set_font(p.add_run(ln), size, bold, color, font)


def add_row(table, cells, widths, bold=False, fill=None, aligns=None):
    row = table.add_row()
    for i, txt in enumerate(cells):
        cell = row.cells[i]
        cell.width = Cm(widths[i])
        write_cell(cell, txt, bold=bold, align=aligns[i] if aligns else None,
                   fill=fill)
    trPr = row._tr.get_or_add_trPr()
    trPr.append(OxmlElement("w:cantSplit"))
    return row


def make_table(doc, headers, widths):
    table = doc.add_table(rows=1, cols=len(headers))
    table_setup(table)
    row = table.rows[0]
    trPr = row._tr.get_or_add_trPr()
    trPr.append(OxmlElement("w:tblHeader"))
    for i, h in enumerate(headers):
        cell = row.cells[i]
        cell.width = Cm(widths[i])
        write_cell(cell, h, bold=True, font=HEI, align=CENTER, fill="EFEFEF")
    return table


def add_page_number(doc):
    """页脚居中：第 X 页　共 Y 页"""
    footer = doc.sections[0].footer
    p = footer.paragraphs[0]
    p.alignment = CENTER

    def field(instr, placeholder):
        fld = OxmlElement("w:fldSimple")
        fld.set(qn("w:instr"), instr)
        r = OxmlElement("w:r")
        rPr = OxmlElement("w:rPr")
        sz = OxmlElement("w:sz")
        sz.set(qn("w:val"), "18")
        rPr.append(sz)
        r.append(rPr)
        t = OxmlElement("w:t")
        t.text = placeholder
        r.append(t)
        fld.append(r)
        p._p.append(fld)

    set_font(p.add_run("第 "), 9, font=SONG)
    field(r"PAGE \* arabic \* MERGEFORMAT", "1")
    set_font(p.add_run(" 页　共 "), 9, font=SONG)
    field(r"NUMPAGES \* arabic \* MERGEFORMAT", "1")
    set_font(p.add_run(" 页"), 9, font=SONG)


def wrap(text, width=12):
    return "\n".join(text[i:i + width] for i in range(0, len(text), width))


def draw_flowchart(steps, out_png):
    """竖版流程图：开始/结束圆角节点 + 步骤方框 + 箭头。"""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import FancyBboxPatch
    plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei"]
    plt.rcParams["axes.unicode_minus"] = False

    nodes = ["开始"] + [str(s) for s in steps] + ["结束"]
    n = len(nodes)
    gap, H, BW = 1.0, 0.72, 3.8
    fig_h = max(2.2, n * gap * 0.82 + 0.6)
    fig, ax = plt.subplots(figsize=(6.0, fig_h))
    ax.set_xlim(-5, 5)
    ax.set_ylim(0, n * gap + 0.6)
    ax.axis("off")
    y_top = n * gap + 0.1
    for i, text in enumerate(nodes):
        cy = y_top - i * gap
        terminal = i in (0, n - 1)
        w = 2.4 if terminal else BW
        box = FancyBboxPatch(
            (-w / 2, cy - H / 2), w, H,
            boxstyle="round,pad=0.02,rounding_size=%s" % ("0.36" if terminal else "0.08"),
            fc="#E8F0FE" if terminal else "white", ec=NAVY, lw=1.4)
        ax.add_patch(box)
        ax.text(0, cy, wrap(text), ha="center", va="center",
                fontsize=12, color="#222222", linespacing=1.1)
        if i < n - 1:
            ny = y_top - (i + 1) * gap
            ax.annotate("", xy=(0, ny + H / 2 + 0.03), xytext=(0, cy - H / 2 - 0.03),
                        arrowprops=dict(arrowstyle="-|>", color=NAVY, lw=1.4,
                                        shrinkA=0, shrinkB=0))
    fig.savefig(out_png, dpi=200, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def flowchart_png(steps):
    path = os.path.join(tempfile.gettempdir(), "fy_flow_%d.png" % len(TEMP_FILES))
    draw_flowchart(steps, path)
    TEMP_FILES.append(path)
    return path


def cleanup():
    for path in TEMP_FILES:
        try:
            os.remove(path)
        except OSError:
            pass
    del TEMP_FILES[:]


def build(data, out_path):
    doc = Document()
    sec = doc.sections[0]
    sec.top_margin = Cm(2.54)
    sec.bottom_margin = Cm(2.54)
    sec.left_margin = Cm(2.8)
    sec.right_margin = Cm(2.6)
    add_page_number(doc)

    today = date.today()
    date_str = data.get("date") or "%d年%d月%d日" % (today.year, today.month, today.day)

    # 标题区
    para(doc, data["system_name"], size=22, font=HEI, bold=True,
         align=CENTER, before=6, after=8)
    para(doc, data["subtitle"], size=14, font=KAI, align=CENTER, after=4)
    para(doc, "编制单位：帆远网络科技", size=12, font=SONG, align=CENTER, after=18)

    # 一、项目概述
    idx = 0
    para(doc, "%s、项目概述" % CN_NUM[idx], size=14, font=HEI, indent=True)
    idx += 1
    for text in data.get("overview", []):
        para(doc, text, indent=True)

    # 二、用户角色
    roles = data.get("roles") or []
    if roles:
        para(doc, "%s、用户角色" % CN_NUM[idx], size=14, font=HEI, indent=True)
        idx += 1
        widths = [2.8, 6.4, 6.4]
        t = make_table(doc, ["角色", "角色说明", "核心操作"], widths)
        for r in roles:
            add_row(t, [r.get("name", ""), r.get("desc", ""), r.get("actions", "")], widths)
        para(doc, "", line=1.0)

    # 三、功能模块设计
    para(doc, "%s、功能模块设计" % CN_NUM[idx], size=14, font=HEI, indent=True)
    idx += 1
    for i, m in enumerate(data["modules"], 1):
        head = "（%s）%s" % (CN_NUM[i - 1], m["name"])
        if m.get("desc"):
            head += "——" + m["desc"]
        para(doc, head, size=14, font=KAI, indent=True)
        widths = [4.2, 11.4]
        t = make_table(doc, ["功能点", "功能说明"], widths)
        for f in m.get("features", []):
            add_row(t, [f.get("point", ""), f.get("detail", "")], widths)
        para(doc, "", line=1.0)

    # 四、核心业务流程（自动绘制流程图）
    flows = data.get("flows") or []
    if flows:
        para(doc, "%s、核心业务流程" % CN_NUM[idx], size=14, font=HEI, indent=True)
        idx += 1
        for i, f in enumerate(flows, 1):
            para(doc, "%d.%s" % (i, f["name"]), bold=True, indent=True, after=4)
            p = doc.add_paragraph()
            p.alignment = CENTER
            p.paragraph_format.space_after = Pt(10)
            p.add_run().add_picture(flowchart_png(f["steps"]), width=Cm(8.5))

    # 五、交付形态与范围
    delivery = data.get("delivery")
    if delivery:
        para(doc, "%s、交付形态与范围" % CN_NUM[idx], size=14, font=HEI, indent=True)
        idx += 1
        para(doc, delivery, indent=True)

    # 六、其他说明
    notes = data.get("notes") or []
    if notes:
        para(doc, "%s、其他说明" % CN_NUM[idx], size=14, font=HEI, indent=True)
        for i, n in enumerate(notes, 1):
            para(doc, "%d.%s" % (i, n), indent=True)

    # 告知说明 + 落款（尽到告知义务即可，无需签字盖章，客户线上确认即生效）
    para(doc, "", before=24)
    para(doc, "告知说明", size=14, font=HEI, indent=True, before=6)
    para(doc, "本需求文档由帆远网络科技根据客户提供的需求整理编制，供客户核对功能范围之用。客户通过企业微信、微信、电话、邮件等任一方式（含口头）确认本文件内容的，即视为需求确认完成，本文档作为项目设计与开发依据。", indent=True)
    para(doc, "帆远网络科技", align=RIGHT, right_indent=56, before=16)
    para(doc, date_str, align=RIGHT, right_indent=56)

    doc.save(out_path)
    cleanup()
    print("OK 已生成 %s" % out_path)


def main():
    if len(sys.argv) < 3:
        sys.exit("用法: python gen_doc.py content.json 输出.docx")
    with open(sys.argv[1], encoding="utf-8-sig") as f:
        data = json.load(f)
    for key in ("system_name", "subtitle", "modules"):
        if not data.get(key):
            sys.exit("content.json 缺少必填字段: %s" % key)
    out = os.path.abspath(sys.argv[2])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    build(data, out)


if __name__ == "__main__":
    main()
