// Some rejected native tool calls appear only in Codex stderr, not in the
// completed-item event stream used for the runner-attempt scoreboard.
export const summarizeRouterErrors = (stderr) => {
  const summary = { total: 0, invalidAgentId: 0, unknownMcpServer: 0, other: 0 }
  for (const line of stderr.split('\n')) {
    if (!line.includes('codex_core::tools::router: error=')) continue
    summary.total++
    if (line.includes('invalid agent id ')) summary.invalidAgentId++
    else if (line.includes('unknown MCP server ')) summary.unknownMcpServer++
    else summary.other++
  }
  return summary
}
