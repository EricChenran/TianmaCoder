# -*- coding: utf-8 -*-
"""套用甲方模板生成《UI 界面确认单》DOCX。

用法：python build_docx.py <manifest.json>

做两件事：
  1) 版式照搬模板：复制模板文档，保留页面设置、样式、字体字号、图注段格式
     （9pt 加粗居中、keepNext、段前段后间距）与图片段居中；只替换/新增图注与配图，
     并按模板"xxx界面："的写法增补板块标题（如"小程序界面："）。
  2) 尾部结论固定：模板尾部（从"确认结论"标题到文末）整块删除后按 TAIL_* 常量逐字重写
     ——"二、确认结论"、需求匹配度、设计还原度、双方签署表、备注、以下无正文。
     换任何甲方模板，这一段都不随模板变化。

manifest.json 结构见 ../references/manifest-example.json
"""
import copy
import io
import json
import os
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Emu
from docx.text.paragraph import Paragraph
from PIL import Image


# 尾部固定文案：逐字照抄，不读 manifest、不随模板变化。
TAIL_HEADING = "二、确认结论"
TAIL_ITEMS = (
    "需求匹配度：所有界面模块的布局、交互、文案均与需求文档完全一致，无遗漏或偏离。",
    "设计还原度：UI实现像素级匹配，偏差率≤0.5%",
)
TAIL_TABLE_ROWS = (
    ("客户方确认", "我方确认"),
    ("甲方：______________________", "乙方：______________________"),
    ("", ""),
    ("签字盖章：______________________", "签字盖章：______________________"),
    ("日期：____年____月____日", "日期：____年____月____日"),
)
TAIL_NOTES = (
    "备注：",
    "1.本确认单一式两份，双方各执一份，具有同等效力。",
)
TAIL_END = "以下无正文---------------------------"

TAIL_ANCHOR_SUFFIX = "确认结论"
TEXT_CHILDREN = (qn("w:t"), qn("w:tab"), qn("w:br"), qn("w:cr"))


def para_text(p_el):
    return "".join(t.text or "" for t in p_el.iter(qn("w:t")))


def has_picture(p_el):
    return p_el.find(".//" + qn("a:blip")) is not None


def set_keep_next(p_el):
    ppr = p_el.find(qn("w:pPr"))
    if ppr is None:
        ppr = OxmlElement("w:pPr")
        p_el.insert(0, ppr)
    if ppr.find(qn("w:keepNext")) is None:
        ppr.append(OxmlElement("w:keepNext"))


def set_run_text(run_el, text):
    for child in list(run_el):
        if child.tag in TEXT_CHILDREN:
            run_el.remove(child)
    t = OxmlElement("w:t")
    t.set(qn("xml:space"), "preserve")
    t.text = text
    run_el.append(t)


def first_run(p_el):
    return None if p_el is None else p_el.find(qn("w:r"))


def clone_text(proto_el, text):
    """克隆段落，只保留首个 run 的格式并换成 text。"""
    new = copy.deepcopy(proto_el)
    for br in new.findall(".//" + qn("w:lastRenderedPageBreak")):
        br.getparent().remove(br)
    runs = new.findall(qn("w:r"))
    if not runs:
        raise SystemExit("模板段落没有 run，无法克隆格式")
    first = runs[0]
    for r in runs[1:]:
        new.remove(r)
    set_run_text(first, text)
    return new


def clone_heading(proto_el, text):
    """克隆板块标题段（如 Web界面：）并加 keepNext，避免标题孤零零落在页尾。"""
    new = clone_text(proto_el, text)
    set_keep_next(new)
    return new


def clone_picture(proto_el, doc, img_path, width_emu):
    """克隆图片段（保持居中与段后间距），换成本项目的图。"""
    new = copy.deepcopy(proto_el)
    for r in new.findall(qn("w:r")):
        new.remove(r)
    for d in new.findall(".//" + qn("w:drawing")):
        d.getparent().remove(d)
    par = Paragraph(new, doc)
    run = par.add_run()
    with Image.open(img_path) as im:
        w_px, h_px = im.size
    run.add_picture(img_path, width=Emu(width_emu), height=Emu(int(width_emu * h_px / w_px)))
    return new


def new_paragraph(doc, text, bold=False):
    """模板缺尾部段落时的兜底：用文档默认样式造一段。"""
    par = doc.add_paragraph()
    run = par.add_run(text)
    run.bold = bold
    return par._p


