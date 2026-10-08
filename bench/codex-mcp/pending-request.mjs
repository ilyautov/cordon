import { readFileSync } from 'node:fs'

// A request filename can appear before the gateway finishes writing JSON.
export const readCompletePendingRequest = async (path, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { return JSON.parse(readFileSync(path, 'utf8')) }
    catch (error) {
      if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error
      if (Date.now() >= deadline) throw new Error('pending approval request stayed incomplete')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}
