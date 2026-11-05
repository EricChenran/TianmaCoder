# -*- coding: utf-8 -*-
"""方案书 DOCX 生成器：读一个 content.py，产出按附录 A 排版的 Word 文件。

用法：
    python docbuild.py <content.py 路径> -o <输出目录>
content.py 需提供 META(dict) 与 CONTENT(list)；图片放在 content.py 同级的 img/ 下。
"""
import os
import re
import sys
import datetime
import argparse
import importlib.util
from docx import Document
from docx.shared import Pt, Mm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ROW_HEIGHT_RULE
from docx.enum.section import WD_SECTION
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import qn

C = None                      # content 模块，由 load_content() 注入
HEI, KAI, FANG, SONG, EN = "黑体", "楷体", "仿宋", "宋体", "Times New Roman"
LINE = 28.8
TEXT_W = 156.0
TOC_BREAK = 20      # 目录第二页起始条目序号（0 基）
HERE = os.path.dirname(os.path.abspath(__file__))

# 以下 7 项由 content.py 的 META 覆盖
TITLE = ""
SUBTITLE = "技 术 方 案"
DOC_NAME = ""
ORG = "宜春市天码信息有限公司"
PROJECT_NO = "【项目编号】"
CLIENT = "【委托单位名称】"
IMG_DIR = ""
LOGO = os.path.join(HERE, "..", "assets", "logo_on_white.png")

_CN_DIGIT = "〇一二三四五六七八九"


