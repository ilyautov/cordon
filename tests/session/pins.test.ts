import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PinStore, serverId } from '../../src/session/pins.js'

const home = () => mkdtempSync(join(tmpdir(), 'cordon-pins-'))

describe('PinStore: the tools an owner approved, per server', () => {
  it('has nothing for a server never seen', () => {
    expect(new PinStore(home()).load(['npx', 'server-x'])).toBeNull()
  })

  it('keeps what was saved, per command', () => {
    const store = new PinStore(home())
    store.save(['npx', 'server-x'], { a: 'h1' })
    expect(store.load(['npx', 'server-x'])).toEqual({ a: 'h1' })
    expect(store.load(['npx', 'server-y'])).toBeNull()
  })

  it('is readable only by the owner', () => {
    const dir = home()
    new PinStore(dir).save(['s'], { a: 'h' })
    const [name] = readdirSync(join(dir, 'mcp-pins'))
    expect(statSync(join(dir, 'mcp-pins', name!)).mode & 0o077).toBe(0)
  })

  it('forgets a server on approval, so its next start pins afresh', () => {
    const store = new PinStore(home())
    store.save(['s'], { a: 'h' })
    expect(store.forget(['s'])).toBe(true)
    expect(store.load(['s'])).toBeNull()
    expect(store.forget(['s'])).toBe(false)
  })

  it('a damaged pin file is an error, not an empty one', () => {
    // Empty means "first sight": everything the server lists would be pinned
    // as approved. A damaged file read as empty approves a rug pull.
    const dir = home()
    mkdirSync(join(dir, 'mcp-pins'))
    writeFileSync(join(dir, 'mcp-pins', `${serverId(['s'])}.json`), '{not json')
    expect(() => new PinStore(dir).load(['s'])).toThrow(/pins .* (corrupted|incompatible)/u)
  })

  it('a pin file of the wrong shape is an error', () => {
    const dir = home()
    mkdirSync(join(dir, 'mcp-pins'))
    writeFileSync(join(dir, 'mcp-pins', `${serverId(['s'])}.json`), JSON.stringify({ version: 1, tools: { a: 5 } }))
    expect(() => new PinStore(dir).load(['s'])).toThrow(/incompatible/u)
  })

  it('the server is told apart by its whole command', () => {
    expect(serverId(['npx', 'a b'])).not.toBe(serverId(['npx', 'a', 'b']))
  })
})
