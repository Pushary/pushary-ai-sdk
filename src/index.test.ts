import { describe, it, expect, afterEach } from 'vitest'
import { createPusharyTools, describeAnswer, enroll } from './index'
import type { AskResult } from '@pushary/server'

interface Recorded {
  readonly url: string
  readonly method: string
  readonly body: Record<string, unknown> | undefined
}

type Responder = (call: Recorded) => { status?: number; json: unknown }

const realFetch = globalThis.fetch

const installFetch = (responders: readonly Responder[]): Recorded[] => {
  const calls: Recorded[] = []
  let i = 0
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const call: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    }
    calls.push(call)
    const responder = responders[Math.min(i, responders.length - 1)]
    i += 1
    const { status = 200, json } = responder(call)
    return { ok: status >= 200 && status < 300, status, json: async () => json } as Response
  }) as typeof fetch
  return calls
}

afterEach(() => {
  globalThis.fetch = realFetch
})

const ask = (r: Partial<AskResult>): AskResult => ({
  decisionId: 'd',
  status: 'answered',
  answered: true,
  value: 'yes',
  type: 'confirm',
  approved: true,
  ...r,
})

describe('describeAnswer', () => {
  it('confirm approved / declined / unanswered', () => {
    expect(describeAnswer('confirm', ask({ approved: true }))).toContain('APPROVED')
    expect(describeAnswer('confirm', ask({ approved: false, value: 'no' }))).toContain('DECLINED')
    expect(describeAnswer('confirm', ask({ answered: false, status: 'expired', approved: false }))).toContain(
      'NOT approved',
    )
  })
  it('select/input returns the value', () => {
    expect(describeAnswer('select', ask({ type: 'select', value: 'B' }))).toContain('B')
    expect(describeAnswer('input', ask({ type: 'input', value: 'ship monday' }))).toContain('ship monday')
  })
})

describe('createPusharyTools', () => {
  it('askHuman delivers to the configured externalId and reports approval', async () => {
    const calls = installFetch([
      () => ({ json: { decisionId: 'd', status: 'pending', answered: false, type: 'confirm' } }),
      () => ({ json: { decisionId: 'd', status: 'answered', answered: true, value: 'yes', type: 'confirm' } }),
    ])
    const tools = createPusharyTools({ apiKey: 'pk_x.sk_y', externalId: 'user_9', timeoutMs: 5000 })
    expect(tools.askHuman.execute).toBeTypeOf('function')
    const out = await tools.askHuman.execute!(
      { question: 'Refund $50?', type: 'confirm' },
      { messages: [], toolCallId: 't1' } as never,
    )
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('https://pushary.com/api/v1/server/decisions')
    expect(calls[0].body?.externalId).toBe('user_9')
    expect(calls[0].body?.idempotencyKey).toBeTruthy()
    expect(out).toContain('APPROVED')
  })

  it('a declined confirm tells the model not to proceed', async () => {
    installFetch([
      () => ({ json: { decisionId: 'd', status: 'pending', answered: false, type: 'confirm' } }),
      () => ({ json: { decisionId: 'd', status: 'answered', answered: true, value: 'no', type: 'confirm' } }),
    ])
    const tools = createPusharyTools({ apiKey: 'pk_x.sk_y', externalId: 'u', timeoutMs: 5000 })
    const out = await tools.askHuman.execute!(
      { question: 'Delete prod?', type: 'confirm' },
      { messages: [], toolCallId: 't2' } as never,
    )
    expect(out).toContain('Do not proceed')
  })
})

describe('enroll', () => {
  it('returns the connect link for an end-user', async () => {
    const calls = installFetch([
      () => ({
        json: {
          externalId: 'u',
          token: 'tok',
          deepLink: 'pushary://enroll?token=tok',
          universalLink: 'https://pushary.com/e/tok',
          expiresInSeconds: 900,
        },
      }),
    ])
    const r = await enroll({ apiKey: 'pk_x.sk_y' }, 'u')
    expect(calls[0].url).toBe('https://pushary.com/api/v1/server/enroll')
    expect(r.universalLink).toContain('/e/tok')
  })
})
