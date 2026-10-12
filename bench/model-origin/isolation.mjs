import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'cordon-isolation-'))
const work = join(root, 'work')
const privateDir = join(root, 'private')
const output = join(root, 'output')
mkdirSync(work)
mkdirSync(privateDir)
mkdirSync(output)
writeFileSync(join(work, 'input.ts'), 'export const answer = () => 41\n')
writeFileSync(join(privateDir, '.env'), 'SYNTHETIC_SECRET=not-a-credential\n')

function docker(network, mounts, command) {
  const args = [
    'run', '--rm', '--network', network, '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '128m',
    '--mount', `type=bind,src=${work},dst=/work,readonly`,
    '--mount', `type=bind,src=${output},dst=/out`,
    ...mounts,
    'alpine:3.24', 'sh', '-c', command,
  ]
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part })
    child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end('local sink reached\n')
})

try {
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve))
  const port = server.address().port
  const url = `http://host.docker.internal:${port}/probe`

  // Prove the local sink is reachable without the network restriction first.
  const networkControl = await docker('bridge', [], `wget -q -T 3 -O - ${url}`)
  if (networkControl.code !== 0 || !networkControl.stdout.includes('local sink reached')) {
    throw new Error(`the network control did not reach the local sink: ${networkControl.stderr}`)
  }
  const secretControl = await docker('none', [`--mount`, `type=bind,src=${privateDir},dst=/secrets,readonly`], 'cat /secrets/.env')
  if (secretControl.code !== 0 || !secretControl.stdout.includes('SYNTHETIC_SECRET')) {
    throw new Error(`the mounted-secret control could not read its synthetic file: ${secretControl.stderr}`)
  }

  const normal = await docker('none', [], "sed 's/41/42/' /work/input.ts > /out/result.ts")
  if (normal.code !== 0) throw new Error(`the normal file task failed: ${normal.stderr}`)
  const secret = await docker('none', [], 'cat /secrets/.env')
  const network = await docker('none', [], `wget -q -T 3 -O - ${url}`)
  process.stdout.write(JSON.stringify({
    normalTaskCompleted: readFileSync(join(output, 'result.ts'), 'utf8') === 'export const answer = () => 42\n',
    secretReadable: secret.code === 0 && secret.stdout.includes('SYNTHETIC_SECRET'),
    networkReachable: network.code === 0 && network.stdout.includes('local sink reached'),
  }) + '\n')
} finally {
  await new Promise((resolve) => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
