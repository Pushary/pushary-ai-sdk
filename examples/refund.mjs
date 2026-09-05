// Run after npm install && npm run build. Requires ai@7; no model API key.
import { generateText, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import { pusharyApproval, enroll } from '../dist/index.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'

const live = process.argv.includes('--live')
if (process.argv.slice(2).some(arg => arg !== '--live')) throw new Error('Usage: node examples/refund.mjs [--live]')
const config = live
  ? { apiKey: process.env.PUSHARY_API_KEY, timeoutMs: 55000 }
  : { apiKey: 'pk_demo.sk_demo', baseUrl: 'https://simulation.invalid', timeoutMs: 0 }
const externalId = live ? process.env.PUSHARY_EXTERNAL_ID : 'demo-user'
if (live && (!config.apiKey || !externalId)) {
  throw new Error('Live mode needs PUSHARY_API_KEY and PUSHARY_EXTERNAL_ID. Use your own test user.')
}
if (live) {
  const { universalLink } = await enroll(config, externalId)
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log('Connect your test phone:', universalLink)
    await terminal.question('Open the link and finish connecting before pressing Enter. ')
  } finally { terminal.close() }
}
console.log(live
  ? 'LIVE PHONE: real approval; simulated refund. No money moves.'
  : 'SIMULATION: real framework and adapter; fake API answers. No network, phone, or money movement.')

const realFetch = globalThis.fetch
try {
  for (const answer of live ? ['phone'] : ['yes', 'no', 'unanswered']) {
    let decisionRequests = 0
    if (!live) globalThis.fetch = async (input) => {
      const url = new URL(String(input))
      assert.equal(url.origin, 'https://simulation.invalid', 'Unexpected network request')
      if (url.pathname === '/authorize') return Response.json({
        verdict: 'requires_human', policy: null, authorizationId: null, reason: 'Demo requires a person.',
      })
      assert.equal(url.pathname, '/decisions', 'Unexpected API endpoint')
      decisionRequests++
      return Response.json({
        decisionId: 'demo-decision', type: 'confirm',
        status: answer === 'unanswered' ? 'pending' : 'answered',
        answered: answer !== 'unanswered', value: answer === 'unanswered' ? null : answer,
      })
    }
    let executions = 0

    // The model deterministically requests a refund; the SDK must enforce approval.
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'tool-call', toolCallId: randomUUID(), toolName: 'issueRefund', input: '{"amount":40}' }],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } }, warnings: [],
      },
    })
    await generateText({
      model,
      prompt: 'Refund order DEMO-123.',
      tools: {
        issueRefund: tool({
          description: 'Simulate a refund. No payment provider is connected.',
          inputSchema: z.object({ amount: z.number().positive() }),
          execute: async ({ amount }) => { executions++; return { simulated: true, amount } },
        }),
      },
      toolApproval: pusharyApproval({ ...config, externalId, tools: ['issueRefund'] }),
      maxRetries: 0,
    })

    if (!live) {
      assert.equal(decisionRequests, 1, 'The example must actually request a decision')
      assert.equal(executions, answer === 'yes' ? 1 : 0, 'Only explicit approval may execute')
    }
    console.log(`${answer}: ${executions ? 'executed' : 'blocked'} (simulated refund)`)
  }
} finally { globalThis.fetch = realFetch }
console.log('Found this useful? Star this repo, or share a reproducible issue and help improve it.')

