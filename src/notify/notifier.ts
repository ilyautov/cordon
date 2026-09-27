import { appendFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { makeDirectory } from '../core/mkdir.js'
import { RULES, type AttackClass, type Rule, type Tier } from '../gate/rules.js'

export interface NotifyEvent {
  at: string
  decision: string
  tool: string
  reason: string
  /** Label of the source that caused the decision, when it is known. */
  source: string | null
  /** The rule behind a decision, with its class and tier; absent on events no rule made. */
  rule?: Rule
  class?: AttackClass
  tier?: Tier
  /** The effective policy the event happened under (src/policy/hash.ts). */
  policy?: string
  /** On `policy-applied`: the policy it replaced; null when that one could not be read. */
  previous?: string | null
  /**
   * On an owner's act: the OS user who ran the command. The command runs
   * outside the agent's hook process, so this is who was at the terminal,
   * not a proof of which person.
   */
  approver?: string
  /** A name the owner typed with --as: a claim, recorded as one. */
  declared?: string
  /** On an approval: the question's id and full binding. */
  id?: string
  binding?: string
}

/** Stamps every event with the policy in force, so no line is read without it. */
export function stamped(inner: Notifier, policy: string): Notifier {
  return { notify: (event) => inner.notify({ ...event, policy }) }
}

/** The journal fields of a rule: the code, and the fixed label it carries. */
export function labelled(rule: Rule): { rule: Rule; class: AttackClass; tier: Tier } {
  return { rule, class: RULES[rule].class, tier: RULES[rule].tier }
}

export interface Notifier {
  notify(event: NotifyEvent): void
}

/**
 * Writes events to a file as line-delimited JSON.
 *
 * A notification must travel over a channel the agent cannot reach: telling
 * the agent itself that the agent is blocked makes no sense. A file is the
 * minimum; a webhook or a messenger is the job of an adapter.
 */
/**
 * The size at which the journal moves to `<file>.1`, replacing the previous
 * one. An autonomous agent writes it for weeks, and without a cap it fills
 * the disk it shares with the agent's work. Renaming is what log shippers
 * already follow, so a SIEM agent tailing the file keeps up.
 */
export const MAX_JOURNAL_BYTES = 50 * 1024 * 1024

export class FileNotifier implements Notifier {
  constructor(private readonly path: string, private readonly maxBytes: number = MAX_JOURNAL_BYTES) {}

  notify(event: NotifyEvent): void {
    try {
      // Its own try: two hook processes can both see a full file, and the
      // second rename then finds nothing to move. That failure must not cost
      // the event being written, so the append below runs either way.
      if (statSync(this.path).size >= this.maxBytes) renameSync(this.path, `${this.path}.1`)
    } catch {
      // No file yet, or another process rotated first. The decision is not
      // touched either way: the gate has already made it.
    }
    try {
      makeDirectory(dirname(this.path), 0o755)
      appendFileSync(this.path, JSON.stringify(event) + '\n', 'utf8')
    } catch {
      // Notification is a side effect. Its failure must not turn a deny into
      // an exception that somebody upstream handles as an allow.
    }
  }
}

export const SILENT: Notifier = { notify: () => {} }
