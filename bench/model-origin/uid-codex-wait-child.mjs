// Docker CLI can exit while a relayed stdio pipe never emits close. A bounded
// wait lets the benchmark report a partial run and clean its own containers.
export const waitChildClose = (child, timeoutMs) => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('child close wait needs a positive timeout')
  }
  const state = (settled) => ({ settled,
    exitCode: child.exitCode ?? null, signalCode: child.signalCode ?? null })
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(state(true))
  }
  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timer)
      resolve(state(true))
    }
    const timer = setTimeout(() => {
      child.off('close', onClose)
      resolve(state(false))
    }, timeoutMs)
    child.once('close', onClose)
  })
}
