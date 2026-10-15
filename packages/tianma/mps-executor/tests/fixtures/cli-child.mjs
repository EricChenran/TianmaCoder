// A stand-in for the CLI the node runs: it prints what it was given and then settles
// the way the spec asked, so the runner's process handling can be tested without a
// model, a network, or the real command.
const mode = process.argv[2]
const instruction = process.argv[3]

if (mode === 'bare') {
  // The very first chunk, before any newline reaches the stream.
  process.stdout.write('no newline at all')
}

console.log(`cwd=${process.cwd()}`)
console.log(`instruction=${instruction ?? ''}`)
console.log(`env=${process.env.MPS_TEST_MARK ?? ''}`)

if (mode === 'fail') {
  console.error('build failed: 3 errors')
  process.exit(3)
}

if (mode === 'partial') {
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
