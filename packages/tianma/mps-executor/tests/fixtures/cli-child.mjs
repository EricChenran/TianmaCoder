// A stand-in for the CLI the node runs: it prints what it was given and then settles
// the way the spec asked, so the runner's process handling can be tested without a
// model, a network, or the real command.
const mode = process.argv[2]

// A run that narrates its turns: the node turns those into the progress a platform watches.
if (process.argv[2] === 'turns') {
  for (const turn of [1, 2, 3, 20]) {
    console.log(JSON.stringify({ type: 'status', phase: 'turn_start', turn }))
  }
  console.log(JSON.stringify({ type: 'final', text: 'done' }))
  process.exit(0)
}
// A run that prints more lines than a raw log cap keeps.
if (mode === 'many') {
  for (let index = 1; index <= 10; index += 1) console.log(`line ${String(index)}`)
  process.exit(0)
}

const instruction = process.argv.at(-1)
const args = process.argv.slice(2).join(' ')

if (mode === 'bare') {
  // The very first chunk, before any newline reaches the stream.
  process.stdout.write('no newline at all')
}

console.log(`cwd=${process.cwd()}`)
console.log(`instruction=${instruction ?? ''}`)
console.log(`env=${process.env.MPS_TEST_MARK ?? ''}`)
console.log(`args=${args}`)

if (mode === 'fail') {
  console.error('build failed: 3 errors')
  process.exit(3)
}

if (mode === 'session-owned') {
  // The same refusal a run meets when the previous run of this CLI never exited: the
  // write handle lives in that process, so only a new session can run the work.
  const asked = process.argv.find(value => value.startsWith('--session-id'))
  if (asked !== undefined) {
    console.error(`dsh: session "${asked.slice('--session-id'.length + 1)}" is already owned by an active write handle`)
    process.exit(1)
  }
  console.log(JSON.stringify({ type: 'session', sessionId: 'dsh-session-fresh' }))
  console.log(JSON.stringify({ type: 'final', text: '新会话完成' }))
} else if (mode === 'session-gone') {
  const asked = process.argv.find(value => value.startsWith('--session-id'))
  if (asked !== undefined) {
    console.error(`dsh: session "${asked.slice('--session-id'.length + 1)}" does not exist; omit --session-id to start a new Session`)
    process.exit(1)
  }
  console.log(JSON.stringify({ type: 'session', sessionId: 'dsh-session-fresh' }))
  console.log(JSON.stringify({ type: 'final', text: '新会话完成' }))
} else if (mode === 'json') {
  // The event stream the headless profile writes under --json, as the CLI documents it.
  const events = [
    { type: 'session', sessionId: 'dsh-session-01H8Z', cwd: process.cwd() },
    { type: 'status', phase: 'turn_start', turn: 1 },
    { type: 'thinking', text: '先看需求' },
    { type: 'text', text: '我来改这个文件' },
    { type: 'tool_call', callId: 'call_1', tool: 'read', input: { path: 'readme.md' } },
    { type: 'tool_result', callId: 'call_1', status: 'completed', result: 'ok' },
    { type: 'status', phase: 'turn_end', turn: 1, reason: 'done' },
    // A resumed run may restate the session; the node reports it once.
    { type: 'session', sessionId: 'dsh-session-01H8Z' },
    { type: 'final', text: '已增加批量下载' },
  ]
  for (const event of events) console.log(JSON.stringify(event))
} else if (mode === 'partial') {
  process.stdout.write('a line with no newline yet')
  setInterval(() => {}, 1000)
} else if (mode === 'pid') {
  console.log(`pid=${process.pid}`)
  setInterval(() => {}, 1000)
} else if (mode === 'sleep') {
  console.log('working')
  setInterval(() => {}, 1000)
} else {
  console.log('done')
}
