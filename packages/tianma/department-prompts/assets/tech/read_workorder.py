#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
read_workorder.py — 读《改动任务工单》xlsx，把每一项任务打印成 JSON
用法: python read_workorder.py "<改动任务工单.xlsx>"
依赖: openpyxl
输出: 标准输出为 UTF-8 JSON：workorder / title / project / customer / items[]
      items 每项含 item（工单序号）、time、task、phenomenon、expected、status
用途: 技术部接单第一步——先把工单读成结构化条目，再逐条拆解与处置。
"""
import json
import os
import re
import sys

try:
    from openpyxl import load_workbook
except ImportError:
    sys.exit("缺少依赖 openpyxl：请先执行  python -m pip install openpyxl Pillow")

# 表头别名：列顺序被调整过也认得出
COLUMN_ALIASES = {
    "time": ("时间",),
    "task": ("任务明细", "任务", "改动任务", "需求"),
    "phenomenon": ("当前现象", "现状", "现象"),
    "expected": ("期望改动后", "期望结果", "期望"),
    "status": ("状态",),
    "proof": ("证明截图", "截图"),
}


def cell_text(value):
    if value is None:
        return ""
    return str(value).strip()


def project_from_title(title):
    """标题形如「《某客户电商小程序》改动任务工单」时取出书名号里的项目名。"""
    match = re.search(r"《([^》]+)》", title)
    if match:
        return match.group(1).strip()
    return title.replace("改动任务工单", "").strip(" 　《》")


def locate_header(sheet):
    """找到含「任务明细」的表头行，返回 (行号, {字段: 列号})；找不到即报错。"""
    for row in sheet.iter_rows(min_row=1, max_row=min(sheet.max_row, 30)):
        found = {}
        for cell in row:
            text = cell_text(cell.value)
            for field, aliases in COLUMN_ALIASES.items():
                if text in aliases and field not in found:
                    found[field] = cell.column
        if "task" in found:
            return row[0].row, found
    raise SystemExit("这张表里找不到「任务明细」表头，无法按工单读取；请确认传入的是《改动任务工单》")


def read_workorder(path):
    """把一张工单读成条目清单；表尾的说明行与空行自动跳过。"""
    workbook = load_workbook(path, data_only=True)
    sheet = workbook.active
    header_row, columns = locate_header(sheet)

    title = cell_text(sheet.cell(row=1, column=1).value)
    meta = ""
    for offset in range(1, header_row):
        text = cell_text(sheet.cell(row=offset, column=1).value)
        # 标题行本身常含「客户」二字，只认以「客户：」开头或带编制单位的信息行
        if not text or text == title:
            continue
        if re.match(r"^客户[：:]", text) or "编制单位" in text:
            meta = text
            break

    def meta_value(label):
        for part in meta.split("　"):
            part = part.strip()
            if part.startswith(label):
                return part[len(label):].strip("：: ")
        return ""

    items = []
    for row in sheet.iter_rows(min_row=header_row + 1, max_row=sheet.max_row):
        task = cell_text(row[columns["task"] - 1].value)
        if not task:
            continue
        if task.startswith("说明") or task.startswith("状态口径"):
            break
        entry = {"item": len(items) + 1, "task": task}
        for field, column in columns.items():
            if field in ("task",):
                continue
            entry[field] = cell_text(row[column - 1].value)
        items.append(entry)

    if not items:
        raise SystemExit("工单里没有读到任何任务行；请确认表格从表头下方开始填写")

    project = meta_value("客户") or project_from_title(title)
    return {
        "workorder": os.path.abspath(path),
        "title": title,
        "project": project,
        "customer": meta_value("客户"),
        "items": items,
    }


def main():
    if len(sys.argv) < 2:
        sys.exit("用法: python read_workorder.py 改动任务工单.xlsx")
    source = sys.argv[1]
    if not os.path.isfile(source):
        sys.exit("文件不存在: %s" % source)
    print(json.dumps(read_workorder(source), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
