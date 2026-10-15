/**
 * The stub agent an end-to-end node test runs: it changes the workspace the way a real
 * attempt does — a source change, the report the platform asks for, and the screenshots it
 * declares — and prints the event stream the headless profile prints under `--json`.
 */

import { mkdirSync, writeFileSync } from 'node:fs'

const events = [
  { type: 'session', sessionId: 'dsh-session-e2e' },
  { type: 'status', phase: 'turn_start', turn: 1 },
  { type: 'text', text: '先看需求，再改文件' },
  { type: 'tool_call', callId: 'call_1', tool: 'write', input: { path: 'feature.txt' } },
  { type: 'tool_result', callId: 'call_1', status: 'completed', result: 'written' },
  { type: 'status', phase: 'turn_end', turn: 1, reason: 'done' },
  { type: 'final', text: '已增加批量下载' },
]
for (const event of events) console.log(JSON.stringify(event))

writeFileSync('feature.txt', 'batch download\n', 'utf8')
writeFileSync('REPORT.md', '# 开发报告\n\n增加了批量下载。\n', 'utf8')
mkdirSync('.evidence/screenshots', { recursive: true })
writeFileSync('.evidence/screenshots/detail.png', 'PNG-ish bytes\n', 'utf8')
writeFileSync(
  '.evidence/screenshots.json',
  JSON.stringify([{ file: '.evidence/screenshots/detail.png', route: '/orders', width: 1440, height: 900 }]),
  'utf8',
)
process.exit(0)
