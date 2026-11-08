# -*- coding: utf-8 -*-
"""套用甲方模板生成《UI 界面确认单》DOCX。

用法：python build_docx.py <manifest.json>

核心约束：**不改模板**。直接复制模板文档，保留其页面设置、样式、图注格式、
图片版式、确认结论措辞与签署表；只做两件事：
  1) 替换/新增图注与配图（克隆模板自带的图注段与图片段，继承其全部格式）；
  2) 按模板"xxx界面："的写法增补板块标题（如"小程序界面："）。

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


def clone_heading(proto_el, text, keep_next=True):
    """克隆板块标题段（如 Web界面：），只保留首个 run 的格式。"""
    new = copy.deepcopy(proto_el)
    for br in new.findall(".//" + qn("w:lastRenderedPageBreak")):
        br.getparent().remove(br)
    if keep_next:
        set_keep_next(new)
    runs = new.findall(qn("w:r"))
    if not runs:
        raise SystemExit("模板标题段没有 run，无法克隆格式")
    first = runs[0]
    for r in runs[1:]:
        new.remove(r)
    for child in list(first):
        if child.tag in (qn("w:t"), qn("w:tab"), qn("w:br"), qn("w:cr")):
            first.remove(child)
    t = OxmlElement("w:t")
    t.set(qn("xml:space"), "preserve")
    t.text = text
    first.append(t)
    return new


def clone_caption(proto_el, text):
    """克隆图注段（保持 9pt 加粗居中、keepNext、段前段后间距）。"""
    new = copy.deepcopy(proto_el)
    for br in new.findall(".//" + qn("w:lastRenderedPageBreak")):
        br.getparent().remove(br)
    runs = new.findall(qn("w:r"))
    if not runs:
        raise SystemExit("模板图注段没有 run，无法克隆格式")
    first = runs[0]
    for r in runs[1:]:
        new.remove(r)
    for child in list(first):
        if child.tag in (qn("w:t"), qn("w:tab"), qn("w:br"), qn("w:cr")):
            first.remove(child)
    t = OxmlElement("w:t")
    t.set(qn("xml:space"), "preserve")
    t.text = text
    first.append(t)
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
            append(clone_caption(caption_proto, caption))
            append(clone_picture(picture_proto, doc, img, width))
            made += 1

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


if __name__ == "__main__":
    main()
