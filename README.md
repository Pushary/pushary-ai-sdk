# @pushary/ai-sdk

Your agent asks; your customer answers in the native Pushary app. Use `createPusharyTools` for confirm, select, and input questions. Use the separately enforced `pusharyApproval` gate for permission to execute a tool. Choices and typed answers open the app; yes/no confirmations can use notification actions. Legacy web links remain available.

[Integration guide](https://pushary.com/human-in-the-loop-vercel-ai-sdk?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-ai-sdk&utm_content=guide) · [Connect your customer’s phone](https://pushary.com/sign-up?from=agent&plan=partner&utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-ai-sdk&utm_content=partner-start) · [Report a problem](https://github.com/Pushary/pushary-ai-sdk/issues)

## Try it before signing up

[Open the no-signup browser demo](https://pushary.com/try?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-ai-sdk&utm_content=demo).
It demonstrates a human approval with an open phone page and temporary state;
it does **not** demonstrate push delivery or durable production storage.

For a local example using the real AI SDK approval callback:

```bash
git clone https://github.com/Pushary/pushary-ai-sdk.git
cd pushary-ai-sdk
npm install
npm run build
node examples/refund.mjs
```

Use Node.js 22 and AI SDK 7 (installed by this repo). No account, card, API key, or model provider is needed for this simulation.
It checks all three outcomes:

```text
yes: executed (simulated refund)
no: blocked (simulated refund)
unanswered: blocked (simulated refund)
```

[Read the example and try a real phone approval](examples/README.md).
The integration code is MIT-licensed; real phone delivery uses the hosted Pushary service and requires Partner access.

[Get help or contribute an example](CONTRIBUTING.md).

[![CI](https://github.com/Pushary/pushary-ai-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/Pushary/pushary-ai-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@pushary/ai-sdk)](https://www.npmjs.com/package/@pushary/ai-sdk)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Runtime and approval boundaries

Set `policy: false` when a person must always decide. A trusted `subject` resolver can provide the action target, parameters, and presentation. Recipient identity comes from your authenticated application, never from model-supplied arguments. Tool retries keep their review only while the recipient and complete proposed action remain identical.

Run `npm run build` then `node examples/refund.mjs` for a real AI SDK 7 execution with simulated approval responses; `--live` enrolls your test phone while the refund remains simulated. This request-time gate is bounded by its timeout. For answers arriving later, persist the AI SDK's pending approval and messages in your application and resume them only after verifying the matching decision. This package does not add a durable runner.

Version `0.3.0` requires server SDK 2.1. The basic ask tool retains `ai >=5` and Node.js 18 as its minimum metadata; follow the runtime requirements of your installed AI SDK version. The enforced `toolApproval` API requires AI SDK 7 and Node.js 22 or later. The delayed SQLite recipe needs Node.js 22.13 or later (tested on 24.3 with `ai@7.0.66`); the broader peer range is not a claim that every version was tested. Do not assume nested subagent tools support the same approval API. Upgrade alongside server SDK 2.1 and finish old pending operations on their original version, because approval keys now bind the full action.

## Install

```bash
npm i @pushary/ai-sdk ai zod
```

Set `PUSHARY_API_KEY` (get it in your [dashboard](https://pushary.com/onboarding/partner)).

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
  prompt: 'Ask the customer which order they need help with.',
})
```

The agent gets an `askHuman` tool. When it calls it, the person gets a push notification and approves, declines, picks an option, or types an answer from their phone. The tool blocks until they reply, then hands the model an unambiguous result.

## Behavior that matters

- **Fail-closed.** A declined, expired, or unanswered `confirm` is reported to the model as "not approved, do not proceed." Approval only happens on an explicit yes.
- **Bounded wait.** Each ask blocks up to 55 seconds by default (`timeoutMs`). A later answer does not restart that completed request. For delayed answers, use the saved-message recipe below or your existing durable workflow.
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

## Delayed customer answers

The [SQLite reference recipe](examples/DELAYED-REVIEWS.md) saves AI SDK's native approval messages before asking the customer, reads the authoritative answer later, and resumes only the saved call. It includes atomic worker claims, exact customer/action binding, durable outputs and uncertain-execution recovery. No hosted scheduler is required.

Run `npm run test:restart` with Node.js 22.13 or later (tested on 24.3) to check fresh-process recovery, duplicate workers and crash handling using a simulated API. Examples are included in the npm package. The delayed recipe requires AI SDK 7; confirm/select/input in the existing ask tool remain request-time interactions.

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
