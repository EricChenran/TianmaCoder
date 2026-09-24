---
description: "Department operating rules for the TianmaCoder desktop modes as one literal system-prompt section per mode, plus the 商务部 document toolbox and the bundled 公文 skill, both published out of the runtime archive."
kind: "package-reference"
---

# @tianma/dsh-department-prompts

English | [中文](README.zh.md)

## Summary

`dsh-department-prompts` turns one preset row into a department mode. `apply` registers the selected department's rules as one literal system-prompt section, `tianma:department`, after the tianma behavioral guidelines and before the plan policy. It also publishes the bundled 公文 (official document) skill for both modes, and for 商务部 the five packaged document scripts, advertised as `DSH_DEPARTMENT_TOOLS`. Rules never load through the skill system or resolve to a file the model can read; they reach the model as compiled text, while the skill is a separate contribution only these two modes carry.

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

The shipped `tech` (技术部) and `business` (商务部) presets each mount one row:

```yaml
- id: tianma-department
  name: '@tianma/dsh-department-prompts'
  config:
    department: business
```

| Field | Default | Meaning |
|---|---|---|
| `department` | required | Rule set this row contributes: `tech` or `business` |
| `assetRoot` | the packaged `assets/business/` | Script source directory, for a deployment that ships its own copies |
| `toolsDir` | `<harness home>/department/business-tools` | Directory the scripts are published into |
| `skillAssetRoot` | the packaged `skills/official-doc/` | Skill source directory, for a deployment that ships its own copy |
| `skillDir` | `<harness home>/department/skills/official-doc` | Directory the skill is published into |

Both modes register the 公文 skill and publish it; `business` additionally publishes the toolbox when the composition mounts `ctx.shellEnv`. A composition without the skill registry gets the rules and no skill; without `ctx.shellEnv` it gets the rules and no toolbox.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`apply` injects `systemPrompt` and registers one section with `interpolate: false`, so brace pairs inside the JSON examples the rules quote stay literal instead of being read as prompt variables. Section order `150` sits after `tianma:behavioral-guidelines` (100) and before `PLAN_POLICY` (500).

The toolbox is published by copying the packaged scripts and comparing bytes first, so a repeated mount rewrites nothing; the registration itself goes through `ctx.effect`, so the variable unwinds with the plugin fiber. The directory reaches the model only as the `DSH_DEPARTMENT_TOOLS` variable — no rule text, log line, or shell command names the path.

The 公文 skill is published the same way into `<harness home>/department/skills/official-doc`, and its provider registers into the calling row's context, so the catalog entry exists for exactly the modes that mount this row. The loaded body reports that directory as its resource base, and the skill's own relative paths resolve against it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, section registration, skill and toolbox wiring |
| [`src/prompts/tech.ts`](src/prompts/tech.ts) | The 技术部 rules, compiled in |
| [`src/prompts/business.ts`](src/prompts/business.ts) | The 商务部 rules, compiled in |
| [`src/toolbox.ts`](src/toolbox.ts) | Script publication and the `DSH_DEPARTMENT_TOOLS` contributor |
| [`src/skill.ts`](src/skill.ts) | Skill publication and the bundled `official-doc` provider |
| [`assets/business/`](assets/business) | The packaged document scripts: `gen_doc.py`, `gen_quote.py`, `add_watermark.py`, `to_pdf.py`, `open_folder.py` |
| [`skills/official-doc/`](skills/official-doc) | The packaged 公文 skill: `SKILL.md`, `scripts/gen_doc.py`, `assets/logo_light.png` |
| [`tests/department-prompts.spec.ts`](tests/department-prompts.spec.ts) | Section registration, literal rendering, toolbox and skill publication, catalog scoping, vocabulary guard |
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

One literal system-prompt section, `tianma:department`, carrying the selected department's complete rules: 技术部 covers backend, frontend, and operations discipline plus delivery self-checks; 商务部 covers requirement documents, quotations, and case retrieval plus the shared commercial red lines, with each requirement document required to carry complete business workflows as structured text beside a generated flowchart and to write a same-content Markdown copy for the 技术部 handoff. The text equals `departmentPrompt(department)` byte for byte, and the section replaces nothing — it composes beside the persona, workspace instructions, and behavioral guidelines.

#### Token effect

About 6,400 tokens for 技术部 and 3,300 tokens for 商务部 at the 4-chars/token heuristic, once per request as part of the system prompt and unchanged across turns. A mode a user does not select costs nothing.

#### KV Cache effect

Static text inside the stable system-prompt prefix: it contributes to a reusable prefix and never invalidates existing entries. Switching between department modes changes the prefix the same way switching between any two presets does.

### Bundled 公文 skill

#### What the model sees

Sessions in either department mode carry one extra catalog entry, `official-doc`, described as generating 宜春天码信息集团 official documents as DOCX plus PDF. Loading it returns the workflow — fixed GB/T 9704 layout, the `content.json` schema, per-genre drafting notes — plus the resource base where the generator and the group logo were published. The model runs `python <base>/scripts/gen_doc.py` and delivers both files with `present`. No other mode carries the entry.

#### Token effect

One catalog line per request in those two modes (description capped at 500 characters), plus the loaded body's few thousand characters for the steps that load it. Other modes pay nothing.

#### KV Cache effect

The catalog line sits in the stable prefix of a department session; loading the body appends one tool result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the row is a poor fit. They are current package constraints, not a task backlog.

- **Rules are compiled in, not config** — retuning a department means a package change. That is deliberate: a config string would put the rules back into a readable file, and a skill would put them on disk where any session could cite them.
- **中文 only** — no localized variant of either rule set.
- **The toolbox is Windows-oriented** — `to_pdf.py` drives Word through COM and `open_folder.py` opens the desktop shell; the rules direct the model to fall back to the harness Office conversion when Word is absent.
- **Scripts are published verbatim** — the packaged copies keep their own internal comments and dependencies (`python-docx`, `matplotlib`); this package does not maintain them.
- **The 公文 skill needs an interpreter with `reportlab`** — the bundled runtime payload carries `python-docx` and `Pillow` but not `reportlab`, so a machine whose `python` lacks it gets the DOCX and no PDF. The skill body tells the model to deliver the DOCX and say so rather than silently drop the PDF.
- **One toolbox and one skill directory per harness home** — every department session shares `department/business-tools` and `department/skills/official-doc`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Why the rules are a prompt section instead of a skill</summary>

A skill is discovered, listed, and read on demand: its text sits in a `SKILL.md` a session can open, quote, and copy. A department mode instead needs its rules to be part of what the mode *is* — always present for that mode, absent for every other, and not addressable as a document. One `@deepseek-ai/dsh-agent-preset` row per department gives exactly that, and the toolbox keeps its scripts off the prompt path by publishing them to a private directory behind a variable.

</details>

<details>
<summary>Why the 公文 skill is published instead of pointed at</summary>

This row is the only thing the 技术部 and 商务部 presets share, so registering the provider here scopes the skill without touching either preset declaration. The skill cannot simply live in a scanned root either: the packaged copy travels inside the application runtime archive, which only the Host process can read, and the model's interpreter runs as a separate process that cannot open an archive path. Publishing the tree under the harness home gives the model a real directory, and the resource base reported beside the loaded body is how it finds the generator.

</details>
