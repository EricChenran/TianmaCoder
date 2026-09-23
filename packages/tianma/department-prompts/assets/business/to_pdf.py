#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
to_pdf.py — 用本机 MS Word 将 .docx 转成同目录同名 .pdf（保留原 docx）
用法: python to_pdf.py <文件.docx>
说明: 每次调用只转一个文件（本机 Word COM 的稳定用法）；需安装 MS Word。
"""
import os
import subprocess
import sys
import tempfile

PS_TEMPLATE = r'''
$ErrorActionPreference = 'Stop'
$src = '__SRC__'
$dst = '__DST__'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$ok = $false
try {
  $doc = $word.Documents.Open($src, $false, $true)
  $doc.SaveAs2($dst, 17)
  $doc.Close($false)
  $ok = $true
} catch {
  Write-Output ('error: ' + $_.Exception.Message)
} finally {
  try { $word.Quit() } catch { }
}
if (-not $ok) { exit 1 }
Write-Output 'converted'
'''


def main():
    if len(sys.argv) < 2:
        sys.exit("用法: python to_pdf.py <文件.docx>")
    src = os.path.abspath(sys.argv[1])
    if not os.path.isfile(src):
        sys.exit("文件不存在: %s" % src)
    dst = os.path.splitext(src)[0] + ".pdf"
    fd, ps1 = tempfile.mkstemp(suffix=".ps1")
    os.close(fd)
    with open(ps1, "w", encoding="utf-8-sig") as f:
        f.write(PS_TEMPLATE.replace("__SRC__", src.replace("'", "''"))
                        .replace("__DST__", dst.replace("'", "''")))
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
            timeout=180, capture_output=True, text=True)
    finally:
        try:
            os.remove(ps1)
        except OSError:
            pass
    if os.path.exists(dst):
        print("OK 已生成 %s" % dst)
    else:
        sys.exit("PDF 转换失败：请确认本机安装了 MS Word，然后重试")


if __name__ == "__main__":
    main()