def fill_cell(tc, text, run_proto):
    """替换单元格文字，保留该单元格的段落属性；run 格式取模板正文 run。"""
    ps = tc.findall(qn("w:p"))
    if not ps:
        p = OxmlElement("w:p")
        tc.append(p)
        ps = [p]
    for extra in ps[1:]:
        tc.remove(extra)
    p = ps[0]
    for r in p.findall(qn("w:r")):
        p.remove(r)
    if run_proto is not None:
        r = copy.deepcopy(run_proto)
    else:
        r = OxmlElement("w:r")
    set_run_text(r, text)
    p.append(r)


def clone_table(table_proto, body_proto):
    """克隆模板签署表，把行列与文字改写成固定签署表（保留边框、列宽与对齐）。"""
    tbl = copy.deepcopy(table_proto)
    run_proto = first_run(body_proto)

    trs = tbl.findall(qn("w:tr"))
    if not trs:
        raise SystemExit("模板尾部表格没有行，无法克隆签署表")
    while len(trs) < len(TAIL_TABLE_ROWS):
        trs[-1].addnext(copy.deepcopy(trs[-1]))
        trs = tbl.findall(qn("w:tr"))
    for tr in trs[len(TAIL_TABLE_ROWS):]:
        tbl.remove(tr)

    for tr, row in zip(tbl.findall(qn("w:tr")), TAIL_TABLE_ROWS):
        tcs = tr.findall(qn("w:tc"))
        if not tcs:
            raise SystemExit("模板尾部表格没有单元格，无法克隆签署表")
        while len(tcs) < len(row):
            tr.append(copy.deepcopy(tcs[-1]))
            tcs = tr.findall(qn("w:tc"))
        for extra in tcs[len(row):]:
            tr.remove(extra)
        for tc, text in zip(tr.findall(qn("w:tc")), row):
            fill_cell(tc, text, run_proto)
    return tbl


def make_table(doc, body_proto):
    """模板无签署表时的兜底：自建两列等宽表，加全框线。"""
    tbl = doc.add_table(rows=len(TAIL_TABLE_ROWS), cols=2)
    el = tbl._tbl
    doc.element.body.remove(el)
    run_proto = first_run(body_proto)
    for tr, row in zip(el.findall(qn("w:tr")), TAIL_TABLE_ROWS):
        for tc, text in zip(tr.findall(qn("w:tc")), row):
            fill_cell(tc, text, run_proto)

    tbl_pr = el.find(qn("w:tblPr"))
    if tbl_pr is None:
        tbl_pr = OxmlElement("w:tblPr")
        el.insert(0, tbl_pr)
    tbl_w = tbl_pr.find(qn("w:tblW"))
    if tbl_w is None:
        tbl_w = OxmlElement("w:tblW")
        tbl_pr.append(tbl_w)
    tbl_w.set(qn("w:type"), "pct")
    tbl_w.set(qn("w:w"), "5000")
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        e = OxmlElement("w:" + edge)
        e.set(qn("w:val"), "single")
        e.set(qn("w:sz"), "4")
        e.set(qn("w:space"), "0")
        e.set(qn("w:color"), "000000")
        borders.append(e)
    tbl_pr.append(borders)
    return el


def is_tail_anchor(text):
    text = text.strip().rstrip("：:。 ")
    return text == TAIL_ANCHOR_SUFFIX or (
        text.endswith(TAIL_ANCHOR_SUFFIX) and len(text) <= 12
    )


def cut_tail(body):
    """删掉模板自带尾部（确认结论标题到正文末尾），返回可复用的格式原型。

    返回 (标题段原型, 正文段原型, 签署表原型, 删除的元素数)；模板无尾部时原型为 None、计数为 0。
    """
    children = list(body.iterchildren())
    anchor = None
    for el in children:
        if el.tag == qn("w:p") and is_tail_anchor(para_text(el)):
            anchor = el
            break
    if anchor is None:
        return None, None, None, 0

    body_proto = None
    table_proto = None
    tail_elements = [el for el in children[children.index(anchor):] if el.tag != qn("w:sectPr")]
    for el in tail_elements:
        if (
            el is not anchor
            and body_proto is None
            and el.tag == qn("w:p")
            and para_text(el).strip()
            and not has_picture(el)
        ):
            body_proto = el
        if table_proto is None and el.tag == qn("w:tbl"):
            table_proto = el
        body.remove(el)
    return anchor, body_proto, table_proto, len(tail_elements)


