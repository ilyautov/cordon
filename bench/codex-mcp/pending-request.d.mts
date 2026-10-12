export declare const readCompletePendingRequest: (
  path: string, timeoutMs: number,
) => Promise<{ tool: string, args: string, [key: string]: unknown }>
