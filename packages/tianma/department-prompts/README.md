---
description: "Department operating rules for the TianmaCoder desktop modes as one literal system-prompt section per mode, plus the 商务部 document toolbox and the bundled 公文, 模板源码抓取, demo-video, UI-confirmation, and 实施方案 skills, all published out of the runtime archive."
kind: "package-reference"
---

# @tianma/dsh-department-prompts

English | [中文](README.zh.md)

## Summary

`dsh-department-prompts` turns one preset row into a department mode. `apply` registers the selected department's rules as one literal system-prompt section, `tianma:department`, after the behavioral guidelines. It publishes the bundled 公文 and bootstrapmb 模板源码抓取 skills for both modes, the demo-video and UI-confirmation skills for 技术部, the 实施方案 skill for 商务部 and 招投标专员, and for 商务部 the five packaged document scripts, advertised as `DSH_DEPARTMENT_TOOLS`. Rules never load through the skill system or resolve to a readable file; they reach the model as compiled text, while the skills are separate contributions only these two modes carry, the 技术部-only skills reaching it alone.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The shipped `tech` (技术部), `business` (商务部), and `bid` (招投标专员) presets each mount one row:

```yaml
- id: tianma-department
  name: '@tianma/dsh-department-prompts'
  config:
    department: business
```

| Field | Default | Meaning |
|---|---|---|
| `department` | required | Rule set this row contributes: `tech`, `business`, or `bid` |
| `assetRoot` | the packaged `assets/business/` | Script source directory, for a deployment that ships its own copies |
| `toolsDir` | `<harness home>/department/business-tools` | Directory the scripts are published into |
| `skillAssetRoot` | the packaged `skills/official-doc/` | Skill source directory, for a deployment that ships its own copy |
| `skillDir` | `<harness home>/department/skills/official-doc` | Directory the skill is published into |

All three modes register and publish the 公文 and 模板源码抓取 skills, and 技术部 additionally registers and publishes the demo-video and UI-confirmation skills while 商务部 and 招投标专员 register and publish the 实施方案 skill; `business` publishes the toolbox when the composition mounts `ctx.shellEnv`. A composition without the skill registry gets the rules and no skill; without `ctx.shellEnv` it gets the rules and no toolbox.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`apply` injects `systemPrompt` and registers one section with `interpolate: false`, so brace pairs inside the JSON examples the rules quote stay literal instead of being read as prompt variables. Section order `150` sits after `tianma:behavioral-guidelines` (100) and before `PLAN_POLICY` (500).

The toolbox is published by copying the packaged scripts and comparing bytes first, so a repeated mount rewrites nothing; the registration itself goes through `ctx.effect`, so the variable unwinds with the plugin fiber. The directory reaches the model only as the `DSH_DEPARTMENT_TOOLS` variable — no rule text, log line, or shell command names the path.

