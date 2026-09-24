---
description: "Department operating rules for the TianmaCoder desktop modes as one literal system-prompt section per mode, plus the 商务部 document toolbox published as a managed shell variable."
kind: "package-reference"
---

# @tianma/dsh-department-prompts

English | [中文](README.zh.md)

## Summary

`dsh-department-prompts` turns one preset row into a department mode. `apply` registers the selected department's rules as one literal system-prompt section — `tianma:department`, ordered after the tianma behavioral guidelines and before the plan policy — and for 商务部 it also publishes the five packaged document-generation scripts into a private directory under the harness home, advertised to model shell calls as `DSH_DEPARTMENT_TOOLS`. The rules never load through the skill system, never resolve to a file the model can read, and reach the model as text compiled into the plugin.

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

`tech` registers rules and nothing else. `business` publishes the toolbox when the composition mounts `ctx.shellEnv`; a composition without that registry still gets the rules, and its script steps stay inert.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`apply` injects `systemPrompt` and registers one section with `interpolate: false`, so brace pairs inside the JSON examples the rules quote stay literal instead of being read as prompt variables. Section order `150` sits after `tianma:behavioral-guidelines` (100) and before `PLAN_POLICY` (500).

The toolbox is published by copying the packaged scripts and comparing bytes first, so a repeated mount rewrites nothing; the registration itself goes through `ctx.effect`, so the variable unwinds with the plugin fiber. The directory reaches the model only as the `DSH_DEPARTMENT_TOOLS` variable — no rule text, log line, or shell command names the path.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, section registration, toolbox wiring |
| [`src/prompts/tech.ts`](src/prompts/tech.ts) | The 技术部 rules, compiled in |
| [`src/prompts/business.ts`](src/prompts/business.ts) | The 商务部 rules, compiled in |
| [`src/toolbox.ts`](src/toolbox.ts) | Script publication and the `DSH_DEPARTMENT_TOOLS` contributor |
| [`assets/business/`](assets/business) | The packaged document scripts: `gen_doc.py`, `gen_quote.py`, `add_watermark.py`, `to_pdf.py`, `open_folder.py` |
| [`tests/department-prompts.spec.ts`](tests/department-prompts.spec.ts) | Section registration, literal rendering, toolbox publication, vocabulary guard |
| — | No runtime invariant companion is published; the plugin owns one static section and one derived directory, both asserted by test, and exposes no independent relation a companion could observe. |

</details>

<a id="further-exploration"></a>
## Further Exploration

- [system-prompt assembly](../../core/system-prompt/README.md) — the seam this section registers into
- [shell-env](../../shell/shell-env/README.md) — the managed `DSH_*` environment the toolbox variable joins
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

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the row is a poor fit. They are current package constraints, not a task backlog.

- **Rules are compiled in, not config** — retuning a department means a package change. That is deliberate: a config string would put the rules back into a readable file, and a skill would put them on disk where any session could cite them.
- **中文 only** — no localized variant of either rule set.
- **The toolbox is Windows-oriented** — `to_pdf.py` drives Word through COM and `open_folder.py` opens the desktop shell; the rules direct the model to fall back to the harness Office conversion when Word is absent.
- **Scripts are published verbatim** — the packaged copies keep their own internal comments and dependencies (`python-docx`, `matplotlib`); this package does not maintain them.
- **One toolbox directory per harness home** — every business session shares `department/business-tools`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Why the rules are a prompt section instead of a skill</summary>

A skill is discovered, listed, and read on demand: its text sits in a `SKILL.md` a session can open, quote, and copy. A department mode instead needs its rules to be part of what the mode *is* — always present for that mode, absent for every other, and not addressable as a document. One `@deepseek-ai/dsh-agent-preset` row per department gives exactly that, and the toolbox keeps its scripts off the prompt path by publishing them to a private directory behind a variable.

</details>
