import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * Configuration is code too, and a mistake in it is quiet: the hook simply
 * does not fire, and it looks like working protection. So it is checked the
 * same way as code rather than read with the eyes.
 */
const ROOT = process.cwd()

/**
 * The plugin root: the directory that holds `.claude-plugin`, and exactly what
 * the harness expands `${CLAUDE_PLUGIN_ROOT}` into.
 */
const PLUGIN_ROOT = join(ROOT, 'plugin')

function read(...parts: string[]): Record<string, never> {
  return JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'))
}

const plugin = read('plugin', '.claude-plugin', 'plugin.json') as unknown as { name: string; version: string }
const hooks = read('plugin', 'hooks', 'hooks.json') as unknown as {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>>
}
const market = read('.claude-plugin', 'marketplace.json') as unknown as {
  plugins: Array<{ name: string; source: string }>
}

describe('packaging the plugin', () => {
  it('the manifest is named and versioned', () => {
    expect(plugin.name).toBe('cordon')
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/u)
  })

  it('all four events are intercepted', () => {
    expect(Object.keys(hooks.hooks).sort()).toEqual([
      'MessageDisplay', 'PostToolUse', 'PreToolUse', 'UserPromptSubmit',
    ])
  })

  it('the display event has a shorter timeout than the default', () => {
    // The event default is 10 seconds. The hot path is synchronous, with no
    // network and no waiting: missing the deadline means broken, not slow. Five
    // seconds is how long the human waits for their own answer on screen, and
    // there is nothing to stretch that with.
    expect(hooks.hooks.MessageDisplay![0]!.hooks[0]!.timeout).toBeLessThanOrEqual(5)
  })

  it('every event catches all tools', () => {
    for (const event of ['PreToolUse', 'PostToolUse']) {
      expect(hooks.hooks[event]![0]!.matcher).toBe('*')
    }
  })

  it('the command starts from the plugin root', () => {
    const command = hooks.hooks.PreToolUse![0]!.hooks[0]!.command
    expect(command).toContain('${CLAUDE_PLUGIN_ROOT}')
  })

  it('the timeout is set short explicitly', () => {
    for (const event of Object.keys(hooks.hooks)) {
      const hook = hooks.hooks[event]![0]!.hooks[0]!
      expect(hook.timeout).toBeLessThanOrEqual(10)
    }
  })

  it('the marketplace points at the plugin', () => {
    expect(market.plugins.some((p: { name: string }) => p.name === 'cordon')).toBe(true)
  })
})

// Below is a set of its own: ways in which a configuration correct in form
// still fails to work. Every one of them is quiet - the hook does not start,
// and that looks like an absence of firings, that is, like working
// protection.
describe('packaging the plugin: the quiet ways of not working', () => {
  beforeAll(() => {
    // The path to the BUILT file is checked, so the build has to exist.
    if (!existsSync(join(PLUGIN_ROOT, 'dist', 'cli.js'))) {
      execFileSync('npm', ['run', 'build'], { stdio: 'inherit' })
    }
  }, 60_000)

  it('the command points at a file that exists after the build', () => {
    // The main trap: ${CLAUDE_PLUGIN_ROOT} is the root of the PLUGIN, while
    // the build puts the file relative to the root of the REPOSITORY. Let them
    // diverge and node will not find the file, the hook will crash, and the
    // harness will read the crash as "let it through".
    for (const event of Object.keys(hooks.hooks)) {
      const command = hooks.hooks[event]![0]!.hooks[0]!.command
      const path = command.replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT).replace(/^node\s+/u, '').split(' ')[0]!
      expect(existsSync(path), `${event}: ${path} does not exist`).toBe(true)
    }
  })

  it('every event calls the same hook subcommand', () => {
    for (const event of Object.keys(hooks.hooks)) {
      expect(hooks.hooks[event]![0]!.hooks[0]!.command.endsWith(' hook')).toBe(true)
      expect(hooks.hooks[event]![0]!.hooks[0]!.type).toBe('command')
    }
  })

  it('UserPromptSubmit has no matcher: the event is not about a tool', () => {
    expect(hooks.hooks.UserPromptSubmit![0]!.matcher).toBeUndefined()
  })

  it('the marketplace refers to the root that holds the plugin manifest', () => {
    // A reference that misses the manifest is an install that quietly installs nothing.
    const entry = market.plugins.find((p) => p.name === 'cordon')!
    const source = entry.source === './' ? ROOT : join(ROOT, entry.source)
    expect(existsSync(join(source, '.claude-plugin', 'plugin.json'))).toBe(true)
    expect(existsSync(join(source, 'hooks', 'hooks.json'))).toBe(true)
  })

  it('the plugin version matches the version in the marketplace', () => {
    const entry = market.plugins.find((p) => p.name === 'cordon') as unknown as { version?: string }
    if (entry.version !== undefined) expect(entry.version).toBe(plugin.version)
  })
})
