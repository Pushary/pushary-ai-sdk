# @pushary/ai-sdk

[![CI](https://github.com/Pushary/pushary-ai-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/Pushary/pushary-ai-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@pushary/ai-sdk)](https://www.npmjs.com/package/@pushary/ai-sdk)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Full walkthrough: [Human-in-the-loop for the Vercel AI SDK](https://pushary.com/human-in-the-loop-vercel-ai-sdk). Reaching your own end-users on their phones is the Pushary [Partner plan](https://pushary.com/human-in-the-loop).

Human-in-the-loop for the [Vercel AI SDK](https://ai-sdk.dev). Give your agent one tool that pauses until a real human approves on their phone, and answers from the lock screen.

Two calls is the whole integration:

1. `enroll(externalId)` once per end-user. Show them the link it returns. One tap connects their phone.
2. Add `createPusharyTools({ externalId })` to your agent. Now it can ask that person and block on the answer.

No UI to build, no polling to write, no webhooks required. Requires the Pushary [Partner plan](https://pushary.com/agent-notifications-integration).

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
import { openai } from '@ai-sdk/openai'
import { createPusharyTools } from '@pushary/ai-sdk'

const { text } = await generateText({
  model: openai('gpt-4o'),
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

## API

### `createPusharyTools(config)`

`config`: `{ apiKey, externalId, agentName?, timeoutMs?, baseUrl? }`. Returns `{ askHuman }`, a tool you pass to `generateText` / `streamText`. Merge it with your own tools:

```ts
tools: { ...createPusharyTools({ apiKey, externalId }), ...myOtherTools }
```

### `enroll(config, externalId)`

`config`: `{ apiKey, baseUrl? }`. Returns `{ token, deepLink, universalLink, expiresInSeconds }`.

## Under the hood

This package is a thin wrapper over [`@pushary/server`](https://www.npmjs.com/package/@pushary/server) (`enroll` + `decisions.ask`). Use that directly for any framework, or reach for the Pushary MCP server to wire agents up with no code at all. See the [adapters guide](https://pushary.com/docs/agents/adapters).

MIT
