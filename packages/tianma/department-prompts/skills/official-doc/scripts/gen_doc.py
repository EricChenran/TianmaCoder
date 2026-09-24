#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_doc.py — 宜春天码信息集团企业公文生成器（DOCX + PDF 一步生成）

用法:
    python gen_doc.py <content.json> [-o 输出目录或 .docx 路径]

版式（参照 GB/T 9704-2012 的企业公文惯例版）:
    A4；页边距 上37/下35/左28/右26mm（版心156×225mm）
    红头   小初36磅 小标宋(缺省宋体加粗) 红色 居中，上方居中排LOGO
    文号   三号仿宋 居中，红线上方
    红线   1.5磅红色分隔线
    标题   二号 小标宋(缺省宋体加粗) 居中
    正文   三号仿宋，行距固定28磅，首行缩进2字符，两端对齐
    一级标题 三号黑体 / 二级 三号楷体 / 三级 三号仿宋加粗（均缩进2字符）
    落款   署名右空二字对齐成文日期、成文日期右空四字（以宽度自动居中对齐）
    页码   四号宋体 "— N —"，单页码右空一字、双页码左空一字
    版记   四号仿宋（抄送/印发单位），上下细横线

字体按本机实际安装自动择优:
    标题类: 方正小标宋_GBK > 方正小标宋简体 > 方正小标宋 > 华文中宋 > 宋体
    正文类: 仿宋_GB2312 > 仿宋 ；二级: 楷体_GB2312 > 楷体 ；一级: 黑体
    PDF 由内置排版引擎直接生成并内嵌中文字体，不依赖 Word/WPS/LibreOffice。
