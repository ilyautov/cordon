import { mkdirSync } from 'node:fs'
import { parse, sep } from 'node:path'

/**
 * Creates a directory and every missing parent, one level at a time.
 *
 * `mkdirSync(path, { recursive: true })` is what this replaces, and the
 * reason is that it does not always come back. Under `/proc` on Linux the
 * recursive call blocks forever at zero CPU, while the same call without
 * `recursive` returns ENOENT in twenty milliseconds. Cordon's home is a
 * setting, `CORDON_HOME`, so an unlucky or hostile value reaches this line
 * on the hot path — and a hook that never returns is read by both harnesses
 * as permission to proceed. A path that cannot be created has to say so.
 *
 * Mode 0700 on every level created here: what goes below holds provenance
 * atoms and draft text, and there is no reason for shared access to them.
 */
export function makeDirectory(path: string, mode = 0o700): void {
  const { root } = parse(path)
  let built = root
  for (const part of path.slice(root.length).split(sep)) {
    if (part === '') continue
    built = built === '' ? part : built.endsWith(sep) ? built + part : built + sep + part
    try {
      mkdirSync(built, { mode })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}
