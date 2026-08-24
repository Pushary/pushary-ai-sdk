import { describe, it, expect, afterEach } from 'vitest'
import { pusharyApproval, pusharyToolApproval } from './approval'

interface Recorded {
  readonly body: Record<string, unknown> | undefined
}
type Responder = () => unknown

// What POST /authorize answers. The gate asks policy before it asks a person; this
// suite is about the framework binding, so the default verdict is the one that
// still reaches a human.
const REQUIRES_HUMAN = {
  verdict: 'requires_human',
  policy: null,
  reason: 'No policy rule names this action, so a person decides.',
  authorizationId: null,
}

const realFetch = globalThis.fetch
// The policy hop is answered but not recorded, so `calls` keeps meaning "the
// decisions this adapter opened" and every assertion below reads as it did before
// the gate consulted policy.
const installFetch = (
  responders: readonly Responder[],
  evaluation: unknown = REQUIRES_HUMAN,
): Recorded[] => {
  const calls: Recorded[] = []
  let i = 0
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    if (String(input).endsWith('/authorize')) {
      return { ok: true, status: 200, json: async () => evaluation } as Response
    }
    calls.push({ body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined })
    const json = responders[Math.min(i, responders.length - 1)]()
    i += 1
    return { ok: true, status: 200, json: async () => json } as Response
  }) as typeof fetch
  return calls
}

const ALLOWED = {
  verdict: 'allow',
  policy: 'issue_refund',
  reason: 'Allowed by policy rule issue_refund.',
  authorizationId: 'az_1',
}
afterEach(() => {
  globalThis.fetch = realFetch
})

const CONFIG = {
  apiKey: 'pk_x.sk_y',
  baseUrl: 'https://pushary.com/api/v1/server',
  timeoutMs: 0,
  externalId: 'user_1',
}

const answered = (value: string) => () => ({
  decisionId: 'd1',
  status: 'answered',
  answered: true,
  value,
  type: 'confirm',
})
const unanswered = () => ({
  decisionId: 'd1',
  status: 'pending',
  answered: false,
  value: null,
  type: 'confirm',
})

const toolCall = {
  toolCallId: 'call_1',
  toolName: 'issueRefund',
  input: { amount: 480 },
}

describe('pusharyApproval', () => {
  it('approves when the human says yes', async () => {
    installFetch([answered('yes')])
    expect(await pusharyApproval(CONFIG)({ toolCall })).toEqual({ type: 'approved' })
  })

  it('approves without opening a decision when a rule allows the call', async () => {
    const calls = installFetch([answered('yes')], ALLOWED)
    expect(await pusharyApproval(CONFIG)({ toolCall })).toEqual({ type: 'approved' })
    expect(calls).toHaveLength(0)
  })

  it('denies on a policy denial without asking anyone', async () => {
    const calls = installFetch([answered('yes')], {
      verdict: 'deny',
      policy: 'issueRefund',
      reason: 'Denied by policy rule issueRefund.',
      authorizationId: 'az_1',
    })
    const status = (await pusharyApproval(CONFIG)({ toolCall })) as { type: string; reason: string }
    expect(status.type).toBe('denied')
    expect(status.reason).toContain('Denied by policy rule issueRefund.')
    expect(calls).toHaveLength(0)
  })

  it('gives policy the call arguments so a rule can read them', async () => {
    let seen: Record<string, unknown> | undefined
    const realFetch2 = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
      if (String(input).endsWith('/authorize')) {
        seen = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
      }
      return { ok: true, status: 200, json: async () => ALLOWED } as Response
    }) as typeof fetch
    await pusharyApproval(CONFIG)({ toolCall })
    globalThis.fetch = realFetch2
    expect(seen?.parameters).toEqual({ amount: 480 })
  })

  it('denies when the human says no', async () => {
    installFetch([answered('no')])
    const status = await pusharyApproval(CONFIG)({ toolCall })
    expect(status).toMatchObject({ type: 'denied' })
  })

  it('fails closed when nobody answers', async () => {
    installFetch([unanswered])
    const status = (await pusharyApproval(CONFIG)({ toolCall })) as {
      type: string
      reason: string
    }
    expect(status.type).toBe('denied')
    expect(status.reason).toContain('No answer')
  })

  it('leaves an ungated tool alone rather than approving it', async () => {
    const calls = installFetch([answered('yes')])
    const status = await pusharyApproval({ ...CONFIG, tools: ['issueRefund'] })({
      toolCall: { ...toolCall, toolName: 'lookupOrder' },
    })
    expect(status).toEqual({ type: 'not-applicable' })
    expect(calls).toHaveLength(0)
  })

  it('gates a tool named in the allowlist', async () => {
    const calls = installFetch([answered('yes')])
    await pusharyApproval({ ...CONFIG, tools: ['issueRefund'] })({ toolCall })
    expect(calls).toHaveLength(1)
  })

  it('puts the tool input in the question', async () => {
    const calls = installFetch([answered('yes')])
    await pusharyApproval(CONFIG)({ toolCall })
    expect(String(calls[0]?.body?.question)).toContain('480')
  })

  it('always asks confirm, never a free-text type', async () => {
    const calls = installFetch([answered('yes')])
    await pusharyApproval(CONFIG)({ toolCall })
    expect(calls[0]?.body?.type).toBe('confirm')
  })

  it('lets externalId be resolved per call for a multi-tenant product', async () => {
    const calls = installFetch([answered('yes')])
    await pusharyApproval({ ...CONFIG, externalId: (call) => `tenant:${call.toolName}` })({
      toolCall,
    })
    expect(calls[0]?.body?.externalId).toBe('tenant:issueRefund')
  })

  it('refuses when the resolver finds no end-user to ask', async () => {
    installFetch([answered('yes')])
    await expect(
      pusharyApproval({ ...CONFIG, externalId: () => undefined })({ toolCall }),
    ).rejects.toThrow(/no end-user to ask/)
  })

  it('keys on the tool call so a provider retry does not ask twice', async () => {
    const calls = installFetch([answered('yes'), answered('yes')])
    const gate = pusharyApproval(CONFIG)
    await gate({ toolCall })
    await gate({ toolCall })
    expect(calls[0]?.body?.idempotencyKey).toBe(calls[1]?.body?.idempotencyKey)
  })

  it('keys two distinct tool calls apart', async () => {
    const calls = installFetch([answered('yes'), answered('yes')])
    const gate = pusharyApproval(CONFIG)
    await gate({ toolCall })
    await gate({ toolCall: { ...toolCall, toolCallId: 'call_2' } })
    expect(calls[0]?.body?.idempotencyKey).not.toBe(calls[1]?.body?.idempotencyKey)
  })
})

describe('pusharyToolApproval', () => {
  it('gates one named tool from its input and call id', async () => {
    const calls = installFetch([answered('yes')])
    const gate = pusharyToolApproval<{ amount: number }>({ ...CONFIG, toolName: 'issueRefund' })
    expect(await gate({ amount: 480 }, { toolCallId: 'call_1' })).toEqual({ type: 'approved' })
    expect(String(calls[0]?.body?.question)).toContain('issueRefund')
    expect(String(calls[0]?.body?.question)).toContain('480')
  })

  it('fails closed on silence', async () => {
    installFetch([unanswered])
    const gate = pusharyToolApproval<{ amount: number }>({ ...CONFIG, toolName: 'issueRefund' })
    expect(await gate({ amount: 480 }, { toolCallId: 'call_1' })).toMatchObject({ type: 'denied' })
  })
})
