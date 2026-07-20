/**
 * Minimal Vercel AI SDK example: one tool that pauses the agent until a human approves.
 *
 * Prereqs: npm i @pushary/ai-sdk ai zod @ai-sdk/openai
 * Run:     PUSHARY_API_KEY=... OPENAI_API_KEY=... npx tsx examples/basic.ts
 */
import { generateText, stepCountIs } from 'ai'
import { openai } from '@ai-sdk/openai'
import { enroll, createPusharyTools } from '@pushary/ai-sdk'

const config = { apiKey: process.env.PUSHARY_API_KEY! }
const userId = 'user_123'

async function main() {
  // Once per end-user: show them the link, they tap to connect their phone.
  const { universalLink } = await enroll(config, userId)
  console.log('Ask the user to open:', universalLink)

  const { text } = await generateText({
    model: openai('gpt-4o'),
    tools: createPusharyTools({ apiKey: config.apiKey, externalId: userId }),
    stopWhen: stepCountIs(10),
    prompt: 'Issue the refund only if a human approves it.',
  })
  console.log(text)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
