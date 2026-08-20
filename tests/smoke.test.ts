import { describe, it, expect } from 'vitest'
import { VERSION } from '../src/index.js'

describe('the package', () => {
  it('exports the version', () => {
    expect(VERSION).toBe('0.0.0')
  })
})
