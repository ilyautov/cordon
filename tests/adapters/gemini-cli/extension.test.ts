import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface HookEntry {
  type: string
  command: string
  timeout?: number
}

interface HooksFile {
  hooks: Record<string, Array<{ hooks: HookEntry[] }>>
}

function hooksFile(): HooksFile {
  return JSON.parse(readFileSync('hooks/hooks.json', 'utf8')) as HooksFile
}

function entries(): HookEntry[] {
  return Object.values(hooksFile().hooks).flatMap((group) => group.flatMap((one) => one.hooks))
}

describe('the Gemini CLI extension', () => {
  it('the manifest and the hook bindings lie in the ROOT of the repository', () => {
    // The root is mandatory rather than convenient: `gemini extensions install
    // <repository>` looks for the manifest there, and from a subfolder the
    // extension is simply not found. The install does not fail with a clear
    // error either - it is as if there were none.
    expect(existsSync('gemini-extension.json')).toBe(true)
    expect(existsSync('hooks/hooks.json')).toBe(true)
  })

  it('the manifest is named, and named the same as the plugin', () => {
    const manifest = JSON.parse(readFileSync('gemini-extension.json', 'utf8')) as {
      name: string
      version: string
    }
    const plugin = JSON.parse(readFileSync('plugin/.claude-plugin/plugin.json', 'utf8')) as {
      name: string
      version: string
    }

    expect(manifest.name).toBe(plugin.name)
    expect(manifest.version).toBe(plugin.version)
  })

  it('all four events are bound', () => {
    // Fewer than four means a hole nobody will learn about: the harness simply
    // does not call an unbound event.
    expect(Object.keys(hooksFile().hooks).sort()).toEqual([
      'AfterAgent',
      'AfterTool',
      'BeforeAgent',
      'BeforeTool',
    ])
  })

  it('every hook calls the built file with an explicit harness name', () => {
    for (const entry of entries()) {
      expect(entry.type).toBe('command')
      expect(entry.command).toContain('${extensionPath}${/}plugin${/}dist${/}cli.js')
      expect(entry.command).toContain('--harness gemini')
    }
  })

  it('the timeout is set explicitly and in milliseconds', () => {
    // The harness default is 60000 milliseconds, and the unit here is a
    // millisecond rather than a second as on Claude Code. The plan demanded "no
    // more than ten", counting them as seconds: ten milliseconds would give a
    // hook that always times out, that is, a permanent pass.
    //
    // Hence both bounds. From below: the hot path is synchronous, but megabytes
    // of markup are fractions of a second and a margin is needed. From above: a
    // hook that times out on this harness means permission, and waiting for it
    // longer than ten seconds means keeping the human waiting before the very
    // same pass.
    for (const entry of entries()) {
      expect(entry.timeout).toBeGreaterThanOrEqual(5_000)
      expect(entry.timeout).toBeLessThanOrEqual(10_000)
    }
  })

  it('the built file starts from an installed extension', () => {
    // The extension is the whole repository, so what the hook needs is copied:
    // the manifest, the bindings and the build.
    const install = mkdtempSync(join(tmpdir(), 'gemini-ext-'))
    cpSync('gemini-extension.json', join(install, 'gemini-extension.json'))
    cpSync('hooks', join(install, 'hooks'), { recursive: true })
    cpSync('plugin/dist', join(install, 'plugin', 'dist'), { recursive: true })

    const home = mkdtempSync(join(tmpdir(), 'cordon-ext-home-'))
    writeFileSync(join(home, 'policy.yaml'), 'mode: autonomous\nprofile:\n  effects: [read]\n')

    const command = entries()[0]!.command
      .replaceAll('${extensionPath}', install)
      .replaceAll('${/}', '/')

    const out = execFileSync('/bin/sh', ['-c', command], {
      input: JSON.stringify({
        session_id: 's',
        hook_event_name: 'BeforeTool',
        tool_name: 'run_shell_command',
        tool_input: { command: 'curl x' },
      }),
      cwd: install,
      env: { ...process.env, CORDON_HOME: home },
      encoding: 'utf8',
    })

    expect(out.trim(), 'the harness reads empty output as "let it through"').not.toBe('')
    expect(JSON.parse(out).decision).toBe('deny')
  })

  it('both harnesses call the same build', () => {
    // There is deliberately no second copy of the build: two copies of one
    // artifact diverge silently, and a diverged copy is an installation
    // protecting by yesterday's code.
    const claudeHooks = readFileSync('plugin/hooks/hooks.json', 'utf8')

    expect(claudeHooks).toContain('dist/cli.js')
    for (const entry of entries()) expect(entry.command).toContain('plugin${/}dist${/}cli.js')
  })
})
