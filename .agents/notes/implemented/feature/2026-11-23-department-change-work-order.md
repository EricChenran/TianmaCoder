# Agent Note: Work-order loop from 商务部 intake to 技术部 disposition

Status: implemented

English | [中文](2026-11-23-department-change-work-order.zh.md)

## Problem

商务部 staff intake change requests as a mix of chat text and screenshots. The mode could already produce requirement documents, quotations, and case lists, but nothing turned that intake into a dispatchable table, and no packaged script could write an Excel workbook with embedded images. Rebuilding that table by hand costs the same review pass the template exists to remove.

## Decision

[The department-mode mechanism](2026-09-23-department-modes.md) is unchanged: one literal system-prompt section plus a published toolbox. This note covers only the capability added on top of it — `assets/business/gen_workorder.py` joins the toolbox and the rules gain one `# 改动任务工单` section. The script reads one `content.json` and writes one xlsx; the model only reads the customer's material, splits it into rows, and fills the input.

- **Six fixed columns, in the order the business asked for:** 时间, 任务明细, 当前现象, 期望改动后, 证明截图, 状态. One row is one independently verifiable change. No sequence, priority, or schedule column is added; the workbook is the customer-facing intake record, not a tracker.
- **Screenshots are embedded only from files on disk.** A pasted image reaches the model as an attachment whose identifier is not a path it may name, so the rules ask the user to save the file (suggesting `<客户名>/images/`) and fall back to a `proof` sentence when no file exists. Each listed path is resolved as given, then against the JSON directory, then against the working directory; any miss aborts the build with the row index instead of producing a sheet that silently lacks evidence.
- **Validation reports every problem in one pass.** Required: `project`, and per row `task`, `phenomenon`, `expected`. The status vocabulary is closed at 待处理, 处理中, 已完成, 已验收, 已驳回, 已取消 and defaults to 待处理, so a fresh customer request is never recorded as finished. `blank_rows` serves the "empty template" request without weakening row validation.
- **The layout stays in the script:** merged title and information rows, a frozen filterable header repeated across pages, wrapped bordered cells whose rows are sized to their images, a status colour key, a note row, A4 landscape at page width, and footer page numbers.
- **The workbook is xlsx only.** `to_pdf.py` drives Word COM, so the rules state that a PDF cannot be promised rather than adding a second conversion path.

The mode advertises the capability in its preset card and usage guide in both locales, so the web e2e golden for that card line moves with it.

### The 技术部 half of the loop

The same workbook drives the other end. `assets/tech/read_workorder.py` reads a work order into JSON, and `build_disposition.py` writes a disposition table whose rows are checked against that workbook: a missing item, a duplicate, an out-of-range number, or an unresolvable image aborts the build with the offending row named, so "every requirement is covered" is enforced by the script rather than asserted in prose.

Between reading and building sits a research gate: one read-only subagent per item reports the current behavior, the expected behavior, and the change surface with file-and-line evidence; the main agent consolidates that three-part report and asks the user to confirm, and no file changes before the confirmation. Implementation dispatch, per-item verification, and the disposition build follow unchanged. Each row's proof cell carries a 改前/改后 comparison composed by the script — labels, a caption, and an environment line wrapped to the panel width — and a change with nothing to capture says so in the cell instead of shipping a blank one.

The 技术部 row publishes its own toolbox (`department/tech-tools`) through the same install path as 商务部's, so both departments reach their scripts as `DSH_DEPARTMENT_TOOLS` without a skill entry. Asking the user before dispatching parallel subagents is a rule in the prompt, and shared ports, build outputs, browser profiles, and databases still serialize.

## Testing

`tests/department-prompts.spec.ts` pins the six-column contract, the toolbox command, the disk-only screenshot rule, the closed status vocabulary, the research-first order with its confirmation gate, and the generator's own header literals. The generator was exercised on a three-row sample — two stacked screenshots, one tall screenshot, one missing-screenshot note — rendered through the bundled LibreOffice for a layout check; a missing image and a missing required field each exit non-zero with the offending row named.

## Alternatives considered

**Ship it as a skill instead of a toolbox script.** The mode's existing document production — requirement documents, quotations, watermarks, PDF — is a set of scripts behind `DSH_DEPARTMENT_TOOLS`, and the work order is the same shape of work: one input file in, one file out. A skill would add a catalog entry to every 商务部 request and make the template a document the session reads rather than a command it runs.

**Add the work order to `gen_quote.py` or `gen_doc.py`.** Those scripts own Word layouts with fixed watermarks, page furniture, and a total check; an image-bearing spreadsheet shares none of that machinery, and merging would make one script's failure modes the other's.

**Accept screenshots pasted into the conversation.** The attachment store keeps images content-addressed with no model-visible path, so the generator cannot open them; teaching the generator to scavenge the store would couple the toolbox to harness internals and still leave the model guessing which object belongs to which row. Asking the user for a file keeps the sheet honest.

**Write the missing cell as an empty proof column instead of failing.** A silently blank evidence column looks like "no screenshot needed" rather than "evidence missing", which is exactly the misreading the 证明截图 column exists to prevent.

**Give 技术部 a bundled skill for the disposition loop.** A skill body loads on demand and pays a catalog line on every 技术部 request; this flow is one prompt section plus one render step whose contract the rules already spell out, and the toolbox install path already exists for a department's generation scripts.

## Consequences

- 商务部 gains roughly 700 tokens of prompt (about 4,200 total, once per request) and the toolbox one more published script; unselected modes still pay nothing.
- 技术部 gains roughly 800 tokens of prompt (about 7,600 total) and two published disposition scripts in its own toolbox directory.
- The workbook and the disposition table need an interpreter with `openpyxl` and `Pillow`; missing either, the generator exits with the install command instead of producing a partial sheet. The package README records that limit.
- A customer request now has a fixed, reviewable intake table, and the mode refuses to mark it finished on the customer's behalf.
- An incomplete pass fails the disposition build instead of shipping a table with silent gaps, so "every item covered" stops being a promise and becomes a precondition.
- The Excel-only delivery is explicit: a PDF requires a conversion path this toolbox does not have.
