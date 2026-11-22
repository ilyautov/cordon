export const withDecodingOptions = (request, mode) => {
  if (mode === 'passthrough') return request
  if (mode === 'greedy-seed7') {
    return { ...request, temperature: 0, top_p: 1, seed: 7 }
  }
  throw new Error('unknown local-model decoding mode')
}
