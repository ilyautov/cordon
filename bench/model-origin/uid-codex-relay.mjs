// The MCP child can reach only the agent parent's local relay socket. The
// parent forwards bytes over container stdio to the owner-side connector.
import { connect } from 'node:net'

const socket = connect(process.env.CORDON_AGENT_RELAY)
process.stdin.pipe(socket)
socket.pipe(process.stdout)
socket.on('error', (error) => {
  process.stderr.write('agent relay failed: ' + error.message + '\n')
  process.exitCode = 1
})
socket.on('close', () => {
  if (process.stdin.readableEnded) return
  process.stdin.destroy()
})
