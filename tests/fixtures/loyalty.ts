import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const LOYALTY_DIR = join(dirname(fileURLToPath(import.meta.url)), 'loyalty')

/** Documents that are honest in the form the human SEES rendered. */
export const RENDERED: string[] = readdirSync(LOYALTY_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)

/**
 * Documents that are honest in the form the human READS as source.
 *
 * They lie apart because the yardstick for them is a different one, and that
 * difference is the whole point of the fix this directory came from. Real
 * markup with `<style>`, `<script>` and comments produces findings: the
 * neutralization module treats text as text and knows nothing about the
 * source. Demanding silence from it here would mean demanding that it tell
 * intent apart, which is neither its job nor its skill.
 *
 * Loyalty to such documents is measured a level up, at the adapter: a result
 * the human sees as source is neither substituted nor escalated, and a finding
 * ends in a conversation with the human. The user's file must reach the model
 * as exactly what lies on the disk.
 */
export const AS_SOURCE_DIR = join(LOYALTY_DIR, 'as-source')

export const AS_SOURCE: string[] = readdirSync(AS_SOURCE_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
