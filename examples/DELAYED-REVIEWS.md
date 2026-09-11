# A customer answers after the process exits

This reference uses AI SDK 7's native approval messages, the shared Pushary server SDK, and an application-owned SQLite database. It introduces no hosted worker or scheduler. The existing `pusharyApproval` helper remains useful for short request-time waits; this recipe persists before asking and resumes later.

From this package's source directory, using Node.js 22.13 or later (tested on 24.3):

```bash
npm install
npm run build
npm run test:restart
```

The same examples ship in the npm artifact. After installing the package and its peers, run `node node_modules/@pushary/ai-sdk/examples/delayed-review.mjs`.

The test uses the real framework and fresh Node processes, a scripted model, simulated HTTP responses, and SQLite receipts. It never sends a notification or contacts a model. It checks approval, denial, expiry, concurrent workers, duplicate delivery, wrong customer, tampered decisions, changed snapshots, a process exit after the simulated action, preservation of subsequent approvals, and output retention when both finalization writes fail. SQLite is experimental in the tested Node.js 24.3 runtime. The reference is tested against `ai@7.0.66`; the package's basic ask tool has a broader peer range.

## Adapt the three files

- `delayed-review.mjs` contains the native pause and resume calls. AI SDK returns a `tool-approval-request`; save the input messages plus `result.response.messages`. Later, add the verified `tool-approval-response` and call `generateText` again with the same tools and policies. Both initial and resumed calls require user approval for new refund calls.
- `delayed-review-store.mjs` contains the application review record and authoritative decision reconciliation. Keep the customer ID server-bound. The immutable binding includes operation, code/framework version, exact tool call and arguments, and a hash of the saved framework state. Changing those values requires a new operation and review. The bounded refund schema supplies structured order, EUR amount and draft-version fields for the phone; context carries only the immutable binding fingerprint. Adapt this trusted presentation and input schema together for your business action.
- `delayed-simulation.mjs` is the test harness, not the production HTTP client. Replace its simulated transport/model/effect with your application wiring. The review code already calls the shared authenticated SDK; never install the harness's global `fetch` replacement in production.

Connect the customer once with the package's `enroll` helper and a real Partner credential. The reference requests `requireReachable: true`. Persist the paused state **before** `openReview`; its deterministic create key closes the create-to-save retry window. Use an opaque operation ID unique to this saved pause, and reuse it for retries. Never start the model again merely because the process restarted.

Your existing job system periodically calls `reconcileReview` with the authenticated customer's identity and original code version. It reads the decision from Pushary through the server credential. A pending answer leaves the native state untouched; only a verified `confirm` answer of `yes` permits execution. Denial, expiry and cancellation become a native rejection. This reference covers protected confirmations; choice/text questions remain data, and the existing request-time ask tool does not gain delayed behavior from this example.

A signed callback can wake the same reconciliation job, but is not required. If added, verify its raw body with the shared SDK, durably enqueue receipt before acknowledging it, and still read the authoritative decision. Keep periodic reconciliation because callbacks have bounded retries. Do not accept an unverified callback's answer or a customer ID supplied by the model.

## Claims, output, and recovery

An atomic SQL update lets one worker claim an operation. Other workers return `busy`, or the already stored output once complete. The completion update stores output and state together. The saved output includes messages and new approval requests: hand those to your application and open a new, distinct operation for the next pause. This bounded starter processes one pending protected call per operation; extend the schema and serialize the whole run before supporting parallel pending tools. All resumers for that run must use the same database/coordination boundary. This store locks an operation, not an arbitrary framework run: never assign different operation IDs to the same saved run/pause. There must be exactly one outstanding protected call and operation for that snapshot; create the next operation only from the previous completed continuation's new pause.

If resumption throws, the record becomes `uncertain`. If finalization fails, the return value retains any generated output and reports the persistence failure; store that diagnostic through your application's recovery channel. A process crash after claiming leaves `resuming`. Neither state is reset by an elapsed timeout. Inspect the framework snapshot and business execution receipt before manually settling or replacing the operation. Never rerun an uncertain side effect automatically.

The simulated effect uses an operation-keyed receipt and validates exact arguments. A real refund must also validate the current business revision inside its conditional database write and use the payment provider's idempotency key. A completed review means the framework continuation was saved; inspect the tool result for business success. SQLite suits workers sharing the same database file; use your existing transactional database across distributed hosts. Protect saved messages as customer data and keep credentials out of snapshots. Drain old operations with their original framework and application versions before upgrading serialized formats.

Official API references: [AI SDK tool approval messages](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling) and [AI SDK 7 approvals](https://vercel.com/blog/ai-sdk-7). No physical phone delivery is claimed by this simulation.

`node:sqlite` is available without its experimental flag from [Node.js 22.13](https://nodejs.org/api/sqlite.html). The recipe does not change the runtime requirements of the installed framework.
