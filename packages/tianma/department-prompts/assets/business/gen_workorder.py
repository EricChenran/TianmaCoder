#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_workorder.py — 从 content.json 一步生成《改动任务工单》Excel（图文混排）
用法: python gen_workorder.py content.json "客户名/改动任务工单-客户名.xlsx"
依赖: openpyxl、Pillow（缺任一即报错退出，并给出安装命令）
校验: rows 非空；每行 task / phenomenon / expected 必填；images 指向的文件必须存在
版式: 六列（时间｜任务明细｜当前现象｜期望改动后｜证明截图｜状态），
      标题行合并、表头冻结并重复打印、整表细边框、自动换行、
      「证明截图」列内嵌图片并按图高自动调整行高、A4 横向按页宽缩放、
      页脚"第 X 页 共 Y 页"。
"""
import json
import os
import sys
from datetime import datetime

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
    from PIL import Image as PILImage
except ImportError:
    sys.exit("缺少依赖 Pillow：请先执行  python -m pip install openpyxl Pillow")

SONG, HEI = "宋体", "黑体"
BRAND = "帆远网络科技"
DEFAULT_STATUS = "待处理"

# 列：表头、字符宽、水平对齐
COLUMNS = [
    ("时间", 19, "center"),
    ("任务明细", 32, "left"),
    ("当前现象", 32, "left"),
    ("期望改动后", 32, "left"),
    ("证明截图", 34, "center"),
    ("状态", 10, "center"),
]
COL_TIME, COL_TASK, COL_PHENOMENON, COL_EXPECTED, COL_PROOF, COL_STATUS = range(6)
LAST_COL = get_column_letter(len(COLUMNS))

PX_PER_UNIT = 7          # Excel 字符宽 → 像素的近似换算
CHINESE_PX = 14          # 11pt 中文单字宽度
LINE_PT = 16             # 单行文字高度（pt）
ROW_HEIGHT_MAX = 409     # Excel 行高上限（pt）
IMAGE_GAP_PX = 6
CELL_PAD_PX = 4
TALL_IMAGE_PX = 300      # 单张图片高度上限，超过按高度先缩
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

STATUS_STYLE = {
    "待处理": ("FFF4E5", "B45309"),
    "处理中": ("E8F0FE", "1D4ED8"),
    "已完成": ("E6F4EA", "15803D"),
    "已验收": ("DCFCE7", "166534"),
    "已驳回": ("FDECEA", "B91C1C"),
    "已取消": ("F3F4F6", "4B5563"),
}
TIME_FORMATS = ("%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y/%m/%d %H:%M", "%Y/%m/%d",
                "%Y年%m月%d日 %H:%M", "%Y年%m月%d日", "%Y.%m.%d")


def font(size=11, bold=False, name=SONG, color="000000"):
    return Font(name=name, size=size, bold=bold, color=color)


def column_px(width):
    return width * PX_PER_UNIT + 5


def text_lines(text, width):
    """估算一段文字在给定列宽下占几行。"""
    per_line = max(4, int(column_px(width) / CHINESE_PX))
    total = 0
    for line in str(text).split("\n"):
        total += max(1, (len(line) + per_line - 1) // per_line)
    return total


def as_text_list(value):
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    return [str(item) for item in value]


def parse_time(value):
    """把时间写成可排序的日期/日期时间；认不出的写法原样保留为文本。"""
    raw = str(value).strip()
    if not raw:
        return None, None
    for fmt in TIME_FORMATS:
        try:
            parsed = datetime.strptime(raw, fmt)
        except ValueError:
            continue
        return parsed, "yyyy-mm-dd hh:mm" if "%H" in fmt else "yyyy-mm-dd"
    return raw, None


def resolve_image(path, json_dir):
    """按 原样 → JSON 所在目录 → 当前目录 的顺序找图片。"""
    candidates = [path] if os.path.isabs(path) else [path, os.path.join(json_dir, path),
                                                    os.path.join(os.getcwd(), path)]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
    return None


def layout_images(paths):
    """等宽缩放一组图片，返回 [(path, 宽px, 高px)]；超高时整体再缩。"""
    box = column_px(COLUMNS[COL_PROOF][1]) - CELL_PAD_PX * 2
    sized = []
    for path in paths:
        with PILImage.open(path) as image:
            width, height = image.size
        if width <= 0 or height <= 0:
            raise ValueError(path)
        scale = box / float(width)
        if height * scale > TALL_IMAGE_PX:
            scale = TALL_IMAGE_PX / float(height)
        sized.append([path, max(1, int(round(width * scale))), max(1, int(round(height * scale)))])
    budget = ROW_HEIGHT_MAX * 0.75 - CELL_PAD_PX * 2 - IMAGE_GAP_PX * max(0, len(sized) - 1)
    total = sum(item[2] for item in sized) + IMAGE_GAP_PX * max(0, len(sized) - 1)
    if total > budget and total > 0:
        factor = budget / float(total)
        for item in sized:
            item[1] = max(1, int(item[1] * factor))
            item[2] = max(1, int(item[2] * factor))
    return [tuple(item) for item in sized]


def validate(data, json_dir):
    """收集全部问题后一次性报出，避免逐条改、逐条跑。"""
    problems = []
    rows = data.get("rows") or []
    blank_rows = data.get("blank_rows")
    if not rows and not isinstance(blank_rows, int):
        problems.append("content.json 缺少 rows（或提供 blank_rows 生成空模板）")
    resolved = []
    for index, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            problems.append("第 %d 行不是对象" % index)
            continue
        for key, label in (("task", "任务明细"), ("phenomenon", "当前现象"), ("expected", "期望改动后")):
            if not str(row.get(key) or "").strip():
                problems.append("第 %d 行缺少必填字段 %s（%s）" % (index, key, label))
        images = []
        raw_images = row.get("images")
        if raw_images is None and row.get("image") is not None:
            raw_images = row.get("image")
        for path in as_text_list(raw_images):
            if not str(path).strip():
                continue
            found = resolve_image(str(path).strip(), json_dir)
            if found is None:
                problems.append("第 %d 行的图片不存在：%s" % (index, path))
            else:
                images.append(found)
        resolved.append((row, images))
    return problems, resolved


def build(data, out_path, json_dir):
    problems, resolved = validate(data, json_dir)
    if problems:
        sys.exit("content.json 校验未通过：\n  - " + "\n  - ".join(problems))

    project = str(data.get("project") or data.get("customer") or "").strip()
    if not project:
        sys.exit("content.json 缺少必填字段: project（客户或项目名）")

    title = str(data.get("title") or "《%s》改动任务工单" % project)
    today = datetime.now()
    stamp = "%d年%d月%d日" % (today.year, today.month, today.day)
    customer = str(data.get("customer") or project).strip()
    author = str(data.get("author") or BRAND).strip()
    rows = resolved
    blank_rows = data.get("blank_rows")
    total_items = len(rows) if rows else (blank_rows if isinstance(blank_rows, int) else 0)

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "改动任务工单"
    for index, (header, width, _align) in enumerate(COLUMNS, start=1):
        sheet.column_dimensions[get_column_letter(index)].width = width

    # 标题行与信息行
    sheet.merge_cells("A1:%s1" % LAST_COL)
    cell = sheet["A1"]
    cell.value = title
    cell.font = font(18, bold=True, name=HEI)
    cell.alignment = Alignment(horizontal="center", vertical="center")
    sheet.row_dimensions[1].height = 36

    sheet.merge_cells("A2:%s2" % LAST_COL)
    cell = sheet["A2"]
    cell.value = "客户：%s　　编制单位：%s　　生成日期：%s　　任务项：%d" % (customer, author, stamp, total_items)
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
    for row, images in rows:
        heights = []
        for index, (header, width, align) in enumerate(COLUMNS):
            if index == COL_PROOF:
                continue
            value = row.get("time") if index == COL_TIME else row.get(
                {COL_TASK: "task", COL_PHENOMENON: "phenomenon", COL_EXPECTED: "expected",
                 COL_STATUS: "status"}[index])
            if index == COL_TIME:
                parsed, number_format = parse_time(value or "")
                if parsed is None:
                    parsed = stamp
                cell = sheet.cell(row=position, column=index + 1, value=parsed)
                if number_format:
                    cell.number_format = number_format
            elif index == COL_STATUS:
                status = str(value or "").strip() or DEFAULT_STATUS
                cell = sheet.cell(row=position, column=index + 1, value=status)
                fill, color = STATUS_STYLE.get(status, ("F3F4F6", "374151"))
                cell.fill = PatternFill("solid", fgColor=fill)
                cell.font = font(11, bold=True, color=color)
            else:
                cell = sheet.cell(row=position, column=index + 1, value=str(value))
                cell.font = font(11)
            cell.border = BORDER
            cell.alignment = Alignment(horizontal=align, vertical="top", wrap_text=True)
            heights.append(text_lines(cell.value or "", width) * LINE_PT + 8)

        note = str(row.get("proof") or "").strip()
        proof_cell = sheet.cell(row=position, column=COL_PROOF + 1)
        proof_cell.border = BORDER
        proof_cell.alignment = Alignment(horizontal="center", vertical="top", wrap_text=True)
        offset_px = CELL_PAD_PX
        if note:
            proof_cell.value = note
            proof_cell.font = font(10)
            note_lines = text_lines(note, COLUMNS[COL_PROOF][1])
            offset_px += note_lines * LINE_PT * 0.75
            heights.append(note_lines * LINE_PT + 8)
        elif not images:
            proof_cell.value = "—"
            proof_cell.font = font(10, color="808080")
        if images:
            try:
                sized = layout_images(images)
            except ValueError:
                sys.exit("图片无法读取（文件损坏或不是图片）：%s" % ", ".join(images))
            cursor = offset_px
            for path, width, height in sized:
                picture = XLImage(path)
                picture.width, picture.height = width, height
                marker = AnchorMarker(
                    col=COL_PROOF, colOff=pixels_to_EMU(CELL_PAD_PX),
                    row=position - 1, rowOff=pixels_to_EMU(cursor),
                )
                picture.anchor = OneCellAnchor(
                    _from=marker, ext=XDRPositiveSize2D(pixels_to_EMU(width), pixels_to_EMU(height)),
                )
                sheet.add_image(picture)
                cursor += height + IMAGE_GAP_PX
                placed += 1
            heights.append(cursor * 0.75 + CELL_PAD_PX)
        sheet.row_dimensions[position].height = min(ROW_HEIGHT_MAX, max(24, max(heights)))
        position += 1

    if not rows and isinstance(blank_rows, int):
        for _ in range(max(0, blank_rows)):
            for index, (_header, _width, align) in enumerate(COLUMNS, start=1):
                cell = sheet.cell(row=position, column=index)
                cell.border = BORDER
                cell.alignment = Alignment(horizontal=align, vertical="top", wrap_text=True)
            sheet.row_dimensions[position].height = 30
            position += 1

    last_data_row = position - 1
    sheet.merge_cells("A%d:%s%d" % (position, LAST_COL, position))
    cell = sheet.cell(row=position, column=1)
    cell.value = ("说明：状态口径为 %s；证明截图须为改动前现象或改动后结果的真实截图，"
                  "缺图时在单元格内注明缺图原因。" % " / ".join(STATUS_STYLE))
    cell.font = font(9, color="808080")
    cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
    sheet.row_dimensions[position].height = 24

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
    print("OK 已生成 %s（%d 项任务，%d 张截图）" % (out_path, total_items, placed))


def main():
    if len(sys.argv) < 3:
        sys.exit("用法: python gen_workorder.py content.json 输出.xlsx")
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
