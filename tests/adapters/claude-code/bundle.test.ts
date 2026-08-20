import { execFileSync } from 'node:child_process'
import { builtinModules } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The plugin has to work right after installation, with no build step.
 *
 * An installed plugin is a copied `plugin` directory and nothing else: there
 * will be no `node_modules` and no repository `package.json` next to it. A file
 * that does not start in such surroundings brings `node` down, and the harness
 * reads a crashed hook as "let it through": the protection switches itself off
 * silently.
 */
const BUNDLE = 'plugin/dist/cli.js'

/** An event whose correct answer is known in advance: a write into our own config. */
function selfProtectEvent(home: string): string {
  return JSON.stringify({
    session_id: 'b1',
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: join(home, 'policy.yaml'), content: 'mode: off' },
  })
}

describe('the plugin is self-contained', () => {
  it('the built file lies in the repository', () => {
    expect(existsSync(BUNDLE)).toBe(true)
  })

  it('no external imports are left in the built file', () => {
    const source = readFileSync(BUNDLE, 'utf8')

    // A require or an import of anything from node_modules means the file will
    // not work once the plugin is installed: the dependencies will not be there.
    //
    // The property itself is checked rather than a list of known packages. A
    // list here has already diverged from reality once: it named a package that
    // was no longer in the code and stayed silent about the one that replaced
    // it. A list of names by its very design misses every new dependency, that
    // is, exactly the case the check was written for.
    const external = [...source.matchAll(/(?:from\s*|require\()['"]([^'"]+)['"]/gu)]
      .map((match) => match[1]!)
      .filter((specifier) => !specifier.startsWith('.'))
      // Built-in modules are filtered out by Node's own list rather than by
      // one of ours: they resolve without node_modules, but by name they are
      // indistinguishable from a package, and `process` in the bundle has
      // already been taken for a harmless one once.
      .filter((specifier) => !builtinModules.includes(specifier.replace(/^node:/u, '')))

    expect([...new Set(external)]).toEqual([])
  })

  it('it starts from a directory without node_modules', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'cordon-elsewhere-'))
    const home = mkdtempSync(join(tmpdir(), 'cordon-bundle-home-'))

    const out = execFileSync('node', [join(process.cwd(), BUNDLE), 'hook'], {
      input: selfProtectEvent(home),
      cwd: elsewhere,
      env: { ...process.env, CORDON_HOME: home },
      encoding: 'utf8',
    })

    const decision = JSON.parse(out)
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('self-protection')
  })

  it('it starts from a copy of the plugin outside the repository', () => {
    // The previous test changes only the working directory, while the file
    // itself stays inside the repository, where a package.json with
    // "type": "module" lies next to it. An installed plugin has no such
    // package.json, and then node reads .js as CommonJS while the built ESM
    // module crashes on its very first line. The only way to tell one from the
    // other is a copy of the plugin outwards.
    const installed = join(mkdtempSync(join(tmpdir(), 'cordon-installed-')), 'cordon')
    cpSync(join(process.cwd(), 'plugin'), installed, { recursive: true })
    const home = mkdtempSync(join(tmpdir(), 'cordon-installed-home-'))

    const out = execFileSync('node', [join(installed, 'dist', 'cli.js'), 'hook'], {
      input: selfProtectEvent(home),
      cwd: installed,
      env: { ...process.env, CORDON_HOME: home },
      encoding: 'utf8',
    })

    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('the command from hooks.json works verbatim on an installed copy', () => {
    // Started exactly the way the harness will do it: by the command string
    // from the configuration, with ${CLAUDE_PLUGIN_ROOT} substituted.
    const installed = join(mkdtempSync(join(tmpdir(), 'cordon-hooked-')), 'cordon')
    cpSync(join(process.cwd(), 'plugin'), installed, { recursive: true })
    const home = mkdtempSync(join(tmpdir(), 'cordon-hooked-home-'))

    const hooks = JSON.parse(readFileSync('plugin/hooks/hooks.json', 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    const command = hooks.hooks.PreToolUse![0]!.hooks[0]!.command.replaceAll(
      '${CLAUDE_PLUGIN_ROOT}',
      installed,
    )

    const out = execFileSync('/bin/sh', ['-c', command], {
      input: selfProtectEvent(home),
      cwd: installed,
      env: { ...process.env, CORDON_HOME: home },
      encoding: 'utf8',
    })

    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('it starts along a path that goes through a symbolic link', () => {
    // A trap visible only on a real installation path. The entry point starts
    // on a comparison of `import.meta.url` with `process.argv[1]`, and node
    // resolves the first to the real path while the second stays whatever the
    // caller wrote. A link in the path separates them, the condition comes out
    // false, main does not start, the hook prints emptiness and exits with
    // zero. The harness reads empty output as the absence of a decision, that
    // is, it lets the call through. On macOS even /tmp goes through a link, so
    // the case is not an exotic one.
    const base = mkdtempSync(join(tmpdir(), 'cordon-symlink-'))
    const real = join(base, 'real')
    mkdirSync(real)
    cpSync(join(process.cwd(), 'plugin'), join(real, 'cordon'), { recursive: true })
    const link = join(base, 'link')
    symlinkSync(real, link, 'dir')
    const home = mkdtempSync(join(tmpdir(), 'cordon-symlink-home-'))

    const out = execFileSync('node', [join(link, 'cordon', 'dist', 'cli.js'), 'hook'], {
      input: selfProtectEvent(home),
      env: { ...process.env, CORDON_HOME: home },
      encoding: 'utf8',
    })

    expect(out.trim(), 'the harness reads empty hook output as "let it through"').not.toBe('')
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('the built file matches the sources', () => {
    // A rebuild must not change the file: otherwise the repository holds an
    // artifact from a different version of the code, and whoever reads it is
    // deceived.
    //
    // The build goes into a temporary place rather than over the repository.
    // Over it would mean the test rewrites a file that neighbouring tests are
    // reading at the same time while starting the plugin as a separate
    // process.
    const out = join(mkdtempSync(join(tmpdir(), 'cordon-rebuild-')), 'cli.js')
    const script = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> })
      .scripts.bundle!
    execFileSync('/bin/sh', ['-c', script.replaceAll('plugin/dist/', join(out, '..') + '/')], {
      encoding: 'utf8',
    })
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(BUNDLE, 'utf8'))
  }, 60_000)
})
