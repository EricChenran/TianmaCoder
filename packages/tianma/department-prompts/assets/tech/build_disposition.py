#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_disposition.py — 从 content.json 生成《改动任务处置表》xlsx（工单逐项对上 + 改前改后对比图）
用法: python build_disposition.py content.json "客户名/改动任务处置表-客户名.xlsx"
依赖: openpyxl、Pillow
校验: 工单里每一项都必须有对应处置行（缺项、重复、越界一次列全后退出）
版式: 八列（序号｜任务明细｜当前现象｜期望改动后｜处置结果｜改动位置｜证明截图｜状态），
      「证明截图」列按改前/改后并排合成一张对比图（带标签与说明行）后嵌入，
      A4 横向、按页宽缩放、冻结并随页重复的表头、页脚页码。
"""
import json
import os
import shutil
import sys
import tempfile

try:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter
    from openpyxl.utils.units import pixels_to_EMU
    from openpyxl.drawing.image import Image as XLImage
    from openpyxl.drawing.spreadsheet_drawing import AnchorMarker, OneCellAnchor
    from openpyxl.drawing.xdr import XDRPositiveSize2D
    from openpyxl.worksheet.properties import PageSetupProperties
except ImportError:
    sys.exit("缺少依赖 openpyxl：请先执行  python -m pip install openpyxl Pillow")
try:
    from PIL import Image as PILImage, ImageDraw, ImageFont
except ImportError:
    sys.exit("缺少依赖 Pillow：请先执行  python -m pip install openpyxl Pillow")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from read_workorder import read_workorder  # noqa: E402  同目录脚本，读取工单做逐项核对

SONG, HEI = "宋体", "黑体"
BRAND = "帆远网络科技"
DEFAULT_STATUS = "已修复"

COLUMNS = [
    ("序号", 6, "center"),
    ("任务明细", 24, "left"),
    ("当前现象", 22, "left"),
    ("期望改动后", 22, "left"),
    ("处置结果", 26, "left"),
    ("改动位置", 16, "left"),
    ("证明截图", 46, "center"),
    ("状态", 10, "center"),
]
(COL_INDEX, COL_TASK, COL_PHENOMENON, COL_EXPECTED,
 COL_HANDLING, COL_FILES, COL_PROOF, COL_STATUS) = range(8)
LAST_COL = get_column_letter(len(COLUMNS))

PX_PER_UNIT = 7
CHINESE_PX = 14
LINE_PT = 16
ROW_HEIGHT_MAX = 409
IMAGE_GAP_PX = 6
CELL_PAD_PX = 4
PROOF_BUDGET_PX = ROW_HEIGHT_MAX * 0.75 - CELL_PAD_PX * 2
# 对比图按单元格宽度的 3 倍绘制，Excel 缩放后标签与说明仍可读
COMPOSE_SCALE = 3
PANEL_MAX_W = 470
PANEL_MAX_H = 1300
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

STATUS_STYLE = {
    "已修复": ("E6F4EA", "15803D"),
    "部分修复": ("FFF4E5", "B45309"),
    "未修复": ("FDECEA", "B91C1C"),
    "无法复现": ("F3F4F6", "4B5563"),
    "不在本次范围": ("EDE9FE", "5B21B6"),
    "待客户确认": ("E8F0FE", "1D4ED8"),
}
FONT_CANDIDATES = ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc",
                   "C:/Windows/Fonts/simhei.ttf", "/System/Library/Fonts/PingFang.ttc")


def font(size=11, bold=False, name=SONG, color="000000"):
    return Font(name=name, size=size, bold=bold, color=color)


def column_px(width):
    return width * PX_PER_UNIT + 5


def text_lines(text, width):
    per_line = max(4, int(column_px(width) / CHINESE_PX))
    total = 0
    for line in str(text).split("\n"):
        total += max(1, (len(line) + per_line - 1) // per_line)
    return total


def picture_font(size, bold=False):
    for path in FONT_CANDIDATES:
        if os.path.isfile(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def resolve_path(value, base_dir):
    """按 原样 → JSON 所在目录 → 当前目录 的顺序找文件。"""
    if not str(value).strip():
        return None
    candidates = [value] if os.path.isabs(value) else [
        value, os.path.join(base_dir, value), os.path.join(os.getcwd(), value)]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
    return None


def load_panel(path):
    """按面板上限等比缩放，返回 (图片, 宽, 高)。"""
    with PILImage.open(path) as image:
        image = image.convert("RGB")
        width, height = image.size
        scale = min(PANEL_MAX_W / float(width), PANEL_MAX_H / float(height))
        size = (max(1, int(round(width * scale))), max(1, int(round(height * scale))))
        return image.resize(size, PILImage.LANCZOS), size[0], size[1]


def wrap_to_width(draw, text, font, max_width):
    """按像素宽度逐字换行（中文没有空格可断，只能逐字量）。"""
    lines, current = [], ""
    for char in str(text):
        trial = current + char
        if current and draw.textlength(trial, font=font) > max_width:
            lines.append(current)
            current = char
        else:
            current = trial
    if current:
        lines.append(current)
    return lines


def compose_compare(before, after, caption, env):
    """把改前/改后并排合成一张对比图：每屏一条标签条，图下写说明与环境。"""
    panels = []
    for label, path, fill, color in (("改前", before, (242, 243, 245), (55, 65, 81)),
                                     ("改后", after, (234, 246, 238), (21, 128, 61))):
        if path:
            panels.append((label, load_panel(path), fill, color))
    if not panels:
        return None

    pad, gap, label_h = 12 * COMPOSE_SCALE, 14 * COMPOSE_SCALE, 24 * COMPOSE_SCALE
    label_font = picture_font(18 * COMPOSE_SCALE, bold=True)
    caption_font = picture_font(15 * COMPOSE_SCALE)

    body_h = max(panel[1][2] for panel in panels)
    width = pad * 2 + sum(panel[1][1] for panel in panels) + gap * (len(panels) - 1)
    measure = ImageDraw.Draw(PILImage.new("RGB", (1, 1)))
    caption_lines = []
    for line in (caption, env):
        if str(line or "").strip():
            caption_lines.extend(wrap_to_width(measure, line, caption_font, width - pad * 2))
    line_h = 24 * COMPOSE_SCALE
    height = pad * 2 + label_h + body_h + (line_h * len(caption_lines) + (6 * COMPOSE_SCALE if caption_lines else 0))

    canvas = PILImage.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)

    cursor = pad
    for label, (image, panel_w, panel_h), fill, color in panels:
        draw.rectangle([cursor, pad, cursor + panel_w, pad + label_h], fill=fill)
        draw.text((cursor + 12 * COMPOSE_SCALE, pad + 8 * COMPOSE_SCALE), label,
                  font=label_font, fill=color)
        canvas.paste(image, (cursor, pad + label_h))
        cursor += panel_w + gap

    y = pad + label_h + body_h + 8 * COMPOSE_SCALE
    for index, line in enumerate(caption_lines):
        text_w = draw.textlength(line, font=caption_font)
        draw.text(((width - text_w) / 2, y + index * line_h), line,
                  font=caption_font, fill=(110, 110, 110))
    return canvas


def validate(data, base_dir):
    """先收集全部问题再退出：1:1 覆盖、必填、图片可达。"""
    problems = []
    order_path = resolve_path(data.get("workorder") or "", base_dir)
    order = None
    if data.get("workorder") and order_path is None:
        problems.append("workorder 指向的工单不存在：%s" % data.get("workorder"))
    elif order_path:
        try:
            order = read_workorder(order_path)
        except SystemExit as error:
            problems.append("工单读取失败：%s" % error)

    rows = data.get("rows") or []
    if not rows:
        problems.append("content.json 缺少 rows（处置行）")

    seen = {}
    resolved = []
    for position, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            problems.append("第 %d 行不是对象" % position)
            continue
        item = row.get("item")
        if not isinstance(item, int) or isinstance(item, bool) or item < 1:
            problems.append("第 %d 行缺少合法的 item（工单序号，从 1 起）" % position)
            item = None
        elif item in seen:
            problems.append("item %d 重复出现（第 %d 行与第 %d 行）" % (item, seen[item], position))
        else:
            seen[item] = position
        if not str(row.get("handling") or "").strip():
            problems.append("第 %d 行缺少必填字段 handling（处置结果）" % position)

        source = order["items"][item - 1] if order and item and item <= len(order["items"]) else {}
        merged = {
            "task": str(row.get("task") or source.get("task") or "").strip(),
            "phenomenon": str(row.get("phenomenon") or source.get("phenomenon") or "").strip(),
            "expected": str(row.get("expected") or source.get("expected") or "").strip(),
            "handling": str(row.get("handling") or "").strip(),
            "files": str(row.get("files") or "").strip(),
            "status": str(row.get("status") or "").strip() or DEFAULT_STATUS,
            "caption": str(row.get("caption") or "").strip(),
            "env": str(row.get("env") or "").strip(),
        }
        if not merged["task"]:
            problems.append("第 %d 行缺少 task（任务明细），工单里也没有对应项" % position)
        images = {}
        for key in ("before", "after"):
            value = row.get(key)
            if value is None:
                images[key] = None
                continue
            found = resolve_path(str(value), base_dir)
            if found is None:
                problems.append("第 %d 行的 %s 图片不存在：%s" % (position, key, value))
            images[key] = found
        merged["note"] = str(row.get("note") or "").strip()
        resolved.append((item, merged, images))

    if order:
        total = len(order["items"])
        missing = [number for number in range(1, total + 1) if number not in seen]
        extra = sorted(number for number in seen if number > total)
        if missing:
            problems.append("工单共 %d 项任务，处置表缺第 %s 项" % (
                total, "、".join(str(number) for number in missing)))
        if extra:
            problems.append("处置表的 item 超出工单范围（工单共 %d 项）：%s" % (
                total, "、".join(str(number) for number in extra)))
    return problems, resolved, order


def build(data, out_path, base_dir):
    problems, resolved, order = validate(data, base_dir)
    if problems:
        sys.exit("content.json 校验未通过：\n  - " + "\n  - ".join(problems))

    project = str(data.get("project") or (order or {}).get("customer") or "").strip()
    if not project:
        sys.exit("content.json 缺少必填字段: project（客户或项目名）")
    customer = str(data.get("customer") or (order or {}).get("customer") or project).strip()
    rows = sorted(resolved, key=lambda entry: entry[0])
    sources = {entry[0]: entry[1]["task"] for entry in rows}
    for number, item_entry in enumerate((order or {}).get("items", []), start=1):
        if number in sources and sources[number] != item_entry["task"]:
            print("提醒：第 %d 项的 task 与工单原文不同，已按 content.json 写入" % number, file=sys.stderr)

    from datetime import datetime
    today = datetime.now()
    stamp = "%d年%d月%d日" % (today.year, today.month, today.day)
    title = str(data.get("title") or "《%s》改动任务处置表" % project)

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "改动任务处置表"
    for index, (_header, width, _align) in enumerate(COLUMNS, start=1):
        sheet.column_dimensions[get_column_letter(index)].width = width

    sheet.merge_cells("A1:%s1" % LAST_COL)
    cell = sheet["A1"]
    cell.value = title
    cell.font = font(18, bold=True, name=HEI)
    cell.alignment = Alignment(horizontal="center", vertical="center")
    sheet.row_dimensions[1].height = 36

    done = sum(1 for _item, row, _images in rows if row["status"] in ("已修复", "部分修复"))
    sheet.merge_cells("A2:%s2" % LAST_COL)
    cell = sheet["A2"]
    cell.value = "客户：%s　　编制单位：%s　　生成日期：%s　　工单任务：%d 项　　已处置：%d 项" % (
        customer, str(data.get("author") or BRAND), stamp, len(rows), done)
    cell.font = font(10, color="595959")
    cell.alignment = Alignment(horizontal="center", vertical="center")
    sheet.row_dimensions[2].height = 20

    header_fill = PatternFill("solid", fgColor="1F3864")
    header_font = font(11, bold=True, name=HEI, color="FFFFFF")
    for index, (header, _width, align) in enumerate(COLUMNS, start=1):
        cell = sheet.cell(row=3, column=index, value=header)
        cell.font = header_font
        cell.fill = header_fill
        cell.border = BORDER
        cell.alignment = Alignment(horizontal=align, vertical="center", wrap_text=True)
    sheet.row_dimensions[3].height = 26

    position = 4
    placed = 0
    scratch = tempfile.mkdtemp(prefix="disposition-")
    for item, row, images in rows:
        heights = []
        for index, (_header, width, align) in enumerate(COLUMNS):
            if index == COL_PROOF:
                continue
            if index == COL_INDEX:
                cell = sheet.cell(row=position, column=index + 1, value=item)
                cell.font = font(11, bold=True)
            elif index == COL_STATUS:
                cell = sheet.cell(row=position, column=index + 1, value=row["status"])
                fill, color = STATUS_STYLE.get(row["status"], ("F3F4F6", "374151"))
                cell.fill = PatternFill("solid", fgColor=fill)
                cell.font = font(11, bold=True, color=color)
            else:
                key = {COL_TASK: "task", COL_PHENOMENON: "phenomenon", COL_EXPECTED: "expected",
                       COL_HANDLING: "handling", COL_FILES: "files"}[index]
                cell = sheet.cell(row=position, column=index + 1, value=row[key] or "—")
                cell.font = font(11)
            cell.border = BORDER
            cell.alignment = Alignment(horizontal=align, vertical="top", wrap_text=True)
            heights.append(text_lines(cell.value or "", width) * LINE_PT + 8)

        proof_cell = sheet.cell(row=position, column=COL_PROOF + 1)
        proof_cell.border = BORDER
        proof_cell.alignment = Alignment(horizontal="center", vertical="top", wrap_text=True)

        canvas = compose_compare(images["before"], images["after"], row["caption"], row["env"])
        if canvas is None:
            note = row["note"] or "未提供：本次改动无可截图的界面变化"
            proof_cell.value = note
            proof_cell.font = font(10, color="808080")
            heights.append(text_lines(note, COLUMNS[COL_PROOF][1]) * LINE_PT + 8)
        else:
            box = column_px(COLUMNS[COL_PROOF][1]) - CELL_PAD_PX * 2
            scale = box / float(canvas.width) if canvas.width > box else 1.0
            width = max(1, int(round(canvas.width * scale)))
            height = max(1, int(round(canvas.height * scale)))
            if height > PROOF_BUDGET_PX:
                factor = PROOF_BUDGET_PX / float(height)
                width, height = max(1, int(width * factor)), max(1, int(height * factor))
            # openpyxl 只接受带 fp 的图片来源，合成图先落盘再交给它
            staged = os.path.join(scratch, "compare-%d.png" % item)
            canvas.save(staged, format="PNG")
            picture = XLImage(staged)
            picture.width, picture.height = width, height
            marker = AnchorMarker(col=COL_PROOF, colOff=pixels_to_EMU(CELL_PAD_PX),
                                  row=position - 1, rowOff=pixels_to_EMU(CELL_PAD_PX))
            picture.anchor = OneCellAnchor(
                _from=marker, ext=XDRPositiveSize2D(pixels_to_EMU(width), pixels_to_EMU(height)))
            sheet.add_image(picture)
            heights.append(height * 0.75 + CELL_PAD_PX * 2)
            placed += 1

        sheet.row_dimensions[position].height = min(ROW_HEIGHT_MAX, max(26, max(heights)))
        position += 1

    last_data_row = position - 1
    sheet.merge_cells("A%d:%s%d" % (position, LAST_COL, position))
    cell = sheet.cell(row=position, column=1)
    cell.value = ("说明：本表逐项对应工单第 1~%d 项，未覆盖即视为未处置；「证明截图」为改前/改后对比，"
                  "无可截图变化时写明原因；状态口径为 %s。" % (len(rows), " / ".join(STATUS_STYLE)))
    cell.font = font(9, color="808080")
    cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
    sheet.row_dimensions[position].height = 26

    sheet.freeze_panes = "A4"
    sheet.auto_filter.ref = "A3:%s%d" % (LAST_COL, max(3, last_data_row))
    sheet.print_title_rows = "3:3"
    sheet.page_setup.orientation = "landscape"
    sheet.page_setup.paperSize = sheet.PAPERSIZE_A4
    sheet.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
    sheet.page_setup.fitToWidth = 1
    sheet.page_setup.fitToHeight = 0
    sheet.print_options.horizontalCentered = True
    sheet.oddFooter.center.text = "第 &P 页 共 &N 页"
    sheet.oddFooter.center.size = 9

    workbook.save(out_path)
    shutil.rmtree(scratch, ignore_errors=True)
    print("OK 已生成 %s（%d 项任务全部对上，%d 张对比图）" % (out_path, len(rows), placed))


def main():
    if len(sys.argv) < 3:
        sys.exit("用法: python build_disposition.py content.json 输出.xlsx")
    json_path = os.path.abspath(sys.argv[1])
    try:
        with open(json_path, encoding="utf-8-sig") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as error:
        sys.exit("content.json 不是合法 JSON：%s" % error)
    out = os.path.abspath(sys.argv[2])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    build(data, out, os.path.dirname(json_path))


if __name__ == "__main__":
    main()
