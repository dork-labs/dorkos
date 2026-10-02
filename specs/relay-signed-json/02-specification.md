# Preserve signed Relay JSON through the full app (DOR-2661)

**Status:** Implemented with real RED/green and mutation proof; independent stable-source preflight approved. Parent affected verification and exact-pushed-head delivery review remain pending.
**Identifier:** 261001-213235
**Preparation base:** `27aa09a0b597c6e5429cb2ca39bdccab064e22b3`
**Execution base:** `e3210be2cb14c823696a213f4df0ab21fa8acdd8`

## Original bug and preparation source trace

`createApp` in `apps/server/src/app.ts` mounts `express.json({ limit: '1mb' })` before the session gate. `index.ts` later mounts `createRelayRouter` at `/api/relay`. Its real receiver in `routes/relay-adapters.ts` uses `express.raw({ type: '*/*' })`, then passes `req.body as Buffer` to `WebhookAdapter.handleInbound`. For application/json, the global parser has already consumed the stream and substituted an object. A TypeScript cast restores neither the bytes nor the Buffer.

The adapter signs/verifies UTF-8 text as `timestamp + '.' + body`, checks nonce presence, timestamp, replay and HMAC before JSON parsing, registers a verified nonce, then publishes the parsed data. The existing route test mocks `handleInbound`, so it cannot detect byte loss. A route-only Express fixture also omits the global parser seam.

## Bounded implementation proposal

Add parser-only middleware for the exact POST path `/api/relay/webhooks/:adapterId` in `createApp`, before global JSON parsing but after existing admission, CORS, host guard and Better Auth mounts:

```ts
app.post('/api/relay/webhooks/:adapterId', express.raw({ type: '*/*', limit: '1mb' }));
```

It consumes the body and calls next; it must not look up an app connection, verify a signature, publish, or answer acceptance. The existing downstream session gate and real receiver remain in place. Set the receiver's own raw parser ceiling explicitly to `1mb` as well, so standalone receiver composition does not retain raw's default 100kb ceiling.

The change is restricted to POST and this path. Ordinary JSON routes keep the existing global parser. No handler moves ahead of authorization. No login exemption is added. Feedback and signed connection-event ingress retain their existing parsing and mount order. Current raw-parser inflation behavior is preserved; compressed-wire signing and non-UTF-8 signature redesign are outside scope.

## Required red regression, first executable task

Before editing production source, build a new full-app test that composes real `createApp({ admission })`, real `createRelayRouter` and receiver, then real `finalizeApp` in the production order. Use an actual started `WebhookAdapter` with a valid webhook-owned subject, actual registry lookup and real Node HMAC. A capturing fake publisher may stand in for downstream delivery; it must not replace the adapter's inbound processing or verification.

Send an explicit UTF-8 Buffer containing whitespace, a newline and Unicode (for example accented text and an emoji), Content-Type application/json, a fresh timestamp and nonce, and a signature generated over exactly those bytes. Assert 200 and exactly one publication with the expected parsed payload, subject, sender and nonce. Do not sign a reserialized copy. Never mock `handleInbound`, `verifySignature`, the receiver or the global parser. A call-through observer may establish Buffer type/byte equality without substituting implementation.

Run this regression against the unchanged base and read the collected failure. Missing dependency builds, test collection failures and wrong test paths do not qualify as red evidence. Existing tests and positive controls must collect. Only then implement the bounded parser fix and rerun it green.

## Acceptance matrix

These are the repaired-path outcomes. On the unchanged full app, malformed application/json is rejected by the global JSON parser before sessionGate or the receiver: finalizeApp returns 500 `INTERNAL_ERROR`, the adapter is not called, and no nonce is consumed. The repair intentionally restores the receiver's HMAC-before-JSON behavior for that signed path. Ordinary JSON routes keep their current parser behavior.

