#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_doc.py — 从 content.json 一步生成《需求文档》Word 与同内容 Markdown
用法: python gen_doc.py content.json "需求文档-系统名.docx"
依赖: python-docx, matplotlib
产出: 除了指定的 .docx，在同一目录写出同名 .md（便于转发给技术部），
      流程图 PNG 落在同目录 images/ 下，Markdown 以内链引用，内容与 Word 一致。
版式: 业内合同规范——黑体二号标题、黑体/楷体条款标题、宋体小四正文、
      1.5倍行距、结尾双方签署栏、"第 X 页 共 Y 页"页码。
业务流程: 每条流程先输出完整正文（业务目标／参与角色／触发条件／前置条件／
      步骤表／异常与分支／结束状态），再输出脚本绘制的竖版流程图与图题；
      正文自足，图只作辅助理解，图上的步骤编号与步骤表序号一一对应。
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
GRAY = RGBColor(0x59, 0x59, 0x59)
NAVY = "#1F4E79"
SONG, HEI, KAI, FANG = "宋体", "黑体", "楷体", "仿宋"
CENTER = WD_ALIGN_PARAGRAPH.CENTER
RIGHT = WD_ALIGN_PARAGRAPH.RIGHT


def cn_num(n):
    """中文序号：1→一、11→十一、21→二十一；1~99 之外回退阿拉伯数字。"""
    digits = "零一二三四五六七八九"
    if not 1 <= n <= 99:
        return str(n)
    if n < 10:
        return digits[n]
    tens, ones = divmod(n, 10)
    return ("十" if tens == 1 else digits[tens] + "十") + (digits[ones] if ones else "")


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
    """竖版流程图：开始/结束圆角节点 + 编号步骤方框 + 箭头。

    步骤编号与正文步骤表的序号一一对应；图只画主流程，异常与分支留在正文。
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import FancyBboxPatch
    plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei"]
    plt.rcParams["axes.unicode_minus"] = False

    labels = ["%d. %s" % (i, s if isinstance(s, str) else s["action"])
              for i, s in enumerate(steps, 1)]
    nodes = ["开始"] + labels + ["结束"]
    n = len(nodes)
    gap, H, BW = 1.0, 0.72, 4.6
    fig_h = max(2.2, n * gap * 0.82 + 0.6)
    fig, ax = plt.subplots(figsize=(6.4, fig_h))
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
        ax.text(0, cy, wrap(text, 16), ha="center", va="center",
                fontsize=11, color="#222222", linespacing=1.1)
        if i < n - 1:
            ny = y_top - (i + 1) * gap
            ax.annotate("", xy=(0, ny + H / 2 + 0.03), xytext=(0, cy - H / 2 - 0.03),
                        arrowprops=dict(arrowstyle="-|>", color=NAVY, lw=1.4,
                                        shrinkA=0, shrinkB=0))
    fig.savefig(out_png, dpi=200, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def safe_filename(text):
    """把流程名规范成可用作文件名的形式。"""
    for ch in '\\/:*?"<>|':
        text = text.replace(ch, "_")
    return text.strip() or "流程"


def flow_image_path(images_dir, index, name):
    """一条流程的流程图落盘路径（Word 与 Markdown 复用同一张图）。"""
    return os.path.join(images_dir, "图%d-%s.png" % (index, safe_filename(name)))


def md_cell(text):
    """Markdown 表格单元格：转义竖线、压掉换行。"""
    return str(text).replace("|", "\\|").replace("\n", " ")


def md_table(headers, rows):
    """渲染一张 Markdown 表格。"""
    lines = ["| " + " | ".join(headers) + " |",
             "| " + " | ".join("---" for _ in headers) + " |"]
    for row in rows:
        lines.append("| " + " | ".join(md_cell(cell) for cell in row) + " |")
    return "\n".join(lines)


def normalize_flow(raw, index):
    """校验并归一化一条业务流程；必填项缺失或步骤非法时直接报错退出。"""
    where = "第 %d 条业务流程" % index
    if not isinstance(raw, dict):
        sys.exit("%s 必须是对象" % where)
    name = str(raw.get("name") or "").strip()
    if not name:
        sys.exit("%s 缺少必填字段 name" % where)
    where = "%s（%s）" % (where, name)
    trigger = str(raw.get("trigger") or "").strip()
    if not trigger:
        sys.exit("%s 缺少必填字段 trigger（触发条件）" % where)
    result = str(raw.get("result") or "").strip()
    if not result:
        sys.exit("%s 缺少必填字段 result（结束状态）" % where)
    raw_steps = raw.get("steps")
    if not isinstance(raw_steps, list) or not raw_steps:
        sys.exit("%s 缺少必填字段 steps（流程步骤，至少一步）" % where)
    steps = []
    for i, step in enumerate(raw_steps, 1):
        if isinstance(step, str):
            action, actor, rule = step.strip(), "", ""
        elif isinstance(step, dict):
            action = str(step.get("action") or "").strip()
            actor = str(step.get("actor") or "").strip()
            rule = str(step.get("rule") or "").strip()
        else:
            sys.exit("%s 第 %d 步必须是字符串或对象" % (where, i))
        if not action:
            sys.exit("%s 第 %d 步缺少 action（该步的操作内容）" % (where, i))
        steps.append({"actor": actor, "action": action, "rule": rule})
    exceptions = []
    for item in raw.get("exceptions") or []:
        case = str(item.get("case") or "").strip() if isinstance(item, dict) else ""
        handling = str(item.get("handling") or "").strip() if isinstance(item, dict) else ""
        if not case or not handling:
            sys.exit("%s 的 exceptions 每项都要有 case 与 handling" % where)
        exceptions.append({"case": case, "handling": handling})
    roles = [str(r).strip() for r in raw.get("roles") or [] if str(r).strip()]
    if not roles:
        roles = list(dict.fromkeys(s["actor"] for s in steps if s["actor"]))
    return {
        "name": name,
        "goal": str(raw.get("goal") or "").strip(),
        "roles": roles,
        "trigger": trigger,
        "precondition": str(raw.get("precondition") or "").strip(),
        "steps": steps,
        "exceptions": exceptions,
        "result": result,
    }


def add_flow(doc, flow, index, figure, image_path):
    """输出一条业务流程：正文（结构化）在前，流程图与图题在后。"""
    para(doc, "（%s）%s" % (cn_num(index), flow["name"]), size=14, font=KAI,
         indent=True, before=6)
    if flow["goal"]:
        para(doc, [("业务目标：", {"bold": True}), (flow["goal"], {})], indent=True)
    if flow["roles"]:
        para(doc, [("参与角色：", {"bold": True}), ("、".join(flow["roles"]), {})], indent=True)
    para(doc, [("触发条件：", {"bold": True}), (flow["trigger"], {})], indent=True)
    if flow["precondition"]:
        para(doc, [("前置条件：", {"bold": True}), (flow["precondition"], {})], indent=True)

    para(doc, "流程步骤：", bold=True, indent=True, before=6)
    with_actor = any(s["actor"] for s in flow["steps"])
    with_rule = any(s["rule"] for s in flow["steps"])
    headers = ["序号"] + (["执行角色"] if with_actor else []) + ["操作内容"] \
        + (["业务规则与输出"] if with_rule else [])
    widths = ([1.4, 2.6, 6.8, 4.8] if with_actor and with_rule
              else [1.4, 2.6, 11.6] if with_actor
              else [1.4, 4.0, 10.2] if with_rule
              else [1.4, 14.2])
    table = make_table(doc, headers, widths)
    for i, step in enumerate(flow["steps"], 1):
        cells = [str(i)] + ([step["actor"]] if with_actor else []) + [step["action"]] \
            + ([step["rule"]] if with_rule else [])
        aligns = [CENTER] + ([None] if with_actor else []) + [None] \
            + ([None] if with_rule else [])
        add_row(table, cells, widths, aligns=aligns)

    if flow["exceptions"]:
        para(doc, "异常与分支：", bold=True, indent=True, before=8)
        widths = [6.0, 9.6]
        table = make_table(doc, ["异常或分支", "处理方式"], widths)
        for item in flow["exceptions"]:
            add_row(table, [item["case"], item["handling"]], widths)

    para(doc, [("结束状态：", {"bold": True}), (flow["result"], {})], indent=True, before=8)
    para(doc, "流程图（辅助理解）：", bold=True, indent=True, before=8)
    p = doc.add_paragraph()
    p.alignment = CENTER
    p.paragraph_format.space_after = Pt(2)
    p.add_run().add_picture(image_path, width=Cm(8.5))
    para(doc, "图 %d　%s流程图" % (figure, flow["name"]), size=9, color=GRAY,
         align=CENTER, after=12)


def write_markdown(data, flows, image_links, date_str, out_md):
    """把同一份内容写成 Markdown：与 Word 逐节对应，流程图以内链引用 images/ 下的 PNG。"""
    lines = ["# %s" % data["system_name"], "",
             "%s" % data["subtitle"], "",
             "编制单位：帆远网络科技", ""]

    def section(heading):
        lines.extend(["## %s" % heading, ""])

    section("一、项目概述")
    idx = 1
    for text in data.get("overview", []):
        lines.extend([text, ""])

    roles = data.get("roles") or []
    if roles:
        section("%s、用户角色" % cn_num(idx + 1))
        idx += 1
        lines.extend([md_table(["角色", "角色说明", "核心操作"],
                               [[r.get("name", ""), r.get("desc", ""), r.get("actions", "")]
                                for r in roles]), ""])

    section("%s、功能模块设计" % cn_num(idx + 1))
    idx += 1
    for i, module in enumerate(data["modules"], 1):
        head = "### （%s）%s" % (cn_num(i), module["name"])
        if module.get("desc"):
            head += "——" + module["desc"]
        lines.extend([head, ""])
        features = module.get("features") or []
        if features:
            lines.extend([md_table(["功能点", "功能说明"],
                                   [[f.get("point", ""), f.get("detail", "")] for f in features]), ""])

    if flows:
        section("%s、核心业务流程" % cn_num(idx + 1))
        idx += 1
        for i, flow in enumerate(flows, 1):
            lines.extend(["### （%s）%s" % (cn_num(i), flow["name"]), ""])
            if flow["goal"]:
                lines.append("- **业务目标**：%s" % flow["goal"])
            if flow["roles"]:
                lines.append("- **参与角色**：%s" % "、".join(flow["roles"]))
            lines.append("- **触发条件**：%s" % flow["trigger"])
            if flow["precondition"]:
                lines.append("- **前置条件**：%s" % flow["precondition"])
            lines.append("")
            lines.extend(["**流程步骤**", ""])
            with_actor = any(s["actor"] for s in flow["steps"])
            with_rule = any(s["rule"] for s in flow["steps"])
            headers = ["序号"] + (["执行角色"] if with_actor else []) + ["操作内容"] \
                + (["业务规则与输出"] if with_rule else [])
            rows = []
            for n, step in enumerate(flow["steps"], 1):
                rows.append([str(n)] + ([step["actor"]] if with_actor else []) + [step["action"]]
                            + ([step["rule"]] if with_rule else []))
            lines.extend([md_table(headers, rows), ""])
            if flow["exceptions"]:
                lines.extend(["**异常与分支**", ""])
                lines.extend([md_table(["异常或分支", "处理方式"],
                                       [[item["case"], item["handling"]] for item in flow["exceptions"]]), ""])
            lines.extend(["**结束状态**：%s" % flow["result"], ""])
            lines.extend(["**流程图（辅助理解）**", "",
                          "![图 %d　%s流程图](%s)" % (i, flow["name"], image_links[i]), ""])

    delivery = data.get("delivery")
    if delivery:
        section("%s、交付形态与范围" % cn_num(idx + 1))
        idx += 1
        lines.extend([delivery, ""])

    notes = data.get("notes") or []
    if notes:
        section("%s、其他说明" % cn_num(idx + 1))
        for i, note in enumerate(notes, 1):
            lines.append("%d.%s" % (i, note))
        lines.append("")

    lines.extend(["## 告知说明", "",
                  "本需求文档由帆远网络科技根据客户提供的需求整理编制，供客户核对功能范围之用。"
                  "客户通过企业微信、微信、电话、邮件等任一方式（含口头）确认本文件内容的，"
                  "即视为需求确认完成，本文档作为项目设计与开发依据。", "",
                  "**帆远网络科技**", "", date_str, ""])
    with open(out_md, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines).rstrip("\n") + "\n")


def build(data, out_path):
    flows = [normalize_flow(raw, i) for i, raw in enumerate(data.get("flows") or [], 1)]
    out_abs = os.path.abspath(out_path)
    images_dir = os.path.join(os.path.dirname(out_abs) or ".", "images")
    image_paths, image_links = {}, {}
    if flows:
        os.makedirs(images_dir, exist_ok=True)
        for i, flow in enumerate(flows, 1):
            path = flow_image_path(images_dir, i, flow["name"])
            draw_flowchart(flow["steps"], path)
            image_paths[i] = path
            image_links[i] = "images/" + os.path.basename(path).replace(" ", "%20")
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
    para(doc, "%s、项目概述" % cn_num(idx + 1), size=14, font=HEI, indent=True)
    idx += 1
    for text in data.get("overview", []):
        para(doc, text, indent=True)

    # 二、用户角色
    roles = data.get("roles") or []
    if roles:
        para(doc, "%s、用户角色" % cn_num(idx + 1), size=14, font=HEI, indent=True)
        idx += 1
        widths = [2.8, 6.4, 6.4]
        t = make_table(doc, ["角色", "角色说明", "核心操作"], widths)
        for r in roles:
            add_row(t, [r.get("name", ""), r.get("desc", ""), r.get("actions", "")], widths)
        para(doc, "", line=1.0)

    # 三、功能模块设计
    para(doc, "%s、功能模块设计" % cn_num(idx + 1), size=14, font=HEI, indent=True)
    idx += 1
    for i, m in enumerate(data["modules"], 1):
        head = "（%s）%s" % (cn_num(i), m["name"])
        if m.get("desc"):
            head += "——" + m["desc"]
        para(doc, head, size=14, font=KAI, indent=True)
        widths = [4.2, 11.4]
        t = make_table(doc, ["功能点", "功能说明"], widths)
        for f in m.get("features", []):
            add_row(t, [f.get("point", ""), f.get("detail", "")], widths)
        para(doc, "", line=1.0)

    # 四、核心业务流程（每条流程：正文在前，流程图与图题在后）
    if flows:
        para(doc, "%s、核心业务流程" % cn_num(idx + 1), size=14, font=HEI, indent=True)
        idx += 1
        for i, flow in enumerate(flows, 1):
            add_flow(doc, flow, i, i, image_paths[i])

    # 五、交付形态与范围
    delivery = data.get("delivery")
    if delivery:
        para(doc, "%s、交付形态与范围" % cn_num(idx + 1), size=14, font=HEI, indent=True)
        idx += 1
        para(doc, delivery, indent=True)

    # 六、其他说明
    notes = data.get("notes") or []
    if notes:
        para(doc, "%s、其他说明" % cn_num(idx + 1), size=14, font=HEI, indent=True)
        for i, n in enumerate(notes, 1):
            para(doc, "%d.%s" % (i, n), indent=True)

    # 告知说明 + 落款（尽到告知义务即可，无需签字盖章，客户线上确认即生效）
    para(doc, "", before=24)
    para(doc, "告知说明", size=14, font=HEI, indent=True, before=6)
    para(doc, "本需求文档由帆远网络科技根据客户提供的需求整理编制，供客户核对功能范围之用。客户通过企业微信、微信、电话、邮件等任一方式（含口头）确认本文件内容的，即视为需求确认完成，本文档作为项目设计与开发依据。", indent=True)
    para(doc, "帆远网络科技", align=RIGHT, right_indent=56, before=16)
    para(doc, date_str, align=RIGHT, right_indent=56)

    doc.save(out_path)
    out_md = os.path.splitext(os.path.abspath(out_path))[0] + ".md"
    write_markdown(data, flows, image_links, date_str, out_md)
    print("OK 已生成 %s（Word）与 %s（Markdown）" % (out_path, out_md))


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
