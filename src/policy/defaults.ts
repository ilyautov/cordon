import type { EffectClass, PresenceMode, ResourceBounds, SourceView } from '../core/types.js'

export interface Policy {
  mode: PresenceMode
  profile: {
    effects: EffectClass[]
    resources: ResourceBounds
  }
  /** Effect classes for tools the core does not know about. */
  tools: Record<string, EffectClass[]>
  /** Sources declared trusted by an explicit decision of the user. */
  trustedSources: string[]
  /**
   * What a tool returns: `source` or `rendered`.
   *
   * It answers the question of whether the human sees this text as the model
   * receives it. Whether the hidden layer is stripped from the result depends
   * on the answer: from rendered output it is stripped, from source there is
   * nothing to cut, and attempting to cut destroys the content when it is
   * written back.
   *
   * It exists because Cordon answers this question by tool name, and an MCP
   * tool's name is chosen by the server, that is, by an untrusted party
   *. Only the human who connected that server knows the answer — and
   * this is where they write it down.
   *
   * The key is the tool name exactly as the harness calls it. On Claude Code
   * that is `mcp__server__tool`; on Gemini CLI the server name arrives
   * separately in the event, and the key is written as `server/tool`.
   */
  toolsReturn: Record<string, SourceView>
  notify: {
    /**
     * The file autonomous-mode events are written to.
     *
     * A file, and only a file. The channel has to be one the agent cannot
     * reach, and it has to cost nothing on the hot path: there is no network
     * anywhere in the core, so delivering to a webhook or a messenger is the
     * job of something reading this file, not of Cordon.
     */
    file: string | null
  }
  output: {
    /**
     * Whether to append a source-influence footer under the model's answer.
     *
     * The switch exists because the footer stands under every answer where a
     * verbatim match was found, and a person bothered by it needs a way to
     * remove it without deleting the plugin. Deleting the plugin would also
     * cost them the control and data axes, that is, the whole defence at once
     * for the sake of three lines under an answer.
     *
     * Turning it off weakens no other axis: the footer decides nothing, it
     * only describes.
     */
    footer: boolean
  }
}

/**
 * The default is meant to be uselessly safe rather than convenient. A user
 * who configured nothing gets an agent that can only read and summarize.
 * Widening it is a deliberate act.
 */
export const DEFAULT_POLICY: Policy = {
  mode: 'autonomous',
  profile: {
    effects: ['read', 'summarize'],
    resources: { paths: [], hosts: [] },
  },
  tools: {},
  trustedSources: [],
  toolsReturn: {},
  notify: { file: null },
  output: { footer: true },
}
