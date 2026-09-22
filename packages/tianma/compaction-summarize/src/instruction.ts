/**
 * The fidelity summarization instruction, ported from ZCode's hand-tuned
 * compaction prompt: nine fixed sections, every user message preserved as a
 * list item, security constraints preserved verbatim, forced
 * `<analysis>`-then-`<summary>` output shape, and NO_TOOLS bookends that
 * guard the auxiliary call without touching the request envelope (the tool
 * schemas stay attached so the provider's KV prefix cache is reused).
 *
 * @module @tianma/dsh-compaction-summarize/instruction
 */

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`

const NO_TOOLS_TRAILER = `

REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.`

const FIDELITY_BODY = `You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context. This summary must be thorough in capturing technical details, code patterns, and architectural decisions.

Before providing your final checkpoint, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like file names, full code snippets, function signatures, file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
   - Note any security-relevant instructions or constraints the user stated (e.g. sensitive files or data to avoid, operations that must not be performed, credential or secret handling rules). These MUST be preserved verbatim in the checkpoint so they continue to apply after compaction.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your checkpoint must contain the following sections, in order:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail.
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable, and state why each file matters.
4. Errors and Fixes: List all errors you ran into, how you fixed them, and any user feedback on the error.
5. All User Messages: List ALL user messages that are not tool results, as a numbered list, each summarized faithfully. These are critical for understanding the user's feedback and changing intent. Preserve any security-relevant instructions or constraints VERBATIM so they remain in effect after compaction.
6. Pending Tasks: Outline any pending tasks you were explicitly asked to work on.
7. Current Work: Describe in detail precisely what was being worked on immediately before this checkpoint, with file names and code snippets where applicable.
8. Next Step: The single next action directly in line with the most recent user request, or "(none)". Include direct quotes from the most recent conversation showing exactly what task was in progress and where it left off, so there is no drift in task interpretation.
9. Critical Context: Decisions and their rationale, constraints, user preferences, open questions, and data needed to continue.

Rules:
- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.
- Do NOT mention this summarization request or that the context was compacted.
- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts (especially the numbered user-message list and any verbatim security constraints), drop stale ones, and merge newer information into a single consolidated checkpoint under the same structure.`

/** The complete fidelity instruction: NO_TOOLS bookends around the body. */
export const FIDELITY_INSTRUCTION: string = NO_TOOLS_PREAMBLE + FIDELITY_BODY + NO_TOOLS_TRAILER

/** Section headers every fidelity checkpoint must carry. */
export const FIDELITY_SECTION_HEADERS: readonly string[] = Object.freeze([
  '1. Primary Request and Intent',
  '2. Key Technical Concepts',
  '3. Files and Code',
  '4. Errors and Fixes',
  '5. All User Messages',
  '6. Pending Tasks',
  '7. Current Work',
  '8. Next Step',
  '9. Critical Context',
])
