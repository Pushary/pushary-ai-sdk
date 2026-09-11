import assert from 'node:assert/strict'
import { generateText, modelMessageSchema, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import { decisionFingerprint } from '@pushary/server/adapters'
import { saveReview } from './delayed-review-store.mjs'
import { runSimulation } from './delayed-simulation.mjs'

const inputSchema = z.object({ orderId: z.string(), amount: z.number().int().positive(), draftVersion: z.number().int().positive() }).strict()
const approvalSchema = z.object({
  type: z.literal('tool-approval-request'), approvalId: z.string().min(1),
  toolCall: z.object({ toolCallId: z.string().min(1), toolName: z.literal('refund'), input: inputSchema }),
})

const model = (scenario, resumed) => new MockLanguageModelV4({
  doGenerate: {
    content: !resumed || scenario === 'next'
      ? [{ type: 'tool-call', toolCallId: resumed ? 'call_2' : 'call_1', toolName: 'refund', input: JSON.stringify({ orderId: 'order_1', amount: 4800, draftVersion: 1 }) }]
      : [{ type: 'text', text: 'Review continued.' }],
    finishReason: { unified: !resumed || scenario === 'next' ? 'tool-calls' : 'stop', raw: undefined },
    usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } }, warnings: [],
  },
})
const tools = effect => ({
  refund: tool({ description: 'Simulate a refund after the customer approves.', inputSchema, execute: effect }),
})

await runSimulation(import.meta.url, {
  framework: 'ai@7.0.66',
  async start({ store, target, effect, scenario }) {
    const messages = [{ role: 'user', content: 'Refund order_1 only after customer approval.' }]
    const result = await generateText({ model: model(scenario, false), tools: tools(effect), messages, toolApproval: { refund: 'user-approval' }, maxRetries: 0 })
    const requests = result.content.filter(part => part.type === 'tool-approval-request')
    assert.equal(requests.length, 1, 'This bounded recipe opens one protected call per saved operation')
    const request = approvalSchema.parse(requests[0])
    saveReview(store, target, JSON.stringify([...messages, ...result.response.messages]), { ...request.toolCall, approvalId: request.approvalId })
  },
  async resume({ snapshot, binding, approved, effect, scenario }) {
    const messages = JSON.parse(snapshot).map(message => modelMessageSchema.parse(message))
    const requests = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    const approval = requests.find(part => part.type === 'tool-approval-request' && part.approvalId === binding.call.approvalId)
    const call = requests.find(part => part.type === 'tool-call' && part.toolCallId === binding.call.toolCallId)
    assert.ok(approval, 'Saved native approval missing')
    assert.equal(approval.toolCallId, binding.call.toolCallId)
    assert.equal(call?.toolName, binding.call.toolName)
    assert.equal(decisionFingerprint(call.input), decisionFingerprint(binding.call.input))
    const result = await generateText({
      model: model(scenario, true), tools: tools(effect), maxRetries: 0, toolApproval: { refund: 'user-approval' },
      messages: [...messages, { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: binding.call.approvalId, approved }] }],
    })
    return {
      text: result.text, finishReason: result.finishReason,
      snapshot: JSON.stringify([...messages, { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: binding.call.approvalId, approved }] }, ...result.response.messages]),
      content: result.content,
      pending: result.content.filter(part => part.type === 'tool-approval-request'),
    }
  },
})
