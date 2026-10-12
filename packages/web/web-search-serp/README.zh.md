---
description: "ctx.web 的搜索引擎抓取提供方：部署无需搜索 API、无需凭据、也无需辅助模型请求，即可检索百度、Bing、360 的结果页。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-serp

[English](README.md) | 中文

## 概述

`dsh-web-search-serp` 让 harness 通过读取百度、Bing、360 以纯 HTTP 返回的结果页来搜索网络。当一个部署既没有搜索 API、也不希望在搜索链路上放置凭据或发起辅助模型请求时选择它；出厂的 base 组合包把它选为 `serp`。提供方并发查询每个已配置的引擎，丢弃失败或被拦截的引擎，再把存活引擎的结果合并为一份去重后的来源列表。没有引擎返回生成式答案，因此结果只携带可引用的来源。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发者备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务的组合中挂载本提供方；它以 `serp` 这一搜索提供方 id 注册，因此当它是唯一可用后端时 `ctx.web.search()` 会自动解析到它，也可以用 `searchProvider: serp` 固定选择——出厂 base 组合包就是这么做的。

### 何时选择它

当没有可用的搜索 API（或不希望接入）且该部署接受以 HTTP 读取引擎结果页时，选择这个后端：它不需要任何密钥，因此未配置的安装也能搜索，并且不消耗模型 token 做检索。当结果必须完整或稳定时它并不合适——页面内容由引擎决定，而对它不信任的客户端，引擎可能返回验证页而不是结果。

### 最小配置

加载 web 服务与提供方；每个字段都有出厂默认值，因此它零配置即可使用。

