# 配图取用技能改动记录

## 2026-11-08

- 首版。固定 Pexels 检索页作为唯一抓取源，并联下载、JPEG 字节校验、按内容哈希去重、落本地图库。
- 图库默认落在用户本地数据目录，可用 `DSH_IMAGE_STORE` 覆盖；技能目录只存脚本与文档，避免重复发布把用户图片覆盖掉。
- 加入比例与尺寸过滤（`-Orientation`、`-MinWidth`），并在过滤开启时提高候选取样倍数，避免竖图占比高时凑不够张数。
- `curl.exe` 缺失时回退 `Invoke-WebRequest`；并发用 RunspacePool 实现，兼容 Windows PowerShell 5.1。
- 修正三处会在 5.1 上静默失效的写法：字节左移被截断导致宽高只剩低字节、`ConvertFrom-Json` 不拆数组导致索引层层嵌套、无 BOM 时中文按 GBK 解析报语法错。
- 去掉 `Invoke-WebRequest` 回退：实测该方式被图源站点以 403 拒绝，补 TLS 1.2 与浏览器请求头均无效；改为缺少 `curl.exe` 时报 `curl-missing` 并以退出码 5 结束，同时提示改用库内复用。