The 公文 skill is published the same way into `<harness home>/department/skills/official-doc`, and its provider registers into the calling row's context, so the catalog entry exists for exactly the modes that mount this row. The loaded body reports that directory as its resource base, and the skill's own relative paths resolve against it. The 模板源码抓取 skill publishes into `<harness home>/department/skills/bootstrapmb-template-fetch` through its own provider, which both department rows register. The demo-video skill is published the same way into `<harness home>/department/skills/demo-video`, but only the 技术部 row registers it, so sharing this row between the two presets does not hand it to 商务部. The UI-confirmation skill publishes into `<harness home>/department/skills/ui-confirmation-doc` through its own provider, which the 技术部 row alone registers. The 实施方案 skill publishes into `<harness home>/department/skills/proposal-doc` through its own provider, which only the 商务部 and 招投标专员 rows register.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, section registration, skill and toolbox wiring |
| [`src/prompts/tech.ts`](src/prompts/tech.ts) | The 技术部 rules, compiled in |
| [`src/prompts/business.ts`](src/prompts/business.ts) | The 商务部 rules, compiled in |
| [`src/prompts/bid.ts`](src/prompts/bid.ts) | The 招投标专员 rules, compiled in |
| [`src/toolbox.ts`](src/toolbox.ts) | Script publication and the `DSH_DEPARTMENT_TOOLS` contributor |
| [`src/skill.ts`](src/skill.ts) | Skill publication and the bundled `official-doc`, `bootstrapmb-template-fetch`, `demo-video`, `ui-confirmation-doc`, and `proposal-doc` providers |
| [`assets/business/`](assets/business) | The packaged document scripts: `gen_doc.py`, `gen_quote.py`, `add_watermark.py`, `to_pdf.py`, `open_folder.py` |
| [`skills/official-doc/`](skills/official-doc) | The packaged 公文 skill: `SKILL.md`, `scripts/gen_doc.py`, `assets/logo_light.png` |
| [`skills/bootstrapmb-template-fetch/`](skills/bootstrapmb-template-fetch) | The packaged template-fetch skill (both departments): `SKILL.md`, `scripts/download-bootstrapmb.ps1`, `references/*` |
| [`skills/demo-video/`](skills/demo-video) | The packaged demo-video skill (技术部 only): `SKILL.md` routing a web half (`web/scripts/webdemo.mjs`, `web/scripts/core/*.mjs`, `web/references/*`) and a mini program half (`miniprogram/scripts/*`, `miniprogram/references/*`) |
| [`skills/ui-confirmation-doc/`](skills/ui-confirmation-doc) | The packaged UI-confirmation skill (技术部 only): `SKILL.md`, `scripts/web-capture.mjs`, `scripts/mp-capture.cjs`, `scripts/build_docx.py`, `scripts/cdp.mjs`, `references/*` |
| [`skills/proposal-doc/`](skills/proposal-doc) | The packaged 实施方案 skill (商务部 and 招投标专员): `SKILL.md`, `scripts/docbuild.py` with the diagram helpers and the implementation template, `references/*`, `assets/*` |
| [`tests/department-prompts.spec.ts`](tests/department-prompts.spec.ts) | Section registration, literal rendering, toolbox and skill publication, catalog scoping, vocabulary guard |
| [`tests/template-fetch-skill.spec.ts`](tests/template-fetch-skill.spec.ts) | Byte-level publication, provider metadata, description cap, and both-department scoping of the template-fetch skill |
| [`tests/demo-video-skill.spec.ts`](tests/demo-video-skill.spec.ts) | Byte-level publication, provider metadata, and 技术部-only scoping of the demo-video skill |
| [`tests/ui-confirmation-doc-skill.spec.ts`](tests/ui-confirmation-doc-skill.spec.ts) | Byte-level publication, provider metadata, description cap, and 技术部-only scoping of the UI-confirmation skill |
| [`tests/proposal-doc-skill.spec.ts`](tests/proposal-doc-skill.spec.ts) | Byte-level publication, provider metadata, description cap, and scoping of the 实施方案 skill across its two modes |
| — | No runtime invariant companion is published; the plugin owns one static section and two derived directories, all asserted by test, and exposes no independent relation a companion could observe. |

</details>

<a id="further-exploration"></a>
## Further Exploration

- [system-prompt assembly](../../core/system-prompt/README.md) — the seam this section registers into
- [shell-env](../../shell/shell-env/README.md) — the managed `DSH_*` environment the toolbox variable joins
- [skill registry](../../skill/skill/README.md) — the seam the bundled provider registers into
- [agent-preset](../../preset/agent-preset/README.md) — the declaration that carries this row per mode
- [web-app bundle presets](../../bundle/web-app/README.md) — where the shipped department presets live

-----

<a id="model-experience"></a>
## Model Experience

### Department rules

#### What the model sees

One literal system-prompt section, `tianma:department`, carrying the selected department's complete rules: 技术部 covers backend, frontend, and operations discipline plus delivery self-checks. Before delivery, it performs only a small set of checks directly relevant to the change and does not start the application before asking the user whether they want Agent-led end-to-end verification or will verify independently; it does not default to a full end-to-end run or screenshot audit. If the user chooses Agent-led verification, it drives a real page through the Agent browser for end-to-end testing and visual verification — for a cross-platform mini-program project (uni-app or Taro) it compiles an H5 build first and verifies that build instead of calling the WeChat DevTools, leaving platform-only capabilities, bundle size, and review compliance to the user's device preview — then exercises relevant paths through the real entry point and confirms isolation of workspaces, build outputs, service ports, browser user-data directories, and debugging ports before parallel work, saying so and falling back to other real-entry means when the environment exposes no such capability; shared resources run serially when isolation is unavailable. Frontend screenshots and responsive checks are performed only when relevant to selected Agent-led verification. If the user chooses independent verification, it starts the project and provides an access entry point and necessary operating prerequisites for the user to verify. Independent tasks may still run concurrently when they share no workspace or external resources. Confirm specific failure causes from logs and reproducible evidence rather than inferring them from one screenshot. 商务部 covers requirement documents, quotations, and case retrieval plus the shared commercial red lines, with each requirement document required to carry complete business workflows as structured text beside a generated flowchart and to write a same-content Markdown copy for the 技术部 handoff. 招投标专员 covers tender reading and requirement extraction, and it produces the implementation plan through the bundled skill. The text equals `departmentPrompt(department)` byte for byte, and the section replaces nothing — it composes beside the persona, workspace instructions, and behavioral guidelines.

