export type CapturedOutputHeader = { text: string, sha256: string }

export declare const capturedOutputHeader: (requests: unknown[]) => CapturedOutputHeader
export declare const wrappedRetryInput: (
  prompt: string, command: string, notice: string, header: CapturedOutputHeader, arm: string,
) => Array<{ output?: string | Array<{ type: string, text: string }> }>
