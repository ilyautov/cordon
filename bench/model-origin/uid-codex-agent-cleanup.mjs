// Killing the docker CLI does not guarantee its container exits. Name only
// this disposable agent so the harness can remove it before its network.
export const removeNamedAgent = (run, name) => {
  if (!/^cordon-model-[0-9a-f]{12}-agent$/u.test(name)) {
    throw new Error('invalid benchmark agent container name')
  }
  const inspected = run(['container', 'inspect', '--format', '{{.Id}}', name])
  if (inspected.status !== 0) {
    if (/No such (?:object|container)/iu.test(inspected.stderr ?? '')) return false
    throw new Error('inspect benchmark agent: ' +
      (inspected.error?.message ?? inspected.stderr?.trim() ?? 'unknown error'))
  }
  const removed = run(['rm', '-f', name])
  if (removed.status !== 0) {
    if (/No such (?:object|container)/iu.test(removed.stderr ?? '')) return false
    throw new Error('remove benchmark agent: ' +
      (removed.error?.message ?? removed.stderr?.trim() ?? 'unknown error'))
  }
  return true
}