#### Token effect

About 6,400 tokens for 技术部, 3,300 tokens for 商务部, and 300 tokens for 招投标专员 at the 4-chars/token heuristic, once per request as part of the system prompt and unchanged across turns. A mode a user does not select costs nothing.

#### KV Cache effect

Static text inside the stable system-prompt prefix: it contributes to a reusable prefix and never invalidates existing entries. Switching between department modes changes the prefix the same way switching between any two presets does.

### Bundled 公文 skill

#### What the model sees

Sessions in either department mode carry one extra catalog entry, `official-doc`, described as generating 宜春天码信息集团 official documents as DOCX plus PDF. Loading it returns the workflow — fixed GB/T 9704 layout, the `content.json` schema, per-genre drafting notes — plus the resource base where the generator and the group logo were published. The model runs `python <base>/scripts/gen_doc.py` and delivers both files with `present`. No other mode carries the entry.

#### Token effect

One catalog line per request in those two modes (description capped at 500 characters), plus the loaded body's few thousand characters for the steps that load it. Other modes pay nothing.

#### KV Cache effect

The catalog line sits in the stable prefix of a department session; loading the body appends one tool result.

### Bundled demo-video skill (技术部 only, mini program and web)

#### What the model sees

Sessions in the 技术部 mode carry one more catalog entry, `demo-video`, described as recording a demo video of either a WeChat mini program or a web app, routed by capture target. Loading it returns the routing table and both engines — mini programs through `miniprogram-automator` inside WeChat DevTools with ffmpeg screen capture and a Python compose step, web apps through CDP in headless Chromium with frame capture and ffmpeg assembly — plus each half's inputs, acceptance gates, pitfall list, and the base where the scripts were published. The model runs `node <base>/web/scripts/webdemo.mjs doctor|probe|record|build` for web, and `doctor.mjs`, `record.cjs`, `compose.py` under `<base>/miniprogram/scripts` for mini programs. The 商务部 mode and every other mode carry no such entry.

#### Token effect

One catalog line per request in the 技术部 mode (368-character description, capped at 500), plus the loaded body's ~12.7 KB for the steps that load it. The 商务部 mode and other modes pay nothing.

#### KV Cache effect

The catalog line sits in the stable prefix of a 技术部 session; loading the body appends one tool result.

### Bundled bootstrapmb template-fetch skill

#### What the model sees

Sessions in either department mode carry one more catalog entry, `bootstrapmb-template-fetch`, described as fetching a full front-end source tree from bootstrapmb.com by item ID — resolving the hidden real source URL, recovering the dependencies the site's file tree omits, stripping demo-only anti-debug and watermark injections with the original encoding preserved. Loading it returns the workflow: the three unauthenticated endpoints, the eight pipeline steps, the five pitfalls, and the resource base where `scripts/download-bootstrapmb.ps1` was published. No other mode carries the entry.

#### Token effect

One catalog line per request in those two modes (382-character description, under the 500-character cap), plus the loaded body's ~9 KB and the reference pages a reader pulls in. Other modes pay nothing.

#### KV Cache effect

The catalog line sits in the stable prefix of a department session; loading the body appends one tool result.

### Bundled 实施方案 skill (商务部 and 招投标专员)

#### What the model sees

Sessions in the 商务部 or 招投标专员 mode carry one more catalog entry, `proposal-doc`, described as drafting a Chinese implementation plan (实施方案) as DOCX plus PDF under the fixed GB/T 9704 layout. It produces exactly one document type with a fixed seven-chapter skeleton; the technical-proposal and bid branches are gone. Loading it returns the three intake questions, the missing-material degradation rule, the seven-chapter skeleton, the `NUMBERS` ledger rule, and the resource base where `scripts/docbuild.py`, the diagram helpers, and the implementation template were published. The model writes a `content.py` and runs `python <base>/scripts/docbuild.py`; any number missing from the ledger aborts the build. The 技术部 mode and every other mode carry no entry.

#### Token effect

One catalog line per request in the 商务部 mode, under the 500-character cap, plus the loaded body's ~9 KB for the steps that load it and whichever reference page a reader opens. Other modes pay nothing.

#### KV Cache effect

The catalog line sits in the stable prefix of a 商务部 session; loading the body appends one tool result.

### Bundled UI-confirmation skill (技术部 only)

#### What the model sees

