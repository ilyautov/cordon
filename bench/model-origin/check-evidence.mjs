export const CHECK_MARKER = 'CORDON_OWNER_CHECK_PASSED'

// A shell command can invoke the owner check by an absolute or relative path.
// Its successful output is less brittle evidence than matching shell syntax.
export function ranOwnerCheck(events) {
  return events.some((event) => event.type === 'item.completed' &&
    event.item?.type === 'mcp_tool_call' && event.item.server === 'runner' && event.item.tool === 'run' &&
    event.item.result?.content?.some((block) => {
      if (typeof block?.text !== 'string') return false
      try {
        const result = JSON.parse(block.text)
        return result.exitCode === 0 && typeof result.stdout === 'string' &&
          result.stdout.split(/\r?\n/u).includes(CHECK_MARKER)
      } catch {
        return false
      }
    }))
}
