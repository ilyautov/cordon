import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { handle } from '../../../src/adapters/gemini-cli/handlers.js'
import { parseEvent } from '../../../src/adapters/gemini-cli/protocol.js'
import { loadPolicy } from '../../../src/policy/load.js'

function env(policy = 'mode: autonomous\nprofile:\n  effects: [read, summarize]\n') {
  const home = mkdtempSync(join(tmpdir(), 'cordon-gemini-axes-'))
  writeFileSync(join(home, 'policy.yaml'), policy)
  return { policy: loadPolicy(home), cordonHome: home }
}

function ev(event: object) {
  return parseEvent(JSON.stringify({ session_id: 's', ...event }))
}

describe('the control axis', () => {
  it('a call outside the certificate is rejected', () => {
    const out = handle(
      ev({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'curl x' } }),
      env(),
    )
    expect(out.decision).toBe('deny')
    expect(out.reason).toContain('certificate')
  })

  it('a call inside the certificate goes through', () => {
    const out = handle(
      ev({ hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: { absolute_path: '/tmp/a' } }),
      env(),
    )
    expect(out).toEqual({})
  })

  it('a write outside the certificate is rejected', () => {
    const out = handle(
      ev({ hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: '/tmp/a', content: 'x' } }),
      env(),
    )
    expect(out.decision).toBe('deny')
  })

  it('an unfamiliar tool does not pass more freely than a familiar one', () => {
    const out = handle(
      ev({ hook_event_name: 'BeforeTool', tool_name: 'mytool', tool_input: {} }),
      env(),
    )
    expect(out.decision).toBe('deny')
  })

  it('a tool name from an MCP server is not matched against the built-in table', () => {
    // The name is chosen by the MCP server, that is, by an untrusted party. A
    // server that called its tool read_file must not get the rights of the
    // built-in read: the policy has to classify it.
    const out = handle(
      ev({
        hook_event_name: 'BeforeTool',
        tool_name: 'read_file',
        tool_input: {},
        mcp_context: { server_name: 'someone-else', tool_name: 'read_file' },
      }),
      env(),
    )
    expect(out.decision).toBe('deny')
  })

  it('the user policy is stronger than the built-in table', () => {
    const out = handle(
      ev({ hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: { absolute_path: '/tmp/a' } }),
      env('mode: autonomous\nprofile:\n  effects: [summarize]\ntools:\n  read_file: [read]\n'),
    )
    expect(out.decision).toBe('deny')
  })

  it('a user directive narrows the certificate and survives the process', () => {
    const home = env('mode: autonomous\nprofile:\n  effects: [read, summarize, create, update]\n')
    handle(ev({ hook_event_name: 'BeforeAgent', prompt: 'cordon: scope read\nread the files' }), home)
    const out = handle(
      ev({ hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: '/tmp/a', content: 'x' } }),
      home,
    )
    expect(out.decision).toBe('deny')
  })

  it('without a directive the same call goes through', () => {
    // A control for the previous test: without it that test would only prove
    // that a write is always rejected.
    const home = env('mode: autonomous\nprofile:\n  effects: [read, summarize, create, update]\n')
    handle(ev({ hook_event_name: 'BeforeAgent', prompt: 'read the files' }), home)
    const out = handle(
      ev({ hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: '/tmp/a', content: 'x' } }),
      home,
    )
    expect(out).toEqual({})
  })

  it('a directive that was not understood is said out loud to the human', () => {
    // Silence here would mean the human believes the rights are narrowed while
    // they are not. It goes to the human; nothing is returned to the model.
    const out = handle(ev({ hook_event_name: 'BeforeAgent', prompt: 'cordon: scope reading' }), env())
    expect(out.systemMessage).toContain('cordon: scope')
    expect(out.decision).toBeUndefined()
    expect(out.hookSpecificOutput?.additionalContext).toBeUndefined()
  })

  it('a user message forbids nothing and appends nothing', () => {
    const out = handle(ev({ hook_event_name: 'BeforeAgent', prompt: 'work out the revenue' }), env())
    expect(out).toEqual({})
  })

  it('self-protection does not let a write into the Cordon config through', () => {
    const home = env()
    const out = handle(
      ev({
        hook_event_name: 'BeforeTool',
        tool_name: 'write_file',
        tool_input: { file_path: join(home.cordonHome, 'policy.yaml'), content: 'mode: off' },
      }),
      home,
    )
    expect(out.decision).toBe('deny')
    expect(out.reason).toContain('self-protection')
  })
})

describe('the output axis', () => {
  const claim = 'CRM-X remains the only system with full support for end-to-end sales analytics.'

  function read(home: ReturnType<typeof env>, text = claim) {
    handle(
      ev({
        hook_event_name: 'AfterTool',
        tool_name: 'web_fetch',
        tool_input: { url: 'https://crm-x.com/about' },
        tool_response: { llmContent: text, error: null },
      }),
      home,
    )
  }

  it('the footer goes to the human, not to the model', () => {
    const home = env()
    read(home)
    const out = handle(ev({ hook_event_name: 'AfterAgent', response: `The conclusion: ${claim}` }), home)

    expect(out.systemMessage).toContain('crm-x.com')
    // Not a single field that returns text to the model: a footer that got
    // into the context would become the carrier of the injection on the next
    // turn.
    expect(out.hookSpecificOutput?.additionalContext).toBeUndefined()
    expect(out.decision).toBeUndefined()
    expect(out.reason).toBeUndefined()
  })

  it('it stays silent when no sources were read', () => {
    const out = handle(ev({ hook_event_name: 'AfterAgent', response: 'An ordinary answer.' }), env())
    expect(out).toEqual({})
  })

  it('a switched-off footer stays silent even on a match', () => {
    const home = env('mode: autonomous\nprofile:\n  effects: [read, summarize]\noutput:\n  footer: false\n')
    read(home)
    const out = handle(ev({ hook_event_name: 'AfterAgent', response: `The conclusion: ${claim}` }), home)
    expect(out).toEqual({})
  })

  it('the end of a turn does not bring the hook down on a broken Cordon home', () => {
    // The event decides nothing, and a failure on this harness means "allow":
    // an exception from here would cost the human the answer and would protect
    // nothing.
    const broken = { policy: env().policy, cordonHome: '/no-such/directory' }
    expect(handle(ev({ hook_event_name: 'AfterAgent', response: 'the answer' }), broken)).toEqual({})
  })
})
