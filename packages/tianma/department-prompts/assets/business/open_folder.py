#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
open_folder.py — 用资源管理器打开文件夹
用法: python open_folder.py <文件夹>
"""
import os
import sys


def main():
    if len(sys.argv) < 2:
        sys.exit("用法: python open_folder.py <文件夹>")
    path = os.path.abspath(sys.argv[1])
    if not os.path.isdir(path):
        sys.exit("文件夹不存在: %s" % path)
    os.startfile(path)
    print("OK 已在资源管理器打开 %s" % path)


if __name__ == "__main__":
    main()
