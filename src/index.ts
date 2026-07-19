import type { ToolSet } from 'ai'
import { z } from 'zod'
import {
  createPusharyServer,
  deterministicKey,
  type AskResult,
  type DecisionType,
  type EnrollResult,
  type PusharyServer,
} from '@pushary/server'

export interface PusharyToolsConfig {
  /** Your Pushary API key (pk_xxx.sk_xxx). */
  readonly apiKey: string
  /**
   * The enrolled end-user who should answer. Connect them once with `enroll()`.
   * Every ask from these tools is delivered to this person's phone.
   */
  readonly externalId: string
  /** Shown on the approval so the human knows which agent is asking. */
  readonly agentName?: string
  /** How long each ask blocks before returning (default 55s, serverless-safe). */
  readonly timeoutMs?: number
  /** Override the API base URL (tests / self-host). */
  readonly baseUrl?: string
}

/** Turn a decision outcome into an unambiguous instruction for the model. */
export const describeAnswer = (type: DecisionType, result: AskResult): string => {
  if (!result.answered) {
    return `No answer yet (status: ${result.status}). Treat this as NOT approved and do not proceed.`
  }
  if (type === 'confirm') {
    return result.approved
      ? 'The human APPROVED. You may proceed.'
      : 'The human DECLINED. Do not proceed.'
  }
  return `The human answered: ${result.value ?? ''}`
}

interface AskInput {
  question: string
  type: DecisionType
  options?: string[]
}

// Cast to a shallow ZodType so ai's `tool()` generic does not recurse through the
// full inferred zod shape (TS2589 "excessively deep") on some `ai` minor versions.
// Runtime validation is unchanged; only the compile-time inference is simplified.
const askInputSchema = z.object({
  question: z.string().describe('The exact question to put to the human.'),
  type: z
    .enum(['confirm', 'select', 'input'])
    .default('confirm')
    .describe('confirm = yes/no, select = pick one of options, input = free text.'),
  options: z.array(z.string()).optional().describe('The choices, for a select question.'),
}) as unknown as z.ZodType<AskInput>

/**
 * Vercel AI SDK tools that let your agent pause for a real human on their phone.
 * Drop the result into `generateText`/`streamText` `tools`. The one tool your
 * agent needs is `askHuman`.
 *
 * ```ts
 * const { text } = await generateText({
 *   model: openai('gpt-4o'),
 *   tools: createPusharyTools({ apiKey: process.env.PUSHARY_API_KEY!, externalId: user.id }),
 *   stopWhen: stepCountIs(10),
 *   prompt: 'Issue the refund only if a human approves it.',
 * })
 * ```
 */
export const createPusharyTools = (config: PusharyToolsConfig): ToolSet => {
  const client: PusharyServer = createPusharyServer({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  })

  // Built as a plain structural object, not via ai's `tool()` helper and not
  // annotated with `Tool<>`. `tool()` is a pure identity function (it returns its
  // argument), but both its overloaded generic and the `Tool` union type make the
  // dts build recurse (TS2589) on some `ai` minor versions. Explicit execute param
  // types keep type safety without naming `Tool`, and the return is cast to
  // `ToolSet` so consumers spread it into `generateText`/`streamText` `tools`.
  const askHuman = {
    description:
      'Ask a real human to approve, choose, or answer. Delivered to their phone and answered from the lock screen. Blocks until they reply. Use this before any risky or irreversible action (spending money, deleting data, sending an external message) or whenever you genuinely need a human decision.',
    inputSchema: askInputSchema,
    execute: async (
      { question, type, options }: AskInput,
      { toolCallId }: { toolCallId: string },
    ): Promise<string> => {
      const result = await client.decisions.ask({
        question,
        type,
        options,
        externalId: config.externalId,
        agentName: config.agentName,
        timeoutMs: config.timeoutMs,
        // Keyed to this specific tool call: a provider-level retry of the same call
        // dedupes, while two distinct askHuman calls (even with identical text) stay
        // separate decisions that each reach the human.
        idempotencyKey: deterministicKey([config.externalId, toolCallId]),
      })
      return describeAnswer(type, result)
    },
  }

  return { askHuman } as unknown as ToolSet
}

/**
 * Connect an end-user's phone (keyless). Returns a single-use link to show them;
 * one tap turns on approvals. Call once per end-user and cache the enrollment
 * (not the link — it is single-use and expires).
 */
export const enroll = (
  config: { readonly apiKey: string; readonly baseUrl?: string },
  externalId: string,
): Promise<EnrollResult> =>
  createPusharyServer({ apiKey: config.apiKey, baseUrl: config.baseUrl }).enroll(externalId)