```yaml
- name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: serp
- name: '@deepseek-ai/dsh-web-search-serp'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `engines` | `[baidu, bing, so360]` | 要查询的引擎，顺序即结果合并顺序；空列表在加载时报错 |
| `endpoints` | 各引擎自身的搜索端点 | 按引擎覆盖端点，用于镜像或测试替身 |
| `timeoutMs` | `8000` | 单次搜索预算（毫秒），覆盖该次搜索发起的全部引擎请求 |
| `minIntervalMs` | `1000` | 对同一引擎主机两次请求之间的最小间隔（毫秒）；`0` 关闭该间隔 |
| `maxResultsPerEngine` | `10` | 从单个引擎页面读取的最大行数 |
| `maxHtmlChars` | `2000000` | 解析器读取的抓取文档长度上限 |
| `userAgent` | 一个 Chrome 浏览器标识 | 每次引擎请求携带的 User-Agent |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-serp)是每个可接受字段及其 JSDoc 的权威来源。

### 一次搜索返回什么

每个引擎结果行映射为一个 `WebSearchSource`：`url`、`title`，以及引擎渲染了摘要时的 `snippet`。结果行按名次交错（已作答的每个引擎都先于任何引擎的第二行出现），随后按规范化 URL 去重，并以请求的 `maxResults` 或 `maxResultsPerEngine` 为上限。重复项或被上限截掉的行会置 `truncated`。没有引擎返回生成式答案，因此结果不携带 `content`。

### 失败与恢复

失败或返回反自动化验证页的引擎会被丢弃，其余引擎照常作答；只有当每个引擎都失败时，搜索才抛出 `WebError` `WEB_PROVIDER_ERROR`，其消息逐个点名引擎及其自身失败原因，包括端点不可用、反自动化验证页、或页面结构已不再匹配解析器。调用方取消或单次搜索预算耗尽表现为 `WEB_ABORTED`。由于请求不携带凭据，HTTP 重定向会被跟随；拒绝重定向的规则针对携带凭据的请求，而本提供方不发起此类请求。调用方按错误码分流；面向模型的 `web_search` 工具在自己的错误包装层内呈现这些失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

本节解释提供方背后的设计取舍；可观测行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计原则

提供方是三个薄引擎适配器背后的一个规范化结果，遵循四条明确规则：

- **接口是引擎页面结构，而不是 API。** 每个适配器用一小组模式从抓取到的文档中读取该引擎的结果行，并由一份抓取夹具固定。结构变化就是对一个适配器的一处聚焦、可测试的改动。
- **不引入 DOM 依赖。** 安装包不新增任何运行时依赖：属性、文本与结果行的读取都在 `src/html.ts`，其中也解码引擎吐出的实体。这样引擎变化是解析器改动，而不是供应链改动。
- **在引擎之间降级，而不是在搜索之间降级。** 引擎彼此独立、可以部分失败；某个引擎的验证页不会让整个搜索失败，其余引擎的来源仍然保留。
- **说清失败的是什么。** 解析不出任何结果行的页面会被报为该引擎的失败，而不是空结果——因为"解析为空"正是结构已变或请求被拦截的信号。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema 与校验、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `SerpSearchProvider`：并发扇出、单引擎请求与错误处理、限速闸门、按名次交错的合并 |
| [`src/engines.ts`](src/engines.ts) | 每个引擎一份 spec：端点、查询参数，以及读取该引擎结果行的解析器 |
| [`src/html.ts`](src/html.ts) | 实体解码、文本与属性读取、URL 规范化、验证页标记，以及文档长度上限 |
| [`src/types.ts`](src/types.ts) | 引擎 id 与一个已解析结果行（`SerpHit`） |
| — | 不发布运行时不变式伴生包；除其所属能力缝已强制的契约外，本包不暴露独立的事件序列或可变数据关系。 |

### 请求流程

`search()` 在一个统一的预算信号下为每个已配置引擎发起一次请求，该信号由调用方信号与 `AbortSignal.timeout(timeoutMs)` 组成。每个引擎请求先等待其主机的 `minIntervalMs` 间隔，然后以浏览器 User-Agent 与 `accept-language` GET `{endpoint}?{queryParam}={query}`。响应被限制在 `maxHtmlChars` 内，交由该引擎的适配器解析，截断到 `maxResultsPerEngine`，再交给合并。引擎失败被收集而从不向上传播，直到合并发现没有任何存活引擎。合并结果按 origin、路径与查询去重（去掉片段与末尾斜杠），因此两个引擎报告同一页面时会折叠为一个来源。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不足时阅读这些页面。它们从共享词表出发，走向服务、面向模型的工具，以及设计依据。

- [Web 子系统](../../../docs/subsystems/web.zh.md) — 搜索请求与结果的完整词表和错误码。
- [Web 包地图](../README.zh.md) — 包家族与各自的角色。
- [dsh-web](../web/README.zh.md) — 本提供方注册进的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md) — 渲染本提供方来源的面向模型的 `web_search` 工具。
- [dsh-web-search-deepseek](../web-search-deepseek/README.zh.md) — 出厂 base 组合包中被本提供方取代、且仍可选择的辅助模型搜索路线。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-serp) — 每个可接受配置字段及其源码声明。
- [Web 能力缝决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md) — 为什么搜索与抓取共用一个提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

经由 `dsh-tool-web` 间接体现：该消费者在本提供方自己的错误包装层内，保留本提供方受 `maxResults` 约束的 URL、标题与摘要，或它确切的 `every configured search engine failed — <engine>: <failure>` 错误。

#### KV Cache effect

无直接失效影响；任何请求前缀变化由上述消费者负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本提供方不适合的场景。它们是当前包约束。

- **夹具每个引擎只固定一次抓取** — 每个适配器由一份 2026-10-11 抓取的结果页覆盖（来源见 `tests/fixtures/` 头部注释）；当某引擎调整页面结构时，该引擎的解析器与夹具一并修改。
- **返回什么取决于引擎当时给了什么** — 除丢弃引擎自身的挂件与站内页之外，提供方不过滤广告、推广行或低质镜像站，也无法像 API 的相关性评分那样对结果排序。
- **百度会对反复搜索的客户端限流** — 它以 HTTP 200 返回安全验证页；本提供方把它报为该引擎的失败，其余引擎仍照常作答。验证页标记列在 `src/html.ts`；某个引擎改了验证页就需要在那里补上它的标记。
- **"确实没有结果"与"结构已变"无法区分** — 两者都解析为零行，而提供方把零行报为该引擎的失败，而不是空结果。
- **部分引擎失败在结果中是静默的** — 能力缝的结果没有告警字段，因此调用方只看到已作答引擎的来源；只有全部引擎失败时这些失败才会显现。
- **360 的引用携带其点击跳转包装** — 它的结果行经由 `so.com/link?m=…` 链接，该地址在浏览器中会解析到目标，但并非目标 URL；要解析它需要每行多一次请求。
- **提供方不查阅 `robots.txt`，也不评估任何引擎的服务条款** — 挂载它的部署即接受了搜索运营方的条款，而 `minIntervalMs` 是它提供的唯一礼貌性开关。
- **只实现了百度、Bing、360** — 搜狗需要 cookie 握手，而它自己的反自动化页拒绝给出；搜狐搜索页在客户端渲染结果，两者都无法以纯 HTTP 触达。
- **`snippet` 取决于各引擎的摘要容器** — 未渲染摘要的结果行只贡献 URL 与标题。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 — 点击展开</summary>

本备注是维护者的工作上下文：待决问题与尚未确定的方向。它明确非权威——已发布行为、限制与依据见上文各节及所链接的 Agent Note。

#### 待决：解析引擎跳转包装 URL

360 以及部分百度结果行引用的是点击跳转包装而非目标本身。解析包装意味着每行多一次请求，当前设计基于延迟与限流理由拒绝这么做；如果引用质量的价值高于该成本，带缓存的受限解析器是替代方案。

#### 待决：把验证页标记做成配置

验证页标记目前是 `src/html.ts` 中的外部规范常量。在引擎集合固定时它们保持为常量；若部署要自加引擎，则需要按 spec 配置它们。

</details>
