// Measures the wall time of the committed hook, process start included, the
// way the harness pays for it: one `node plugin/dist/cli.js hook` per event.
//
// The number matters for a reason beyond comfort. Claude Code does not block
// a call whose hook timed out, so a slow hook is a hole, not a delay; the
// margin between this and the harness timeout is part of the defence.
//
//   node scripts/bench-hook.mjs [runs]
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'

const runs = Number(process.argv[2] ?? 30)
const home = mkdtempSync(join(tmpdir(), 'cordon-bench-'))
const event = (fields) => JSON.stringify({ session_id: 'bench', ...fields })

const write = event({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/tmp/bench.txt', content: 'hello' } })
const page = `<p>${'lorem ipsum dolor sit amet '.repeat(8000)}</p>`
const fetched = event({ hook_event_name: 'PostToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://a.example/' }, tool_response: page })

function measure(input, count) {
  const times = []
  for (let i = 0; i < count; i++) {
    const start = process.hrtime.bigint()
    const result = spawnSync('node', ['plugin/dist/cli.js', 'hook'], { input, env: { ...process.env, CORDON_HOME: home } })
    if (result.error) throw result.error
    times.push(Number(process.hrtime.bigint() - start) / 1e6)
  }
  times.sort((a, b) => a - b)
  const at = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))].toFixed(0)
  return `p50 ${at(0.5)} ms, p95 ${at(0.95)} ms, max ${at(1)} ms`
}

console.log(`node ${process.version}, ${cpus()[0]?.model ?? 'unknown cpu'}, ${runs} runs each`)
console.log(`PreToolUse, empty session:        ${measure(write, runs)}`)
console.log(`PostToolUse, ${Math.round(page.length / 1024)} KB page:       ${measure(fetched, Math.max(5, Math.floor(runs / 2)))}`)
console.log(`PreToolUse, after the page:       ${measure(write, runs)}`)
console.log('Claude Code hook timeout: 30 s by default, and a timed-out hook does not block the call.')
