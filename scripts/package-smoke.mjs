// Exercise the tarball a user installs, not the repository's dist directory.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'cordon-package-smoke-'))
const installed = join(scratch, 'installed')
const ownerHome = join(scratch, 'owner-home')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    input: options.input,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error || result.status !== (options.status ?? 0)) {
    throw new Error(`${command} ${args.join(' ')}: ${result.error?.message ??
      `exit ${result.status}`}\n${result.stderr?.trim() ?? ''}\n${result.stdout?.trim() ?? ''}`)
  }
  return result.stdout
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

try {
  const packed = JSON.parse(run('npm', [
    'pack', '--ignore-scripts', '--json', '--pack-destination', scratch,
  ]))
  assert(Array.isArray(packed) && packed.length === 1, 'npm pack returned no single package')
  const archive = join(scratch, packed[0].filename)
  const entries = new Set(packed[0].files.map((file) => file.path))
  for (const entry of ['package.json', 'dist/cli.js', 'dist/index.js', 'dist/index.d.ts']) {
    assert(entries.has(entry), `tarball lacks ${entry}`)
  }
  assert(![...entries].some((entry) => entry.startsWith('src/') || entry.startsWith('tests/')),
    'tarball includes source or tests outside dist')

  run('npm', [
    'install', '--prefix', installed, '--ignore-scripts', '--no-audit', '--no-fund',
    '--omit=dev', archive,
  ], { cwd: scratch })
  const packageDir = join(installed, 'node_modules', '@ilyautov', 'cordon')
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  assert(manifest.bin?.cordon === 'dist/cli.js', 'installed CLI bin points elsewhere')
  assert(hash(join(packageDir, 'dist/cli.js')) === hash(join(root, 'dist/cli.js')),
    'installed CLI differs from the built release artifact')

  const bin = join(installed, 'node_modules', '.bin',
    process.platform === 'win32' ? 'cordon.cmd' : 'cordon')
  assert(existsSync(bin), 'installed CLI executable is missing')
  const scan = JSON.parse(run(bin, ['scan', '-', '--json'], {
    cwd: installed,
    input: '<div style="display:none">hidden instruction</div>',
  }))
  assert(scan.clean === '' && scan.findings?.some((finding) => finding.kind === 'hidden-html'),
    'installed CLI failed the hidden HTML scan')

  const env = { ...process.env, CORDON_HOME: ownerHome }
  run(bin, ['init', '--profile', 'locked'], { cwd: installed, env })
  assert(existsSync(join(ownerHome, 'policy.yaml')), 'installed CLI did not write the owner policy')
  const doctor = run(bin, ['doctor'], { cwd: installed, env })
  assert(doctor.includes('self-check: ok'), 'installed CLI failed its self-check')

  const denied = run(bin, ['hook', '--harness', 'codex'], {
    cwd: installed, env, status: 2,
    input: JSON.stringify({
      session_id: 'package-smoke', hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_input: { command: 'pwd' },
    }),
  })
  assert(JSON.parse(denied).hookSpecificOutput?.permissionDecision === 'deny',
    'installed Codex hook did not block exec under locked policy')

  const library = await import(pathToFileURL(join(packageDir, 'dist/index.js')).href)
  assert(typeof library.Cordon === 'function', 'installed library lacks the Cordon export')
  process.stdout.write(`package smoke: ok (${packed[0].entryCount} tarball entries)\n`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
