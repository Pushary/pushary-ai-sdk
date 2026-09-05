// The enforced gate, as opposed to the model-callable ask tool in index.ts. The AI
// SDK evaluates `toolApproval` before a tool executes, so a model that would rather
// not be interrupted cannot route around it.
//
// Nothing here imports a type from `ai`. The shapes below are structurally
// assignable to AI SDK 7's `ToolApprovalConfiguration`, keeping the dts build off
// `ai`'s deeply generic tool types. The ai >= 5 peer floor supports the basic ask
// tool; these gates need a version exposing `toolApproval` (use ai@7).

import { createAdapterKernel, renderApprovalQuestion } from '@pushary/server/adapters'

/**
 * A tool approval outcome, structurally assignable to the AI SDK's
 * `ToolApprovalStatus`.
 */
export type PusharyApprovalStatus =
  | { readonly type: 'approved' }
  | { readonly type: 'denied'; readonly reason: string }
  | { readonly type: 'not-applicable' }

/** The part of the AI SDK's tool call a gate reads. */
export interface GatedToolCall {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: unknown
}

/** Resolves a value from one gated tool call. */
export type ToolCallResolver<TValue> = (toolCall: GatedToolCall) => TValue

export interface PusharyApprovalConfig {
  /** Pushary API key. Defaults to `process.env.PUSHARY_API_KEY`. */
  readonly apiKey?: string
  /**
   * The enrolled end-user who decides. A string binds every call to one person; a
   * resolver picks one per call.
   */
  readonly externalId: string | ToolCallResolver<string | undefined>
  /**
   * Only gate these tools. Every other call comes back `not-applicable`, so one
   * gate can sit on the whole run and still ask about the risky few.
   */
  readonly tools?: readonly string[]
  /** Shown on the approval so the human knows which agent is asking. */
  readonly agentName?: string
  /** How long the decision stays answerable. */
  readonly expiresInSeconds?: number
  /** How long to block waiting for an answer before failing closed. */
  readonly timeoutMs?: number
  /**
   * Refuse to open a decision nobody can receive, so an end-user with no connected
   * device is denied at request time instead of silently expiring.
   */
  readonly requireReachable?: boolean
  /** Builds the question the human sees. Defaults to the tool name plus its input. */
  readonly question?: ToolCallResolver<string>
  /**
   * Groups one run's calls for idempotency. Tool call ids are already unique per
   * call, so this only matters if you replay a run under ids you minted yourself.
   */
  readonly sessionId?: string
  /** Override the API base URL (tests / self-host). */
  readonly baseUrl?: string
}

/** A run-wide gate, assignable to `generateText`/`streamText` `toolApproval`. */
export type PusharyApprovalPolicy = (options: {
  readonly toolCall: GatedToolCall
}) => Promise<PusharyApprovalStatus>

/** A single-tool gate, assignable to a `toolApproval` entry keyed by tool name. */
export type PusharySingleToolApproval<TInput> = (
  input: TInput,
  options: { readonly toolCallId: string },
) => Promise<PusharyApprovalStatus>

const kernel = createAdapterKernel('pusharyApproval()')

const gateFor = (config: PusharyApprovalConfig) => {
  const gate = kernel.createGate(config)
  const buildQuestion =
    config.question ?? ((call: GatedToolCall) => renderApprovalQuestion(call.toolName, call.input))

  return async (toolCall: GatedToolCall): Promise<PusharyApprovalStatus> => {
    const configured =
      typeof config.externalId === 'function' ? config.externalId(toolCall) : config.externalId
    const decision = await gate({
      toolName: toolCall.toolName,
      callId: toolCall.toolCallId,
      sessionId: config.sessionId ?? '',
      question: buildQuestion(toolCall),
      externalId: kernel.requireExternalId(configured),
      // Lets a rule decide on the call's arguments and not only its name. The
      // kernel bounds what it derives, and derives nothing it cannot carry whole.
      input: toolCall.input,
    })
    return decision.approved ? { type: 'approved' } : { type: 'denied', reason: decision.reason }
  }
}

/**
 * Gate a whole run on a real person. Fails closed: a decline, an expiry, or nobody
 * answering all come back denied and the tool does not run.
 *
 * ```ts
 * const { text } = await generateText({
 *   model: 'openai/gpt-4o',
 *   tools: { issueRefund, lookupOrder },
 *   toolApproval: pusharyApproval({ externalId: user.id, tools: ['issueRefund'] }),
 *   prompt: 'Refund order 1234.',
 * })
 * ```
 *
 * Without `tools` every call is gated, which is the right default for an agent
 * whose whole tool set is consequential.
 */
export const pusharyApproval = (config: PusharyApprovalConfig): PusharyApprovalPolicy => {
  const ask = gateFor(config)
  const gated = config.tools ? new Set(config.tools) : undefined

  return async ({ toolCall }) => {
    if (gated && !gated.has(toolCall.toolName)) return { type: 'not-applicable' }
    return ask(toolCall)
  }
}

// `tools` is the run-wide allowlist and means nothing here: this gate is already
// bound to one tool, so accepting it would only invite someone to set it and wonder
// why it did nothing.
export interface PusharySingleToolApprovalConfig extends Omit<PusharyApprovalConfig, 'tools'> {
  /** The tool this gate sits on, used in the question and the idempotency key. */
  readonly toolName: string
}

/**
 * Gate one tool by name, for the per-tool form of `toolApproval`.
 *
 * ```ts
 * toolApproval: {
 *   issueRefund: pusharyToolApproval({ toolName: 'issueRefund', externalId: user.id }),
 * }
 * ```
 */
export const pusharyToolApproval = <TInput = unknown>(
  config: PusharySingleToolApprovalConfig,
): PusharySingleToolApproval<TInput> => {
  const ask = gateFor(config)

  return (input, { toolCallId }) =>
    ask({ toolCallId, toolName: config.toolName, input })
}