| Case                                                 | Required outcome and counted evidence                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Valid whitespace/Unicode JSON                        | 200; one real adapter publication, exact expected payload and metadata                                   |
| Wrong HMAC with fresh nonce                          | 401 `Invalid signature`; zero publications                                                               |
| Body modified after signing                          | 401 `Invalid signature`; zero publications, including whitespace-only byte change                        |
| Replay of accepted timestamp/body/nonce              | First 200, then 401 replay; exactly one publication total                                                |
| Malformed JSON with valid HMAC                       | Restored adapter semantics: 401 `Publish failed`; verified nonce consumed, zero publications             |
| Same malformed bytes with invalid HMAC               | 401 `Invalid signature`, proving HMAC precedes JSON interpretation                                       |
| Valid signed JSON larger than 100kb but below 1mb    | 200 and one publication; no accidental raw-parser default ceiling                                        |
| Signed body larger than 1mb                          | 413 `REQUEST_TOO_LARGE`; zero adapter processing/publications                                            |
| Ordinary JSON POST                                   | Existing route receives a parsed object and responds normally; does not receive a Buffer                 |
| Ordinary malformed JSON                              | Preserve current finalized-app error behavior (currently 500 `INTERNAL_ERROR`), not a new error contract |
| Ordinary body larger than 1mb                        | Existing 413 `REQUEST_TOO_LARGE` remains                                                                 |
| Login enabled, valid signature but no app credential | 401 `AUTH_REQUIRED`; zero adapter processing/publications                                                |
| Login disabled, valid signature                      | Successful positive control proves gate fixture does not reject all requests                             |
| Host guard refuses raw hostile Host                  | Existing 403/code; zero adapter processing/publications                                                  |
| Untrusted browser Origin                             | Existing CORS refusal; zero adapter processing/publications                                              |
| Closed MainRequestAdmission                          | 503 `SERVER_STOPPING`; zero adapter processing/publications                                              |
| Parser-only scope                                    | Neighboring Relay JSON routes and non-POST path retain ordinary parsing/routing                          |

Negative cases need exact counts and a known successful counterpart. Count handler/publication attempts at the appropriate seam rather than asserting that an unobserved array remains empty. Do not mock security middleware. Test auth against the real session gate with isolated config and, where needed, the repository's local Better Auth fixture. Do not assume every rejection uses the same status: CORS currently follows the finalized app error handler.

## Verification and cleanup

Use throwaway test data, OS-assigned listeners, existing listening-server helpers and fake downstream delivery. Never run inference or touch operator accounts/ports/data. Stop every started adapter in finally/afterEach to clear its nonce-pruning timer; close owned listeners, dispose stores/auth fixtures and restore environment/config state. No broad process kills.

Required verification: targeted new full-app regression; existing Relay route tests; real webhook-adapter tests; meaningful auth/middleware controls; server package typecheck/lint; relay package checks if its implementation is changed. Record exact command, exit status and collection/pass/fail counts. Run the original red regression green after the fix. Independent adversarial review precedes delivery.

## Scope boundaries and known ambiguities

No DOR-2660 namespace changes, DOR-2664 authority documentation, DOR-2666 delivery receipts, Doc Channel or browser work. Choose a valid webhook-owned fixture subject compatible with DOR-2660 when it merges; do not weaken ownership guards for a fixture.

On the unchanged full app, malformed application/json (with either a valid or invalid signature) is rejected by the global JSON parser before sessionGate and the receiver. finalizeApp returns 500 `INTERNAL_ERROR`; the adapter is not called and the nonce is not consumed. The existing direct-adapter or non-JSON raw-receiver path instead verifies HMAC first, consumes a verified nonce, and then returns 401 `Publish failed` for malformed JSON. The repaired signed application/json path intentionally restores those receiver semantics: valid HMAC reaches JSON parsing and consumes the nonce, while invalid HMAC returns 401 `Invalid signature` without parsing or nonce consumption. Ordinary malformed JSON routes retain their current 500 response; do not broaden the app error handler. Oversized requests may be refused by the parser before the downstream session gate, exactly as the current global parser does; the authorization requirement applies to in-limit signed requests. Empty-body/non-Buffer handling must be observed during implementation: only add a narrowly justified receiver check if needed to avoid a new parser-path defect, and report any required contract change before expanding scope. Runtime results are pending, not inferred from this source audit.

## Observed receiver edge contract

The real red fixture observed a request with no Content-Type reaching the receiver with undefined body and returning finalized 500 from the Buffer cast/toString assumption. The bounded guard now returns 400 `Send a request body with a content type.` before calling the adapter. A typed empty body remains an empty Buffer and follows real HMAC/JSON handling (valid signature: 401 `Publish failed`); an untyped absent body returns 400. This is the evidenced defensive check anticipated by the scope, without changing signature semantics.
