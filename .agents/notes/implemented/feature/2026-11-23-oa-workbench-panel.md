# Agent Note: An OA workbench inside the sidebar

Status: implemented

English | [中文](2026-11-23-oa-workbench-panel.zh.md)

## Problem

The product's Tianma OA integration stopped at the account: a captcha sign-in dialog, a sidebar launcher, and a Settings section showing the profile and its counters. Everything an employee actually does — reading station messages, deciding approvals, keeping a to-do list, checking today's schedule and tasks, punching in — still meant leaving for the OA app or its mini-program. The Host already held the token and the backend already exposed the reads, so the missing piece was one surface and the operations behind it.

## Decision

- **One first-level panel, seven modules.** A `main` panel keyed `oa-workbench` opens module tabs — overview, messages, approvals, to-do, schedule, tasks, attendance — and a `sidebar.panellist` row at order `-10` puts the entry ahead of the shipped panels.
- **Second-level tabs that stay mounted.** A message or an approval opens a tab beside its list. Module bodies and open documents are hidden rather than unmounted, so filters, scroll position, and a half-typed approval comment survive a switch; closing a document removes only that document.
- **Every read goes through the Host.** The account service grew 23 Remote methods covering messages and their read state, notification switches, to-dos, approvals (lists, detail, decision, categories, submit, draft), today's schedule, the task board, completion, and attendance. All reuse `authorized()`, so one expired token re-signs once and no token reaches the browser.
- **Closed vocabularies at the wire boundary.** Nine message kinds map from the backend's `system` with an `other` fallback; approval and node statuses fall back to `unknown` instead of failing a list; a numeric net pay is carried as text. A leave line derived from an approval keeps its composite string id and becomes `kind: 'leave'`, so today's schedule never presents a colleague's leave as a meeting.
- **One guard the backend cannot phrase.** A rejection with an empty comment is refused in the module before any request; every other refusal shows the backend's own message, including "无审批权限或已审批" for a double click.
- **Slices, not one blob.** The workbench snapshot keeps five independent slices — stats, messages, to-dos, attendance, notifications — so a refused read reports inside its own module, and each mutation reloads only the slice it touched.
- **Attendance records stay unread.** `GET /attendance/records` rewrites historical days that only carry a clock-in as early leave, so the panel offers today's state and the monthly summary and leaves the record rewrite to the backend's own surfaces.

## Testing

The account spec pins the new wire contract: message kind and payload projection with the `other` fallback, read routes, preference keys, to-do routes including `DELETE`, approval projection and refusal text, category mapping, the submit-versus-draft bodies, schedule events against leave lines, the task board and its completion route, the boolean lunch flag, and the summary's text penalty. Client specs render the approval module (a rejection stops at the empty-comment guard, an approval sends the typed comment), the schedule and task modules, and the panel itself — seven module tabs, and opening an unread message marks it read and opens its page beside the list.

Gates run for this change: package and repository typechecks, `oxlint`, `verify-client-ui-i18n`, the translation pairing, the client slot catalog, and the client bundle build through the purity gate.

## Alternatives considered

**Add the workbench to the Settings section.** Settings is a configuration surface reached through the account menu; a daily work list would be two clicks deep and would still sit in a page whose other sections are one-time edits.

**Ship the workbench as its own plugin package.** It shares the account snapshot, the sign-in dialog, and the locale namespace with the existing surfaces. A second package would have to reach back across the plugin boundary for "open the sign-in dialog", which the client rules forbid, or duplicate that state.

**Left list plus a right detail pane instead of tabs.** The product already uses second-level tabs inside a panel; following that idiom keeps one navigation model. A split pane would also shrink the list column on a laptop.

**Call the OA backend from the browser.** The backend allows only its own CORS origins, and the token would then live in browser storage. Keeping the calls on the Host keeps the credential in the seam and the browser on one BFF.

**Expose the attendance record list as well.** That read mutates history, so listing it from a workbench tab would change the user's month as a side effect of looking at it.

## Consequences

- The sidebar gains one entry, so an assembled-web snapshot that captures the sidebar needs a refresh when the panel lands.
- Approval actions are one request per document: the employee side has neither a batch action nor a transfer, and the module does not invent one.
- Salary slips and file transfer stay out until the Host exposes reads for them; the messages that announce them still open their payload.
