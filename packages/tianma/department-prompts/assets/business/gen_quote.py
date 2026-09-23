#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_quote.py — 从 content.json 一步生成《报价单》Word（合同规范版式 + 分阶段报价）
用法: python gen_quote.py content.json "报价单-系统名.docx"
依赖: python-docx
校验: 所有模块 amount 之和必须等于 total，否则报错退出
版式: 业内合同规范——黑体二号标题、黑体条款标题、宋体正文、1.5倍行距、
      按"UI设计→客户确认→功能开发→测试上线"开发模式分阶段列表、
      双方签署栏、"第 X 页 共 Y 页"页码。
"""
import json
import os
import sys
from datetime import date

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

BLACK = RGBColor(0, 0, 0)
GRAY = RGBColor(0x44, 0x44, 0x44)
SONG, HEI, KAI, FANG = "宋体", "黑体", "楷体", "仿宋"
CENTER = WD_ALIGN_PARAGRAPH.CENTER
RIGHT = WD_ALIGN_PARAGRAPH.RIGHT

MODE_NOTE = ("本项目采用“先设计、后开发”的实施模式：第一阶段完成UI设计并提交客户确认，"
             "经客户确认后进入功能开发阶段；各阶段成果经客户确认后方可进入下一阶段。")


def set_font(run, size=12, bold=False, color=None, font=SONG):
    run.font.name = font
    run._element.rPr.rFonts.set(qn("w:eastAsia"), font)
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color if color is not None else BLACK


def para(doc, runs, size=12, font=SONG, bold=False, color=None, align=None,
         before=0, after=0, indent=False, line=1.5, right_indent=None):
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


def add_phase_row(table, name, note, widths):
    """阶段行：五列合并，阶段名加粗，备注小字。"""
    row = table.add_row()
    merged = row.cells[0]
    for c in row.cells[1:]:
        merged = merged.merge(c)
    shade_cell(merged, "F2F2F2")
    p = merged.paragraphs[0]
    pf = p.paragraph_format
    pf.space_before = Pt(2)
    pf.space_after = Pt(1)
    pf.line_spacing = 1.15
    set_font(p.add_run(name), 10.5, True, BLACK, HEI)
    if note:
        p2 = merged.add_paragraph()
        pf2 = p2.paragraph_format
        pf2.space_before = Pt(0)
        pf2.space_after = Pt(2)
        pf2.line_spacing = 1.15
        set_font(p2.add_run(note), 9, False, GRAY, SONG)
    trPr = row._tr.get_or_add_trPr()
    trPr.append(OxmlElement("w:cantSplit"))
    return row


def add_page_number(doc):
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


def build(data, out_path):
    total = int(data["total"])
    phases = data.get("phases")
    if phases:
        groups = [(p.get("name", ""), p.get("note", ""), p.get("modules", []))
                  for p in phases]
        all_modules = [m for _, _, ms in groups for m in ms]
    else:
        groups = None
        all_modules = data["modules"]
    s = sum(int(m["amount"]) for m in all_modules)
    if s != total:
        sys.exit("金额校验失败: 各模块合计 %d ≠ 总金额 %d，请修正 content.json 后重跑" % (s, total))

    doc = Document()
    sec = doc.sections[0]
    sec.top_margin = Cm(2.54)
    sec.bottom_margin = Cm(2.54)
    sec.left_margin = Cm(2.8)
    sec.right_margin = Cm(2.6)
    add_page_number(doc)

    today = date.today()
    date_str = data.get("date") or "%d年%d月%d日" % (today.year, today.month, today.day)
    valid_days = data.get("valid_days", 30)

    # 标题区
    para(doc, "%s_报价单" % data["system_name"], size=22, font=HEI, bold=True,
         align=CENTER, before=6, after=8)
    para(doc, [("总金额：", {"font": KAI}),
               ("¥%s" % format(total, ","), {"font": SONG, "bold": True, "size": 14}),
               ("　　工期：", {"font": KAI}),
               (str(data["duration"]), {"font": SONG, "bold": True, "size": 14})],
         size=14, align=CENTER, after=4)
    para(doc, "帆远网络科技 · 报价日期：%s · 报价有效期%d天" % (date_str, valid_days),
         size=11, align=CENTER, after=16)

    # 报价明细表（按阶段分组）
    widths = [1.2, 3.2, 6.4, 2.4, 2.4]
    aligns = [CENTER, None, None, CENTER, RIGHT]
    table = doc.add_table(rows=1, cols=5)
    table_setup(table)
    hdr = table.rows[0]
    trPr = hdr._tr.get_or_add_trPr()
    trPr.append(OxmlElement("w:tblHeader"))
    for i, h in enumerate(["序号", "模块名称", "功能说明", "开发周期", "金额（元）"]):
        cell = hdr.cells[i]
        cell.width = Cm(widths[i])
        write_cell(cell, h, bold=True, font=HEI, align=CENTER, fill="EFEFEF")
    seq = 0
    if groups:
        for pname, pnote, mods in groups:
            add_phase_row(table, pname, pnote, widths)
            for m in mods:
                seq += 1
                feats = ["• " + x for x in m.get("features", [])]
                add_row(table, [str(seq), m["name"], feats or "—",
                                m.get("period", "—"), format(int(m["amount"]), ",")],
                        widths, aligns=aligns)
    else:
        for m in all_modules:
            seq += 1
            feats = ["• " + x for x in m.get("features", [])]
            add_row(table, [str(seq), m["name"], feats or "—",
                            m.get("period", "—"), format(int(m["amount"]), ",")],
                    widths, aligns=aligns)
    row = table.add_row()
    merged = row.cells[0].merge(row.cells[1]).merge(row.cells[2])
    for c in (merged, row.cells[3], row.cells[4]):
        shade_cell(c, "EFEFEF")
    write_cell(merged, "合　计", bold=True, font=HEI, align=CENTER, fill="EFEFEF")
    write_cell(row.cells[3], str(data["duration"]), bold=True, align=CENTER, fill="EFEFEF")
    write_cell(row.cells[4], format(total, ","), bold=True, align=RIGHT, fill="EFEFEF")
    para(doc, "", line=1.0)

    # 开发模式说明
    para(doc, "开发模式说明", size=14, font=HEI, indent=True, before=8)
    para(doc, MODE_NOTE, indent=True)

    # 报价说明（固定文案）
    para(doc, "报价说明", size=14, font=HEI, indent=True, before=8)
    para(doc, "（一）本报价仅包含系统开发费用，不包含第三方接口调用、服务使用、服务器、域名等第三方产生的费用。", indent=True)
    para(doc, "（二）基本上线费用参考：", indent=True)
    para(doc, "1.网站：域名费用、服务器费用；", indent=True)
    para(doc, "2.APP：域名费用、服务器费用、软件著作权（软著）办理费用、苹果开发者账号认证费用（99美元/年）、上架应用商店相关费用；", indent=True)
    para(doc, "3.小程序：域名费用、服务器费用、小程序认证费用（微信小程序认证300元/年）。", indent=True)
    para(doc, "（三）其他费用可咨询客服。", indent=True)
    remark = data.get("remark")
    if remark:
        para(doc, "（四）补充说明：%s" % remark, indent=True)

    # 告知说明 + 落款（尽到告知义务即可，无需签字盖章，客户线上确认即生效）
    para(doc, "", before=20)
    para(doc, "告知：本报价单由帆远网络科技出具，用于说明项目开发范围与费用构成。客户通过企业微信、微信、电话、邮件等任一方式（含口头）确认本报价的，即视为报价确认，本报价单作为项目立项与结算依据。", indent=True)
    para(doc, "帆远网络科技", align=RIGHT, right_indent=56, before=16)
    para(doc, date_str, align=RIGHT, right_indent=56)

    doc.save(out_path)
    print("OK 已生成 %s（合计校验通过：%s 元）" % (out_path, format(total, ",")))


def main():
    if len(sys.argv) < 3:
        sys.exit("用法: python gen_quote.py content.json 输出.docx")
    with open(sys.argv[1], encoding="utf-8-sig") as f:
        data = json.load(f)
    for key in ("system_name", "total", "duration"):
        if data.get(key) in (None, "", []):
            sys.exit("content.json 缺少必填字段: %s" % key)
    if not data.get("modules") and not data.get("phases"):
        sys.exit("content.json 缺少必填字段: modules 或 phases 至少提供一项")
    out = os.path.abspath(sys.argv[2])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    build(data, out)


if __name__ == "__main__":
    main()
