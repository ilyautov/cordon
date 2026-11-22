export type CodexContext = {
  instructions: string
  developerMessage: unknown
  instructionsSha256: string
  developerMessageSha256: string
  toolsSha256: string
}

export declare const codexContext: (requests: unknown[]) => CodexContext
export declare const contextInputForArm: (
  prompt: string, command: string, notice: string, context: CodexContext, arm: string,
) => { instructions?: string, input: unknown[] }
