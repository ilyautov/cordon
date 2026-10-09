export declare const approvalReplayRequest: (captured: unknown, arm: string) => {
  request: {
    stream: boolean
    max_output_tokens: number
    input: Array<{ output?: string | Array<{ type: string, text: string }> }>
  }
  originalCommand: string
  notice: string
  header: string
}
