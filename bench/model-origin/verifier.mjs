// Exit 1 remains a task or check failure for the caller to classify. Docker
// startup and timeout errors must stop the benchmark before a score is made.
export function requireVerifierResult(result, label) {
  if (result.error || ![0, 1].includes(result.status)) {
    throw new Error(label + ' verifier could not run (exit ' + result.status + '): ' +
      (result.error?.message ?? result.stderr?.slice(-1200) ?? 'no stderr'))
  }
  return result
}
