#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
add_watermark.py — 给 .docx 每一页添加斜向文字水印（Word 原生 WordArt 水印，位于页眉、衬于文字下方）

用法:
    python add_watermark.py <file.docx> [水印文字]     # 水印文字默认 "帆远网络科技"

依赖: python-docx
说明: 水印写进各节页眉，Word/WPS 打开即显示；重复运行会自动跳过已加水印的页眉。
"""
import sys

from docx import Document
from docx.oxml import parse_xml

WM_NS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
         'xmlns:v="urn:schemas-microsoft-com:vml" '
         'xmlns:o="urn:schemas-microsoft-com:office:office"')

# WordArt 136（纯文本）shapetype，Word 原生水印所引用的形状定义
SHAPETYPE = (
    '<v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" '
    'path="m@7,l@8,m@5,21600l@6,21600e">'
    '<v:formulas>'
    '<v:f eqn="sum #0 0 10800"/><v:f eqn="prod #0 2 1"/><v:f eqn="sum 21600 0 @1"/>'
    '<v:f eqn="sum 0 0 @2"/><v:f eqn="sum 21600 0 @3"/><v:f eqn="if @0 @3 0"/>'
    '<v:f eqn="if @0 21600 @1"/><v:f eqn="if @0 0 @2"/><v:f eqn="if @0 @4 21600"/>'
    '<v:f eqn="mid @5 @6"/><v:f eqn="mid @8 @5"/><v:f eqn="mid @7 @8"/>'
    '<v:f eqn="mid @6 @7"/><v:f eqn="sum @6 0 @5"/>'
    '</v:formulas>'
    '<v:path textpathok="t" o:connecttype="custom" '
    'o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800" o:connectangles="270,180,90,0"/>'
    '<v:textpath on="t" fitshape="t"/>'
    '<v:handles><v:h position="#0,bottomRight" xrange="6629,14971"/></v:handles>'
    '<o:lock v:ext="edit" text="t" shapetype="t"/>'
    '</v:shapetype>'
)


def watermark_paragraph(text, idx):
    """构造含水印形状的页眉段落（本身几乎不占行高）。"""
    xml = (
        '<w:p ' + WM_NS + '>'
        '<w:pPr>'
        '<w:spacing w:before="0" w:after="0" w:line="14" w:lineRule="exact"/>'
        '<w:rPr><w:sz w:val="2"/></w:rPr>'
        '</w:pPr>'
        '<w:r><w:rPr><w:noProof/><w:sz w:val="2"/></w:rPr>'
        '<w:pict>'
        + SHAPETYPE +
        '<v:shape id="ZWatermark' + str(idx) + '" o:spid="_x0000_s20' + str(40 + idx) + '" '
        'type="#_x0000_t136" '
        'style="position:absolute;margin-left:0;margin-top:0;width:527.85pt;height:131.95pt;'
        'rotation:315;z-index:-251658752;mso-position-horizontal:center;'
        'mso-position-horizontal-relative:margin;mso-position-vertical:center;'
        'mso-position-vertical-relative:margin" o:allowincell="f" '
        'fillcolor="#c0c0c0" stroked="f">'
        '<v:fill opacity=".5"/>'
        '<v:textpath style="font-family:&quot;\u5fae\u8f6f\u96c5\u9ed1&quot;;font-size:1pt" '
        'string="' + text + '"/>'
        '</v:shape>'
        '</w:pict></w:r>'
        '</w:p>'
    )
    return parse_xml(xml)


def has_watermark(header):
    xml = header._element.xml
    return 'ZWatermark' in xml or 'PowerPlusWaterMarkObject' in xml


def add_watermark(path, text="帆远网络科技"):
    doc = Document(path)
    count = 0
    for section in doc.sections:
        targets = [section.header]
        if section.different_first_page_header_footer:
            targets.append(section.first_page_header)
        for header in targets:
            # 链接到前一节且前一节已有水印时无需处理
            if has_watermark(header):
                continue
            if header.is_linked_to_previous:
                header.is_linked_to_previous = False
            header._element.append(watermark_paragraph(text, count))
            count += 1
    doc.save(path)
    print('OK: 已为 %s 添加水印「%s」（%d 处页眉）' % (path, text, count))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit('用法: python add_watermark.py <file.docx> [水印文字]')
    add_watermark(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "帆远网络科技")
