import { appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { makeDirectory } from '../core/mkdir.js'

export interface NotifyEvent {
  at: string
  decision: string
  tool: string
  reason: string
  /** Label of the source that caused the decision, when it is known. */
  source: string | null
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
export class FileNotifier implements Notifier {
  constructor(private readonly path: string) {}

  notify(event: NotifyEvent): void {
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
