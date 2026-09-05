# @pushary/ai-sdk

[![CI](https://github.com/Pushary/pushary-ai-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/Pushary/pushary-ai-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@pushary/ai-sdk)](https://www.npmjs.com/package/@pushary/ai-sdk)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Full walkthrough: [Human-in-the-loop for the Vercel AI SDK](https://pushary.com/human-in-the-loop-vercel-ai-sdk?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-ai-sdk&utm_content=readme). Reaching your own end-users on their phones is the Pushary [Partner plan](https://pushary.com/human-in-the-loop?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-ai-sdk&utm_content=readme).

Human-in-the-loop for the [Vercel AI SDK](https://ai-sdk.dev). Give your agent one tool that pauses until a real human approves on their phone, and answers from the lock screen.

Two calls is the whole integration:

1. `enroll(externalId)` once per end-user. Show them the link it returns. One tap connects their phone.
2. Add `createPusharyTools({ externalId })` to your agent. Now it can ask that person and block on the answer.

No UI to build, no polling to write, no webhooks required. Requires the Pushary [Partner plan](https://pushary.com/agent-notifications-integration?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-ai-sdk&utm_content=readme).

## Install

```bash
npm i @pushary/ai-sdk ai zod
```

Set `PUSHARY_API_KEY` (get it in your [dashboard](https://pushary.com/dashboard/settings)).

## Connect an end-user's phone (once)

```ts
import { enroll } from '@pushary/ai-sdk'

const { universalLink } = await enroll({ apiKey: process.env.PUSHARY_API_KEY! }, user.id)
// Show universalLink to the user as a button or QR. One tap turns on approvals.
// Cache the fact that they enrolled, not the link itself (it is single-use).
```

## Give your agent a human to ask

```ts
import { generateText, stepCountIs } from 'ai'
import { createPusharyTools } from '@pushary/ai-sdk'

const { text } = await generateText({
  model: 'openai/gpt-4o',
  tools: createPusharyTools({
    apiKey: process.env.PUSHARY_API_KEY!,
    externalId: user.id, // the enrolled person who answers
  }),
  stopWhen: stepCountIs(10),
  prompt: 'Issue the refund only if a human approves it.',
})
```

The agent gets an `askHuman` tool. When it calls it, the person gets a push notification and approves, declines, picks an option, or types an answer from their phone. The tool blocks until they reply, then hands the model an unambiguous result.

## Behavior that matters

- **Fail-closed.** A declined, expired, or unanswered `confirm` is reported to the model as "not approved, do not proceed." Approval only happens on an explicit yes.
- **Serverless-safe.** Each ask blocks up to 55 seconds by default (`timeoutMs`). The decision stays answerable for its full lifetime, so a slow human still resolves it. For waits of minutes or hours, run under a durable workflow (Inngest, Temporal, Vercel Workflow) and use a `callbackUrl`.
- **No double-asks on retry.** The idempotency key is derived deterministically, so a retried step reuses the same decision instead of paging the human twice.

## Gating a tool the model cannot skip

`createPusharyTools` gives the model a tool it chooses to call. That is right for
"go ask someone about this", and wrong for "this must not happen without a yes",
because a model that does not want to be interrupted can decline to call it.

For an enforced gate, use `pusharyApproval()` in the AI SDK's own `toolApproval`.
The SDK evaluates it before the tool executes, so there is no path around it:

```ts
import { generateText } from 'ai'
import { pusharyApproval } from '@pushary/ai-sdk'

const { text } = await generateText({
  model: 'openai/gpt-4o',
  tools: { issueRefund, lookupOrder },
  // only issueRefund asks a human; lookupOrder runs untouched
  toolApproval: pusharyApproval({ externalId: user.id, tools: ['issueRefund'] }),
  prompt: 'Refund order 1234.',
})
```

Drop `tools` to gate every call. For the per-tool form:

```ts
toolApproval: {
  issueRefund: pusharyToolApproval({ toolName: 'issueRefund', externalId: user.id }),
}
```

Fail-closed: a denial, an expiry, or nobody answering all come back denied and the
tool does not run. The decision is keyed on the tool call, so a provider-level retry
resolves to the same decision instead of asking twice.

For a multi-tenant product, resolve the end-user per call:

```ts
toolApproval: pusharyApproval({ externalId: (call) => ownerOf(call.input) })
```

Use `ai@7` for the `toolApproval` gate examples above. This API is absent from
`ai@5.0.0` and `ai@6.0.0`; the package's `ai >= 5.0.0` peer range also serves the
basic ask tool, which works from `ai@5` on.

## API

### `createPusharyTools(config)`

`config`: `{ apiKey, externalId, agentName?, timeoutMs?, baseUrl? }`. Returns `{ askHuman }`, a tool you pass to `generateText` / `streamText`. Merge it with your own tools:

```ts
tools: { ...createPusharyTools({ apiKey, externalId }), ...myOtherTools }
```

### `enroll(config, externalId)`

`config`: `{ apiKey, baseUrl? }`. Returns `{ token, deepLink, universalLink, expiresInSeconds }`.

## Under the hood

This package is a thin binding over the shared adapter kernel in [`@pushary/server`](https://www.npmjs.com/package/@pushary/server) (`@pushary/server/adapters`), which every Pushary framework adapter is built on. Use `@pushary/server` directly for any framework, `@pushary/server/adapters` to write your own adapter, or the Pushary MCP server to wire agents up with no code at all. See the [adapters guide](https://pushary.com/docs/agents/adapters?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-ai-sdk&utm_content=readme).

MIT

## Example

A runnable example is in [`examples/`](examples).