"""
import argparse
import datetime
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LOGO = os.path.join(HERE, "..", "assets", "logo_light.png")

MM = 72.0 / 25.4  # 1mm 的磅数
PAGE_W, PAGE_H = 210 * MM, 297 * MM
M_TOP, M_BOTTOM, M_LEFT, M_RIGHT = 37 * MM, 35 * MM, 28 * MM, 26 * MM
CONTENT_W = PAGE_W - M_LEFT - M_RIGHT            # 442.2pt
FS_LETTERHEAD, FS_TITLE, FS_BODY, FS_PAGE = 36, 22, 16, 14
LINE_H = 28.0                                     # 正文固定行距
RED = (1.0, 0.0, 0.0)
BLACK = (0.0, 0.0, 0.0)

# 字体角色 → 候选（按优先级）
FONT_ROLES = {
    "TITLE": ["方正小标宋_GBK", "方正小标宋简体", "方正小标宋", "华文中宋", "宋体"],
    "FS":    ["仿宋_GB2312", "仿宋", "FangSong"],
    "HEI":   ["黑体", "SimHei"],
    "KT":    ["楷体_GB2312", "楷体", "KaiTi"],
    "SONG":  ["宋体", "SimSun"],
}

NO_START = set("，。、；：？！）】》」』”’%﹚］｝·…—～")
NO_END = set("（【《「『“‘%（[｛［")


# ---------------------------------------------------------------- 字体解析
def font_registry():
    """Windows 已安装字体: {显示名小写: 文件路径}；非 Windows 返回空表。"""
    mapping = {}
    try:
        import winreg
    except ImportError:
        return mapping
    windir = os.environ.get("WINDIR", r"C:\Windows")
    for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        try:
            key = winreg.OpenKey(root, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts")
        except OSError:
            continue
        with key:
            i = 0
            while True:
                try:
                    name, fname, _ = winreg.EnumValue(key, i)
                except OSError:
                    break
                i += 1
                fname = str(fname).strip()
                path = fname if os.path.isabs(fname) else os.path.join(windir, "Fonts", fname)
                if os.path.isfile(path):
                    mapping[name.lower()] = path
    return mapping


def pick_font(role, reg):
    """按候选优先级返回 (字体族名, ttf路径或None)。"""
    for cand in FONT_ROLES[role]:
        for disp, path in reg.items():
            base = disp.split("(")[0].strip()
            if base == cand.lower():
                return cand, path
    for cand in FONT_ROLES[role]:
        for disp, path in reg.items():
            base = disp.split("(")[0].strip()
            if cand.lower() in base:
                return cand, path
    return FONT_ROLES[role][-1], None


def resolve_fonts():
    reg = font_registry()
    fams, paths = {}, {}
    for role in FONT_ROLES:
        fams[role], paths[role] = pick_font(role, reg)
    return fams, paths


# ---------------------------------------------------------------- 文本工具
def text_width(s, fs):
    """按全角/半角估算字符串宽度（磅）。"""
    return sum(fs if ord(c) > 0x2000 else fs * 0.5 for c in s)


def fit_size(text, base, max_w):
    units = sum(1.0 if ord(c) > 0x2000 else 0.5 for c in text)
    if units <= 0:
        return base
    return min(base, max(18, int(max_w / units * 0.96)))


def _tokens(text):
    """连续 ASCII 字母数字合为一个 token，避免数字/英文被拆断跨行。"""
    toks, cur = [], ""
    for ch in text:
        if ord(ch) < 128 and (ch.isalnum() or ch in "%.,"):
            cur += ch
        else:
            if cur:
                toks.append(cur)
                cur = ""
            toks.append(ch)
    if cur:
        toks.append(cur)
    return toks


def wrap_cjk(text, width, measure):
    """中文避头尾换行，返回行列表。measure(s) 返回字符串渲染宽度（磅）。"""
    lines, cur = [], ""
    for tok in _tokens(text):
        if cur and measure(cur + tok) > width:
            lines.append(cur)
            cur = tok
        else:
            cur += tok
    if cur:
        lines.append(cur)
    # 避头尾：下一行行首禁排标点回退到上一行行尾
    for i in range(len(lines) - 1):
        moved = True
        while moved and lines[i + 1]:
            moved = False
            if lines[i + 1][0] in NO_START and len(lines[i]) > 1:
                lines[i + 1] = lines[i][-1] + lines[i + 1]
                lines[i] = lines[i][:-1]
                moved = True
            elif lines[i][-1] in NO_END and len(lines[i]) > 1:
                lines[i + 1] = lines[i][-1] + lines[i + 1]
                lines[i] = lines[i][:-1]
                moved = True
    return lines


# ---------------------------------------------------------------- DOCX 构建
def build_docx(cfg, fams, out_path):
    from docx import Document
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_TAB_ALIGNMENT
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Mm, Pt, RGBColor

    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Mm(210), Mm(297)
    sec.top_margin, sec.bottom_margin = Mm(37), Mm(35)
    sec.left_margin, sec.right_margin = Mm(28), Mm(26)
    sec.footer_distance = Mm(22)

    # 默认样式：正文三号仿宋
    normal = doc.styles["Normal"]
    normal.font.name = fams["FS"]
    normal.font.size = Pt(FS_BODY)
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), fams["FS"])

    # 奇偶页页码
    doc.settings.element.append(OxmlElement("w:evenAndOddHeaders"))

    def R(p, text, ea, size, bold=False, color=None):
        run = p.add_run(text)
        run.font.name = ea
        run.font.size = Pt(size)
        run.font.bold = bold
        if color:
            run.font.color.rgb = RGBColor(*[int(round(v * 255)) for v in color])
        run._element.rPr.rFonts.set(qn("w:eastAsia"), ea)
        return run

    def P(align=None, exact=LINE_H, before=0, after=0, first_chars=0, left_pt=0.0,
          right_pt=0.0):
        p = doc.add_paragraph()
        pf = p.paragraph_format
        if align:
            p.alignment = align
        if exact:
            pf.line_spacing = Pt(exact)
            pf.line_spacing_rule = WD_LINE_SPACING.EXACTLY
        pf.space_before, pf.space_after = Pt(before), Pt(after)
        ind = p._p.get_or_add_pPr().get_or_add_ind()
        if first_chars:
            ind.set(qn("w:firstLineChars"), str(first_chars))
            ind.set(qn("w:firstLine"), str(int(first_chars / 100 * FS_BODY * 20)))
        if left_pt:
            ind.set(qn("w:left"), str(int(left_pt * 20)))
        if right_pt:
            ind.set(qn("w:right"), str(int(right_pt * 20)))
        return p

    def border(p, edges, color="000000", sz=4):
        pBdr = OxmlElement("w:pBdr")
        for e in edges:
            el = OxmlElement("w:" + e)
            el.set(qn("w:val"), "single")
            el.set(qn("w:sz"), str(sz))
            el.set(qn("w:space"), "1")
            el.set(qn("w:color"), color)
            pBdr.append(el)
        p._p.get_or_add_pPr().append(pBdr)

    # ---- 页码 ----
    def footer_para(footer, odd):
        footer.is_linked_to_previous = False
        p = footer.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT if odd else WD_ALIGN_PARAGRAPH.LEFT
        pf = p.paragraph_format
        if odd:
            pf.right_indent = Pt(14)
        else:
            pf.left_indent = Pt(14)
        R(p, "— ", fams["SONG"], FS_PAGE)
        fld = OxmlElement("w:fldSimple")
        fld.set(qn("w:instr"), r" PAGE \* MERGEFORMAT ")
        r = OxmlElement("w:r")
        rPr = OxmlElement("w:rPr")
        rf = OxmlElement("w:rFonts")
        rf.set(qn("w:ascii"), fams["SONG"])
        rf.set(qn("w:hAnsi"), fams["SONG"])
        rf.set(qn("w:eastAsia"), fams["SONG"])
        szv = OxmlElement("w:sz")
        szv.set(qn("w:val"), str(FS_PAGE * 2))
        rPr.append(rf)
        rPr.append(szv)
        r.append(rPr)
        t = OxmlElement("w:t")
        t.text = "1"
        r.append(t)
        fld.append(r)
        p._p.append(fld)
        R(p, " —", fams["SONG"], FS_PAGE)

    footer_para(sec.footer, odd=True)
    footer_para(sec.even_page_footer, odd=False)

    # ---- 密级 / 紧急程度 ----
    head = "　".join(x for x in (cfg.get("secret", ""), cfg.get("urgency", "")) if x)
    if head:
        p = P(align=WD_ALIGN_PARAGRAPH.LEFT, after=LINE_H)
        R(p, head, fams["HEI"], FS_BODY)

    # ---- 页眉LOGO（每页左上角，不占正文版面）----
    if cfg.get("logo", True) and os.path.isfile(LOGO):
        from PIL import Image as PILImage
        with PILImage.open(LOGO) as im:
            w_px, h_px = im.size
        sec.header_distance = Mm(13)
        hdr = sec.header
        hdr.is_linked_to_previous = False
        hp = hdr.paragraphs[0]
        hp.alignment = WD_ALIGN_PARAGRAPH.LEFT
        hp.paragraph_format.space_before = Pt(0)
        hp.paragraph_format.space_after = Pt(0)
        hp.add_run().add_picture(LOGO, height=Mm(12))

    # ---- 红头 ----
    letterhead = cfg.get("letterhead") or "宜春天码信息集团文件"
    lh_size = fit_size(letterhead, FS_LETTERHEAD, CONTENT_W)
    p = P(align=WD_ALIGN_PARAGRAPH.CENTER, exact=int(lh_size * 1.3), before=4, after=2)
    R(p, letterhead, fams["TITLE"], lh_size, bold=True, color=RED)

    # ---- 文号 / 签发人 ----
    year = datetime.date.today().year
    doc_number = cfg.get("doc_number")
    if doc_number is None or doc_number == "":
        doc_number = "天码发〔%d〕　号" % year
    signer = cfg.get("signer", "")
    if signer:
        tbl = doc.add_table(rows=1, cols=2)
        tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
        tbl.autofit = False
        for cell, w in zip(tbl.rows[0].cells, (Mm(90), Mm(66))):
            cell.width = w
        pl = tbl.rows[0].cells[0].paragraphs[0]
        pl.paragraph_format.left_indent = Pt(FS_BODY)
        R(pl, doc_number, fams["FS"], FS_BODY)
        pr = tbl.rows[0].cells[1].paragraphs[0]
        pr.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        pr.paragraph_format.right_indent = Pt(FS_BODY)
        R(pr, "签发人：", fams["FS"], FS_BODY)
        R(pr, signer, fams["KT"], FS_BODY)
    else:
        p = P(align=WD_ALIGN_PARAGRAPH.CENTER, after=6)
        R(p, doc_number, fams["FS"], FS_BODY)

    # ---- 红色分隔线 ----
    p = P(exact=6, before=2, after=0)
    border(p, ("bottom",), color="FF0000", sz=12)

    # ---- 标题 ----
    title = cfg["title"]
    p = P(align=WD_ALIGN_PARAGRAPH.CENTER, exact=32, before=24, after=8)
    R(p, title, fams["TITLE"], FS_TITLE, bold=True)

    # ---- 主送机关 ----
    recipient = cfg.get("recipient", "")
    if recipient:
        p = P(align=WD_ALIGN_PARAGRAPH.LEFT)
        R(p, recipient, fams["FS"], FS_BODY)

    # ---- 正文 ----
    AMAP = {"p": WD_ALIGN_PARAGRAPH.JUSTIFY, "h1": WD_ALIGN_PARAGRAPH.JUSTIFY,
            "h2": WD_ALIGN_PARAGRAPH.JUSTIFY, "h3": WD_ALIGN_PARAGRAPH.JUSTIFY,
            "att_head": WD_ALIGN_PARAGRAPH.LEFT}
    last_body_p = None
    for item in cfg.get("body", []):
        t = item.get("t", "p")
        if t == "page":
            doc.add_page_break()
            last_body_p = None
            continue
        x = item.get("x", "")
        p = P(align=AMAP.get(t, WD_ALIGN_PARAGRAPH.JUSTIFY),
              first_chars=0 if t == "att_head" else 200)
        if t == "h1":
            R(p, x, fams["HEI"], FS_BODY)
        elif t == "h2":
            R(p, x, fams["KT"], FS_BODY)
        elif t == "h3":
            R(p, x, fams["FS"], FS_BODY, bold=True)
        else:
            R(p, x, fams["FS"], FS_BODY)
        last_body_p = p

    # ---- 附件说明 ----
    atts = cfg.get("attachments") or []
    att_ps = []
    if atts:
        for i, a in enumerate(atts):
            prefix = "附件：" if i == 0 else ""
            left = FS_BODY * 2 if i == 0 else FS_BODY * (2 + 3)
            p = P(align=WD_ALIGN_PARAGRAPH.LEFT, before=LINE_H if i == 0 else 0,
                  left_pt=left)
            R(p, prefix + a, fams["FS"], FS_BODY)
            att_ps.append(p)

    # ---- 落款 ----
    signature = cfg.get("signature") or ""
    date = cfg.get("date") or datetime.date.today().strftime("%Y年%m月%d日")
    if signature:
        wn, wd_ = text_width(signature, FS_BODY), text_width(date, FS_BODY)
        base = FS_BODY * 4  # 日期右空四字
        if wn >= wd_:
            rn, rd = base, base + (wn - wd_) / 2
        else:
            rn, rd = base + (wd_ - wn) / 2, base
        p = P(align=WD_ALIGN_PARAGRAPH.RIGHT, before=LINE_H, right_pt=rn)
        R(p, signature, fams["FS"], FS_BODY)
        p.paragraph_format.keep_with_next = True
        p = P(align=WD_ALIGN_PARAGRAPH.RIGHT, right_pt=rd)
        R(p, date, fams["FS"], FS_BODY)
        # 落款不与正文/附件说明分面：最后一段正文及附件说明设 keepNext
        for q in ([last_body_p] if last_body_p is not None else []) + att_ps:
            q.paragraph_format.keep_with_next = True

    # ---- 版记 ----
    cc, issuer = cfg.get("cc", ""), cfg.get("issuer", "")
    if cc or issuer:
        first = True
        if cc:
            p = P(align=WD_ALIGN_PARAGRAPH.LEFT, exact=None, before=LINE_H if first else 6,
                  left_pt=FS_BODY)
            border(p, ("top",))
            R(p, cc, fams["FS"], FS_PAGE)
            first = False
        if issuer:
            p = P(align=WD_ALIGN_PARAGRAPH.LEFT, exact=None, before=6 if first else 0,
                  left_pt=FS_BODY, right_pt=FS_BODY)
            border(p, ("top", "bottom"))
            p.paragraph_format.tab_stops.add_tab_stop(
                Pt(CONTENT_W - FS_BODY * 2), WD_TAB_ALIGNMENT.RIGHT)
            R(p, issuer, fams["FS"], FS_PAGE)
            R(p, "\t" + date + "印发", fams["FS"], FS_PAGE)

    doc.save(out_path)


# ---------------------------------------------------------------- PDF 构建
def build_pdf(cfg, fams, paths, out_path):
    from reportlab.lib.colors import Color
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas as pdfcanvas

    pdf_font = {}
    fallback = {"TITLE": "simsun.ttc", "FS": "simfang.ttf", "HEI": "simhei.ttf",
                "KT": "simkai.ttf", "SONG": "simsun.ttc"}
    windir = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    for role in FONT_ROLES:
        name = "PDF_" + role
        path = paths[role] or os.path.join(windir, fallback[role])
        pdfmetrics.registerFont(TTFont(name, path, subfontIndex=0))
        pdf_font[role] = name

    blocks = layout_blocks(cfg, fams)
    colophon = next((b for b in blocks if b.get("kind") == "colophon"), None)
    flow_blocks = [b for b in blocks if b.get("kind") != "colophon"]

    # 页眉LOGO尺寸（每页左上角）
    logo_dims = None
    if cfg.get("logo", True) and os.path.isfile(LOGO):
        from PIL import Image as PILImage
        with PILImage.open(LOGO) as im:
            ratio = im.size[0] / im.size[1]
        h_logo = 12 * MM
        logo_dims = (h_logo * ratio, h_logo)

    def render_once(target, line_h):
        """渲染整篇；返回 {sig_orphan: 落款是否孤悬页首}。"""
        c = pdfcanvas.Canvas(target, pagesize=(PAGE_W, PAGE_H))
        c.setTitle(cfg.get("title", "公文"))
        st = {"page": 0, "y": PAGE_H - M_TOP, "first": True,
              "sig_pages": [], "body_page": None}

        def footer():
            n = st["page"]
            if n <= 0:
                return
            # 页眉LOGO：每页左上角，距页顶13mm
            if logo_dims:
                w, h = logo_dims
                c.drawImage(LOGO, M_LEFT, PAGE_H - 13 * MM - h, w, h, mask="auto")
            label = "— %d —" % n
            c.setFont(pdf_font["SONG"], FS_PAGE)
            c.setFillColorRGB(*BLACK)
            y = M_BOTTOM * 0.72
            if n % 2 == 1:
                c.drawRightString(PAGE_W - M_RIGHT - FS_PAGE, y, label)
            else:
                c.drawString(M_LEFT + FS_PAGE, y, label)

        def new_page():
            footer()
            c.showPage()
            st["page"] += 1
            st["y"] = PAGE_H - M_TOP
            st["first"] = True

        st["page"] = 1

        def ensure(h):
            if st["y"] - h < M_BOTTOM:
                new_page()

        def draw_line(text, x, y, role, size, bold, color):
            # PDF 的 Tr（文本渲染模式）会跨 BT/ET 残留，而 reportlab 的
            # PDFTextObject 只在"值变化"时才写出算子，导致常规文字继承
            # 红头的 2 Tr + 红色描边。这里显式写入算子，强制重置。
            t = c.beginText(x, y)
            t._code.append("%d Tr" % (2 if bold else 0))
            t.setFont(pdf_font[role], size)
            t.setFillColorRGB(*color)
            if bold:
                c.setLineWidth(size * 0.028)
                t.setStrokeColorRGB(*color)
            t.textOut(text)
            c.drawText(t)

        def mark(blk):
            if blk.get("tag", "").startswith("sig"):
                st["sig_pages"].append(st["page"])
            else:
                st["body_page"] = st["page"]
            st["first"] = False

        def emit(blk):
            kind = blk.get("kind", "text")
            if kind == "page":
                new_page()
                return
            st["y"] -= blk.get("space_before", 0)
            if kind == "image":
                h = blk["h"]
                ensure(h + blk.get("space_after", 0))
                c.drawImage(LOGO, (PAGE_W - blk["w"]) / 2, st["y"] - h, blk["w"], h,
                            mask="auto")
                st["y"] -= h + blk.get("space_after", 0)
                st["first"] = False
                return
            if kind == "rule":
                ensure(blk.get("w", 1.5) + 12)
                yy = st["y"] - 3
                c.setStrokeColorRGB(*blk.get("color", RED))
                c.setLineWidth(blk.get("w", 1.5))
                c.line(M_LEFT, yy, M_LEFT + CONTENT_W, yy)
                st["y"] = yy - blk.get("space_after", 0)
                st["first"] = False
                return
            if kind == "samerow":  # 同一行左右两端（文号 + 签发人）
                ensure(blk.get("leading", line_h))
                mark(blk)
                size = blk["size"]
                baseline = st["y"] - size * 0.84
                draw_line(blk["left"], M_LEFT + blk.get("left_indent", 0), baseline,
                          blk["left_role"], size, False, BLACK)
                rw = pdfmetrics.stringWidth(blk["right"], pdf_font[blk["right_role"]], size)
                draw_line(blk["right"], M_LEFT + CONTENT_W - blk.get("right_indent", 0) - rw,
                          baseline, blk["right_role"], size, False, BLACK)
                st["y"] -= blk.get("leading", line_h)
                return
            if kind == "colophon":  # 版记：抄送 / 印发单位，上下细横线（位置由调用方给定）
                rows = []
                if blk.get("cc"):
                    rows.append(("left", "抄送：" + blk["cc"]))
                if blk.get("issuer"):
                    rows.append(("split", blk["issuer"], blk["date"] + "印发"))
                if not rows:
                    return
                row_h = 24
                c.setStrokeColorRGB(*BLACK)
                c.setLineWidth(0.75)
                yy = st["y"] - 8
                c.line(M_LEFT, yy, M_LEFT + CONTENT_W, yy)
                for j, row in enumerate(rows):
                    baseline = yy - 17
                    draw_line(row[1], M_LEFT + FS_PAGE, baseline, "FS", FS_PAGE,
                              False, BLACK)
                    if row[0] == "split":
                        tw = pdfmetrics.stringWidth(row[2], pdf_font["FS"], FS_PAGE)
                        draw_line(row[2], M_LEFT + CONTENT_W - FS_PAGE - tw, baseline,
                                  "FS", FS_PAGE, False, BLACK)
                    if j < len(rows) - 1:
                        c.line(M_LEFT, yy - row_h, M_LEFT + CONTENT_W, yy - row_h)
                    yy -= row_h
                c.line(M_LEFT, yy, M_LEFT + CONTENT_W, yy)
                st["y"] = yy - 6
                st["first"] = False
                return
            # 文本块
            role, size = blk["role"], blk["size"]
            leading = blk.get("leading", line_h)
            align = blk.get("align", "justify")
            bold, color = blk.get("bold", False), blk.get("color", BLACK)
            fi = blk.get("first_indent", 0)
            li, ri = blk.get("left_indent", 0), blk.get("right_indent", 0)
            avail = CONTENT_W - fi - li - ri
            lines = wrap_cjk(blk["text"], avail, lambda s: pdfmetrics.stringWidth(
                s, pdf_font[role], size))
            for i, ln in enumerate(lines):
                ensure(leading)
                if i == 0:
                    mark(blk)
                indent = fi if i == 0 else 0
                x0 = M_LEFT + li + indent
                avail_i = CONTENT_W - li - ri - indent
                baseline = st["y"] - size * 0.84
                w = pdfmetrics.stringWidth(ln, pdf_font[role], size)
                if align == "center":
                    draw_line(ln, (PAGE_W - w) / 2, baseline, role, size, bold, color)
                elif align == "right":
                    draw_line(ln, M_LEFT + CONTENT_W - ri - w, baseline,
                              role, size, bold, color)
                elif align == "justify" and i < len(lines) - 1 and w > avail_i * 0.6 \
                        and len(ln) > 1:
                    extra = (avail_i - w) / (len(ln) - 1)
                    xx = x0
                    for ch in ln:
                        draw_line(ch, xx, baseline, role, size, bold, color)
                        xx += pdfmetrics.stringWidth(ch, pdf_font[role], size) + extra
                else:
                    draw_line(ln, x0, baseline, role, size, bold, color)
                st["y"] -= leading
            st["y"] -= blk.get("space_after", 0)

        for blk in flow_blocks:
            emit(blk)

        # 版记固定到末页版心下缘；正文侵入版记区时另起一面（试排时记录碰撞）
        collision = False
        if colophon:
            nrows = (1 if colophon.get("cc") else 0) + (1 if colophon.get("issuer") else 0)
            h_c = 8 + 24 * nrows + 6
            if st["y"] < M_BOTTOM + h_c + 8:
                collision = True
                new_page()
            st["y"] = M_BOTTOM + h_c
            emit(colophon)
        footer()
        c.save()
        # 落款孤悬判定：任一落款块与正文不同面，或署名/日期被拆到两页
        orphan = (bool(st["sig_pages"]) and st["body_page"] is not None
                  and (max(st["sig_pages"]) > st["body_page"]
                       or len(set(st["sig_pages"])) > 1))
        return orphan, collision

    # 落款不得孤悬页首、正文不得侵入版记区：逐级压缩行距（公文允许“调整行距”）
    line_h = LINE_H
    if os.path.isfile(out_path):
        os.remove(out_path)
    for cand in (LINE_H, 27, 26, 25):
        tmp = out_path + "._try.pdf"
        orphan, collision = render_once(tmp, cand)
        if os.path.isfile(tmp):
            os.remove(tmp)
        if not orphan and not collision:
            line_h = cand
            break
    else:
        line_h = LINE_H
    render_once(out_path, line_h)
    if line_h != LINE_H:
        print("提示: 为使落款与版记同面收尾，正文行距已由28磅调整为%s磅。" % line_h)


def layout_blocks(cfg, fams):
    """内容 → 排版块（PDF 用）。"""
    B = []

    def T(text, role, size, **kw):
        B.append(dict(kind="text", text=text, role=role, size=size, **kw))

    head = "　".join(x for x in (cfg.get("secret", ""), cfg.get("urgency", "")) if x)
    if head:
        T(head, "HEI", FS_BODY, align="left", space_after=LINE_H)

    letterhead = cfg.get("letterhead") or "宜春天码信息集团文件"
    sz = fit_size(letterhead, FS_LETTERHEAD, CONTENT_W)
    T(letterhead, "TITLE", sz, align="center", bold=True, color=RED,
      leading=int(sz * 1.3), space_before=4, space_after=2)

    year = datetime.date.today().year
    doc_number = cfg.get("doc_number")
    if doc_number is None or doc_number == "":
        doc_number = "天码发〔%d〕　号" % year
    signer = cfg.get("signer", "")
    if signer:
        B.append(dict(kind="samerow", left=doc_number, left_role="FS",
                      right="签发人：" + signer, right_role="KT", size=FS_BODY,
                      left_indent=FS_BODY, right_indent=FS_BODY))
    else:
        T(doc_number, "FS", FS_BODY, align="center", space_after=6)

    B.append(dict(kind="rule", color=RED, w=1.5, space_after=0))

    T(cfg["title"], "TITLE", FS_TITLE, align="center", bold=True, leading=32,
      space_before=24, space_after=8)

    if cfg.get("recipient", ""):
        T(cfg["recipient"], "FS", FS_BODY, align="left")

    for item in cfg.get("body", []):
        t = item.get("t", "p")
        if t == "page":
            B.append(dict(kind="page"))
            continue
        role = {"p": "FS", "h1": "HEI", "h2": "KT", "h3": "FS",
                "att_head": "HEI"}.get(t, "FS")
        T(item.get("x", ""), role, FS_BODY, align="left" if t == "att_head" else "justify",
          bold=(t == "h3"), first_indent=0 if t == "att_head" else FS_BODY * 2)

    atts = cfg.get("attachments") or []
    for i, a in enumerate(atts):
        prefix = "附件：" if i == 0 else ""
        left = FS_BODY * 2 if i == 0 else FS_BODY * (2 + 3)
        T(prefix + a, "FS", FS_BODY, align="left", left_indent=left,
          space_before=LINE_H if i == 0 else 0)

    signature = cfg.get("signature") or ""
    date = cfg.get("date") or datetime.date.today().strftime("%Y年%m月%d日")
    if signature:
        wn, wd_ = text_width(signature, FS_BODY), text_width(date, FS_BODY)
        base = FS_BODY * 4
        rn = base if wn >= wd_ else base + (wd_ - wn) / 2
        rd = base + (wn - wd_) / 2 if wn >= wd_ else base
        T(signature, "FS", FS_BODY, align="right", right_indent=rn,
          space_before=LINE_H, tag="sig")
        T(date, "FS", FS_BODY, align="right", right_indent=rd, tag="sig")

    cc, issuer = cfg.get("cc", ""), cfg.get("issuer", "")
    if cc or issuer:
        B.append(dict(kind="colophon", cc=cc, issuer=issuer, date=date))
    return B


# ---------------------------------------------------------------- 入口
def main():
    ap = argparse.ArgumentParser(description="宜春天码信息集团公文生成器（DOCX+PDF）")
    ap.add_argument("content", help="content.json 路径")
    ap.add_argument("-o", "--out", default="", help="输出目录或 .docx 路径（默认桌面）")
    args = ap.parse_args()

    with open(args.content, encoding="utf-8-sig") as f:
        cfg = json.load(f)
    if not cfg.get("title"):
        sys.exit("content.json 缺少必填字段 title")

    fams, paths = resolve_fonts()

    title = re.sub(r'[\\/:*?"<>|\r\n]', "", cfg["title"]).strip() or "公文"
    out = args.out or os.path.join(os.path.expanduser("~"), "Desktop")
    if out.lower().endswith(".docx"):
        base = out[:-5]
    elif out.lower().endswith(".pdf"):
        base = out[:-4]
    else:
        base = os.path.join(out, title)
    os.makedirs(os.path.dirname(base) or ".", exist_ok=True)

    docx_path, pdf_path = base + ".docx", base + ".pdf"
    build_docx(cfg, fams, docx_path)
    build_pdf(cfg, fams, paths, pdf_path)

    print("OK 已生成:")
    print("  DOCX " + docx_path)
    print("  PDF  " + pdf_path)
    print("字体: " + "，".join("%s=%s" % (r, fams[r]) for r in ("TITLE", "FS", "HEI", "KT")))
    if cfg.get("doc_number", "") in ("", None):
        print("提示: 未提供发文字号，已留占位“〔%d〕　号”，请补填。" % datetime.date.today().year)


if __name__ == "__main__":
    main()
