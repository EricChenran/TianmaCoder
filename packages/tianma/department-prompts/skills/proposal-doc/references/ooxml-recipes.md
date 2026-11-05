# OOXML 排版坑位与配方（全部实测踩过）

面向 `python-docx` 直接生成 DOCX 的场景。按"症状 → 原因 → 处置"组织，命中即照做，不要重新分析。

## 1. 该不缩进的段落仍然缩进 2 字符

- 症状：表格单元格、图题、页码、封面文字整体右移两个字符；表格列因此变窄、文字反复折行。
- 原因：`Normal` 样式里写了 `w:ind/@w:firstLineChars="200"`。直接格式只写 `w:firstLine="0"` 时，`firstLineChars` 仍从样式继承，而**字符单位优先于磅值**。
- 处置：不缩进的段落必须显式写 `w:firstLineChars="0"`（同理 `w:leftChars="0"`）；要 2 字符缩进就写 `w:firstLineChars="200"` 并且不要同时写 `w:firstLine`。

```python
ind.set(qn("w:firstLineChars"), "0")   # 关键：0 也要写出来
```

## 2. 表格宽度设置无效 / 列宽不按给定值

- 症状：明明设了 156mm 与逐列宽度，渲染出来却是均分或自动布局。
- 原因：`tblPr` 里出现了**两个 `w:tblW`**（python-docx 的 `autofit=False` 会写一个 `w:tblLayout`，而手工 `append` 又写了一份），且子元素顺序错误（`tblBorders` 必须在 `tblLayout` 之前）。渲染器取第一个，宽度就废了。
- 处置：先删同名元素再按序插入。

```python
for tag in ("w:tblW", "w:tblBorders", "w:tblCellMar"):
    for el in tblPr.findall(qn(tag)):
        tblPr.remove(el)
# 按 tblPr 顺序插入：tblStyle→tblW→jc→tblBorders→tblLayout→tblCellMar→tblLook
```

`tblPr` 顺序：`tblStyle, tblpPr, tblOverlap, bidiVisual, tblStyleRowBandSize, tblStyleColBandSize, tblW, jc, tblCellSpacing, tblInd, tblBorders, shd, tblLayout, tblCellMar, tblLook …`

`trPr` 顺序：`cnfStyle, divId, gridBefore, gridAfter, wBefore, wAfter, cantSplit, trHeight, tblHeader, tblCellSpacing, jc, hidden …`

## 3. 页眉横线只画一半 / 页码不右对齐

- 症状：页眉下划线从版心左边界起但只有 139mm 长；页码明明设了右对齐却跑到中间。
- 原因：`w:pBdr`、`w:spacing`、`w:ind`、`w:jc` 被 `append` 到 `pPr` 末尾，顺序错乱，渲染器只认一部分。
- 处置：按 `pPr` 顺序插入（`pBdr` 在 `shd` 前，`spacing` 在 `ind` 前，`jc` 在 `textDirection` 前）；或者干脆用 python-docx 的 `paragraph_format` 设置（它内部就是有序插入），只对 `firstLineChars` 这类它不支持的属性做"属性级"补写（属性顺序无所谓，元素顺序才有所谓）。

`pPr` 顺序：`pStyle, keepNext, keepLines, pageBreakBefore, framePr, widowControl, numPr, suppressLineNumbers, pBdr, shd, tabs, …, snapToGrid, spacing, ind, contextualSpacing, …, jc, textDirection, …, outlineLvl, …, rPr, sectPr, pPrChange`

## 4. 图片被裁掉一截 / 只露一条

- 症状：插入的图只显示顶部一条。
- 原因：图片所在段落继承了 28.8 磅的固定行距，行高被锁死。
- 处置：图片段落单独设 `line_spacing = 1.0`（并 `snapToGrid=0`）。

## 5. 目录页码全是 1，或整块变灰

- 症状：用 `TOC` 域包住目录内容，LibreOffice 渲染出灰底色块，页码全是 1。
- 原因：LO 把 `TOC` 域当成"索引对象"整体处理，不解析域结果里嵌套的 `PAGEREF`。
- 处置：**不要外层 `TOC` 域**。目录用普通段落 + 右对齐点状前导符制表位 + 每条一个 `PAGEREF` 域，指向标题处的书签。Word 与 LO 在排版时都会解析 `PAGEREF`，页码永远是对的。

```text
[书签] w:bookmarkStart w:name="_Toc0001"  ← 放在标题段首
[目录项] 文本 + <w:tab/> + { PAGEREF _Toc0001 \h }
```

## 6. 表格只掉一行到下一页

- 症状：整张表在页底被切断，续页只剩一行加表头。
- 处置：除最后一行外，所有单元格段落设 `keep_with_next=True`，并给每行加 `w:cantSplit`；表头行加 `w:tblHeader` 保证续页有表头。
- 副作用：表放不下时会整体挪到下一页，**前一页留白**。这时应回头压缩表格（缩文案、调列宽、降行距），而不是放开 keep。

## 7. 连续几张图把整页顶空

- 症状：正文写完了，后面跟着 4 张图，结果第一张图之后整页空白，4 张图全跑到下一页。
- 原因：图题也设了 `keep_with_next`，于是"图→题→图→题…"串成一条长链，必须整体同页。
- 处置：图片段落 `keep_with_next=True`（保证不和图题分离），**图题 `keep_with_next=False`**。

## 8. 奇偶页页码

- 需要 `settings.xml` 加 `<w:evenAndOddHeaders/>`，然后分别设 `section.footer`（奇数页）与 `section.even_page_footer`（偶数页），两者都要 `is_linked_to_previous = False`。
- 正文页码从 1 重起：在该节 `sectPr` 插 `<w:pgNumType w:start="1" w:fmt="decimal"/>`（需插在 `w:cols` 之前）。
- 页码格式：`—` + 两个半角空格 + `PAGE` 域 + 两个半角空格 + `—`，宋体四号；单页右对齐且右缩进 1 字，双页左对齐且左缩进 1 字。

## 9. 表格跨页没有"（续）"

- `w:tblHeader` 只能重复表头，不会生成"表N（续）"题注。要严格合规，只能把长表手工拆成两张表、第二张重新写题注。
- 实务做法：优先**把长表压到一页**（缩文案、行高 5.6mm、字号五号），压不下去再拆。报价明细 30 行左右在一页内是放得下的。

## 10. 图片周围多出一圈细框

- 现象：LibreOffice 渲染时给内联图片画 1px 浅灰边框，Word 不画。
- 这是渲染器差异，DOCX 里没有 `a:ln`，不是文件缺陷。给 `pic:spPr` 补 `<a:ln><a:noFill/></a:ln>` 也去不掉（LO 忽略）。**交付时用 Word 或 WPS 复核，不要以 LO 预览为准判定"图片有边框"。**

## 11. 渲染核对的小工具

```python
from PIL import Image
import numpy as np
im = Image.open(page_png).convert("L")
a = np.array(im)
rows = np.where((a < 150).any(axis=1))[0]
print("内容下沿 mm =", round(rows.max() / a.shape[0] * 297, 1))   # 判断留白多少
```

页眉横线、页码位置都建议这样量：`bbox` 换算成 mm 再对照 28/184mm 的版心边界，比目测可靠。
