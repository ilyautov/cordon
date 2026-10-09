import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { Transform } from 'node:stream'

const MAX_LINE = 2_000_000

// The observer forwards the original MCP bytes. A malformed or oversized
// line costs benchmark evidence, never the agent's transport.
export class ToolListTap extends Transform {
  constructor() {
    super()
    this.decoder = new StringDecoder('utf8')
    this.line = ''
    this.toolLists = []
    this.parseErrors = 0
    this.overLimit = false
  }

  observe(part) {
    if (this.overLimit) return
    this.line += part
    if (this.line.length > MAX_LINE) {
      this.overLimit = true
      this.line = ''
      return
    }
    let end = this.line.indexOf('\n')
    while (end !== -1) {
      const line = this.line.slice(0, end)
      this.line = this.line.slice(end + 1)
      if (line !== '') this.observeLine(line)
      end = this.line.indexOf('\n')
    }
  }

  observeLine(line) {
    let message
    try { message = JSON.parse(line) }
    catch { this.parseErrors++; return }
    const tools = message?.result?.tools
    if (!Array.isArray(tools)) return
    this.toolLists.push({
      sha256: createHash('sha256').update(JSON.stringify(tools)).digest('hex'),
      names: tools.map((tool) => typeof tool?.name === 'string' ? tool.name : null),
    })
  }

  _transform(chunk, _encoding, callback) {
    this.observe(this.decoder.write(chunk))
    callback(null, chunk)
  }

  _flush(callback) {
    this.observe(this.decoder.end())
    if (this.line !== '') this.observeLine(this.line)
    callback()
  }

  snapshot() {
    return { toolLists: this.toolLists, parseErrors: this.parseErrors,
      overLimit: this.overLimit }
  }
}