def write_tail(doc, heading_proto, body_proto, table_proto):
    """按固定文案写尾部：标题、两条结论、签署表、备注、以下无正文。"""
    body = doc.element.body
    sect = body.find(qn("w:sectPr"))

    def place(el):
        if sect is None:
            body.append(el)
        else:
            sect.addprevious(el)

    def body_paragraph(text):
        if body_proto is not None:
            return clone_text(body_proto, text)
        return new_paragraph(doc, text, bold=True)

    if heading_proto is not None:
        heading = clone_heading(heading_proto, TAIL_HEADING)
    else:
        heading = new_paragraph(doc, TAIL_HEADING, bold=True)
        set_keep_next(heading)
    place(heading)

    for item in TAIL_ITEMS:
        place(body_paragraph(item))

    place(
        clone_table(table_proto, body_proto)
        if table_proto is not None
        else make_table(doc, body_proto)
    )

    for note in TAIL_NOTES + (TAIL_END,):
        place(body_paragraph(note))


def main():
    if len(sys.argv) < 2:
        raise SystemExit("用法: python build_docx.py <manifest.json>")

    manifest_path = os.path.abspath(sys.argv[1])
    with open(manifest_path, encoding="utf-8-sig") as f:
        cfg = json.load(f)

    base = os.path.dirname(manifest_path)

    def p(x):
        return x if os.path.isabs(x) else os.path.normpath(os.path.join(base, x))

    template = p(cfg["template"])
    output = p(cfg["output"])
    anchor_text = cfg.get("anchorHeading", "Web界面：")
    figure_prefix = cfg.get("figurePrefix", "图")
    default_width = int(cfg.get("imageWidthEmu", 5256000))

    doc = Document(template)
    body = doc.element.body

    # 定位模板原型段落
    heading_proto = caption_proto = picture_proto = None
    for el in body.iterchildren(qn("w:p")):
        txt = para_text(el).strip()
        if heading_proto is None and txt == anchor_text:
            heading_proto = el
        elif caption_proto is None and txt.startswith(figure_prefix + " "):
            caption_proto = el
        elif caption_proto is not None and picture_proto is None and has_picture(el):
            picture_proto = el
            break

    if heading_proto is None:
        raise SystemExit(f"模板中未找到板块标题「{anchor_text}」，可用 anchorHeading 指定")
    if caption_proto is None or picture_proto is None:
        raise SystemExit("模板中未找到图注段或图片段原型，无法继承版式")

    # 删除模板原有图注与图片
    removed = 0
    for el in list(body.iterchildren(qn("w:p"))):
        txt = para_text(el).strip()
        if txt.startswith(figure_prefix + " ") or has_picture(el):
            body.remove(el)
            removed += 1

    cursor = heading_proto
    counter = 0
    made = 0

    def append(el):
        nonlocal cursor
        cursor.addnext(el)
        cursor = el

    for sec_idx, section in enumerate(cfg["sections"]):
        if sec_idx > 0:
            append(clone_heading(heading_proto, section["heading"]))
        width = int(section.get("imageWidthEmu", default_width))
        for fig in section["figures"]:
            img = p(fig["image"])
            if not os.path.exists(img):
                raise SystemExit("缺少截图：" + img)
            counter += 1
            caption = "%s %02d　%s" % (figure_prefix, counter, fig["caption"])
            append(clone_text(caption_proto, caption))
            append(clone_picture(picture_proto, doc, img, width))
            made += 1

    tail_heading, tail_body, tail_table, tail_removed = cut_tail(body)
    write_tail(doc, tail_heading, tail_body, tail_table)

    if cfg.get("title"):
        doc.core_properties.title = cfg["title"]
    if cfg.get("subject"):
        doc.core_properties.subject = cfg["subject"]
    if cfg.get("author"):
        doc.core_properties.author = cfg["author"]

    os.makedirs(os.path.dirname(output), exist_ok=True)
    doc.save(output)
    print("已生成:", output)
    print("移除模板原图注/图片段落:", removed)
    print("写入界面图:", made, "（%d 个板块）" % len(cfg["sections"]))
    if tail_removed:
        print("尾部结论: 已按固定文案重写（替换模板原有 %d 段）" % tail_removed)
    else:
        print("尾部结论: 模板中未找到「确认结论」，已按固定文案追加")


if __name__ == "__main__":
    main()
