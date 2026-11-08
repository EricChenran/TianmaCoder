# CHANGELOG

## 1.0.0 — 2026-11-08

**首个版本：从花伴鲜花项目管理后台/小程序确认书的实际编制过程抽取**

- 新增 `scripts/cdp.mjs` + `scripts/web-capture.mjs`：无头 Chromium + CDP 逐屏截图，覆盖
  内置浏览器截图不可用（`UnknownVizError`）的场景；动作词表含 menu/btn/rowbtn/radio/fill/wait/esc/
  setViewport/scroll，支持"整页截"（fit）与"弹窗截"（固定视口）两种取景。
- 新增 `scripts/mp-capture.cjs`：微信开发者工具 + miniprogram-automator 截图，内置
  登录流程、`cli auto` 通道打开、中文参数不编码等约束。
- 新增 `scripts/build_docx.py`：直接改甲方模板本体——克隆模板自带图注段与图片段继承版式，
  只替换文字与配图；支持多板块（Web界面 / 小程序界面）与连续图号。
- 新增 `references/scope-policy.md`：**截图范围口径**——一级页面全覆盖、二级页面每端 ≤5 张、
  合计 16–24 张，明确不截的六类页面。
- 新增三份示例配置：Web 截图计划、小程序截图计划、文档清单。
- 记录十条实测坑位（服务端口、ELECTRON_RUN_AS_NODE、mp.close()、管道提前关闭、
  段落克隆丢格式、板块标题 keepNext、图片高度换算等）。

## 1.1.0 — 2026-11-08

**内置到技术部模式**

- 随 `@tianma/dsh-department-prompts` 打包，由「技术部」预设挂载：启动时发布到
  `<harness home>/department/skills/ui-confirmation-doc`，无需手动加载；商务部与招投标专员不注册。
- 示例配置去掉本机绝对路径：甲方模板、微信开发者工具 CLI 与小程序项目目录改用占位符，换机器不失效。