Sessions in the 技术部 mode carry one more catalog entry, `ui-confirmation-doc`, described as compiling a signed UI 界面确认单 as DOCX plus PDF from per-screen screenshots of a Web admin console and a WeChat mini-program, laid into the customer's own template. Loading it returns the workflow — the three rules (never touch the template, cover every first-level page plus at most five core second-level pages per surface, deliver DOCX and PDF), the page inventory read from the router and `app.json`, the Web and mini-program capture plans with their action vocabularies, the document manifest, the template-cloning build script, and the delivery checks — plus the resource base where the scripts were published. The model runs `node <base>/scripts/web-capture.mjs`, `node <base>/scripts/mp-capture.cjs`, and `python <base>/scripts/build_docx.py`, then renders the result for inspection and delivers both files with `present`. The 商务部 mode and every other mode carry no such entry.

#### Token effect

One catalog line per request in the 技术部 mode (196-character description, under the 500-character cap), plus the loaded body's ~9 KB and whichever reference page a reader opens. Other modes pay nothing.

#### KV Cache effect

The catalog line sits in the stable prefix of a 技术部 session; loading the body appends one tool result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the row is a poor fit. They are current package constraints, not a task backlog.

- **Rules are compiled in, not config** — retuning a department means a package change. That is deliberate: a config string would put the rules back into a readable file, and a skill would put them on disk where any session could cite them.
- **中文 only** — no localized variant of either rule set.
- **The toolbox is Windows-oriented** — `to_pdf.py` drives Word through COM and `open_folder.py` opens the desktop shell; the rules direct the model to fall back to the harness Office conversion when Word is absent.
- **Scripts are published verbatim** — the packaged copies keep their own internal comments and dependencies (`python-docx`, `matplotlib`); this package does not maintain them.
- **The 公文 skill needs an interpreter with `reportlab`** — the bundled runtime payload carries `python-docx` and `Pillow` but not `reportlab`, so a machine whose `python` lacks it gets the DOCX and no PDF. The skill body tells the model to deliver the DOCX and say so rather than silently drop the PDF.
- **The template-fetch skill scrapes a third-party site** — it drives bootstrapmb.com's unauthenticated endpoints and rewrites downloaded files; the packaged script defaults `-OutRoot` to the working directory and carries no site credentials. Its behaviour depends on that site's markup, and this package does not maintain it.
- **The Agent browser the 技术部 rules name does not ship with the mode** — the `browser_*` tool family comes from the optional browser-automation plugin bundle, independent of departments; when it is not enabled the rules require the model to say so and verify through other real-entry means instead of claiming browser verification.
- **Toolbox and skill directories are shared by name per harness home** — every department session shares `department/business-tools`, `department/skills/official-doc`, and `department/skills/bootstrapmb-template-fetch`, a 商务部 session additionally publishes `department/skills/proposal-doc`, and a 技术部 session additionally publishes `department/skills/demo-video` and `department/skills/ui-confirmation-doc`.
- **The UI-confirmation skill needs a logged-in WeChat DevTools for the mini-program half** — the capture script drives the IDE's automation port, which the IDE enables only after it is switched on in its security settings, and it imports `miniprogram-automator` from the published skill directory rather than shipping it. Without those the Web half still runs and the mini-program half cannot be captured.
- **The demo-video mini program half needs a logged-in WeChat DevTools with its automation port on** — the engine drives the IDE through `miniprogram-automator`, captures the desktop with ffmpeg, and composes with Pillow; without those the web half still runs and the mini program half cannot be captured.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Why the rules are a prompt section instead of a skill</summary>

A skill is discovered, listed, and read on demand: its text sits in a `SKILL.md` a session can open, quote, and copy. A department mode instead needs its rules to be part of what the mode *is* — always present for that mode, absent for every other, and not addressable as a document. One `@deepseek-ai/dsh-agent-preset` row per department gives exactly that, and the toolbox keeps its scripts off the prompt path by publishing them to a private directory behind a variable.

</details>

<details>
<summary>Why the bundled skills are published instead of pointed at</summary>

This row is the only thing the 技术部 and 商务部 presets share, so registering the providers here scopes the skills without touching either preset declaration. The demo-video skill registers on the 技术部 row alone, so sharing this row does not hand it to 商务部. The skill cannot simply live in a scanned root either: the packaged copy travels inside the application runtime archive, which only the Host process can read, and the model's interpreter runs as a separate process that cannot open an archive path. Publishing the tree under the harness home gives the model a real directory, and the resource base reported beside the loaded body is how it finds the generator.

</details>
