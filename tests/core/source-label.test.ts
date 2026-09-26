import { describe, expect, it } from 'vitest'
import { sourceLabel } from '../../src/core/argument-keys.js'

describe('the source label', () => {
  it('is the link, then the path, then the tool name', () => {
    expect(sourceLabel({ tool: 'fetch', args: { file_path: '/srv/a', url: 'https://a.example/x' } })).toBe('https://a.example/x')
    expect(sourceLabel({ tool: 'read', args: { filePath: '/srv/a' } })).toBe('/srv/a')
    expect(sourceLabel({ tool: 'get_channels', args: {} })).toBe('get_channels')
  })

  it('does not look into nested arguments', () => {
    // The label decides which declared trusted source a result counts as. A
    // call could carry a trusted link in a nested field beside the one it
    // actually fetches, and the result would be classified by the decoy.
    const call = { tool: 'fetch', args: { target: 'https://evil.example/x', options: { url: 'https://docs.internal/a' } } }
    expect(sourceLabel(call)).toBe('fetch')
  })
})