def cn_num(n):
    if n <= 10:
        return "十" if n == 10 else _CN_DIGIT[n]
    if n < 20:
        return "十" + _CN_DIGIT[n % 10]
    tail = _CN_DIGIT[n % 10] if n % 10 else ""
    return _CN_DIGIT[n // 10] + "十" + tail


def cn_date(d):
    return "%s年%s月%s日" % ("".join(_CN_DIGIT[int(c)] for c in str(d.year)),
                             cn_num(d.month), cn_num(d.day))

PPR_ORDER = ["w:pStyle", "w:keepNext", "w:keepLines", "w:pageBreakBefore", "w:framePr",
             "w:widowControl", "w:numPr", "w:suppressLineNumbers", "w:pBdr", "w:shd",
             "w:tabs", "w:suppressAutoHyphens", "w:kinsoku", "w:wordWrap", "w:overflowPunct",
             "w:topLinePunct", "w:autoSpaceDE", "w:autoSpaceDN", "w:bidi", "w:adjustRightInd",
             "w:snapToGrid", "w:spacing", "w:ind", "w:contextualSpacing", "w:mirrorIndents",
             "w:suppressOverlap", "w:jc", "w:textDirection", "w:textAlignment",
             "w:textboxTightWrap", "w:outlineLvl", "w:divId", "w:cnfStyle", "w:rPr",
             "w:sectPr", "w:pPrChange"]

TBLPR_ORDER = ["w:tblStyle", "w:tblpPr", "w:tblOverlap", "w:bidiVisual", "w:tblStyleRowBandSize",
               "w:tblStyleColBandSize", "w:tblW", "w:jc", "w:tblCellSpacing", "w:tblInd",
               "w:tblBorders", "w:shd", "w:tblLayout", "w:tblCellMar", "w:tblLook",
               "w:tblCaption", "w:tblDescription"]

TRPR_ORDER = ["w:cnfStyle", "w:divId", "w:gridBefore", "w:gridAfter", "w:wBefore", "w:wAfter",
              "w:cantSplit", "w:trHeight", "w:tblHeader", "w:tblCellSpacing", "w:jc", "w:hidden",
              "w:ins", "w:del", "w:trPrChange"]

CJK = "\u4e00-\u9fff\u3000-\u303f\uff00-\uffef"
RE_1 = re.compile("(?<=[%s])[ \u00a0]+(?=\\d)" % CJK)
RE_2 = re.compile("(?<=[\\d%%℃])[ \u00a0]+(?=[%s])" % CJK)


def tighten(s):
    """中文与数字之间去掉空格，避免两端对齐时被拉成大空隙。"""
    s = RE_1.sub("", s)
    return RE_2.sub("", s)


def mm2tw(v):
    return int(round(v * 1440 / 25.4))


def put(pPr, el):
    tag = el.tag
    names = [qn(t) for t in PPR_ORDER]
    try:
        idx = names.index(tag)
    except ValueError:
        pPr.append(el)
        return el
    for child in pPr:
        if child.tag in names and names.index(child.tag) > idx:
            child.addprevious(el)
            return el
    pPr.append(el)
    return el


def put_tbl(tblPr, el):
    names = [qn(t) for t in TBLPR_ORDER]
    idx = names.index(el.tag)
    for child in tblPr:
        if child.tag in names and names.index(child.tag) > idx:
            child.addprevious(el)
            return el
    tblPr.append(el)
    return el


def put_tr(trPr, el):
    names = [qn(t) for t in TRPR_ORDER]
    idx = names.index(el.tag)
    for child in trPr:
        if child.tag in names and names.index(child.tag) > idx:
            child.addprevious(el)
            return el
    trPr.append(el)
    return el


def set_fonts(rPr, cn_name, en_name=EN):
    rFonts = rPr.find(qn("w:rFonts"))
    if rFonts is None:
        rFonts = OxmlElement("w:rFonts")
        rPr.insert(0, rFonts)
    for a in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
        if rFonts.get(qn(a)) is not None:
            del rFonts.attrib[qn(a)]
    rFonts.set(qn("w:ascii"), en_name)
    rFonts.set(qn("w:hAnsi"), en_name)
    rFonts.set(qn("w:eastAsia"), cn_name)
    rFonts.set(qn("w:cs"), en_name)


def style_font(style, cn_name, size, bold=False):
    style.font.name = EN
    style.font.size = Pt(size)
    style.font.bold = bold
    style.font.color.rgb = RGBColor(0, 0, 0)
    style.font.italic = False
    set_fonts(style.element.get_or_add_rPr(), cn_name)


def run_font(run, cn_name, size, bold=False):
    run.font.name = EN
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = RGBColor(0, 0, 0)
    run.font.italic = False
    set_fonts(run._r.get_or_add_rPr(), cn_name)


def pfmt(par, line=LINE, before=0, after=0, first_chars=200, left_chars=0,
         align=None, keep=False, page_break=False, before_lines=None, after_lines=None,
         snap=False, right_pt=None, first_pt=None, left_pt=None):
    pf = par.paragraph_format
    pf.line_spacing = Pt(line)
    pf.space_before = Pt(before)
    pf.space_after = Pt(after)
    if first_pt is not None:
        pf.first_line_indent = Pt(first_pt)
    else:
        pf.first_line_indent = Pt(first_chars / 100.0 * 16)
    if left_pt is not None:
        pf.left_indent = Pt(left_pt)
    else:
        pf.left_indent = Pt(left_chars / 100.0 * 16)
    if right_pt is not None:
        pf.right_indent = Pt(right_pt)
    else:
        pf.right_indent = Pt(0)
    if align is not None:
        pf.alignment = align
    pf.keep_with_next = keep
    if page_break:
        pf.page_break_before = True

    pPr = par._p.get_or_add_pPr()
    ind = pPr.find(qn("w:ind"))
    if first_pt is not None:
        ind.set(qn("w:firstLineChars"), "0")
    elif first_chars:
        ind.set(qn("w:firstLineChars"), str(first_chars))
    else:
        ind.set(qn("w:firstLineChars"), "0")
    if left_pt is not None:
        ind.set(qn("w:leftChars"), "0")
    elif left_chars:
        ind.set(qn("w:leftChars"), str(left_chars))
    else:
        ind.set(qn("w:leftChars"), "0")

    sp = pPr.find(qn("w:spacing"))
    if before_lines is not None:
        sp.set(qn("w:beforeLines"), str(before_lines))
    if after_lines is not None:
        sp.set(qn("w:afterLines"), str(after_lines))
    if not snap:
        el = OxmlElement("w:snapToGrid")
        el.set(qn("w:val"), "0")
        put(pPr, el)
    return par


def add_field(par, instr, cached, cn_name=SONG, size=14, bold=False):
    r1 = par.add_run()
    fc = OxmlElement("w:fldChar"); fc.set(qn("w:fldCharType"), "begin"); r1._r.append(fc)
    r2 = par.add_run()
    it = OxmlElement("w:instrText"); it.set(qn("xml:space"), "preserve"); it.text = instr
    r2._r.append(it)
    r3 = par.add_run()
    fc = OxmlElement("w:fldChar"); fc.set(qn("w:fldCharType"), "separate"); r3._r.append(fc)
    r4 = par.add_run(cached)
    r5 = par.add_run()
    fc = OxmlElement("w:fldChar"); fc.set(qn("w:fldCharType"), "end"); r5._r.append(fc)
    for r in (r1, r2, r3, r4, r5):
        run_font(r, cn_name, size, bold)
    return r4


def add_bookmark(par, name, bid):
    start = OxmlElement("w:bookmarkStart")
    start.set(qn("w:id"), str(bid))
    start.set(qn("w:name"), name)
    end = OxmlElement("w:bookmarkEnd")
    end.set(qn("w:id"), str(bid))
    par._p.insert(0, start)
    par._p.append(end)


# ---------------------------------------------------------------- 样式
def setup_styles(doc):
    normal = doc.styles["Normal"]
    style_font(normal, FANG, 16)
    pf = normal.paragraph_format
    pf.line_spacing = Pt(LINE)
    pf.space_before = Pt(0)
    pf.space_after = Pt(0)
    pf.first_line_indent = Pt(32)
    pf.left_indent = Pt(0)
    pf.right_indent = Pt(0)
    pf.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    ind = normal.element.get_or_add_pPr().find(qn("w:ind"))
    ind.set(qn("w:firstLineChars"), "200")

    h1 = doc.styles["Heading 1"]
    style_font(h1, HEI, 22)
    pf = h1.paragraph_format
    pf.line_spacing = Pt(LINE)
    pf.space_before = Pt(14)
    pf.space_after = Pt(14)
    pf.first_line_indent = Pt(0)
    pf.left_indent = Pt(0)
    pf.alignment = WD_ALIGN_PARAGRAPH.CENTER
    pf.keep_with_next = True
    sp = h1.element.get_or_add_pPr().find(qn("w:spacing"))
    sp.set(qn("w:beforeLines"), "50")
    sp.set(qn("w:afterLines"), "50")
    h1.element.get_or_add_pPr().find(qn("w:ind")).set(qn("w:firstLineChars"), "0")

    h2 = doc.styles["Heading 2"]
    style_font(h2, HEI, 16)
    pf = h2.paragraph_format
    pf.line_spacing = Pt(LINE)
    pf.space_before = Pt(0)
    pf.space_after = Pt(0)
    pf.first_line_indent = Pt(0)
    pf.left_indent = Pt(32)
    pf.alignment = WD_ALIGN_PARAGRAPH.LEFT
    pf.keep_with_next = True
    ind = h2.element.get_or_add_pPr().find(qn("w:ind"))
    ind.set(qn("w:leftChars"), "200")
    ind.set(qn("w:firstLineChars"), "0")

    for name, lv in (("toc 1", 1), ("toc 2", 2)):
        try:
            st = doc.styles[name]
        except KeyError:
            st = doc.styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
            st.base_style = doc.styles["Normal"]
        style_font(st, FANG, 16)
        pf = st.paragraph_format
        pf.line_spacing = Pt(LINE)
        pf.space_before = Pt(0)
        pf.space_after = Pt(0)
        pf.first_line_indent = Pt(0)
        pf.left_indent = Pt(0 if lv == 1 else 32)
        pf.alignment = WD_ALIGN_PARAGRAPH.LEFT
        pf.tab_stops.add_tab_stop(Mm(TEXT_W), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)
        ind = st.element.get_or_add_pPr().find(qn("w:ind"))
        ind.set(qn("w:firstLineChars"), "0")
        ind.set(qn("w:leftChars"), "0" if lv == 1 else "200")


def setup_section(sec, body=False):
    sec.page_width = Mm(210)
    sec.page_height = Mm(297)
    sec.top_margin = Mm(37)
    sec.bottom_margin = Mm(35)
    sec.left_margin = Mm(28)
    sec.right_margin = Mm(26)
    sec.header_distance = Mm(15)
    sec.footer_distance = Mm(25)
    sectPr = sec._sectPr
    grid = OxmlElement("w:docGrid")
    grid.set(qn("w:type"), "lines")
    grid.set(qn("w:linePitch"), "576")
    sectPr.insert_element_before(grid, "w:printerSettings", "w:sectPrChange")
    if body:
        pg = OxmlElement("w:pgNumType")
        pg.set(qn("w:start"), "1")
        pg.set(qn("w:fmt"), "decimal")
        sectPr.insert_element_before(pg, "w:cols", "w:docGrid")


WATERMARK = """<w:pict xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800"
 path="m@7,l@8,m@5,21600l@6,21600e">
<v:formulas><v:f eqn="sum #0 0 10800"/><v:f eqn="prod #0 2 1"/><v:f eqn="sum 21600 0 @1"/>
<v:f eqn="sum 0 0 @2"/><v:f eqn="sum 21600 0 @3"/><v:f eqn="if @0 @3 0"/>
<v:f eqn="if @0 21600 @1"/><v:f eqn="if @0 0 @2"/><v:f eqn="if @0 @4 21600"/>
<v:f eqn="mid @5 @6"/><v:f eqn="mid @8 @5"/><v:f eqn="mid @7 @8"/>
<v:f eqn="mid @6 @7"/><v:f eqn="sum @6 0 @5"/></v:formulas>
<v:path textpathok="t" o:connecttype="custom" o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800"
 o:connectangles="270,180,90,0"/>
<v:textpath on="t" fitshape="t"/>
<v:handles><v:h position="#0,bottomRight" xrange="6629,14971"/></v:handles>
<o:lock v:ext="edit" text="t" shapetype="t"/>
</v:shapetype>
<v:shape id="PowerPlusWaterMarkObject1" o:spid="_x0000_s1001" type="#_x0000_t136"
 style="position:absolute;left:0;text-align:left;margin-left:0;margin-top:0;width:400pt;height:100pt;rotation:315;z-index:-251658752;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin"
 o:allowincell="f" fillcolor="#d8d8d8" stroked="f">
<v:fill opacity=".4"/>
<v:textpath style="font-family:&quot;宋体&quot;;font-size:1pt" string="{text}"/>
</v:shape></w:pict>"""


def add_watermark(par, text):
    r = par.add_run()
    r._r.append(parse_xml(WATERMARK.format(text=text)))
    return r


def setup_header(sec, with_title):
    """页眉：左上 LOGO + 居中文件名 + 0.5 磅细线，整段叠水印（奇偶页相同）。"""
    for hdr in (sec.header, sec.even_page_header):
        hdr.is_linked_to_previous = False
        for p in list(hdr.paragraphs):
            p.text = ""
        hp = hdr.paragraphs[0]
        pfmt(hp, line=16, first_chars=0, align=WD_ALIGN_PARAGRAPH.LEFT)
        hp.paragraph_format.line_spacing = 1.0
        hp.paragraph_format.tab_stops.add_tab_stop(Mm(TEXT_W / 2.0), WD_TAB_ALIGNMENT.CENTER)
        hp.paragraph_format.tab_stops.add_tab_stop(Mm(TEXT_W), WD_TAB_ALIGNMENT.RIGHT)
        hp.add_run().add_picture(LOGO, height=Mm(7.5))
        hp.add_run("\t")
        if with_title:
            rt = hp.add_run(DOC_NAME)
            run_font(rt, SONG, 9)
            pos = OxmlElement("w:position")
            pos.set(qn("w:val"), "12")
            rt._r.get_or_add_rPr().insert_element_before(
                pos, "w:sz", "w:szCs", "w:highlight", "w:u", "w:effect", "w:bdr", "w:shd",
                "w:fitText", "w:vertAlign", "w:rtl", "w:cs", "w:em", "w:lang",
                "w:eastAsianLayout", "w:specVanish", "w:oMath")
        hp.add_run("\t")
        add_watermark(hp, ORG)
        pPr = hp._p.get_or_add_pPr()
        bdr = OxmlElement("w:pBdr")
        bottom = OxmlElement("w:bottom")
        bottom.set(qn("w:val"), "single")
        bottom.set(qn("w:sz"), "4")
        bottom.set(qn("w:space"), "1")
        bottom.set(qn("w:color"), "000000")
        bdr.append(bottom)
        put(pPr, bdr)


def setup_footer(sec, numbered):
    for obj in (sec.footer, sec.even_page_footer, sec.first_page_footer):
        obj.is_linked_to_previous = False
        for p in list(obj.paragraphs):
            p.text = ""
    if not numbered:
        return

    def fill(par, align, right_pt=0.0, left_pt=0.0):
        pfmt(par, line=18, first_chars=0, align=align, right_pt=right_pt or None,
             left_pt=left_pt or None)
        run_font(par.add_run("—\u2002"), SONG, 14)
        add_field(par, " PAGE ", "1")
        run_font(par.add_run("\u2002—"), SONG, 14)

    fill(sec.footer.paragraphs[0], WD_ALIGN_PARAGRAPH.RIGHT, right_pt=14.0)
    fill(sec.even_page_footer.paragraphs[0], WD_ALIGN_PARAGRAPH.LEFT, left_pt=14.0)


# ---------------------------------------------------------------- 内容块
def para(doc, text):
    p = doc.add_paragraph()
    run_font(p.add_run(tighten(text)), FANG, 16)
    return p


def lead_para(doc, head, body):
    p = doc.add_paragraph()
    run_font(p.add_run(tighten(head)), KAI, 16)
    if body:
        run_font(p.add_run(tighten(body)), FANG, 16)
    return p


def heading(doc, text, level, first=False):
    p = doc.add_paragraph(style="Heading 1" if level == 1 else "Heading 2")
    run_font(p.add_run(text), HEI, 22 if level == 1 else 16)
    if level == 1 and not first:
        pfmt(p, line=LINE, before=14, after=14, first_chars=0, align=WD_ALIGN_PARAGRAPH.CENTER,
             keep=True, page_break=True, before_lines=50, after_lines=50)
    elif level == 2:
        pfmt(p, line=LINE, before=0, after=0, first_chars=0, left_chars=200,
             align=WD_ALIGN_PARAGRAPH.LEFT, keep=True)
    return p


def caption(doc, text, before=6, after=3, keep=True):
    p = doc.add_paragraph()
    pfmt(p, line=20, before=before, after=after, first_chars=0,
         align=WD_ALIGN_PARAGRAPH.CENTER, keep=keep)
    run_font(p.add_run(tighten(text)), HEI, 12)
    return p


def add_figure(doc, fname, cap, width=154.0):
    p = doc.add_paragraph()
    pfmt(p, line=LINE, before=3, after=0, first_chars=0,
         align=WD_ALIGN_PARAGRAPH.CENTER, keep=True)
    p.paragraph_format.line_spacing = 1.0
    p.add_run().add_picture(os.path.join(IMG_DIR, fname), width=Mm(width))
    caption(doc, cap, before=2, after=5, keep=False)


def _cell_text(cell, text, cn_name=FANG, size=10.5, align="left"):
    cell.vertical_alignment = 1
    p = cell.paragraphs[0]
    pfmt(p, line=13.6, before=0, after=0, first_chars=0,
         align={"l": WD_ALIGN_PARAGRAPH.LEFT, "c": WD_ALIGN_PARAGRAPH.CENTER,
                "r": WD_ALIGN_PARAGRAPH.RIGHT}[align])
    p.paragraph_format.line_spacing = 1.0
    run_font(p.add_run(tighten(text)), cn_name, size)


def add_table(doc, spec):
    caption(doc, spec["caption"])
    headers, rows, widths = spec["headers"], spec["rows"], spec["widths"]
    aligns = spec.get("aligns", ["l"] * len(headers))
    table = doc.add_table(rows=1 + len(rows), cols=len(headers))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    tblPr = table._tbl.tblPr

    for tag in ("w:tblW", "w:tblBorders", "w:tblCellMar"):
        for el in tblPr.findall(qn(tag)):
            tblPr.remove(el)

    tw = OxmlElement("w:tblW")
    tw.set(qn("w:type"), "dxa")
    tw.set(qn("w:w"), str(mm2tw(sum(widths))))
    put_tbl(tblPr, tw)

    borders = OxmlElement("w:tblBorders")
    for edge, val, sz in (("top", "single", 12), ("left", "none", 0), ("bottom", "single", 12),
                          ("right", "none", 0), ("insideH", "none", 0), ("insideV", "none", 0)):
        e = OxmlElement("w:" + edge)
        e.set(qn("w:val"), val)
        e.set(qn("w:sz"), str(sz))
        e.set(qn("w:space"), "0")
        e.set(qn("w:color"), "000000")
        borders.append(e)
    put_tbl(tblPr, borders)

    mar = OxmlElement("w:tblCellMar")
    for side, v in (("top", 20), ("left", 85), ("bottom", 20), ("right", 85)):
        e = OxmlElement("w:" + side)
        e.set(qn("w:w"), str(v))
        e.set(qn("w:type"), "dxa")
        mar.append(e)
    put_tbl(tblPr, mar)

    for i, w in enumerate(widths):
        table.columns[i].width = Mm(w)

    hdr = table.rows[0]
    trPr = hdr._tr.get_or_add_trPr()
    put_tr(trPr, OxmlElement("w:tblHeader"))
    put_tr(trPr, OxmlElement("w:cantSplit"))
    hdr.height = Mm(8)
    hdr.height_rule = WD_ROW_HEIGHT_RULE.AT_LEAST
    for i, h in enumerate(headers):
        cell = hdr.cells[i]
        cell.width = Mm(widths[i])
        tcPr = cell._tc.get_or_add_tcPr()
        shd = OxmlElement("w:shd")
        shd.set(qn("w:val"), "clear")
        shd.set(qn("w:color"), "auto")
        shd.set(qn("w:fill"), "F2F2F2")
        tcPr.append(shd)
        tcB = OxmlElement("w:tcBorders")
        b = OxmlElement("w:bottom")
        b.set(qn("w:val"), "single")
        b.set(qn("w:sz"), "6")
        b.set(qn("w:space"), "0")
        b.set(qn("w:color"), "000000")
        tcB.append(b)
        tcPr.append(tcB)
        _cell_text(cell, h, HEI, 10.5, "c")

    for ri, row in enumerate(rows):
        tr = table.rows[ri + 1]
        put_tr(tr._tr.get_or_add_trPr(), OxmlElement("w:cantSplit"))
        tr.height = Mm(5.6)
        tr.height_rule = WD_ROW_HEIGHT_RULE.AT_LEAST
        for ci, val in enumerate(row):
            cell = tr.cells[ci]
            cell.width = Mm(widths[ci])
            _cell_text(cell, val, FANG, 10.5, aligns[ci])
            if ri < len(rows) - 1:
                cell.paragraphs[0].paragraph_format.keep_with_next = True

    sp = doc.add_paragraph()
    pfmt(sp, line=12, before=0, after=0, first_chars=0)


# ---------------------------------------------------------------- 封面
def build_cover(doc):
    def blank(n, h=LINE):
        for _ in range(n):
            p = doc.add_paragraph()
            pfmt(p, line=h, before=0, after=0, first_chars=0)

    blank(6)
    p = doc.add_paragraph()
    pfmt(p, line=35, before=0, after=0, first_chars=0, align=WD_ALIGN_PARAGRAPH.CENTER)
    run_font(p.add_run(TITLE), SONG, 22, bold=True)

    blank(1)
    p = doc.add_paragraph()
    pfmt(p, line=LINE, before=0, after=0, first_chars=0, align=WD_ALIGN_PARAGRAPH.CENTER)
    run_font(p.add_run(SUBTITLE), KAI, 16)

    blank(7)
    for label, val in (("项目编号", PROJECT_NO),
                       ("委托单位", CLIENT),
                       ("编制单位", ORG),
                       ("编制日期", cn_date(datetime.date.today()))):
        p = doc.add_paragraph()
        pfmt(p, line=32, before=0, after=0, first_chars=0, align=WD_ALIGN_PARAGRAPH.CENTER)
        run_font(p.add_run("%s：%s" % (label, val)), FANG, 16)


# ---------------------------------------------------------------- 目录
def build_toc(doc, heads):
    def title(text, page_break=False):
        p = doc.add_paragraph()
        pfmt(p, line=32, before=0, after=18, first_chars=0,
             align=WD_ALIGN_PARAGRAPH.CENTER, page_break=page_break)
        run_font(p.add_run(text), HEI, 16)

    title("目　　录")

    for i, (lvl, text, bookmark) in enumerate(heads):
        if i == TOC_BREAK:
            title("目　　录（续）", page_break=True)
        par = doc.add_paragraph(style="toc 1" if lvl == 1 else "toc 2")
        pfmt(par, line=LINE, before=0, after=0, first_chars=0,
             left_chars=0 if lvl == 1 else 200)
        run_font(par.add_run(text), FANG, 16)
        run_font(par.add_run("\t"), FANG, 16)
        add_field(par, " PAGEREF %s \\h " % bookmark, "1", FANG, 16)


# ---------------------------------------------------------------- 主流程
def apply_meta(meta):
    global TITLE, SUBTITLE, DOC_NAME, ORG, PROJECT_NO, CLIENT, IMG_DIR, TOC_BREAK
    TITLE = meta.get("title") or TITLE
    SUBTITLE = meta.get("subtitle") or SUBTITLE
    DOC_NAME = meta.get("doc_name") or (TITLE + "建设方案")
    ORG = meta.get("org") or ORG
    PROJECT_NO = meta.get("project_no") or PROJECT_NO
    CLIENT = meta.get("client") or CLIENT
    IMG_DIR = meta["img_dir"]
    if meta.get("toc_break"):
        TOC_BREAK = int(meta["toc_break"])
    LOGO_OVERRIDE = meta.get("logo")


def build(out_path):
    heads = []
    for blk in C.CONTENT:
        if blk[0] in ("h1", "h2"):
            heads.append((1 if blk[0] == "h1" else 2, blk[1], "_Toc%04d" % (len(heads) + 1)))

    doc = Document()
    cp = doc.core_properties
    cp.title = DOC_NAME
    cp.subject = SUBTITLE
    cp.category = "项目方案书"
    cp.comments = "按 GB/T 9704—2012 版式规范排版"
    setup_styles(doc)
    setup_section(doc.sections[0])
    setup_header(doc.sections[0], with_title=False)
    setup_footer(doc.sections[0], numbered=False)
    build_cover(doc)

    doc.add_section(WD_SECTION.NEW_PAGE)
    sec2 = doc.sections[-1]
    setup_section(sec2)
    setup_header(sec2, with_title=True)
    setup_footer(sec2, numbered=False)
    build_toc(doc, heads)

    doc.add_section(WD_SECTION.NEW_PAGE)
    sec3 = doc.sections[-1]
    setup_section(sec3, body=True)
    setup_header(sec3, with_title=True)
    setup_footer(sec3, numbered=True)

    hi = 0
    for blk in C.CONTENT:
        kind = blk[0]
        if kind in ("h1", "h2"):
            p = heading(doc, blk[1], 1 if kind == "h1" else 2, first=(hi == 0))
            add_bookmark(p, heads[hi][2], 100 + hi)
            hi += 1
        elif kind == "lead":
            lead_para(doc, blk[1], blk[2])
        elif kind == "p":
            para(doc, blk[1])
        elif kind == "fig":
            add_figure(doc, blk[1], blk[2], blk[3] if len(blk) > 3 else 154.0)
        elif kind == "tbl":
            add_table(doc, blk[1])
        elif kind == "pagebreak":
            doc.add_page_break()

    settings = doc.settings.element
    eo = OxmlElement("w:evenAndOddHeaders")
    settings.append(eo)

    doc.save(out_path)
    return heads


def load_content(path):
    """导入用户的 content.py，返回模块。"""
    path = os.path.abspath(path)
    d = os.path.dirname(path)
    if d not in sys.path:
        sys.path.insert(0, d)
    spec = importlib.util.spec_from_file_location("proposal_content", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main(argv=None):
    global C
    ap = argparse.ArgumentParser(description="生成方案书 DOCX")
    ap.add_argument("content", help="content.py 路径")
    ap.add_argument("-o", "--outdir", default=".", help="输出目录")
    ap.add_argument("-n", "--name", default="", help="输出文件名（不含扩展名）")
    args = ap.parse_args(argv)

    C = load_content(args.content)
    meta = dict(getattr(C, "META", {}))
    meta["img_dir"] = os.path.join(os.path.dirname(os.path.abspath(args.content)), "img")
    apply_meta(meta)

    os.makedirs(args.outdir, exist_ok=True)
    name = args.name or DOC_NAME
    out = os.path.join(args.outdir, name + ".docx")
    heads = build(out)
    print("saved %s (%d headings)" % (out, len(heads)))
    return out


if __name__ == "__main__":
    main()
