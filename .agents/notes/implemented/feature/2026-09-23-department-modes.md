# Agent Note: Department modes inject their rules as prompt sections

Status: implemented

English | [中文](2026-09-23-department-modes.zh.md)

## Problem

The product ships two fixed team modes beside the general coding mode: 技术部 (engineering discipline across backend, frontend, and operations) and 商务部 (requirement documents, quotations, case retrieval). Both rule sets began as ZCode skill documents: markdown in a `skills/` tree, discovered per session and read on demand as a tool result.

That shape is wrong for a mode. A mode's rules must be present for every turn of every session in that mode, absent from every other mode, and not addressable as a document a session can open, quote, or copy. The 商务部 flow additionally needs its own document-generation scripts, which a skill would deliver as files inside a directory the session can read.

## Decision

One package, `@tianma/dsh-department-prompts`, carries both rule sets as compiled text and registers the selected department's rules as a single literal system-prompt section: `tianma:department`, order `150`, after the tianma behavioral guidelines and before the plan policy, with `interpolate: false` so the JSON examples the rules quote stay literal. The shipped `tech` and `business` presets in the `@deepseek-ai/dsh-web-app` bundle restate the `standard` plugin list and add one row selecting the department, so a mode differs from `standard` only by the rules its model reads.

The 商务部 toolbox ships as package assets and is published at mount to `<harness home>/department/business-tools`. The directory reaches model shell calls only as the managed variable `DSH_DEPARTMENT_TOOLS`, registered through `ctx.shellEnv`, so no rule text, log line, or command names the path; both the publication and the registration unwind through `ctx.effect` with the plugin fiber.

Both rule sets were adapted to this harness's tools. Skill invocation, `<本技能目录>` script paths, browser-automation steps, and the ZCode file-citation directive are gone; the business rules call the published scripts through the toolbox variable, verify the produced PDF exists, and fall back to the harness Office conversion when Word is absent. Case retrieval became a `web_search`/`web_fetch` procedure that states its own limits instead of the source document's modao.cc DOM tactics.

The rule text is committed to this repository in plaintext, and the owner accepted that trade-off explicitly: both modes must ship inside the product, and any text that reaches a system prompt is extractable from the packaged application regardless of how it is stored.

## Alternatives considered

**Ship the rule sets as skills.** Discovery is per session, the text becomes a document a session can read and quote, and a department's rules would appear in every mode's skill catalog — the two properties a mode has to invert.

**Keep the rules in configuration.** A config string is a readable file again, in the profile patch, and would be identical for every mode rather than selected per mode.

**Leave the toolbox scripts in the user's workspace.** The rules would depend on a directory a user can move or delete, and the scripts would sit in the project the model reads.

**Load the rule text from files at runtime.** The rules become a path: a file to open, and one more place for a reader to find the text.

**Store the text encrypted with a build-time key.** The key and the decryption code ship in the same package, so it raises the cost of reading the text without making it unreachable, and it makes the rules unreviewable in the repository.

## Consequences

- Selecting 技术部 adds roughly 6,400 tokens of system prompt and 商务部 roughly 2,700, once per request; an unselected mode costs nothing.
- Both sections sit in the stable system-prompt prefix, so they affect KV reuse the same way any static section does.
- `apps/cli/tests/web-agent-presets.e2e.ts` boots the shipped composition and pins the six-preset roster, each department's section heading, and the toolbox variable together with the files published under it.
- The toolbox is Windows-oriented: `to_pdf.py` drives Word through COM and `open_folder.py` opens the desktop shell.
- Wording is a package change rather than a configuration change; the package README owns each mode's contract and limits.
