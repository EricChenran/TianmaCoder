---
description: "TianmaCoder 桌面端部门模式的作业规则：每个模式一条字面系统提示词节，外加以受管 shell 变量方式发布的商务部文档工具箱。"
kind: "package-reference"
---

# @tianma/dsh-department-prompts

[English](README.md) | 中文

## 概述

`dsh-department-prompts` 把一条 preset 行变成一种部门模式。`apply` 把所选部门的规则注册为一条字面系统提示词节——`tianma:department`，排在 Tianma 行为规范之后、计划策略之前；对商务部还额外把随包交付的五个文档生成脚本发布到 harness home 下的私有目录，并以 `DSH_DEPARTMENT_TOOLS` 变量暴露给模型的 shell 调用。规则不经过技能系统加载、不会解析成模型可读的文件，而是以编译进插件的文本形式到达模型。

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

`tech` 只注册规则。`business` 在组合挂载了 `ctx.shellEnv` 时发布工具箱；没有该注册表的组合仍会得到规则，其脚本步骤保持惰性。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`apply` 注入 `systemPrompt` 并注册一条 `interpolate: false` 的节，因此规则里引用的 JSON 示例中的花括号会保持字面量，不会被当作提示词变量。节序 `150` 位于 `tianma:behavioral-guidelines`（100）之后、`PLAN_POLICY`（500）之前。

工具箱通过拷贝随包脚本发布，拷贝前先做字节比对，因此重复挂载不会重写任何文件；注册本身走 `ctx.effect`，变量随插件 fiber 一同回退。目录只以 `DSH_DEPARTMENT_TOOLS` 变量形式到达模型——规则文本、日志与 shell 命令中都不出现该路径。

### 源码索引

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、节注册、工具箱接线 |
| [`src/prompts/tech.ts`](src/prompts/tech.ts) | 技术部规则，编译内置 |
| [`src/prompts/business.ts`](src/prompts/business.ts) | 商务部规则，编译内置 |
| [`src/toolbox.ts`](src/toolbox.ts) | 脚本发布与 `DSH_DEPARTMENT_TOOLS` 贡献者 |
| [`assets/business/`](assets/business) | 随包交付的文档脚本：`gen_doc.py`、`gen_quote.py`、`add_watermark.py`、`to_pdf.py`、`open_folder.py` |
| [`tests/department-prompts.spec.ts`](tests/department-prompts.spec.ts) | 节注册、字面渲染、工具箱发布、用词守卫 |
| — | 不发布运行时不变式伴生入口；本插件只拥有一条静态节与一个派生目录，两者均由测试断言，也没有可供伴生入口独立观察的关系。 |

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [system-prompt 装配](../../core/system-prompt/README.zh.md)——本节点注册进的能力边界
- [shell-env](../../shell/shell-env/README.zh.md)——工具箱变量加入的受管 `DSH_*` 环境
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

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

以下边界说明本行在哪些场景不合适。它们是当前包的约束，不是任务清单。

- **规则编译内置，不是配置**——调整某个部门意味着改包。这是有意为之：配置字符串会把规则重新变成可读文件，而技能会把它们放到磁盘上供任何会话引用。
- **仅中文**——两套规则都没有本地化版本。
- **工具箱面向 Windows**——`to_pdf.py` 通过 COM 驱动 Word，`open_folder.py` 调起桌面外壳；本机无 Word 时规则要求模型改用 harness 的 Office 转换。
- **脚本原样发布**——随包副本保留其自身的注释与依赖（`python-docx`、`matplotlib`）；本包不维护它们。
- **每个 harness home 只有一个工具箱目录**——所有商务会话共用 `department/business-tools`。

<a id="dev-note"></a>
### 开发注记

<details>
<summary>为什么规则是提示词节而不是技能</summary>

技能是被发现、被列出、按需读取的：它的文本放在会话可以打开、引用、复制的 `SKILL.md` 里。部门模式需要的恰恰相反——规则要成为该模式本身的一部分：该模式总是带着它，其他模式完全没有它，并且它不能被当作一份文档来寻址。每个部门一条 `@deepseek-ai/dsh-agent-preset` 行正好提供这一点；工具箱则通过把脚本发布到变量背后的私有目录，让脚本不进入提示词路径。

</details>
