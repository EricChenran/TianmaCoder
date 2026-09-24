---
description: "TianmaCoder 桌面端部门模式的作业规则：每个模式一条字面系统提示词节，外加商务部文档工具箱与随包公文技能——两者都从运行时归档中发布出来。"
kind: "package-reference"
---

# @tianma/dsh-department-prompts

[English](README.md) | 中文

## 概述

`dsh-department-prompts` 把一条 preset 行变成一种部门模式。`apply` 把所选部门的规则注册为一条字面系统提示词节——`tianma:department`，排在 Tianma 行为规范之后、计划策略之前；为两种模式发布随包公文技能、为技术部额外发布随包的无头演示视频技能，并对商务部额外把随包交付的五个文档生成脚本发布到 harness home 下的私有目录，以 `DSH_DEPARTMENT_TOOLS` 变量暴露给模型的 shell 调用。规则不经过技能系统加载、不会解析成模型可读的文件，而是以编译进插件的文本形式到达模型；技能是另一项贡献，只有这两种模式携带它们，其中演示视频技能只到技术部。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

随发行版交付的 `tech`（技术部）与 `business`（商务部）两个预设各挂载一行：

```yaml
- id: tianma-department
  name: '@tianma/dsh-department-prompts'
  config:
    department: business
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `department` | 必填 | 本行贡献的规则集：`tech` 或 `business` |
| `assetRoot` | 包内 `assets/business/` | 脚本来源目录，供自行携带副本的部署使用 |
| `toolsDir` | `<harness home>/department/business-tools` | 脚本发布到的目录 |
| `skillAssetRoot` | 包内 `skills/official-doc/` | 技能来源目录，供自行携带副本的部署使用 |
| `skillDir` | `<harness home>/department/skills/official-doc` | 技能发布到的目录 |

两种模式都会注册并发布公文技能，技术部还会注册并发布无头演示视频技能；`business` 在组合挂载了 `ctx.shellEnv` 时还会发布工具箱。缺少技能注册表的组合只得到规则、没有技能；缺少 `ctx.shellEnv` 的组合只得到规则、没有工具箱。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`apply` 注入 `systemPrompt` 并注册一条 `interpolate: false` 的节，因此规则里引用的 JSON 示例中的花括号会保持字面量，不会被当作提示词变量。节序 `150` 位于 `tianma:behavioral-guidelines`（100）之后、`PLAN_POLICY`（500）之前。

工具箱通过拷贝随包脚本发布，拷贝前先做字节比对，因此重复挂载不会重写任何文件；注册本身走 `ctx.effect`，变量随插件 fiber 一同回退。目录只以 `DSH_DEPARTMENT_TOOLS` 变量形式到达模型——规则文本、日志与 shell 命令中都不出现该路径。

公文技能以同样方式发布到 `<harness home>/department/skills/official-doc`，其提供方注册进调用方的上下文，因此这条目录项只存在于挂载本行的模式里。加载后的正文把该目录报告为资源基准，技能自身的相对路径都相对它解析。演示视频技能同样发布到 `<harness home>/department/skills/web-demo-video`，但它只由技术部那一行注册，因此即便两个预设共用本行，商务部也拿不到它。

### 源码索引

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、节注册、技能与工具箱接线 |
| [`src/prompts/tech.ts`](src/prompts/tech.ts) | 技术部规则，编译内置 |
| [`src/prompts/business.ts`](src/prompts/business.ts) | 商务部规则，编译内置 |
| [`src/toolbox.ts`](src/toolbox.ts) | 脚本发布与 `DSH_DEPARTMENT_TOOLS` 贡献者 |
| [`src/skill.ts`](src/skill.ts) | 技能发布与随包 `official-doc`、`web-demo-video` 提供方 |
| [`assets/business/`](assets/business) | 随包交付的文档脚本：`gen_doc.py`、`gen_quote.py`、`add_watermark.py`、`to_pdf.py`、`open_folder.py` |
| [`skills/official-doc/`](skills/official-doc) | 随包交付的公文技能：`SKILL.md`、`scripts/gen_doc.py`、`assets/logo_light.png` |
| [`skills/web-demo-video/`](skills/web-demo-video) | 随包交付的无头演示视频技能（仅技术部）：`SKILL.md`、`scripts/webdemo.mjs`、`scripts/lib/*.mjs`、`references/*` |
| [`tests/department-prompts.spec.ts`](tests/department-prompts.spec.ts) | 节注册、字面渲染、工具箱与技能发布、目录作用域、用词守卫 |
| [`tests/web-demo-video-skill.spec.ts`](tests/web-demo-video-skill.spec.ts) | 演示视频技能的字节级发布、提供方元数据与仅技术部作用域 |
| — | 不发布运行时不变式伴生入口；本插件只拥有一条静态节与两个派生目录，均由测试断言，也没有可供伴生入口独立观察的关系。 |

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [system-prompt 装配](../../core/system-prompt/README.zh.md)——本节点注册进的能力边界
- [shell-env](../../shell/shell-env/README.zh.md)——工具箱变量加入的受管 `DSH_*` 环境
- [技能注册表](../../skill/skill/README.zh.md)——随包提供方注册进的能力边界
- [agent-preset](../../preset/agent-preset/README.zh.md)——按模式携带本行的声明
- [web-app 组合包预设](../../bundle/web-app/README.zh.md)——随发行版交付的两个部门预设所在处

-----

<a id="model-experience"></a>
## 模型体验

### 部门规则

#### 模型看到什么

一条字面系统提示词节 `tianma:department`，承载所选部门的完整规则：技术部覆盖后端、前端、运维三类纪律与交付自检；商务部覆盖需求文档、报价单、案例检索与共通的商务红线，其中需求文档必须以结构化正文承载完整的业务工作流并与脚本生成的流程图并存，同时写出同内容的 Markdown 副本供转交技术部。文本与 `departmentPrompt(department)` 逐字节一致，且该节不替换任何内容——它与 persona、工作区指令、行为规范并列组合。

#### Token 影响

按 4 字符/token 的启发式估计，技术部约 6,400 token、商务部约 3,300 token，作为系统提示词的一部分每请求一次、跨轮不变。用户未选择的模式不产生任何开销。

#### KV 缓存影响

静态文本位于稳定的系统提示词前缀内：它构成可复用前缀，且不会使既有条目失效。在部门模式之间切换，改变前缀的方式与在任意两个预设之间切换相同。

### 随包公文技能

#### 模型看到什么

处于任一部门模式的会话多出一条目录项 `official-doc`，描述为生成宜春天码信息集团公文（DOCX 与 PDF 双格式）。加载后返回工作流——固化的 GB/T 9704 版式、`content.json` schema、各文种起草要点——以及生成脚本与集团 LOGO 被发布到的资源基准。模型执行 `python <基准>/scripts/gen_doc.py`，并用 `present` 交付两个文件。其他模式没有这条目录项。

#### Token 影响

这两种模式下每请求一条目录行（描述上限 500 字符），加上真正加载它的步骤所产生的正文开销（数千字符）。其他模式零开销。

#### KV 缓存影响

目录行位于部门会话的稳定前缀内；加载正文只是追加一条工具结果。

### 随包无头演示视频技能（仅技术部）

#### 模型看到什么

处于技术部模式的会话多出一条目录项 `web-demo-video`，描述为用无头浏览器驱动真实交互、录制带中文讲解字幕的演示视频（配音可选），只认一份 `plan.json`。加载后返回完整作业流程——环境体检与降级阶梯、`plan.json` 结构、验收门禁、踩坑清单——以及脚本被发布到的资源基准；模型执行 `node <基准>/scripts/webdemo.mjs doctor|probe|record|build`。商务部模式与其他模式没有这条目录项。

#### Token 影响

技术部模式下每请求一条目录行（描述 402 字符，上限 500），加上真正加载它的步骤所产生的正文开销（约 12 KB）。商务部模式与其他模式零开销。

#### KV 缓存影响

目录行位于技术部会话的稳定前缀内；加载正文只是追加一条工具结果。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

以下边界说明本行在哪些场景不合适。它们是当前包的约束，不是任务清单。

- **规则编译内置，不是配置**——调整某个部门意味着改包。这是有意为之：配置字符串会把规则重新变成可读文件，而技能会把它们放到磁盘上供任何会话引用。
- **仅中文**——两套规则都没有本地化版本。
- **工具箱面向 Windows**——`to_pdf.py` 通过 COM 驱动 Word，`open_folder.py` 调起桌面外壳；本机无 Word 时规则要求模型改用 harness 的 Office 转换。
- **脚本原样发布**——随包副本保留其自身的注释与依赖（`python-docx`、`matplotlib`）；本包不维护它们。
- **公文技能需要带 `reportlab` 的解释器**——随包运行时载荷带 `python-docx` 与 `Pillow`，但不带 `reportlab`，因此机器上的 `python` 缺它时只能得到 DOCX、没有 PDF。技能正文要求模型交付 DOCX 并说明原因，而不是静默丢掉 PDF。
- **每个 harness home 的工具箱目录与技能目录按名字共用**——所有部门会话共用 `department/business-tools` 与 `department/skills/official-doc`，技术部会话另加 `department/skills/web-demo-video`。
- **技能里的 `scripts/lib/` 要强制入仓**——仓库级 `.gitignore` 忽略所有 `lib/` 目录，因此新增或改动该目录下的文件必须 `git add -f`；漏掉的话仓库与随包副本会缺那五个模块，`webdemo.mjs` 直接起不来。

<a id="dev-note"></a>
### 开发注记

<details>
<summary>为什么规则是提示词节而不是技能</summary>

技能是被发现、被列出、按需读取的：它的文本放在会话可以打开、引用、复制的 `SKILL.md` 里。部门模式需要的恰恰相反——规则要成为该模式本身的一部分：该模式总是带着它，其他模式完全没有它，并且它不能被当作一份文档来寻址。每个部门一条 `@deepseek-ai/dsh-agent-preset` 行正好提供这一点；工具箱则通过把脚本发布到变量背后的私有目录，让脚本不进入提示词路径。

</details>

<details>
<summary>为什么公文技能是发布出来而不是直接指向</summary>

本行是技术部与商务部两个预设唯一共用的东西，因此在这里注册提供方就能限定技能的作用域，无需改动任何一个预设声明。演示视频技能只在技术部那一行注册，所以共用这一行不会把它带给商务部。技能也不能直接放进被扫描的根目录：随包副本位于应用运行时归档内，只有 Host 进程能读，而模型的解释器是独立进程、打不开归档路径。把整棵树发布到 harness home 下，模型才拿到一个真实目录，而随正文一起报告的资源基准就是它找到生成脚本的依据。

</details>
