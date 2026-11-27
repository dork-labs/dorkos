# API Reference

## Interactive Docs

Start the server and visit:

- **Scalar UI**: [http://localhost:6242/api/docs](http://localhost:6242/api/docs) - interactive API explorer
- **Raw spec**: [http://localhost:6242/api/openapi.json](http://localhost:6242/api/openapi.json) - OpenAPI 3.1 JSON

## How Schemas Work

Request/response types are defined as **Zod schemas** in `packages/shared/src/`. Three schema files cover different domains:

- `schemas.ts` — Sessions, commands, health, pulse, models, capabilities
- `relay-schemas.ts` — Relay envelopes, adapters, bindings, catalog
- `mesh-schemas.ts` — Agent manifests, discovery, topology, access control
- `marketplace-schemas.ts` — Marketplace sources, package entries, install/uninstall/update requests

Each schema serves three roles:

1. **TypeScript types** — via `z.infer<typeof Schema>` (compile-time)
2. **Runtime validation** — via `schema.safeParse(data)` in route handlers
3. **OpenAPI spec** — auto-generated via `@asteasolutions/zod-to-openapi` in `services/core/openapi-registry.ts`

Types in `packages/shared/src/types.ts` re-export from `schemas.ts`, so existing `import { Session } from '@dorkos/shared/types'` imports continue to work.

## Adding a New Endpoint

An endpoint is a capability (ADR `261123-170830`): one `defineCapability` with an `http` surface is the route, its OpenAPI entry, its MCP tool and its `dorkos call` id. The generic mount (`apps/server/src/routes/capability-http.ts`) serves the path, and `POST /api/capabilities/{id}/invoke` reaches it too. Both run one dispatcher (`apps/server/src/routes/capability-dispatch.ts`), so the permission check, the audit record, the approval and the statuses are the same on every door. Do not add a hand route or a hand `registerPath` for a new endpoint.

1. **Define the input and output** as Zod schemas, in the domain file or in `packages/shared/src/` when the client reads them too. The input is one `z.object(...)`: path segments, query fields and body fields all land in it.
2. **Declare the capability** in its domain (see [How to add a capability](agent-operator-surface.md#how-to-add-a-capability)) with an `http` surface:

```typescript
surfaces: {
  http: {
    method: 'post',
    path: '/api/agents/{agentId}/pause', // each {segment} fills the input field of its name
    // params: { id: 'agentId' },        // only when a segment's name differs from its field
    // query: ['dryRun'],                // a write's fields that come from the query string
    // success: 201,                     // 200 unless declared; 204 sends no body
    // audience: 'person',               // only a person may call it; an agent gets 403 person_only
    // stability: 'stable',              // promise it to outside callers; preview unless declared (see Stability)
  },
},
```

A `get` or `delete` reads every other field from the query string; a `post`, `put` or `patch` reads them from the JSON body. The path segments always win over a body field of the same name.

3. **Refuse with a code.** A handler that refuses throws `CapabilityToolError({ error, code })`. The status comes from the code in one place (`toolErrorStatus`): `NOT_FOUND` or `…_NOT_FOUND` is 404, a "not you" code (`CANNOT_RESUME_SELF`, `NOT_YOURS`, `OPERATOR_ONLY`) is 403, `NOT_READY` is 503, anything else 400. Never map statuses in a route.
4. **Test it.** A unit test on the handler (the happy path and each refusal), and a route test through the mount for anything HTTP-specific (see `apps/server/src/routes/__tests__/capability-http.test.ts`). Then run `pnpm --filter @dorkos/server census:update`: the route census and its "serves every path a capability declares" check read the new route.
5. **Regenerate the published docs** with BOTH commands below, and commit the result.

**A route only a person may call** (a person-only route) is still a capability: set `audience: 'person'` on its `http` surface. `registry.invoke` refuses it (`PERSON_ONLY`, a `403 person_only` over HTTP) before the gate or the handler runs, unless the call carries proof of a person, whatever door it came through: its own path, the invoke endpoint, or `request_permission`, which also never names a person-only action. Only the HTTP dispatcher mints that proof (`personCaller`), with the same bar as the hand person-only routes: no `X-DorkOS-Agent`, no approval token, no `Authorization` header, and a browser session wherever a person must prove one. Such a capability may not declare an `mcp` surface (every MCP caller is an agent, so composing the registry throws), and the catalog shows `audience: 'person'` on its entry.

Guards keep the mount honest. The mount is registered before every hand route group, and registers its own routes static before param (`GET /api/sessions/running` before any `/:id`). Building the app throws (`assertNoCapabilityRouteCollisions`) when a hand route claims a capability's method and path, when a hand route registered earlier would answer any of its requests, when a capability would answer requests a more specific hand route is meant for, when hand middleware registered after the mount covers a capability path (it would never run: fold its check into the capability, or, when it could never act on that path, list it with the reason in `SKIPPABLE_MIDDLEWARE`), or when two capabilities declare the same path. And `HAND_SERVED_CAPABILITIES` in `capability-http.ts` lists the capabilities whose path an older hand route still serves: it only shrinks, as each hand route is deleted.

### Moving a hand route onto a capability

Every served `/api` route is one of three things, checked by `apps/server/src/http/__tests__/hand-route-census.test.ts` against the route census: a capability the mount serves, a route on the permanent allowlist (`apps/server/src/http/hand-routes/allowlist.ts`), or a route on the pending list (`apps/server/src/http/hand-routes/pending.json`). The pending list may only shrink; a new route never joins it.

To move one:

1. Declare (or reuse) the capability with an `http` surface on the same method and path, as above. Paths stay as they are; renaming a path is a separate change.
2. Delete the hand route, its hand `registerPath`, and its entry in `HAND_SERVED_CAPABILITIES` if it has one. Fold any group middleware the path relied on into the capability: building the app refuses middleware the mount would skip.
3. Fix every caller of anything that changed (the response body, a status). No alias, no deprecation: the old shape is removed.
4. Run `pnpm --filter @dorkos/server census:update`, then `UPDATE_HAND_ROUTE_PENDING=1 pnpm vitest run apps/server/src/http/__tests__/hand-route-census.test.ts`, which only removes entries, and lower `PENDING_CEILING` in that test to the new count.
5. Regenerate the docs (below) and `pnpm check:api-lint -- --update`.

**When a route belongs on the allowlist instead.** Only for a shape a capability cannot express, in one of eight categories: `stream` (SSE), `bytes` (an upload or a file's raw bytes), `callback` (an OAuth redirect or a webhook another site calls), `sign-in-handshake` (a step that sets a session cookie), `html-page` (a page and the files it loads), `health-docs` (health checks and the API's own document), `invoke` (`POST /api/capabilities/{id}/invoke`) and `network-reachable` (a write the app makes from Wi-Fi on purpose, held by hand until the mount can tell an API key from a person; Security's call, DOR-5267). Each entry carries its category and a one-line reason. Apart from `network-reachable`, a JSON read or write is never one of these, however person-only or awkward it is.

An allowlisted route keeps its hand route and a hand `registerPath` in `services/core/openapi-registry.ts`; validate the body with `Schema.safeParse(readJsonBody(c))` and answer `validationProblem(c, error)` (a 400 problem). Every failure is a problem document; see [Errors](#errors).

## Operation ids

Every operation in the document has an `operationId`. It is the name a generated client calls the operation by, so **changing one is an API change**, even when the path stays put. The docs site still files its pages by path and method (`name: { algorithm: 'v1' }` in `apps/site/scripts/generate-api-docs.ts`), so an id change moves no page URL.

- **A capability-projected path** uses its capability id (`audit.get`). The REST path and `POST /api/capabilities/:id/invoke` are two documented doors onto one capability definition, so they share its name. Capability ids keep their own style: snake_case words, and sometimes a group other than the path's (`audit.running_chats` on `GET /api/sessions/running`).
- **A hand-set id wins.** Pass `operationId` to `registerPath` and the generator keeps it.
- **Every other operation gets a derived id**, `${group}.${verb}${Resource}`, from its method, the document's paths and the operation's query parameters, never from a response schema, so adding a field to a body renames nothing. The rule and a table of examples are in the module doc of `services/core/openapi/operation-ids.ts`. In short: a last segment that is a command word is the verb (`POST /api/notifications/read-all` is `notifications.readAll`), and so is a hyphenated last segment led by one on any method but `GET` (`POST /api/auth/revoke-session` is `auth.revokeSession`); a `GET` is `list` on a collection path, one the document also has with a `{param}` added (`GET /api/sessions` beside `/api/sessions/{id}` is `sessions.list`), and also when it pages, declaring a `limit` or `cursor` query parameter (`GET /api/rooms/{id}/entries` is `rooms.listEntries`); every list pages by cursor, so every list ends up `list`. Otherwise a `GET` is `get` (`sessions.get`, `health.getDeep`); `POST`, `PUT`/`PATCH` and `DELETE` are `create`, `update` and `delete` (`sessions.createMessages`).

**Every id is pinned.** `services/core/openapi/__tests__/operation-ids.snapshot.json` maps every `METHOD path` to its id, and `operation-ids-snapshot.test.ts` beside it fails with a line diff when any id changes, appears or goes. A new route changes it too, so commit the snapshot with the route. To accept a change on purpose:

```bash
pnpm vitest run apps/server/src/services/core/openapi/__tests__/operation-ids-snapshot.test.ts -u
```

Read the diff before you commit it: a changed line on an existing operation is an API change. The rule can rename an operation you never touched: adding `/api/x/{id}` turns `GET /api/x` from `x.get` into `x.list`, and adding a `limit` or `cursor` query parameter to a `GET` does the same. Unless that rename is what you want, do not run `-u`. Pin the old id instead: add `operationId: 'x.get'` (the id the snapshot shows on its old line) to that operation's `registerPath` call, and the snapshot passes unchanged.

**Collisions.** `assignOperationIds` throws while the document is generated when two operations' ids match once lowercased with underscores removed (`x.foo_bar` and `x.fooBar`), derived or hand-set, naming both paths, so `pnpm docs:export-api` and every test that generates the document fail. Fix it with a hand-set `operationId` on one of the two `registerPath` calls. `services/core/__tests__/export-openapi.test.ts` checks that every operation has an id and that no two are byte-identical; `services/core/openapi/__tests__/operation-ids.test.ts` checks the throw.

## Security on operations

The document declares two schemes, `sessionCookie` and `apiKey`, and a default of either one. Each operation that differs carries its own `security`, worked out by `services/core/openapi/security-schemes.ts` from the code that enforces it:

- `security: []` for a path the session gate lets through with no credential (`isGateExemptPath` in `services/core/auth/gated-paths.ts`, which the gate itself calls): the health probe, the signed-token and ticket routes, a hub's link path, a computer's passkey return.
- `sessionCookie` only for the Better Auth endpoints under `/api/auth/`: the gate lets them through, and Better Auth reads the signed-in person from the cookie.
- `apiKey` only for the connector routes in `PROGRAM_KEY_ROUTES` (`services/connectors/principal/program-key-routes.ts`). The routers register those routes from that list, so a route added there is documented as key-only with no second edit.

A `registerPath` call that sets `security` keeps it. A local install with "Ask for a password on this computer too" off takes calls from this computer with no credential; the `info.description` and both scheme descriptions say so. `X-DorkOS-Agent` is an identity header, not a credential, so it is not a scheme; `docs/api/index.mdx` describes it. `services/core/openapi/__tests__/security-schemes.test.ts` asks the real session gate about every documented operation and fails when the document calls a path open that the gate guards, or the reverse.

## Stability

Every operation carries `x-stability`: `stable`, `preview` or `internal` (ADR `261123-170832`, DOR-4983).

| Value      | Means                                                                                                                                                               | Published                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `stable`   | Meant for outside callers: scripts, other programs, agents.                                                                                                         | Yes                                                             |
| `preview`  | New or still being reshaped: an area the roadmap is rebuilding, a list that just started paging, any capability route not yet promised.                             | Yes, its description opens with "**Preview.**"                  |
| `internal` | Only DorkOS's own app, command line or desktop app calls it: sign-in steps, settings pages, the app's plumbing, debug and test hooks. It can change without notice. | No: served, but left out of the published document and the site |

**No deprecation period.** Until the API is a stable v1.0, a breaking change lands at once with every caller in the repo fixed in the same change, and a changelog fragment that names what broke and what replaces it. There are no `deprecated` flags on operations, no `Deprecation` or `Sunset` headers and no aliases. `stable` means an operation changes only that way, never quietly.

**Where the value comes from**, first match wins (`services/core/openapi/stability.ts`):

1. The operation's own declaration: `stability` on a capability's `http` surface, or `'x-stability'` on a hand `registerPath` call (the session list's paging, the session routes only the app calls).
2. A capability with none is `internal` in a group marked internal, and `preview` everywhere else. A capability route is promised `stable` only by its own `stability: 'stable'`.
3. A hand route with none takes its route group's value in `GROUP_STABILITY`. A group missing from that table fails `pnpm docs:export-api`, so a new group is classified the day it is documented.

**The groups**, from `GROUP_STABILITY`:

| Value      | Route groups                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stable`   | `activity`, `agents`, `audit`, `capabilities`, `connectors`, `events`, `files`, `health`, `heartbeats`, `marketplace`, `mcp-servers`, `mesh`, `models`, `openapi.json`, `search`, `sessions`, `tasks`, `templates`, `todo-promises`, `todos`, `work-queues`, `workspaces`                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `preview`  | `canvas`, `cloud`, `community-connections`, `computers`, `diff`, `direct-chats`, `documents`, `hub`, `links`, `relay`, `rooms`, `shapes` (the DorkOS account, hubs and agent computers, team spaces, one message system and published docs are all being rebuilt)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `internal` | `admin`, `agent-instructions`, `approvals`, `auth`, `browser-viewers`, `commands`, `communities`, `config`, `debug`, `desktop`, `devices`, `directory`, `discovery`, `errors`, `extension-decisions`, `extension-frame`, `extensions`, `feedback`, `git`, `harness`, `keep-awake`, `lan-access`, `local-browser`, `mcp-config`, `notifications`, `onboarding`, `owner-factors`, `owner-sign-in`, `permissions`, `person-session`, `profile`, `projects`, `push`, `read-cursors`, `remote-access`, `runtimes`, `session-locations`, `session-relay`, `sign-in-landings`, `step-up`, `subagents`, `system`, `team`, `terminal`, `tunnel`, `uploads`, `wifi-sign-in`, `workbench`, `your-browser` |

`events`, `openapi.json` and most `internal` groups above are served but not documented yet (the lint gate's `undocumented-route`); they are classified already, so each takes its value the day its routes are documented.

**Two files.** `pnpm docs:export-api` splits the document (`services/core/openapi/published-document.ts`):

- `docs/api/openapi.json` is the published document: every operation that is not `internal`, and every component except those only `internal` operations use. The site's API pages, `/api/openapi.json` and `/api/docs` all show it.
- `docs/api/openapi-internal.json` holds the `internal` operations and the components only they use. It has no `info`, so a release never touches it. The generated client (`packages/api-client`) and the API lint gate read it merged into the published one (`packages/api-client/scripts/api-document.ts`): the app calls internal operations, and every operation is held to the same lint rules. `openapi-fresh` compares both.

The document's `info.version` is the product version: the running server's version at `/api/openapi.json`, and the repo `VERSION` in the committed `docs/api/openapi.json`. A release bumps `VERSION`, so the release PR regenerates the docs too (`.claude/commands/system/release.md`, Phase 6).

**The census.** `services/core/openapi/__tests__/stability-census.test.ts` fails when an operation has no `x-stability` or an unknown one, when the committed published document holds an `internal` operation or the internal part a published one, and when the published document's `info.version` differs from `VERSION`.

## Errors

Every failed request on the API is answered with one shape: an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem document, served as `application/problem+json` (ADR `261123-170831`, DOR-4979).

```json
{
  "type": "urn:dorkos:problem:invalid_request",
  "title": "The request didn’t pass its checks.",
  "status": 400,
  "code": "invalid_request",
  "detail": "`cwd`: Required.",
  "issues": { "formErrors": [], "fieldErrors": { "cwd": ["Required"] } }
}
```

| Field          | What it is                                                                          |
| -------------- | ----------------------------------------------------------------------------------- |
| `code`         | The machine-readable kind, `lower_snake`. Branch on this. Permanent once published. |
| `title`        | The code's short summary, the same for every occurrence. Safe to show a person.     |
| `detail`       | This occurrence, in words. Safe to show a person. Optional.                         |
| `status`       | The HTTP status, repeated.                                                          |
| `type`         | `urn:dorkos:problem:<code>`.                                                        |
| `issues`       | A validation failure only: Zod's flattened form (`formErrors`, `fieldErrors`).      |
| `retryAfterMs` | A transient failure only: how long to wait. Also sent as `Retry-After`.             |
| `instance`     | Optional: an id for this occurrence, to quote in a report.                          |

**The code list** is `PROBLEM_CODE_LIST`, exported from `packages/shared/src/problem.ts` (import it as `@dorkos/shared/problem`), each code with its default status and title. A code that is not on the list cannot be sent. The codes themselves live in `packages/shared/src/problem-codes/`, one file per group (general, chats and apps, workspace and access, spaces and computers). Add one at the end of the group it belongs to (lower_snake, small and meaningful, never a rename) before you use it; the order there is the order of the `ProblemCode` enum in the API document. The OpenAPI document carries the `Problem` schema, `ProblemCode`, and the answers the chain gives every route (`components.responses`: `ValidationProblem`, `MalformedRequestProblem`, `NotFoundProblem`, `RequestTooLargeProblem`, `InternalErrorProblem`).

**Sending one** (`@dorkos/http-kit`):

```typescript
import { problem, validationProblem } from '@dorkos/http-kit';

if (!agent) return problem(c, 'not_found', { detail: 'No agent is registered at that path.' });

const parsed = Schema.safeParse(readJsonBody(c));
if (!parsed.success) return validationProblem(c, parsed.error); // 400 invalid_request + detail + issues
```

`validationProblem` writes `detail` from the first failing field ("`name`: Required.", plus "(and N more)"); pass `detail` when the route can say what to send in plainer words. Two 400 codes, two meanings: `invalid_request` is a body that was read and failed its checks; `malformed_request` is a body that could not be read at all (the chain sends it). `problem()` takes the status and title from the list; pass `status` only when this occurrence needs a different one, and `retryAfterMs` for a transient failure. `detail` is for a person: write it with the `writing-for-humans` skill, and never put a path, a stack or a secret in it.

**Extra fields** a client acts on (the id of a held action, the packages that conflict, when a window ends) ride as RFC 9457 extension members: `problem(c, 'conflict', { detail, extensions: { conflicts } })`, named in camelCase. An extension member never replaces a standard one. **One code per refusal, and no second one:** a problem names what went wrong in `code` alone, never in a `reason` or any other member. A refusal a client branches on gets a code on `PROBLEM_CODE_LIST` (`precondition_failed` when what the caller was shown changed, `already_resolved`, `not_running`, `no_agent`, …); one no client branches on keeps the generic code (`conflict`, `invalid_request`, `forbidden`) and says which in `detail`. Same meaning, same code: a caller that is not a person is always `person_only`, one not at this computer is always `operator_only`, and a NUL byte in a path is always `400 invalid_request`. A call from one app to another's routes (`/api/ext/<id>/…`) that is refused answers `403 forbidden` with the rule in `detail`, and `403 caller_token_invalid` for a token the server forgot (ask for a new one). It was `{ code: 'app_call_refused', reason: 'not-declared' }`. The SDK's own `AppCallRefusal` words, decided in the frame before any request, keep their kebab-case spelling.

**What the chain answers for you.** An error a route throws reaches the error handler (`middleware/error-handler.ts`): a body over the limit is `413 request_too_large`, broken JSON `400 malformed_request`, a body in an encoding or charset the parser cannot read `415 unsupported_media_type`, a path outside the boundary `403 outside_boundary`, a path with a NUL byte `400 invalid_request`, and anything else `500 internal_error`. Every `detail` the chain writes is a fixed sentence: an exception's message or stack never goes on the wire, in any environment (it is logged instead). The upload refusals follow the same rule. A path no route claims under `/api` is `404 not_found`; a route that must look like such a path answers `apiNotFound(c)` (`http/unclaimed.ts`). A multipart upload the parser refused is `uploadRefusalProblem(c, err)` (`http/problems/upload-refusal.ts`).

**Reading one.** Every client reads failures through `readErrorBody` in `@dorkos/shared/problem` (the web client through `shared/lib/response-error`, the CLI through `ApiError`, the desktop shell directly): `detail`, else `title`, as the message; `code` as the kind. It reads nothing else from a body that is not a problem document, except the deliberate exceptions below that the app still receives (the login gate and the two `428`s). A surface that shows the server's own sentence in place of its own copy (`serverSentence`) takes `detail` only, never the generic `title`.

**Never** `c.json({ error: '…' }, 4xx)`, `c.json({ error, details: z.flattenError(…) })` or a hand-built `{ error, code }` body. The old shape is gone from every route and every reader (DOR-4979), with no compatibility window. The lint rule `problem-only/no-error-body` (`apps/server/eslint-rules/problem-only.js`) refuses, in `routes/`, `http/` and `middleware/`, a `.json(…)` call whose argument is an object literal with an `error` member, or a module-level `const` holding one; a body that keeps another shape on purpose carries a scoped `eslint-disable-next-line` with its reason. It does not see a conditional argument (`c.json(ok ? a : { error })`), a body built elsewhere and imported, `c.body(JSON.stringify(…))` or `new Response(…)`: review those by hand.

**The deliberate exceptions.** These answer another shape on purpose, and stay that way:

- The login gate's `401` `{ error: 'Unauthorized', code: 'AUTH_REQUIRED', signInWith? }` (the `AuthRequired` schema): every client reads its `code` to show the sign-in screen.
- The `428` "confirm first" answers: `StepUpRequired` on every held write, `PasskeyCheckRequired` on the passkey-checked device writes, and an agent's raise card (`agent_raise_card`). They hold an action for a person; they are not refusals.
- MCP's JSON-RPC errors and the OAuth bodies (`/mcp`, the connector MCP listener, the stand-in OAuth server for tests).
- Better Auth's own `{ code, message }` on `/api/auth/*`, which DorkOS does not write (DorkOS's own refusals in front of it, such as the sign-in rate limit and the front-door bar, are problems).
- `200` answers that carry `{ ok: false }` by design: a result, not an error.
- The space server and everything under `services/spaces`, `apps/space` and `community-wire*` (frozen: ADR `261018-124422`). The app's space pages read that wire in `apps/client/src/space`. The app's own space routes are not part of it: while the spaces experiment is off, the gate in front of them (`middleware/spaces-enabled.ts`) answers `404 spaces_disabled`.
- Refusals written to a raw socket (managed and own-tunnel ingress), the credits relay's model-API error format, and the `linear-issues` core extension's own routes.
- The video proxy (`/api/extensions/media/{ticket}`) answers `415`, `416` and `502` with no body: a `<video>` element reads nothing from it.
- An SSE stream's in-band `event: error` (discovery), which is a stream event, not a response.
- Until 0.143 (DOR-5089), the `409` `{ error, code: 'extension-risk', stale }` a step-up page from before 0.141.0 reads.
- Internal values that never reach a client: the approvals commit's `409 different-request`, and the `{ error, code }` refusal objects services hand their route, which turns them into problems.

### Codes that changed: Relay and connected apps

Relay (`/api/relay/*`: messages, mailboxes, chat connections, chat routes, delivery status, the webhook receiver) and connected apps (`/api/connectors/*`, the signed event receiver included) moved to problem documents together (DOR-4979). No `detail` carries an error's own text, an id, an address or a field value any more: the cause is in the server log. For a script written against the old answers:

- **New codes:** `RESERVED_SENDER` → `reserved_sender`, `RESERVED_SUBJECT` (and a mailbox in a namespace DorkOS manages, which now carries `reservedPrefixes`) → `reserved_subject`, `ROOM_SESSION` → `room_conversation`, `BROADCAST_NOT_BRIDGEABLE` → `broadcast_not_bridgeable`, `BRIDGE_NOT_A_DM` → `chat_type_unknown`, a paused chat route's test → `chat_route_paused`, `INVALID_SIGNATURE` and `INVALID_EVENT_SIGNATURE` → `invalid_signature`, `DUPLICATE_ID` → `connection_id_taken`, `CHAT_ALREADY_BOUND` → `chat_already_bound` (still with `conflict`), `cloud_link_needs_update` → `cloud_link_required` (now 401), `provider_not_found` and `authentication_unavailable` → `app_not_set_up` (404), `writes_back_unsupported_app`, `operations_unsupported` and `every_agent_unavailable` → `app_not_supported` (422), `connection_cleanup_pending` → `account_cleanup_pending`, `connection_not_disconnected` → `still_connected`, `session_access_other_agent` → `other_agent_chat`, `session_access_off` → `app_off_in_chat`, `invalid_filter` → `invalid_filter` (now a problem code of its own), `request_open_elsewhere` keeps its name, `definition_changed` and `review_conflict` → `updates_changed` (412, was 409), `event_selection_unavailable` and `events_unavailable` → `updates_unavailable` (503). A new connection that was saved but couldn't start answers `502 connection_saved_not_started` (it was a 500 with the start error's text); trying the add again would meet `connection_id_taken`, so turn it on instead. `INVALID_CONFIG` answers `400 invalid_request` with `fields`, the manifest keys of the refused settings (a map entry is named by the field that holds it; never a value). `cloud_unavailable`, `cloud_refused`, `destination_unavailable` (now 409 everywhere) and `review_resolving` keep their names.
- **Folded into a shared code** (`detail` still says which):
  - `not_found` (404): `NOT_FOUND`, `connection_not_found`, `agent_not_found`, `agent_not_owned`, `flow_not_found`, `review_not_found`, `target_not_found`, `request_not_found`, `UNDO_NOT_FOUND`, `GRANT_NOT_FOUND`, `HOLD_NOT_FOUND`, `MINI_APP_ACCESS_NOT_FOUND`, `RELAY_RECEIPT_NOT_FOUND`, an unknown message, mailbox, trace, chat route or connection, and tracing being off. `session_not_found` keeps its own code.
  - `invalid_request` (400): `INVALID_CONFIG` (with `fields`), `UNKNOWN_TYPE`, `MULTI_INSTANCE_DENIED`, `REMOVE_BUILTIN_DENIED`, `INVALID_AMOUNT`, `INVALID_TOOLKIT`, `INVALID_RELAY_MESSAGE_ID`, `invalid_cursor`, `invalid_selection`, `invalid_event_request`, an unknown agent or connection named in a chat route, a bridge on a route for every chat, and a refused publish or mailbox registration (both were 422).
  - `precondition_failed` (412, was 409): `CONFIRMATION_STALE`, `LISTS_CHANGED`, `UNDO_STALE`, `preview_stale`.
  - `person_only` (403): `connector_owner_required`, `operator_cookie_required`. `owner_only` (403): `OWNER_ADDS_LIST_ID`. `origin_not_allowed` (403): `connector_owner_origin_required`.
  - `forbidden` (403): `HOLD_REQUESTER`, `CONNECTOR_PROGRAM_AGENT_IDENTITY_DENIED`, `marked_turn_typed_secret`, `marked_turn_moves_secret`, `EVENT_BINDING_REJECTED`, `principal_required`.
  - `unauthenticated` (401): `CONNECTOR_PROGRAM_CREDENTIAL_REQUIRED`, `connector_program_credential_required`, `credential_unavailable`, and an account owner DorkOS could not work out.
  - `expired` (410): `request_expired`, `review_expired`, `authority_expired`, `runtime_authority_expired`.
  - `already_resolved` (409): `request_already_resolved`. `rate_limited` (429): `request_rate_limited`, too many chat route tests. `conflict` (409): `idempotency_conflict`, `selection_invalid`, `action_failed`.
  - `temporarily_unavailable` (503): `RELAY_RECEIPT_RESPONSE_UNAVAILABLE` (still with `messageId` and `statusUrl`), `RELAY_RECEIPT_STORAGE_UNAVAILABLE` and the other receipt codes, `EVENTS_UNAVAILABLE`, `service_unavailable`, `agent_requests_unavailable`, `authority_sync_failed`, `managed_sync_unavailable`, `catalog_incomplete`, a chat route store that isn't ready, and a failed connected-apps start (`migration_failed`).
  - `upstream_unavailable` (502): `actions_unavailable`. `internal_error` (500): any other failure, which used to echo the error's message; a non-refusal failure to turn a connection off is now 500 (was 400).
  - `unsupported_media_type` (415), `request_too_large` (413) and `malformed_request` (400): the signed event receiver's `UNSUPPORTED_EVENT_ENCODING`, `EVENT_TOO_LARGE` and `INVALID_EVENT_REQUEST`.
- **The webhook receiver** (`POST /api/relay/webhooks/:id`) answers every refusal before a verified signature with the one flat `401 invalid_signature`: an unknown or stopped connection, one aimed at an address DorkOS keeps, a request with no content type (it was 400) and a bad signature all look the same. After the signature checks out, a body that isn't JSON is `400 malformed_request` (it was the flat 401), a connection that isn't running or a refused delivery is `503 temporarily_unavailable`, and a failed delivery is `500 internal_error`.
- **Kept as they were:** the `401` `AUTH_REQUIRED` body a delivery-status read or send gets before it is signed in (the same one the login gate sends), the `428` "Confirm it's you" body, and the capability gate's answers on `POST /api/connectors/executions` (moved with the capability doors).

### Codes that changed: sign-in, step-up and devices

The routes for confirming it's you, signed-in devices, sign-in checks, network and remote access, the sign-in landing page and the sign-in wrappers moved to problem documents together (DOR-4979). For a script written against the old answers:

- **Same meaning, new spelling:** `wrong-password` → `wrong_password`, `too-many-tries` → `too_many_tries`, `password-too-short` → `password_too_short`, `no-password` → `no_password`, `no-owner` → `no_owner`, `insecure-connection` → `insecure_connection`, `extension-risk` → `extension_risk`, `stale-sign-in` → `stale_sign_in`, `stale-page` → `stale_page`, `not-your-action` → `held_by_another_browser`, `PASSKEY_NEEDED` → `passkey_needed`, `PASSKEY_ON_OTHER_ADDRESS` → `passkey_on_other_address`, `PASSKEY_REFUSED` (a passkey check) → `passkey_refused`, `AUTH_REQUIRED_FOR_EXPOSURE` (network and remote access) → `auth_required_for_exposure`, `SIGN_IN_NEEDS_HTTPS` → `sign_in_needs_https`, `LAN_ACCESS_UNSUPPORTED` → `lan_access_unsupported`, `LAN_ACCESS_SET_BY_ENVIRONMENT` → `set_by_environment`, `SIGNIN_NO_RETRY` → `signin_no_retry`, `MANAGED_REMOTE_UNAVAILABLE` → `remote_access_unavailable`, `MANAGED_REMOTE_ALREADY_SET_UP` → `remote_access_already_set_up`, `MANAGED_REMOTE_NOT_SET_UP` → `remote_access_not_set_up`.
- **Folded into a shared code** (`detail` still says which):
  - `person_only` (403): `not-a-person`, `person_required`, `DEVICES_PEOPLE_ONLY`, `operator_cookie_required`, `operator_only_config`.
  - `operator_only` (403): `NEEDS_PERSON_AT_THIS_COMPUTER`, `REMOTE_SETUP_NEEDS_THIS_COMPUTER`, `API_KEY_NEEDS_THIS_COMPUTER`, `NOT_AT_THIS_COMPUTER`, `not-at-this-computer`.
  - `not_from_wifi` (403): `NOT_FROM_WIFI` from the network level, `WIFI_SIGN_IN_NEEDS_CODE`.
  - `origin_not_allowed` (403): `NOT_FROM_OWN_PAGE`, `PASSKEY_ORIGIN`. `owner_only` (403): `SIGN_IN_FIRST`.
  - `rate_limited` (429): `too-many-attempts` (now with `retryAfterMs`), `too-many-actions`, too many network sign-in requests or tries.
  - `invalid_request` (400): `new-password-invalid`, a missing password (was `wrong-password`), `INVALID_BODY`, `INVALID_MODE`, `NOT_BINDABLE`, `CODE_REFUSED`, `PASSKEY_REFUSED` when adding a passkey.
  - `not_found` (404): `DEVICE_NOT_FOUND`, `REQUEST_ENDED`, `NOT_FOUND`. `expired` (404): `SIGNIN_LANDING_GONE`.
  - `upstream_unavailable` (502): `MANAGED_REMOTE_SETUP_FAILED`, `SIGNIN_RETRY_FAILED`. `internal_error` (500): `STEP_UP_COMMIT_FAILED`, `SIGN_OUT_FAILED`.
  - `precondition_failed` (412, was 409): `different-request`, `BINDING_CHANGED`.
- **Kept as they were:** the `428` `StepUpRequired` and `PasskeyCheckRequired` bodies, and, until 0.143 (DOR-5089), the old `{ error, code: 'extension-risk', stale }` refusal a page from before 0.141.0 reads.

### Codes that changed: spaces, the DorkOS account, the tunnel, hubs and the agent computer

The space connections (`/api/community-connections/*`), the spaces they reach (`/api/communities/*`), the DorkOS account and its hosted spaces (`/api/cloud/*`), your own tunnel (`/api/tunnel/*`), hubs and their linked computers (`/api/hub/*`) and the agent computer (`/api/computers/*`) moved to problem documents together (DOR-4979). No `detail` carries a space's or a linked computer's own words, an error's message or an address: the cause is in the server log. A space server's own answers are unchanged (ADR 261018-124422); these routes read them and answer in their own words. For a script written against the old answers:

- **New codes:** `COMMUNITY_OWNER_CHANGED` → `owner_changed` (now 412), `PAIRING_BUSY` → `pairing_busy`, `COMMUNITY_RECONNECT_REQUIRED` → `reconnect_required`, `COMMUNITY_SELECTION_REQUIRED` → `space_choice_required`, `COMMUNITY_NAME_NOT_FOUND` → `space_name_not_found`, `COMMUNITY_UPGRADE_REQUIRED` → `space_server_outdated`, `COMMUNITY_DELETED` → `space_deleted`, `COMMUNITY_TAKEN_DOWN` → `space_taken_down`, `COMMUNITY_SUSPENDED` → `space_suspended`, `COMMUNITY_HELD` → `space_on_hold`, `COMMUNITY_READ_ONLY` → `space_read_only`, a closed space → `space_not_open`, `COMMUNITY_MUTED` → `space_muted`, `COMMUNITY_SLOW_MODE` → `space_slow_mode` (with `retryAfterMs`), `COMMUNITY_RULES_NOT_ACCEPTED` → `space_rules_not_accepted`, `COMMUNITY_LIMIT_REACHED` → `space_limit_reached` (409 always; was 429 from older space servers), `COMMUNITY_UNSUPPORTED` and a space with no direct messages (was 404) → `space_unsupported`, a taken name → `space_name_taken`, a message you can't report → `report_not_allowed`, a reply on a reply → `reply_on_top_level_only`, a second move while one waits → `move_pending`, an export sent without its size → `length_required` (411), `AGENT_NOT_TAKING_DMS` → `agent_not_taking_dms`, `HUB_LINKED_BY_CLOUD` → `hub_linked_by_cloud`, a runtime mid-reply → `runtime_busy`, credits switched off → `credits_off`, not linked → `cloud_not_linked`, a move export with no room → `disk_full` (with `neededBytes` and `freeBytes`) or `disk_space_unknown`, `AUTH_REQUIRED_FOR_EXPOSURE` → `auth_required_for_exposure`, "Tunnel is already running" → `tunnel_running` (still with `url`), no ngrok token → `tunnel_token_missing`, `TUNNEL_PORT_MISMATCH` → `tunnel_port_mismatch`, `computer_waking`, `computer_refused` and `needs_update` (still with `feature`) keep their names, `LINK_REFUSED` → `link_code_refused`, `ALREADY_LINKED` → `already_linked`, `LINK_LIMIT` → `computer_limit_reached`, a linked computer the hub can't reach → `computer_offline` (503) and one that didn't answer in time → `computer_timed_out` (504), both were the computer's own text, `NOT_ACCEPTABLE` → `not_acceptable`, and the agent computer's `unsupported`, `disabled`, `setup-failed`, `sign-in-required`, `control-lost` and `cleanup-uncertain` → `computer_unsupported`, `computer_disabled`, `computer_setup_failed`, `computer_sign_in_required`, `computer_control_lost` and `computer_cleanup_uncertain`.
- **Folded into a shared code** (`detail` still says which):
  - `precondition_failed` (412, was 409 or 410): `COMMUNITY_CURSOR_STALE`, `COMMUNITY_CONFLICT` for a space that moved on, rules that changed, `ANSWER_IN_CHANGED`, `ACCOUNT_LINK_CHANGED`, `TUNNEL_SETTINGS_CHANGED`.
  - `not_found` (404): `COMMUNITY_NOT_FOUND`, a connection, room, agent, delivery, direct message or billing page that isn't there.
  - `forbidden` (403): `COMMUNITY_ACCESS_DENIED`, `FORBIDDEN` on the hub link. `person_only` (403): `COMMUNITY_PERSON_REQUIRED`, `TUNNEL_STATUS_NOT_FOR_AGENTS`, `operator_only_config` and `operator_cookie_required` on these routes, `not-a-person`, and an agent on a hub. `owner_only`: `not-the-owner` and another account on the DorkOS account writes. `operator_only`: `NEEDS_PERSON_AT_THIS_COMPUTER` and a space connection from another device.
  - `invalid_request` (400): `COMMUNITY_REJECTED` (at the space's own 4xx status), `INVALID`, `invalid-client`, `invalid-input` and every body that failed its checks (now with `issues`). `malformed_request` (400): a hub link body that isn't JSON. `request_too_large` (413): `COMMUNITY_TOO_LARGE`, `TOO_LARGE`, an export larger than DorkOS moves (with `archiveBytes`, `limitBytes` and `mayExist`), and a request too large for the hub to relay. `unsupported_media_type` (415): `COMMUNITY_UNSUPPORTED_FILE`.
  - `rate_limited` (429): `COMMUNITY_RATE_LIMITED` (with `retryAfterMs`, was `retryAfterSeconds`), `TOO_MANY_ATTEMPTS`, a busy space, a hub with too many requests open to one computer.
  - `temporarily_unavailable` (503): `HUB_NOT_READY`, `HUB_NOT_SERVING`, an agent computer not ready or unavailable. `upstream_unavailable` (502): a space or the DorkOS account that can't be reached (was `{ error }` only), a linked computer's own failure, and an answer from it the hub couldn't read. `internal_error` (500): any other failure, which used to echo the error's message on `/api/tunnel/start` and `/api/tunnel/stop`.
- **Kept as they were:** the DorkOS account writes' `200` refusal envelopes (`{ ok: false, problem }` with the service's own problem, or `{ ok: false, message }`), which are answers, not errors, and the `428` "Confirm it's you" body.

### Codes that changed: the last route groups

Approvals, permissions, to-do promises, onboarding, the harness, feedback, push, admin, commands, models, docs links, the browser viewer, the system load gate and shell check, the address and remote-access checks, and the test-only routes moved to problem documents together (DOR-4979). No `detail` carries an error's own text, a path or a field value: the cause is in the server log.

- **New codes:** `ALWAYS_NOT_OFFERED`, `SUGGESTION_NOT_OFFERED` and `SPEND_ONCE_ONLY` → `always_not_offered` (409); `SPEND_LIMIT` → `spend_limit_reached` (409); `MANAGED_BY_DESKTOP` → `managed_by_desktop` (409, and the reset sentence no longer names the data folder); `UNKNOWN_AGENT` on the permission routes → `agent_not_found` (404). A capability's own `AGENT_NOT_FOUND` (agent pause and resume, an agent's MCP servers) now answers `agent_not_found` too, not `not_found`.
- **Folded into a shared code** (`detail` still says which):
  - `person_only` (403): `AGENT_CANNOT_DECIDE`, `REQUESTER_CANNOT_DECIDE`, `operator_cookie_required` and `not-a-person` on approvals and permissions, `NOT_A_PERSON` on to-do promises, `PERSON_REQUIRED` on feedback, `operator_only_harness_sync`, `operator_only_harness_adopt`, `viewer_person_only`, and onboarding's `not-a-person`. `owner_only` (403): `SPEND_OWNER_ONLY`, `NOT_YOURS` on to-do promises, onboarding's `not-the-owner`, `viewer_denied`.
  - `operator_only` (403): `PUSH_OPERATOR_ONLY`, `local_only` on the load gate and shell check, `viewer_local_only`, a reset from away (`NEEDS_PERSON_AT_THIS_COMPUTER`), and first-run setup from another device.
  - `not_from_wifi` (403): `NOT_FROM_WIFI` on approvals, permissions and agent files. `needs_approval` (403): `NEEDS_APPROVAL` on the agent edit routes. `host_not_allowed` (403): `HOST_NOT_ALLOWED`. `forbidden` (403): `RESET_TOKEN_REQUIRED`, `REMOTE_ACCESS_OFF`, `AGENT_COMPUTER_HUB_OWNED`, and the managed-hostname refusal.
  - `not_found` (404): `UNKNOWN_APPROVAL`, `UNKNOWN_EVENT`, `unknown_account`, `browser_discovery_disabled`. `already_resolved` (409): `APPROVAL_NOT_PENDING`, `onboarding_complete`, `agent_raise_gone`, an already re-asked hook. `expired` (410): `APPROVAL_EXPIRED`, `agent_raise_expired`.
  - `precondition_failed` (412, was 409): `UNDO_CONFLICT` (still with `conflicts`), `PERMISSIONS_CHANGED`, `agent_raise_marked`, `viewer_stale`.
  - `conflict` (409): `APPROVAL_INCOMPLETE`, `NOT_UNDOABLE`, `harness_not_set_up`, `HOOK_REASK_UNAVAILABLE`, `file_picker_stuck`, `viewer_busy`, `viewer_uncertain`.
  - `invalid_request` (400): `INVALID_GRANT_BODY`, `INVALID_DENY_BODY`, `INVALID_FEEDBACK`, `INVALID_ROOM_ID`, `INVALID_DOC_SPACE`, `invalid_id`, `invalid_key`, `invalid_setup`, `viewer_bad_request`, `UNKNOWN_AREA`, `UNKNOWN_ACTION`, `ACTION_HAS_NO_AREA`, `FLOOR_NEVER_ALLOWED`, `ALWAYS_ASKS`, `INVALID_STATE`, `INVALID_STOP` (an Always allow refused this way is now 400, was 409), and an unknown runtime on `/api/commands` and `/api/models`. `not_a_folder` (400): a harness path that is a file.
  - `temporarily_unavailable` (503): `unavailable` on the load gate, `team_unavailable`, and `viewer_unavailable` (it was 404 or 409). `rate_limited` (429): `viewer_limit` and the admin limiter. `upstream_unavailable` (502): `models_unreachable` and the feedback history. `internal_error` (500): `DOC_INDEX_FAILED`, `ALWAYS_ALLOW_NOT_RECORDED`, `ALWAYS_ALLOW_NOT_UNDONE`, and every other failure, which used to echo the error's message.
- **Kept as they were:** the login gate's `401 AUTH_REQUIRED` body, the `428` step-up and agent-card (`agent_raise_card`) bodies, and `200` answers that carry `{ ok: false }` by design.

### Codes that changed: the last hand-built bodies

The last answers built by hand moved to problem documents, and every reader dropped the old shape (DOR-4979).

- A server that is stopping: `SERVER_STOPPING` → `temporarily_unavailable` (503, same headers).
- The sign-in rate limit: `RATE_LIMITED` → `rate_limited` (429, now `application/problem+json`; `Retry-After` unchanged).
- The mini app access page's decision: `MINI_APP_ACCESS_BAD_DECISION` and `MINI_APP_ACCESS_NO_ACCOUNT` → `invalid_request` (400); `MINI_APP_ACCESS_STALE` → `stale_page` (409, was 403); `MINI_APP_ACCESS_UNAVAILABLE` → `temporarily_unavailable` (503); a mini app that changed since the page opened → `precondition_failed` (412, was 409).
- An agent's raise that gets no card: `agent_raise_unidentified` → `agent_identity_unverified` (401, was 403); `agent_raise_marked` → `forbidden` (403); `agent_raise_cap` → `rate_limited` (429); `agent_raise_unavailable` → `temporarily_unavailable` (503).
- Document metrics (`GET /api/debug/doc-channels`): `DOC_METRICS_FORBIDDEN` → `owner_only` (403); `DOC_CHANNEL_METRICS_UNAVAILABLE` → `temporarily_unavailable` (503).
- Readers: `readErrorBody` no longer reads `{ error, code }` or `{ message }`; the app no longer knows `NOT_FROM_WIFI` or `NEEDS_PERSON_AT_THIS_COMPUTER`, and the CLI no longer knows `API_NOT_FOUND`.

## Regenerating the published API docs (two steps, not one)

Anything that changes `openapi-registry.ts`, including a description or a response code, has to be regenerated and committed:

```bash
pnpm docs:export-api                          # 1. registry  -> docs/api/openapi.json (+ openapi-internal.json)
pnpm --filter=@dorkos/site generate:api-docs  # 2. that JSON -> docs/api/api/**/*.mdx
```

**Running only the first one is the trap, and it is a quiet one.** They are two generators in a chain: `docs:export-api` writes the spec, and `generate:api-docs` writes the Fumadocs MDX pages the site actually publishes from it. If you run step 1 alone and `git status` is clean, the natural read is "no drift, nothing to commit" — but a description change lands entirely in step 2's output, so the JSON can be byte-identical while the published page still shows the old text. That is a page telling users something untrue, and it is not visible in the diff you just looked at.

The `docs-openapi-check` workflow runs both and fails on any difference, so CI catches it. Catching it locally costs one extra command.

## The API lint gate

The API lint gate (DOR-4996) stops the HTTP API from getting worse while old routes are migrated area by area (DOR-4977). It reads committed files: `docs/api/openapi.json` with its internal part `docs/api/openapi-internal.json` merged in (internal operations are documented, only not published, so they count as documented and every rule holds them), and the route census `apps/server/src/http/__tests__/route-census.baseline.json`, and holds what it finds to a baseline that may only go down. It is one of the ratchets `pnpm ratchet` runs (`scripts/ratchets/registry.ts`), in the `Ratchets (DOR-4948)` step of the required `typecheck` job.

| Concept                  | Location                                                      |
| ------------------------ | ------------------------------------------------------------- |
| The check (CLI, ratchet) | `scripts/api-lint/check-api-lint.ts`                          |
| The rules and word lists | `scripts/api-lint/rules.ts`                                   |
| The baseline             | `scripts/api-lint/baseline.json`                              |
| Tests                    | `scripts/__tests__/check-api-lint.test.ts`                    |
| The CI step              | `.github/workflows/typecheck.yml`, step `Ratchets (DOR-4948)` |

```bash
pnpm check:api-lint                    # check against the baseline
pnpm check:api-lint -- --update        # after fixing findings: lower the baseline
```

`--update` lowers a blocking rule's entries and never raises them. It sets an advisory rule's entries (`hand-registered-path`) to whatever it measured, up or down, so that count stays true and the rule does not go red the day it starts blocking; `--base` never judges an advisory entry. In the merge queue the step adds `--queue`, which turns a stale entry into a note ([contributing/ci.md](ci.md#ratchets-dor-4948-is-red-in-typecheck) says why).

The counts are per rule and group, not per finding: a PR that fixes one finding and adds another of the same rule in the same group leaves the count where it was and passes. The ratchet stops the API getting worse in total, not every new finding.

### The rules

Every rule is counted per **route group**, the first path segment under `/api` (`sessions` for `/api/sessions/{id}/messages`), so two PRs in different groups never touch the same baseline entry. `hand-registered-path` is counted per file. `param-name` is counted per (group, resource) by decision: one resource named two ways across groups (`/agents/{id}` beside `/mesh/agents/{agentId}`) is DOR-4982's job, not this rule's.

Every rule blocks except `hand-registered-path`, which is **advisory** (`blocking: false` in `RULES`, `rules.ts`). It is still measured, written to the baseline and lowered by `--update`, but it prints as an advisory line and never fails the check. A call that documents a route on the hand-route allowlist is not counted. It flips to blocking in the PR that empties the pending list (`hand-routes/pending.json`): until then hand routes still wait to move, and blocking would freeze them.

| Rule                   | A finding is                                                                                                                                                                                                                                                                                                                                                                      | The fix                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `operation-id`         | An operation with no `operationId`. Two operations sharing one id **always fail**, whatever the baseline says; ids that match once lowercased with underscores removed count as shared, as they do for the generator.                                                                                                                                                             | Give each new operation a unique `operationId`.                                                                  |
| `verb-path`            | A static path segment that is a command word (`COMMAND_WORDS` in `rules.ts`, or any segment ending in `-all`). `pause`, `resume`, `halt`, `install`, `fork`, `merge` and `trigger` are allowed (`ALLOWED_VERBS`).                                                                                                                                                                 | Name the resource and let the method be the action: `POST /things`, not `POST /things/create`.                   |
| `param-name`           | A resource whose `{param}` goes by more than one name in its group (`/rooms/{id}` beside `/rooms/{roomId}`): distinct names minus one.                                                                                                                                                                                                                                            | Use the name the group already uses.                                                                             |
| `error-missing`        | An operation with no 4xx or 5xx response.                                                                                                                                                                                                                                                                                                                                         | Declare the error responses the handler can send.                                                                |
| `error-shape`          | A 4xx or 5xx response with no body, or whose body is not a shared error schema (`SHARED_ERROR_SCHEMAS`: `Problem`, `AuthRequired`, `StepUpRequired`, `PasskeyCheckRequired`), an extension of one, or a choice between them.                                                                                                                                                      | Declare it with `problemResponse()`.                                                                             |
| `list-paging`          | A GET whose last segment is static and whose 200 body is a list, but which lacks a `cursor` and `limit` query parameter or a `nextCursor` in its body.                                                                                                                                                                                                                            | Page the list: accept `cursor` and `limit`, return `nextCursor`.                                                 |
| `undocumented-route`   | A served route (from the census) with no documented operation. `ALL` middleware, wildcards, `/api/test` and `/api/ext/{id}` are left out; parameter names are ignored when matching. Known gap: an `ALL` or `/*` route answers requests but is never counted here, so a route served only that way can stay undocumented without a finding.                                       | Document the route, then regenerate the docs (above).                                                            |
| `unserved-operation`   | A documented operation no served route answers.                                                                                                                                                                                                                                                                                                                                   | Serve it, or remove it from the document.                                                                        |
| `hand-registered-path` | Advisory. A `registerPath(` call site in the hand registry: `openapi-registry.ts`, `services/core/openapi/*.ts`, and any `*-openapi.ts` or `openapi.ts` under `apps/server/src`, less calls whose literal method and path are on the hand-route allowlist. It counts call sites, not paths, so a loop that registers several paths counts once (`computer-openapi.ts` does this). | Move the route onto a capability `http` surface ([Moving a hand route](#moving-a-hand-route-onto-a-capability)). |

**What `list-paging` counts as a list.** The 200 body, or any one member of its `oneOf`, `anyOf` or `allOf` judged on its own (so an `allOf` errs toward counting), is a top-level array, or an object that wraps a collection. An object wraps one when at least one property is an array whose items are not plain values, or when every property is an array (`{ files: string[] }`: paths, ids and tags grow without bound). Items are plain when they are an `enum`, directly or through a `$ref`, or every listed type is `string`, `number`, `integer`, `boolean` or `null`; an array with no item schema is not plain. An `id` property makes the object one resource that holds arrays (an agent manifest), except when the segment before the last is a parameter (`/rooms/{id}/members`), where the `id` names the parent and the body is judged as a list. The object's other properties are not judged, because real lists carry `warnings` or counts beside their rows (`GET /api/sessions`).

### When it goes red

| The step says                                | What to do                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `<rule> in <group>: N (baseline M)`          | Your change added a finding. The step lists what it found in that group; fix the new one.             |
| `..., and the baseline holds none there`     | First finding of that rule in a group. Fix it; the baseline is never added to.                        |
| `down to N` or `none left`                   | You fixed something. Run `pnpm check:api-lint -- --update` and commit the lowered baseline.           |
| `baseline raised` or `added to the baseline` | The baseline was edited upward by hand. Revert that edit and fix the finding instead.                 |
| `cannot run` (exit 2)                        | An input is missing or not valid JSON, or `--base` is not a commit. A gate that cannot measure fails. |

### Adding a route that passes

A new endpoint is a capability ([Adding a New Endpoint](#adding-a-new-endpoint)). A hand route, kept only for an allowlisted shape, passes every blocking rule when it is a documented `registerPath` with:

- a unique `operationId` (or none, and the generator derives one: see [Operation ids](#operation-ids));
- at least one 4xx or 5xx response, each a problem document (`problemResponse('…')`, or `INTERNAL_ERROR_RESPONSE` for a read that can only fail inside the server, both in `services/core/openapi/problem-openapi.ts`);
- no command word in any static segment of its path (name the resource, let the method be the action);
- the parameter name its group already uses for that resource;
- on a list `GET`: `cursor` and `limit` query parameters and a `nextCursor` in the 200 body.

Then regenerate the docs (above), so `docs/api/openapi.json` and the census both list it. `hand-registered-path` notes the new call, but only as advice.

A new route is a capability with an `http` surface, served by the generic mount and documented by the OpenAPI projection. The path, parameter and paging rules above still apply to it. `hand-registered-path` still only advises until the pending list is empty.

**Never raise a number in the baseline by hand.** `--update` only lowers or removes entries, and CI runs the check with `--base`, which refuses any entry that is higher than the base's or new.

## Marketplace (`/api/marketplace/*`)

The marketplace routes are mounted at `/api/marketplace` and backed by injected service dependencies (source manager, cache, fetcher, installer, uninstall/update flows). Route file: `apps/server/src/routes/marketplace.ts`, with one module per route group under `apps/server/src/routes/marketplace/`.

| Method   | Path                                          | Description                                                                                         |
| -------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/marketplace/sources`                    | List configured marketplace sources                                                                 |
| `POST`   | `/api/marketplace/sources`                    | Add a new source (`{ name, source, enabled? }`)                                                     |
| `DELETE` | `/api/marketplace/sources/:name`              | Remove a source (also `DELETE /sources?name=`, see below)                                           |
| `POST`   | `/api/marketplace/sources/:name/refresh`      | Force-refetch a source's `marketplace.json` (also `POST /sources/refresh?name=`)                    |
| `GET`    | `/api/marketplace/installed`                  | List installed packages from `~/.dork/plugins/` and `~/.dork/agents/`                               |
| `GET`    | `/api/marketplace/installed/:name`            | Get a single installed package by name                                                              |
| `GET`    | `/api/marketplace/cache`                      | Cache status (counts, total bytes, whether automatic cleanup is paused)                             |
| `DELETE` | `/api/marketplace/cache`                      | Wipe the entire marketplace cache                                                                   |
| `POST`   | `/api/marketplace/cache/prune`                | Remove cached packages no install needs (no options)                                                |
| `GET`    | `/api/marketplace/packages`                   | Aggregate packages from all enabled sources                                                         |
| `GET`    | `/api/marketplace/packages/:name`             | Fetch and validate a single package entry (`?marketplace=` to pin source)                           |
| `POST`   | `/api/marketplace/packages/:name/preview`     | Build a `PermissionPreview` without installing                                                      |
| `POST`   | `/api/marketplace/packages/:name/install`     | Install a package (`{ marketplace?, source?, force?, yes?, projectPath? }`)                         |
| `POST`   | `/api/marketplace/packages/:name/uninstall`   | Uninstall a package (`{ purge?, projectPath? }`)                                                    |
| `POST`   | `/api/marketplace/packages/:name/update`      | Advisory update check; pass `{ apply: true }` to apply the update                                   |
| `POST`   | `/api/marketplace/packages/:name/check-files` | Give an install an older DorkOS made its installed-files record, or say why not                     |
| `POST`   | `/api/marketplace/packages/:name/keep-files`  | A person's "Keep these as mine" for files an update kept but could not sort (signed-in person only) |
| `GET`    | `/api/marketplace/updates`                    | One update check per installation, with what each newer version runs                                |
| `POST`   | `/api/marketplace/updates`                    | Reinstall exactly the installations a person was shown, held to what they saw                       |
| `GET`    | `/api/marketplace/held-back`                  | Global packages held back from sessions, and why                                                    |
| `POST`   | `/api/marketplace/held-back/:name/review`     | Raise the approval card for a held-back package again                                               |
| `POST`   | `/api/marketplace/held-back/:name/decision`   | A person's allow or refuse for a held-back package (trusted caller only)                            |
| `GET`    | `/api/marketplace/dev-links`                  | Every dev link and whether it is in force                                                           |
| `POST`   | `/api/marketplace/dev-links/preview`          | What linking a folder would do; changes nothing                                                     |
| `POST`   | `/api/marketplace/dev-links`                  | Make a dev link (tier-gated: an agent gets a card, 202, or a 403)                                   |
| `POST`   | `/api/marketplace/dev-links/:name/unlink`     | Remove a dev link (the person only)                                                                 |

A source name rides in the path or, from the app, in `?name=`: a name saved by an older DorkOS may hold a `/`, and Remote Access refuses an encoded `/` in a URL path (DOR-4212). Both forms run the same handler.

**Who may call them** (DOR-4978): the capability mount serves the reads (`GET /sources`, `/cache`, `/packages`, `/installed`, `/installed/:name`, `/updates`, `/held-back`, `/dev-links`; `services/marketplace/doors/marketplace-read-capabilities.ts`). They are open to agents, as the `marketplace_*` tools are; an agent reads `/installed`, `/installed/:name` and `/held-back` without the working folder a dev-linked package runs from (`linkedPath`, `devLink.path`, the folder in `note` and a `bindsTo` that spells it). The exception is `GET /dev-links`: it names a person's working folders, so an agent, an approval token, an API key or any `Authorization` header gets `403 person_only`. `GET /packages/:name` and every write stay by hand.

**Error responses** are problem documents from a centralised `mapErrorToProblem` helper — `400 invalid_request` for invalid manifests, `409 conflict` for file conflicts, `404 not_found` for missing packages/sources, `500 internal_error` for unexpected failures.

See `contributing/marketplace-installs.md` for the full install pipeline, transaction semantics, and per-kind flow details.

## SSE Streaming

### POST /api/sessions/:id/messages

Trigger-only and accept-only. The server validates the request, accepts the message into its session queue, and returns `202`; it does not stream the turn in this response. A busy session accepts the message behind its current turn rather than returning `SESSION_LOCKED`. Only `turn_start` on the durable event stream proves that this message's turn began.

**Headers:**

- `X-Client-Id` (optional) - Identifies the originating client; it does not reserve an exclusive session write-lock.

**Request body:** `SendMessageRequest` in `packages/shared/src/schemas.ts`. Important fields include:

- `content` (string, required) - Message text.
- `cwd` (optional) - Working directory.
- `create` (optional) - Allows first-message creation under an unknown id; without it, an unknown session returns `404 session_not_found`.
- `clientMessageId` (optional) - Client correlation for the submitted message.
- `context` (optional) - Neutral client signals, including UI state.
- `runtime`, `account`, `agentPath` (optional) - First-message launch/provenance hints; later messages do not rebind the session.
- `disposition` (optional) - Requested treatment of a message sent while work is running; see `SendMessageRequestSchema` for the current choices and remaining fields.

**Responses:**

- `202` - `SendMessageResponse`: `{ sessionId, messageId, outcome, queuePosition }`. Re-target to the returned canonical id when it differs. `queuePosition: 1` can mean an immediate start or the only waiting message; it is not a start signal.
- `404` - `session_not_found` when no session exists and `create` was not requested.

The session stream carries queue changes and the eventual turn. `apps/server/src/routes/sessions.ts`, `packages/shared/src/schemas.ts` and `Transport.postMessage` define the contract.

### GET /api/sessions/:id/events

Durable per-session stream (snapshot → replay → live). A normal `GET` serves SSE; the app uses a WebSocket upgrade on the same path, with JSON `{ event, data, id? }` frames and the full opaque cursor in `?resume=`. See `packages/shared/src/stream-socket.ts`. Also the cross-client sync mechanism: every subscriber sees the same events, including turns triggered by other clients or the CLI.

**Query params:**

- `cwd` (optional) - Working directory path
- `after` (optional) - Integer resume cursor (alternative to `Last-Event-ID`)

**Headers:**

- `Last-Event-ID` (optional) - Echoed automatically by EventSource on reconnect; format `<sessionId>-<epoch>-<generation>-<seq>`. A matching epoch AND generation resume with a gap-free replay (events with `seq` > cursor, no snapshot). The generation names the projector instance that owns the `seq` counter, which a rekey can replace behind the same session id; a mismatched epoch or generation, a cursor in the older generation-less format, or an unservable one falls back to a cold snapshot.

**Events:**

- `snapshot` - Hydration frame on cold connect (`SessionSnapshot`): `{ messages, inProgressTurn, status, pendingInteractions, cursor }`
- Live `SessionEvent` frames, named by their `type` discriminator (`text_delta`, `thinking_delta`, `tool_call`, `tool_result`, `tool_progress`, `approval_required`, `question_prompt`, `elicitation_prompt`, `interaction_resolved`, `status_change`, `todo_update`, `subagent_update`, `hook_update`, `memory_recall`, `turn_start`, `turn_end`), each with a per-session monotonic `seq` and an SSE `id:` line for resumption

Schemas live in `packages/shared/src/session-stream.ts`; the handler in `apps/server/src/routes/session-events-handler.ts`.

**Usage:** Clients should close the connection when no longer viewing the session.

### GET /api/events

Unified SSE stream for all real-time system events, on one connection. Clients filter by the SSE `event:` field. One older stream still overlaps it: `GET /api/extensions/events`. Under ADR `261123-170833` it is removed in the change that moves every caller onto `/api/events`, as `GET /api/tunnel/stream` and `GET /api/relay/stream` were (DOR-4983). New code reads `/api/events` only.

**Events:**

| Event                | Description                                                                                                           | Payload                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `connected`          | Sent on initial connection                                                                                            | `{ connectedAt: string }` (ISO timestamp)        |
| `heartbeat`          | Keepalive (every 15 s)                                                                                                | _(empty)_                                        |
| `session_upserted`   | Session created or metadata changed                                                                                   | `{ session: Session }`                           |
| `session_removed`    | Session deleted                                                                                                       | `{ sessionId: string }`                          |
| `session_status`     | Session status projection changed; `retiredSessionId` announces a first-turn rekey (drop state held under the old id) | `{ sessionId, cwd?, retiredSessionId?, status }` |
| `tunnel_status`      | Tunnel state changed                                                                                                  | Tunnel status object                             |
| `extension_reloaded` | Extension(s) recompiled                                                                                               | `{ type, extensionIds: string[], timestamp }`    |
| `relay_connected`    | Relay SSE connection established                                                                                      | Connection metadata                              |
| `relay_message`      | New relay message published                                                                                           | Relay envelope                                   |
| `relay_backpressure` | Relay back-pressure signal                                                                                            | Back-pressure details                            |
| `relay_signal`       | Relay control signal                                                                                                  | Signal payload                                   |

The session-list events (`session_upserted`/`session_removed`/`session_status`) feed the sidebar and fleet status views — there is no session-list polling. Schemas: `SessionListEventSchema` in `packages/shared/src/session-stream.ts`.

**Error responses:**

- `503` `temporarily_unavailable` when `SSE.MAX_TOTAL_CLIENTS` (500) is exceeded

**Keepalive:** `event: heartbeat\ndata: \n\n` every 15 seconds.

**Usage:** Open one `EventSource` to `/api/events` and filter on `event.type`. Close when the application unmounts.

### GET /api/sessions/:id/messages

Fetch message history for a session.

**Query params:**

- `cwd` (optional) - Working directory path

**Headers:**

- `If-None-Match` (optional) - ETag from previous response. Returns 304 if content unchanged.

**Responses:**

- `200` - Message array with `ETag` header (based on file mtime + size)
- `304` - Not Modified (when `If-None-Match` matches current `ETag`)
- `404` - Session not found

### GET /api/sessions/:id/tasks

Fetch the current task list (task state, built from `TaskCreate`/`TaskUpdate` tool calls) for a session.

**Query params:**

- `cwd` (optional) - Working directory path

**Headers:**

- `If-None-Match` (optional) - ETag from previous response. Returns 304 if content unchanged.

**Responses:**

- `200` - `{ tasks: Task[] }` with `ETag` header
- `304` - Not Modified (when `If-None-Match` matches current `ETag`)
- `404` - Session not found

### POST /api/sessions/:id/tasks/:taskId/stop

Stop a running background task (subagent or bash command). Delegates to the active runtime's `stopTask` implementation.

**Path params:**

- `id` - Session ID
- `taskId` - Background task ID

**Headers:**

- `X-Client-Id` (optional) - Client identifier for session locking

**Responses:**

- `200` - `{ ok: true }` — task stop signal sent
- `404` - Session or task not found
- `500` - Runtime error stopping task

### POST /api/sessions/:id/interrupt

Stop the active turn and clear the session's waiting-message queue before asking the runtime to interrupt. Cleared messages are returned so the client can put the person's words back in the composer, including when the interrupt fails.

**Path params:**

- `id` - Session ID

**Responses:**

- `200` - `{ receipt: InterruptReceipt, cancelledQueued: QueuedMessage[] }`. The receipt carries `runtime`, `outcome` (`acked`, `closed`, `not-running`, `unconfirmed` or `failed`) and an optional `reason`.
- `400` - Invalid session ID.

An unexpected exception from the runtime becomes a `failed` receipt with `reason: 'delivery-failed'`; it does not discard `cancelledQueued` in a `500` response. Use `turnEnded(receipt)` and `worthRetrying(receipt)` from `@dorkos/shared/schemas` rather than treating every `200` as a confirmed stop. The old `{ ok: boolean }` response is retired.

### POST /api/sessions/:id/approve

Approve a pending tool call. Resolves the server-side deferred promise so the SDK can proceed.

**Request body:** `ApprovalRequest`

```json
{
  "toolCallId": "tc-abc123",
  "alwaysAllow": false
}
```

- `toolCallId` (string, required) - The tool call to approve
- `alwaysAllow` (boolean, optional) - When `true`, forwards SDK permission suggestions as `updatedPermissions` so the tool pattern is permanently allowed without future prompts

**Responses:**

- `200` - `{ ok: true }`
- `400` - Invalid request
- `404` - No pending interaction for this tool call
- `409` - Interaction already resolved (`already_resolved`)

### POST /api/sessions/:id/deny

Deny a pending tool call, optionally saying why.

**Request body:** `ApprovalRequest`

```json
{
  "toolCallId": "tc-abc123",
  "reason": "Use pnpm prune instead — that folder is symlinked"
}
```

- `toolCallId` (string, required) - The tool call to deny
- `reason` (string, optional, max 1000 chars) - Why the person refused. Delivered to
  the agent as the denial message so it can adjust instead of retrying, and recorded on
  the durable stream (`interaction_resolved.reasonGiven`) so the transcript receipt can
  say the agent was told why. A blank string counts as no reason. Runtimes whose
  backend has no free-text refusal channel (OpenCode) drop it and therefore never claim
  a reason was given.

**Responses:**

- `200` - `{ ok: true }`
- `400` - Invalid request
- `404` - No pending interaction for this tool call
- `409` - Interaction already resolved (`already_resolved`)

### POST /api/sessions/:id/batch-approve

Approve multiple pending tool calls in a single request.

**Request body:** `BatchApprovalRequest`

```json
{
  "toolCallIds": ["tc-abc123", "tc-def456", "tc-ghi789"]
}
```

**Responses:**

- `200` - `{ results: [{ toolCallId: string, ok: boolean }] }`
- `400` - Invalid request (empty array or validation error)

### POST /api/sessions/:id/batch-deny

Deny multiple pending tool calls in a single request.

**Request body:** `BatchApprovalRequest`

```json
{
  "toolCallIds": ["tc-abc123", "tc-def456"]
}
```

**Responses:**

- `200` - `{ results: [{ toolCallId: string, ok: boolean }] }`
- `400` - Invalid request (empty array or validation error)

### PATCH /api/sessions/:id

Update the mutable per-session settings. Persisted settings (`permissionMode`, `model`, `effort`, `fastMode`) survive idle eviction and a server restart — they are stored in the `session_metadata` row, not just on the in-memory session (ADR-0260).

**Path params:**

- `id` - Session ID

**Query params:**

- `cwd` (optional) - Working directory path (used to resolve the session and rename the JSONL when `title` is supplied)

**Request body:** `UpdateSessionRequest` — every field is optional; an omitted field means "no change".

```json
{
  "permissionMode": "acceptEdits",
  "model": "claude-opus-4-6",
  "effort": "high",
  "fastMode": false,
  "title": "Refactor the relay adapter"
}
```

- `permissionMode` (string, optional) - One of the permission modes (`default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `auto`). A live mode switch never fails the request: sessions launch with `allowDangerouslySkipPermissions`, so a mode that cannot be applied to the active turn is persisted and takes effect on the next turn rather than returning `422` (ADR-0261).
- `model` (string, optional) - Model identifier to use for subsequent turns
- `effort` (string, optional) - Reasoning effort: `none`, `minimal`, `low`, `medium`, `high`, `max`, `xhigh`
- `fastMode` (boolean, optional) - Toggle fast mode
- `title` (string, optional, 1–200 chars) - Custom session title, persisted to the JSONL via the SDK's `renameSession()`

**Responses:**

- `200` - Updated `Session`
- `400` - Invalid session ID or validation error
- `404` - Session not found

### GET /api/config

Returns server runtime information (version, port, uptime, working directory, tunnel status, Claude CLI path).

**Responses:**

- `200` - Server config JSON

**Notable response fields:**

| Field                      | Type             | Description                                                                                                                                                                         |
| -------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                  | `string`         | Current server version string                                                                                                                                                       |
| `latestVersion`            | `string \| null` | Latest version from npm, or `null` if dev mode or lookup failed                                                                                                                     |
| `isDevMode`                | `boolean`        | Whether the server is running a development build (from `pnpm dev` or `tsx watch`). When `true`, `latestVersion` will be `null` and upgrade notifications are suppressed in the UI. |
| `dismissedUpgradeVersions` | `string[]`       | List of version strings the user has dismissed upgrade notifications for. Managed via `PATCH /api/config` with `{ ui: { dismissedUpgradeVersions: [...] } }`.                       |

### PATCH /api/config

Update user configuration. Accepts a partial config object that is deep-merged with the current `~/.dork/config.json`. The merged result is validated against `UserConfigSchema` before persisting.

**Request body:** Partial JSON object matching the `UserConfig` shape. Only include fields you want to change.

```json
{
  "server": { "port": 8080 },
  "ui": { "theme": "dark" }
}
```

What an agent may actually do is set by permissions (`/api/permissions/*`, `/api/agents/:id/permissions`), never by `PATCH /api/config`: the generic config writers refuse any `permissions.*` key with `USE_PERMISSIONS_API` (spec `agent-permissions` D10, D13). The `agentContext` section this endpoint used to accept — four global toggles that only ever hid MCP tool group documentation from agent system prompts, never restricted which tools a session could call (ADR-260726-171347) — and the per-agent `enabledToolGroups` manifest field that overrode it are both retired: a switch a person had turned off folded into that permission area Blocked, and whether a Blocked area's tool documentation reaches the prompt is now decided by `toolDocGates()` (`services/runtimes/claude-code/messaging/tool-doc-gates.ts`), not by a config toggle. See [`contributing/configuration.md`](configuration.md#boot-time-permission-retirements) for the fold.

**Responses:**

- `200` - Success. Returns the full updated config and optional warnings for sensitive fields:

```json
{
  "success": true,
  "config": {
    "version": 1,
    "server": { "port": 8080, "cwd": null },
    "tunnel": { "enabled": false, "domain": null, "authtoken": null, "auth": null },
    "ui": { "theme": "dark" }
  },
  "warnings": [
    "'tunnel.authtoken' contains sensitive data. Consider using environment variables instead."
  ]
}
```

The `warnings` field is only present when the patch includes keys listed in `SENSITIVE_CONFIG_KEYS`.

- `400` - Validation failed. Returned when the merged config does not pass Zod validation:

```json
{
  "error": "Validation failed",
  "details": ["server.port: Expected number, received string"]
}
```

- `400` - Non-object body:

```json
{
  "error": "Request body must be a JSON object"
}
```

## Task Scheduler (`routes/tasks.ts`)

Mounted at `/api/tasks` when the scheduler is on (`scheduler.enabled`, default `true`, or the `DORKOS_TASKS_ENABLED` override; see [Feature Flags](#feature-flags)).

| Method | Path                         | Description               |
| ------ | ---------------------------- | ------------------------- |
| GET    | `/api/tasks`                 | List all task definitions |
| POST   | `/api/tasks`                 | Create a task definition  |
| PATCH  | `/api/tasks/:id`             | Update a task definition  |
| DELETE | `/api/tasks/:id`             | Delete a task definition  |
| POST   | `/api/tasks/:id/trigger`     | Trigger a task run        |
| GET    | `/api/tasks/runs`            | Get run history           |
| GET    | `/api/tasks/runs/:id`        | Get a specific run        |
| POST   | `/api/tasks/runs/:id/cancel` | Cancel an active run      |

Schedules support an optional `agentId` field for agent-linked scheduling. When `agentId` is set, the schedule's CWD is resolved from the agent's registered project path via MeshCore.

`POST /api/tasks` requires `reason` when the caller does not clear the agent bar (no session cookie, presenting an agent identity or an approval token), and one with no `reason` is refused with `400`. Such a schedule is clamped, and is armed at once only when the caller presented a verified agent token on a Trusted install (ADR 261006-225605); otherwise it is parked at `status: 'pending_approval'`. The `tasks_create` MCP tool (both the in-session and external `/mcp` servers) requires `reason` unconditionally, since every call there is by construction an agent asking; the in-session server arms on a Trusted install, the external one always parks. A parked schedule's row carries `reason`, `proposedBySessionId`, and `proposedByAgentPath` (DOR-1394; `packages/db/src/schema/tasks.ts`); `GET`/`PATCH` responses additionally resolve `proposedByName` live from agent identity rather than storing it, and populate `nextRuns` (the next three occurrences, from `previewNextRuns`) only for `pending_approval` rows, since that is the only state the live scheduler cannot answer for itself.

## Notifications (`routes/notifications.ts`) and Push (`routes/push.ts`)

Always mounted, no feature flag: `/api/notifications` and `/api/push` (spec `notification-system`, DOR-1383/1385).

| Method | Path                          | Description                                             |
| ------ | ----------------------------- | ------------------------------------------------------- |
| GET    | `/api/notifications`          | List notification history, paginated, with unread count |
| PATCH  | `/api/notifications/:id/read` | Mark one notification read                              |
| POST   | `/api/notifications/read-all` | Mark every notification read                            |
| GET    | `/api/push/vapid-public-key`  | The server's VAPID public key, for subscribing          |
| GET    | `/api/push/subscriptions`     | List this browser's push subscriptions                  |
| POST   | `/api/push/subscriptions`     | Register a push subscription                            |
| DELETE | `/api/push/subscriptions/:id` | Remove a push subscription                              |

`GET /api/notifications` and the two mark-read mutations are gated by `notificationEntitlement`, which reads the caller's principal, not a feature flag. A caller that is not the signed-in operator gets `200` with an empty list from the GET (never `403` — the response must not confirm to a machine that notifications about it exist), and a `403 NOTIFICATIONS_OPERATOR_ONLY` from either mutation, since marking something read is a claim only a person looking at a screen can make.

This is the single pipeline every operator-facing message now goes through, including the `schedule.parked` condition a proposed schedule raises (see [Task Scheduler](#task-scheduler-routestasksts) above) — routed, deduped, and recorded here rather than each caller inventing its own alert. See `notifications` in `contributing/configuration.md` for the config section (sounds, escalation timing, away-notification toggle) that decides how loudly a notification is surfaced once it exists.

## Feature Flags

Relay, A2A and the task scheduler are each switched by a user setting, and an environment variable overrides that setting **only when it is present**, in both directions (`'DORKOS_X' in process.env`, so `false` turns the subsystem off). Leave the variable unset to let the setting decide. When a group is off its router is not mounted, and requests to those paths return 404. Mesh routes are always mounted (no flag).

| Setting (default)            | Override               | Guards                                                                                                                                             |
| ---------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relay.enabled` (`true`)     | `DORKOS_RELAY_ENABLED` | `/api/relay/*` routes; resolved by `relayStartsEnabled()` in `services/relay/relay-state.ts`                                                       |
| `a2a.enabled` (`false`)      | `DORKOS_A2A_ENABLED`   | `/.well-known/agent-card.json`, `/a2a/*` (needs Relay and Mesh running)                                                                            |
| `scheduler.enabled` (`true`) | `DORKOS_TASKS_ENABLED` | `/api/tasks/*` routes (task definitions and runs). Firing is a separate gate: outside production, tasks fire only with `DORKOS_TASKS_ENABLED=true` |

Relay also carries external adapters (Telegram, Slack, webhooks) for `POST /api/sessions/:id/messages`. The web client always uses the durable session SSE stream, whatever the Relay setting.

Other relevant environment variables:

| Variable             | Default              | Description                                                                                                                                                                                                                                                                               |
| -------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DORKOS_PORT`        | `4242` (dev: `6242`) | Server port                                                                                                                                                                                                                                                                               |
| `DORKOS_CORS_ORIGIN` | (unset)              | Comma-separated list of EXTRA origins, honoured by CORS, the MCP mounts, the WebSocket upgrade check, and Better Auth's CSRF allowlist. Additive (DOR-1711): entries join the per-request policy (loopback + live tunnel + same-origin), never replace it. `*` is ignored with a warning. |

## Agent Endpoints

Agent identity endpoints are always mounted at `/api/agents/` — no feature flag required. They operate on `.dork/agent.json` files via the shared manifest module. All path parameters are boundary-validated.

### GET /api/agents/current

Get the agent a folder belongs to: its home, through any checkout of its repo, with its SOUL.md, NOPE.md, MEMORY.md and HEARTBEAT.md. Served by the capability mount as `agent.current` (`services/mesh/doors/agent-current-capability.ts`). An agent reading another agent's folder gets no `persona`, `conventions`, `permissions`, `mcpServers`, `workspace`, `projectPath` or files, as the `/api/mesh` reads leave out.

**Query params:**

- `path` (required) - Absolute path to the project directory

**Responses:**

- `200` - The agent, or `null` when no agent lives there
- `400` - Missing `path` query parameter
- `403` - Path outside configured boundary

### POST /api/agents

Create a new agent (writes `.dork/agent.json`).

**Request body:** `CreateAgentRequest`

```json
{
  "path": "/path/to/project",
  "name": "my-agent",
  "description": "Backend API agent",
  "runtime": "claude-code"
}
```

Only `path` is required. `name` defaults to the directory basename, `runtime` defaults to `claude-code`.

**Responses:**

- `201` - Created `AgentManifest`
- `400` - Validation error
- `403` - Path outside configured boundary
- `409` - Agent already exists at this path (returns existing agent)

### PATCH /api/agents/current

Update agent fields by path. Merges the request body into the existing manifest.

**Query params:**

- `path` (required) - Absolute path to the project directory

**Request body:** `UpdateAgentRequest` (all fields optional)

```json
{
  "name": "new-name",
  "description": "Updated description",
  "persona": "You are an expert in REST APIs...",
  "personaEnabled": true,
  "color": "#6366f1",
  "icon": "\ud83e\udd16"
}
```

All fields are optional. The per-agent `enabledToolGroups` object this endpoint used to accept is retired (spec `agent-permissions` D13): what an agent may do lives on its Permissions page instead (`PATCH /api/agents/:id/permissions`), and both `enabledToolGroups` and `tierCeiling` are refused by name here — see the refusal table below.

**This route is agent-reachable, so what it accepts is a classification rather than a schema.** It backs both the app's self-edit and the `update_agent` MCP tool, and it performs no caller-identity check, so a field an agent must not decide for itself cannot be accepted on this path. Every leaf of the wire carries a verdict in `apps/server/src/services/core/operator/agent-write-policy.ts`, and a drift guard fails the build when a new field arrives without one (DOR-1506). These are the refusals:

| Field                                                   | Why it is refused                                                                                                                                                                                                                        | Where it is set instead                                                                                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                                  | The slug is how everything else addresses the agent — `displayName` is the writable half                                                                                                                                                 | `PATCH /api/mesh/agents/:id`                                                                                                                                                      |
| `namespace`                                             | It decides which other agents this one can reach, so an agent moving itself picks its own side of the access rules                                                                                                                       | `PATCH /api/mesh/agents/:id`                                                                                                                                                      |
| `behavior.responseMode`, `behavior.escalationThreshold` | They decide whether a turn RUNS unbidden — an agent could vote itself the floor in every room, on the operator's model budget                                                                                                            | `PATCH /api/mesh/agents/:id`                                                                                                                                                      |
| `account`                                               | Billing is the operator's call — an agent could repoint whose subscription its work bills to                                                                                                                                             | `PATCH /api/mesh/agents/:id`                                                                                                                                                      |
| `permissions`, `enabledToolGroups`, `tierCeiling`       | What an agent may do is a person's call, set on the agent's Permissions page, and every change is audited. `enabledToolGroups` and `tierCeiling` are retired fields that used to answer the same question (spec `agent-permissions` D13) | `PATCH /api/agents/:id/permissions` (this route refuses all three with code `OPERATOR_ONLY`; `PATCH /api/mesh/agents/:id` refuses the same three with code `USE_PERMISSIONS_API`) |

All three are **refused, not stripped**: a partial write that silently dropped the field would let a caller report the change as done. Naming a refused field at all — `true`, `false`, `null`, or any object above it — refuses the whole patch, and the check runs before the schema parse and before the manifest is read, so the answer never depends on the rest of the body being well-formed or on which agent lives at the path.

"Any object above it" includes one carrying **only keys DorkOS does not recognise**, and that is load-bearing rather than pedantic. A write here REPLACES the object it names instead of merging into it, so `{"enabledToolGroups":{"zzz":1}}` would store `{}` — clearing groups a person had turned off — even though the patch named no guarded key. `{"behavior":{"zzz":1}}` is sharper still, because the schema defaults `responseMode` and the replacement would re-arm the most permissive setting. So naming an object that holds a refused field counts as naming every field under it, unless every key it carries is one the policy classifies.

**Two more fields are refused on the `update_agent` MCP tool ONLY, and are accepted here** (DOR-1698). The split is deliberate and the direction matters: this route is how the app's own Safety Boundaries editor saves, and a person editing their agent's boundaries in the app is the case that must stay free.

| Field              | Refused on                                                                | Where an agent does it instead     |
| ------------------ | ------------------------------------------------------------------------- | ---------------------------------- |
| `nopeContent`      | `operator.update_agent` (tier `act`) — the NOPE.md body                   | `operator.update_agent_boundaries` |
| `conventions.nope` | `operator.update_agent` (tier `act`) — whether NOPE.md is injected at all | `operator.update_agent_boundaries` |

`operator.update_agent_boundaries` is tier `destructive`, so an agent changing either one waits for a person's approval, and the card carries the full new text rather than a preview. Both are refused the same way `permissions` is — present at any value, whole patch rejected — so an agent cannot be told half a change landed. See `contributing/agent-operator-surface.md`.

**Three more are refused for an agent caller on this route and on `PATCH /api/mesh/agents/:id`, and accepted from a person** (DOR-2328): `runtime`, `model` and `effort`. A schedule that leaves them unset follows its agent, and a person's approval of it records the unset value, so moving an agent's defaults moves every such approved schedule. A caller that presents an agent identity (`X-Dorkos-Agent`) or an approval token, or that lacks the session cookie under login-on, gets `403` with code `NEEDS_APPROVAL` and a pointer to `operator.update_agent_execution` (tier `destructive`, whose card shows each change old → new). The Runs-on popover and the agent settings page are a person and are not asked. `update_agent` refuses the three for every caller, as it does the boundaries fields.

**Responses:**

- `200` - Updated `AgentManifest`
- `400` - Validation error or missing `path`
- `403` - Refused as operator-only: the patch named a field from the table above
- `403` - Path outside configured boundary
- `404` - No agent registered at this path

### POST /api/agents/resolve

Batch-resolve agents for multiple paths. Avoids N+1 queries in the DirectoryPicker.

**Request body:** `ResolveAgentsRequest`

```json
{
  "paths": ["/path/to/project-a", "/path/to/project-b"]
}
```

Maximum 20 paths per request.

**Responses:**

- `200` - `{ agents: Record<string, AgentManifest | null> }` — keys are paths, values are manifests or `null` for unregistered directories

## Permissions Endpoints (`routes/permissions.ts`)

What agents may do on their own, what waits for a person's yes, and what they cannot do at all (spec `agent-permissions` D10). Mounted at `/api`. Every mutating HTTP route in this group requires a person: `resolveDecisionAuthority` refuses a caller presenting `X-DorkOS-Agent` (resolved or not) or holding an approval token, and `requireOperatorCookieUnderLogin` requires a browser session wherever `personSessionRequired` applies, including local changes once an owner exists — see `contributing/agent-operator-surface.md`. The user guide is `docs/guides/permissions.mdx`; the schemas live in `@dorkos/shared/permissions`. On Wi-Fi, writes may lower permissions but cannot raise them, and Undo is refused. Agents use the separate `permissions.change` capability under its invocation-time permission and approval checks; HTTP person-only routes are not a statement that no agent-facing write exists.

### GET /api/permissions

The default layer: the chosen preset, the changes on top of it, every area with its actions resolved, the Files & commands row, and which agents differ.

- `200` - `PermissionsResponse`: `{ preset, presetLastChange?, defaults, changeCount, filesAndCommands: { stop, presetStop, runtimes: [{ runtime, stop }], exceptions: [{ agentId, agentName, stop, lastChange? }], followingAgentIds, lastChange? }, areas: [...], exceptions: [...], agentCount }`

Every area, action, exception and Files & commands entry carries an optional `lastChange` (`{ eventId, occurredAt, actorLabel, attribution, surface }`): the newest recorded change to any setting the resolver reads for that state, from the last 200 permission events (`readLastChanges`). It is what the app's "Why?" line names; absent when nothing in that window touched it. `followingAgentIds` lists the agents that follow the global Files & commands stop (no stop of their own, none set for their runtime). "Affects N agents" everywhere is `countAgentsFollowing` in `@dorkos/shared/permissions`, one function shared by the app and the CLI.

### GET /api/permissions/history

Query params: `agentId` (optional), `before` (ISO 8601 cursor, optional), `limit` (1–100, default 50).

- `200` - `{ items: PermissionHistoryEntry[], nextCursor: string | null }`

### POST /api/permissions/history/:eventId/undo

Undo one `permission.changed` event (spec `agent-permissions` D14): every key it moved goes back to its `before`, recorded as one new `permission.changed` with `surface: 'undo'` and `undoOf`. Person-only, like every write.

**Request body:** `{ force?: boolean }` (an empty body is a plain Undo).

- A key whose value is no longer the recorded `after` is a conflict. A change to one target is refused whole (`409 UNDO_CONFLICT`, with `conflicts: PermissionUndoSkip[]`). A change that reached several targets sets back the ones that still match and reports the rest in `skipped`; it is refused only when none match. `force: true` sets everything back.
- A preset switch (`presetSnapshot` on the event) goes back as one unit: the preset, the defaults it cleared, and the global stop.
- Never writes Allowed in a floor area (skipped with `reason: 'floor'`); an agent that no longer exists is `reason: 'gone'`.

**Responses:**

- `200` - `{ changes: PermissionChange[], skipped: PermissionUndoSkip[] }`
- `404` - `UNKNOWN_EVENT`
- `409` - `UNDO_CONFLICT` (with `conflicts`), or `NOT_UNDOABLE` for a request-card answer or a notice

### PUT /api/permissions/preset

Choose a preset for everyone (`trusted`, `careful`, and the retired `balanced`/`full`, still accepted so an old install that chose one can still be read back). Moves the global Files & commands stop to the preset's (Trusted → `autonomy`, Careful → `ask`, Balanced → `act`, Full power → `autonomy`) and clears the changes made on top of the old preset; `applyToAgents` also removes those agents' own settings so they follow the new preset.

**Request body:** `{ preset, applyToAgents?: string[], surface }`.

**Responses:**

- `200` - `{ changes: PermissionChange[], permissions: PermissionsResponse }`

### PATCH /api/permissions/defaults

Change one or more areas or single actions for everyone. `null` removes a change so the setting falls back a layer.

**Request body:** `{ areas?: Record<string, state | null>, actions?: Record<string, state | null>, applyToAgents?: string[], surface }`

- `200` - `{ changes: PermissionChange[], permissions: PermissionsResponse }`

### GET /api/agents/:id/permissions

One agent's resolved permissions, with where each area's state and its Files & commands stop came from.

Served by the capability mount as `permissions.view_agent`, beside `GET /api/agents/:id/level` (`permissions.view_agent_level`). Whoever could read it before still can, an agent included (DOR-4978).

- `200` - `AgentPermissionsResponse`: `{ agentId, agentName, overrides, areas: [{ ...area, inherited, changedOutsideAt, lastChange? }], filesAndCommands: { stop, source, lastChange?, inherited: { stop, source, lastChange? } } }`. `source` is one of `agent | runtime | default | runtime-own`; `changedOutsideAt` is set when the area's most recent change was an edit to the agent's settings file DorkOS noticed rather than made.

### PATCH /api/agents/:id/permissions

Change one agent's own areas, actions, or Files & commands stop.

**Request body:** `{ areas?: Record<string, state | null>, actions?: Record<string, state | null>, filesAndCommands?: stop | null, surface }`. `filesAndCommands: null` puts the agent back on the default.

**Refuses `permissions`, `enabledToolGroups`, and `tierCeiling` on `PATCH /api/agents/current` and `PATCH /api/mesh/agents/:id`** — see those routes above; this is the only door in.

**Responses:**

- `200` - `{ changes: PermissionChange[], permissions: AgentPermissionsResponse }`

## Relay Endpoints

All relay endpoints are under `/api/relay/` and are mounted only when Relay is on (`relay.enabled`, default `true`, or the `DORKOS_RELAY_ENABLED` override; see [Feature Flags](#feature-flags)). When Relay is off, the relay router is not mounted and requests return 404.

### POST /api/relay/messages

Send a message to a subject pattern.

**Request body:** `SendMessageRequest` (from `@dorkos/shared/relay-schemas`)

```json
{
  "subject": "relay.agent.task-runner",
  "payload": { "content": "Run the tests" },
  "from": "relay.agent.orchestrator",
  "replyTo": "relay.agent.orchestrator",
  "budget": { "maxHops": 5, "ttl": 300000 }
}
```

The server sets the sender (`routes/relay-message-sender.ts`, DOR-5151). The person's own turn (`sessionLauncherOf`, the chat route's rule) keeps the `from` it names. A verified agent sends from its own registered address, anyone else from `relay.external.http`, and a caller other than the person naming a `relay.human.*` sender is refused, except a verified agent, which is sent from its own address. A message that is not the person's has its turn-shaping payload fields and `responseContext` removed and carries its agent's marks (`launcherTurnCeiling`). A verified agent's message to a chat's own address (`relay.agent.<runtime>.<sessionId>`) meets the chat route's place rule (`routes/relay-chat-place.ts`, `chatPlaceRefusal`, DOR-5200) and gets the same `403 DESK_NOT_OWN` answer.

**Responses:**

- `200` - Message sent: `{ messageId: string, deliveredTo: number }`
- `400` - Validation error
- `401` - Login requires a credential, or `person_session_required` for an app window without a session
- `403` - Reserved sender, destination or reply address, `person_required` for a person's address from someone else, or `DESK_NOT_OWN` for a chat a verified agent may not send into

### GET /api/relay/messages

List messages with optional filtering and cursor-based pagination.

**Query params:**

- `subject` (optional) - Filter by subject pattern
- `status` (optional) - Filter by status: `new`, `cur`, `failed`
- `from` (optional) - Filter by sender
- `cursor` (optional) - ULID cursor for pagination
- `limit` (optional, default 50, max 100)

**Responses:**

- `200` - `{ messages: RelayEnvelope[], cursor?: string }`

### GET /api/relay/conversations

Grouped request/response exchanges with human-readable labels. Builds structured conversations from relay messages by pairing requests with their replies and resolving agent/session names.

**Responses:**

- `200` - `{ conversations: Conversation[] }`
- `500` - Server error

### GET /api/relay/messages/:id

Get a single message by ID.

**Responses:**

- `200` - `RelayEnvelope`
- `404` - Message not found

### GET /api/relay/endpoints

List all registered endpoints.

**Responses:**

- `200` - Array of `{ subject: string, description?: string }`

### POST /api/relay/endpoints

Register a new endpoint.

**Request body:** `EndpointRegistration`

```json
{
  "subject": "relay.agent.my-agent",
  "description": "My custom agent endpoint"
}
```

**Responses:**

- `201` - `{ subject: string, created: boolean }`
- `400` - Validation error

### DELETE /api/relay/endpoints/:subject

Unregister an endpoint.

**Responses:**

- `200` - `{ success: boolean }`
- `404` - Endpoint not found

### GET /api/relay/endpoints/:subject/inbox

Read inbox messages for a specific endpoint.

**Query params:**

- `status` (optional) - Filter by status
- `cursor` (optional) - ULID cursor
- `limit` (optional, default 50, max 100)

**Responses:**

- `200` - `{ messages: RelayEnvelope[], cursor?: string }`
- `404` - Endpoint not found

### GET /api/relay/dead-letters

List dead-letter messages (undeliverable).

**Query params:** Same as GET /api/relay/messages.

**Responses:**

- `200` - `{ messages: RelayEnvelope[], cursor?: string }`

### GET /api/relay/metrics

Relay system metrics.

**Responses:**

- `200` - `{ totalMessages: number, totalEndpoints: number, totalDeadLetters: number }`

### GET /api/relay/messages/:id/trace

Get delivery trace for a specific message. Available only when Relay is on.

**Responses:**

- `200` - Trace with spans:

```json
{
  "traceId": "tr_01HXYZ...",
  "spans": [
    {
      "spanId": "sp_01HXYZ...",
      "messageId": "01HXYZ...",
      "subject": "relay.agent.session-123",
      "operation": "publish",
      "status": "completed",
      "startedAt": "2026-02-25T10:00:00Z",
      "completedAt": "2026-02-25T10:00:01Z"
    }
  ]
}
```

- `404` - Message not found

### GET /api/relay/trace/metrics

Aggregate delivery metrics for the Relay system. Available only when Relay is on.

**Responses:**

- `200` - `DeliveryMetrics` aggregate:

```json
{
  "totalMessages": 1234,
  "totalDelivered": 1200,
  "totalFailed": 34,
  "avgDeliveryMs": 45.2,
  "p99DeliveryMs": 210.5
}
```

## Adapter Catalog Endpoints

All adapter catalog endpoints are under `/api/relay/adapters/` and are available only when Relay is on. They are only mounted when `AdapterManager` is available.

### GET /api/relay/adapters/catalog

Returns the adapter catalog with manifests and running instances for each adapter type, in the order the setup list shows them. Pages with `cursor` and `limit` (1 to 200, default 50): pass `nextCursor` back as `cursor` for the next page; it is `null` on the last. A cursor this list did not give is a `400 invalid_request`.

**Responses:**

- `200` - One page of `CatalogEntry` objects, `{ entries: CatalogEntry[], nextCursor }`:

```json
{
  "entries": [
  {
    "manifest": {
      "type": "telegram",
      "displayName": "Telegram",
      "description": "Send and receive messages via a Telegram bot.",
      "iconId": "telegram",
      "category": "messaging",
      "builtin": true,
      "multiInstance": false,
      "configFields": [...]
    },
    "instances": [
      {
        "id": "telegram",
        "enabled": true,
        "status": { "state": "connected", "messageCount": { "inbound": 42, "outbound": 15 }, "errorCount": 0 }
      }
    ]
  }
  ],
  "nextCursor": null
}
```

- `400` - `invalid_request`: a bad `limit`, another query field, or a cursor this list did not give
- `500` - Internal error

### POST /api/relay/adapters/reload

Hot-reload adapter configuration from disk without server restart.

**Responses:**

- `200` - `{ ok: true }`
- `500` - Reload failed

### POST /api/relay/adapters

Create a new adapter instance. Persists to `~/.dork/relay/adapters.json` and starts the adapter.

**Request body:**

```json
{
  "type": "webhook",
  "id": "github-webhook",
  "config": {
    "inbound": { "subject": "relay.webhook.github", "secret": "min-16-char-secret" },
    "outbound": { "url": "https://example.com/hook", "secret": "min-16-char-secret" }
  },
  "enabled": true
}
```

All of `type`, `id`, and `config` are required. `enabled` defaults to `true`.

**Responses:**

- `201` - Created: `{ ok: true, id: "github-webhook" }`
- `400` - Missing required fields or validation error
- `409` - Duplicate ID (`DUPLICATE_ID`)
- `400` - Unknown adapter type (`UNKNOWN_TYPE`)
- `400` - Single-instance adapter already exists (`MULTI_INSTANCE_DENIED`)

**Error codes** (in `code` field):

| Code                    | HTTP | Description                                      |
| ----------------------- | ---- | ------------------------------------------------ |
| `DUPLICATE_ID`          | 409  | An adapter with this ID already exists           |
| `UNKNOWN_TYPE`          | 400  | The adapter type is not recognized               |
| `MULTI_INSTANCE_DENIED` | 400  | Adapter type does not support multiple instances |

### DELETE /api/relay/adapters/:id

Remove an adapter instance. Stops the adapter and removes it from config.

**Responses:**

- `200` - `{ ok: true }`
- `404` - Adapter not found (`NOT_FOUND`)
- `400` - Cannot remove built-in adapter (`REMOVE_BUILTIN_DENIED`)

### PATCH /api/relay/adapters/:id/config

Update an adapter's configuration. Triggers a hot-reload of the adapter.

**Request body:**

```json
{
  "config": {
    "token": "new-bot-token",
    "mode": "webhook"
  }
}
```

The `config` field is required and replaces the adapter's configuration.

**Responses:**

- `200` - `{ ok: true }`
- `400` - Missing `config` field
- `404` - Adapter not found (`NOT_FOUND`)

### POST /api/relay/adapters/test

Test an adapter connection without persisting. Creates a temporary adapter instance, attempts to start it, and reports success or failure.

**Request body:**

```json
{
  "type": "telegram",
  "config": {
    "token": "123456:ABC...",
    "mode": "polling"
  }
}
```

Both `type` and `config` are required.

**Responses:**

- `200` - `{ ok: true }`
- `400` - Missing required fields
- `500` - Test failed: `{ error: "Connection timeout" }`

## Binding Endpoints

All binding endpoints are under `/api/relay/bindings/` and are available only when Relay is on. They manage adapter-to-agent routing rules.

### GET /api/relay/bindings

List the adapter-agent bindings, newest first. Pages with `cursor` and `limit` (1 to 200, default 50): pass `nextCursor` back as `cursor` for the next page; it is `null` on the last. A cursor this list did not give is a `400 invalid_request`.

**Responses:**

- `200` - `{ bindings: AdapterBinding[], nextCursor: string | null }`
- `400` - `invalid_request`: a bad `limit`, another query field, or a cursor this list did not give
- `503` - Binding subsystem not available

### GET /api/relay/bindings/:id

Get a single binding by ID.

**Responses:**

- `200` - `{ binding: AdapterBinding }`
- `404` - Binding not found
- `503` - Binding subsystem not available

### POST /api/relay/bindings

Create a new adapter-agent binding. Zod-validated via `CreateBindingRequestSchema`.

**Request body:**

```json
{
  "adapterId": "telegram",
  "agentId": "my-agent",
  "projectPath": "/path/to/project",
  "chatId": "12345",
  "channelType": "telegram",
  "sessionStrategy": "per-chat",
  "label": "Telegram to project agent"
}
```

`adapterId`, `agentId`, and `projectPath` are required. `sessionStrategy` defaults to `per-chat`. `permissionMode` defaults to `acceptEdits` (controls the Claude Code permission mode for sessions created by this binding). `chatId`, `channelType`, and `label` are optional.

**Responses:**

- `201` - `{ binding: AdapterBinding }`
- `400` - Validation error
- `503` - Binding subsystem not available

### PATCH /api/relay/bindings/:id

Update an existing binding's fields.

**Request body:** Partial update — all fields optional:

```json
{
  "sessionStrategy": "per-chat",
  "label": "Updated label",
  "chatId": "67890",
  "channelType": "telegram"
}
```

**Responses:**

- `200` - `{ binding: AdapterBinding }`
- `400` - Validation error
- `404` - Binding not found
- `503` - Binding subsystem not available

### DELETE /api/relay/bindings/:id

Delete an adapter-agent binding.

**Responses:**

- `200` - `{ ok: true }`
- `404` - Binding not found
- `503` - Binding subsystem not available

## Mesh Endpoints

All mesh endpoints are under `/api/mesh/` and are always mounted (no feature flag). The Mesh subsystem initializes automatically on server startup.

**Who may call them** (DOR-4978): the capability mount serves every mesh route but `PATCH /api/mesh/agents/:id`, the heartbeat, `GET /agents/paths`, `/agents/:id`, `/agents/:id/access` and `/agents/:id/health`, which stay by hand (`services/mesh/doors/mesh-capabilities.ts`). The reads it serves (`GET /agents`, `/status`, `/topology`) are open to agents. In `GET /agents` and `/topology`, an agent reading another agent gets it without `persona`, `conventions`, `permissions`, `mcpServers`, `workspace` and `projectPath`, and `/status` gives an agent `byProject` empty. The hand reads (`/agents/:id`, `/agents/:id/access`, `/agents/paths`, `/agents/:id/health`) are unchanged and still show every caller those fields. Every other route here (discover, register, remove, delete with data, deny, the denied list and its clearing, the access rules) is person-only: an agent, an approval token, an API key or any `Authorization` header gets `403 person_only`. Agents use the `mesh_*` tools for those.

Mesh manages an in-memory registry of discovered agent peers. Agents heartbeat to maintain their presence and query the topology to find collaborators.

### POST /api/mesh/discover

Trigger peer discovery for a given working directory. Scans for `.dork/agent.json` files in ancestor and sibling directories.

**Request body:**

```json
{
  "cwd": "/path/to/project"
}
```

**Responses:**

- `200` - `{ candidates: DiscoveryCandidate[] }`
- `400` - Missing `cwd`

### POST /api/mesh/agents

Register an agent in the mesh.

**A directory that already holds a `.dork/agent.json` is adopted, never overwritten** (DOR-1019). The file is left byte-identical and the agent it describes is what gets registered, so the returned `id` and `name` can differ from the ones sent — `overrides` apply only to a directory with no manifest, and may be omitted entirely when there is one to adopt (`overrides.name` and `overrides.runtime` are required only for a fresh directory, which is what the `400` below means). A manifest that is present but unreadable, or that names an agent already registered somewhere else, is refused with a `422` naming the file. Registration also clears any denial recorded against the directory, which is how a folder unregistered while git tracked its manifest is taken back on.

**Request body:** `AgentManifest` (from `@dorkos/shared/mesh-schemas`)

```json
{
  "id": "agent-abc123",
  "name": "backend-agent",
  "cwd": "/path/to/project",
  "runtime": "claude-code"
}
```

**Responses:**

- `201` - Registered `AgentManifest`
- `400` - Validation error

### GET /api/mesh/agents/paths

Lightweight agent list returning only IDs and project paths. Used by onboarding and scheduling UIs.

**Responses:**

- `200` - `{ agents: { id: string, projectPath: string }[] }`

### GET /api/mesh/agents

List all registered agents in the mesh.

**Responses:**

- `200` - `{ agents: AgentManifest[] }`

### PATCH /api/mesh/agents/:id

Update a registered agent's manifest fields.

**Request body:** Partial `AgentManifest`

**Refuses `permissions`, `enabledToolGroups`, and `tierCeiling` by name** (`retiredPermissionFields` in `routes/mesh.ts`, spec `agent-permissions` D13): what an agent may do is set only through the Permissions page (`PATCH /api/agents/:id/permissions`), and the two retired fields that used to answer the same question are refused so a caller still sending one learns where the setting went instead of a `200` that changed nothing.

**Responses:**

- `200` - Updated `AgentManifest`
- `400` - Validation error
- `400` - `{ "error": "...", "code": "USE_PERMISSIONS_API", "fields": [...] }` when the body names `permissions`, `enabledToolGroups`, or `tierCeiling`
- `404` - Agent not found

### DELETE /api/mesh/agents/:id

Unregister an agent from the mesh. Deletes its `.dork/agent.json` so the next scan does not adopt it back — **unless git is tracking that file**, in which case it belongs to somebody's repository: the file is left alone and the directory is denied instead, which keeps the agent from returning without touching the repo (DOR-1019). Registering the directory again clears that denial.

**Responses:**

- `200` - `{ success: true, blockedFromDiscovery: boolean }` — `blockedFromDiscovery` is `true` when the manifest was kept and the folder denied, so the app can tell the person about the second effect
- `404` - Agent not found

### DELETE /api/mesh/agents/:id/data

Unregister an agent and delete its whole `.dork/` directory.

**Responses:**

- `200` - `{ success: true, deletedPath: string }`
- `403` - Path outside boundary
- `404` - Agent not found, or it has no project path
- `409` - Its `.dork/agent.json` is tracked by git, so the directory is not DorkOS's to delete. Unregister without data instead (DOR-1019)

### GET /api/mesh/agents/:id/access

Get the access control list for an agent — which other agents are permitted to communicate with it.

**Responses:**

- `200` - `{ allowedAgents: string[] }`
- `404` - Agent not found

### GET /api/mesh/agents/:id/health

Get health status for a registered agent.

**Responses:**

- `200` - `AgentHealth` object:

```json
{
  "agentId": "agent-abc123",
  "status": "healthy",
  "lastHeartbeat": "2026-02-25T10:00:00Z",
  "uptimeSeconds": 3600
}
```

- `404` - Agent not found

### POST /api/mesh/agents/:id/heartbeat

Record a heartbeat for a registered agent. Agents should call this periodically to maintain their presence in the mesh. Stale agents (no heartbeat within the configured TTL) are removed from active topology.

**Responses:**

- `200` - `{ ok: true }`
- `404` - Agent not found

### GET /api/mesh/topology

Get the full mesh topology — all registered agents and their peer relationships.

**Responses:**

- `200` - `{ agents: AgentManifest[], edges: { from: string, to: string }[] }`

### PUT /api/mesh/topology/access

Update access control rules for the topology. Defines which agents may communicate with which.

**Request body:**

```json
{
  "rules": [{ "from": "agent-abc123", "to": "agent-def456" }]
}
```

**Responses:**

- `200` - `{ ok: true }`
- `400` - Validation error

### POST /api/mesh/deny

Add an agent to the deny list. Denied agents cannot communicate with any mesh member.

**Request body:**

```json
{
  "agentId": "agent-abc123",
  "reason": "Unauthorized access attempt"
}
```

**Responses:**

- `200` - `{ ok: true }`
- `400` - Missing `agentId`

### GET /api/mesh/denied

List all denied agents.

**Responses:**

- `200` - `{ denied: DenialRecord[] }`

### DELETE /api/mesh/denied?path=

Clear the denial on a folder. The folder rides in the `path` query parameter, never a path segment: Remote Access refuses an encoded `/` or `\` in a URL path (DOR-4212).

**Responses:**

- `200` - `{ success: true }`
- `400` - Missing path, or one holding `..` or a NUL
- `403` - Path outside the boundary

### GET /api/mesh/status

Get overall mesh status — counts of registered, healthy, and denied agents.

**Responses:**

- `200` - `MeshStatus` object:

```json
{
  "totalAgents": 5,
  "healthyAgents": 4,
  "deniedAgents": 1,
  "lastDiscoveryAt": "2026-02-25T10:00:00Z"
}
```

## Models Endpoint

### GET /api/models

Returns the models supported by the resolved runtime — whichever runtime that is, not Claude's specifically. Resolution is `?runtime=` > `?sessionId=` > the registry default; a non-Claude default returns that runtime's own catalog. Includes display names and descriptions for each model.

No feature flag required — always mounted.

**Responses:**

- `200` - `{ models: ModelOption[] }`:

```json
{
  "models": [
    {
      "id": "claude-opus-4-5",
      "name": "Claude Opus 4.5",
      "description": "Most capable model for complex tasks"
    },
    {
      "id": "claude-sonnet-4-5",
      "name": "Claude Sonnet 4.5",
      "description": "Balanced performance and speed"
    }
  ]
}
```

### GET /api/subagents

Returns the subagents reported by the resolved runtime — `?sessionId=`'s runtime, else the registry default, whichever runtime that is. Values are cached by `RuntimeCache` and refreshed on `reloadPlugins()`.

No feature flag required — always mounted.

**Responses:**

- `200` - `{ subagents: SubagentInfo[] }`:

```json
{
  "subagents": [
    {
      "name": "Explore",
      "description": "Fast agent specialized for exploring codebases",
      "model": "claude-haiku-4-5"
    }
  ]
}
```

## Capabilities Endpoint

### GET /api/capabilities

Returns capability flags for all registered agent runtimes and the current default runtime type. This enables the client to gate UI features (e.g., tool approval, cost tracking) behind runtime capability checks.

No feature flag required — always mounted.

**Responses:**

- `200` - `{ capabilities: Record<string, RuntimeCapabilities>, defaultRuntime: string }`.

`RuntimeCapabilities` is declared in `packages/shared/src/agent-runtime.ts`. It includes feature flags such as `supportsMcp`, `supportsManagedMcpServers`, `supportsToolApproval` and `supportsAccounts`, plus structured `permissionModes: { supported, values }`. The old top-level `supportsPermissionModes` and `supportedPermissionModes` fields are not the current shape.

The map is keyed by registered runtime type; it is not a fixed Claude-only inventory. `defaultRuntime` names the server's default for an unbound selection, not the runtime of every active session. Resolve an existing session's runtime before selecting its capability profile. See [adding a runtime](adding-a-runtime.md#runtimecapabilities) and the generated [runtime capability matrix](capabilities/runtimes.md).

## Discovery Endpoint

### POST /api/discovery/scan

SSE endpoint that streams agent discovery results. Performs a BFS filesystem scan for AI-configured projects (AGENTS.md, .claude/, .cursor/, .dork/agent.json markers). No feature flag required.

**Request body:**

```json
{
  "roots": ["/home/user/projects"],
  "maxDepth": 3,
  "timeout": 30000
}
```

`roots` is required (array of directory paths to scan). `maxDepth` (default 4) and `timeout` (default 30000ms) are optional.

**Response:** `text/event-stream` with these event types:

- `candidate` - Discovered project: `{ path, markers, runtime, name }`
- `progress` - Scan progress: `{ scannedDirs, currentDir }`
- `complete` - Scan finished: `{ totalCandidates, scannedDirs, duration }`
- `error` - Scan error: `{ message }`

All `roots` paths are validated against the configured directory boundary (403 if outside).

## File Uploads

### POST /api/uploads

Upload files to a session's working directory for agent access. Files are stored in `{cwd}/.dork/.temp/uploads/` with sanitized filenames. The returned `savedPath` values can be injected into message text so the agent reads them with its existing filesystem tools.

**Content-Type:** `multipart/form-data`

**Query parameters:**

| Parameter | Type   | Required | Description                                  |
| --------- | ------ | -------- | -------------------------------------------- |
| `cwd`     | string | Yes      | Working directory where files will be stored |

**Form field:** `files` (one or more files)

**Limits** (from `uploads` config section):

| Setting        | Default | Description                         |
| -------------- | ------- | ----------------------------------- |
| `maxFileSize`  | 10 MB   | Maximum size per file               |
| `maxFiles`     | 10      | Maximum number of files per request |
| `allowedTypes` | `*/*`   | MIME type filter                    |

**Success response (200):**

```json
{
  "uploads": [
    {
      "originalName": "design.png",
      "savedPath": "/home/user/myproject/.dork/.temp/uploads/1741567200000-design.png",
      "filename": "1741567200000-design.png",
      "size": 204800,
      "mimeType": "image/png"
    }
  ]
}
```

**Error responses:**

- `400` — Missing `cwd`, no files provided, file too large, or MIME type not allowed
- `403` — `cwd` is outside the configured directory boundary

### GET /api/uploads/:filename

Serve an uploaded file by filename. Used by the client to render image thumbnails in chat history.

**Path parameters:**

| Parameter  | Type   | Description                                     |
| ---------- | ------ | ----------------------------------------------- |
| `filename` | string | Sanitized filename (as returned by POST upload) |

**Query parameters:**

| Parameter | Type   | Required | Description                                 |
| --------- | ------ | -------- | ------------------------------------------- |
| `cwd`     | string | Yes      | Working directory where files were uploaded |

**Success response (200):** File content with appropriate MIME type.

**Error responses:**

- `400` — Missing `cwd` query parameter
- `403` — `cwd` is outside the configured directory boundary, or resolved path escapes upload directory
- `404` — File not found in the upload directory
- `500` — Internal server error

**Security:**

- `path.basename()` strips directory components from the filename parameter
- Resolved path is validated to stay within `{cwd}/.dork/.temp/uploads/`
- Directory boundary validation via `validateBoundary(cwd)`

## Validation Errors

Invalid requests return HTTP 400 with a structured error body:

```json
{
  "error": "Invalid request",
  "details": {
    "content": { "_errors": ["Required"] }
  }
}
```

The `details` field contains Zod's formatted error output, mapping field names to their validation errors.

## MCP Server

The DorkOS server embeds a standards-compliant MCP server at `/mcp` using Streamable HTTP transport. External MCP clients can connect and use the tools this server exposes to their caller, subject to permissions and feature availability.

The MCP endpoint is a protocol endpoint, not a REST API. It speaks JSON-RPC and is mounted at `/mcp` (not under `/api/`).

### Endpoint

| Method | Path   | Description                                          |
| ------ | ------ | ---------------------------------------------------- |
| POST   | `/mcp` | JSON-RPC requests (tool calls, initialize, etc.)     |
| GET    | `/mcp` | Returns 405 (stateless mode, no SSE)                 |
| DELETE | `/mcp` | Returns 405 (stateless mode, no session termination) |

The server operates in **stateless mode** — each POST request creates a fresh transport. There are no persistent sessions or SSE streams on the MCP endpoint.

### Authentication

`honoMcpAuth('mcp')` in `apps/server/src/middleware/mcp-auth.ts` uses `gateAccessFor` from `apps/server/src/services/core/auth/gate-policy.ts`. The caller's route and server role decide whether local-token or tokenless access is available; `auth.enabled` only controls the password requirement on this computer.

The credential acceptors are the static `MCP_API_KEY` override, a per-user API key or browser session via `verifyRequestAuth`, the not-yet-seeded legacy config key, then the local MCP token where the request policy permits it. A refused request class cannot enter through any of them. On Wi-Fi, this verifier ignores session cookies for MCP and A2A and requires a bearer key.

Where the earlier app-wide session gate requires a credential on `/mcp`, a browser session or per-user API key must clear it before this middleware runs; a local token or static MCP override alone does not clear that gate. On an open local request, the parsed JSON-RPC body can use the closed read-only carve-out. Mutating or unknown calls still need a credential. Another device and a sealed agent computer get no tokenless carve-out.

A middleware refusal is a JSON-RPC error envelope. It names the local-token path only where that token would work, and never includes its value. A refusal from the earlier session gate uses `{ error: 'Unauthorized', code: 'AUTH_REQUIRED' }`. See [Authentication](authentication.md#mcp-4-tier-resolution--legacy-seeding) for the acceptor order and caller cases.

### Origin Validation

The MCP endpoint validates the `Origin` header to prevent DNS rebinding attacks, as required by the MCP specification. Non-browser clients (curl, Claude Code CLI, Agent SDK apps, every MCP SDK transport) send no `Origin` header and pass through — a stated option on the shared policy, not an accident, since a browser is the only caller the header can judge.

Since DOR-1711 the decision is `isTrustedBrowserOrigin` in `apps/server/src/lib/trusted-origins.ts` — the one origin policy, read by CORS, by the three MCP mounts, and by the WebSocket upgrade. A browser request passes if its origin is a loopback dev origin, the live tunnel, an entry in `DORKOS_CORS_ORIGIN`, or same-origin with this request's own `Host` (which covers a remapped host port and a reverse proxy). On the MCP mounts the same-origin branch is paired with the host allowlist, because `hostGuard` covers `/api` only, so a DNS-rebound page is still refused.

### Middleware Chain

Requests to `/mcp` pass through this middleware chain in order:

1. `validateMcpOrigin` — DNS rebinding protection (checks `Origin` header)
2. `requireMcpEnabled` — clean `503` when the MCP surface is switched off
3. `honoMcpAuth('mcp')` — credential resolution + the open-local read carve-out (checks credentials, then the parsed body)
4. `mcpRateLimiter` — per-connection rate limiting
5. `createMcpRouter(...)` — Streamable HTTP transport handler

The app-wide `sessionGate` sits ahead of all five (one step in the Hono chain, `http/api-chain.ts`), which is why it can answer an uncredentialed request before `honoMcpAuth` wherever the per-request policy requires a credential.

### Available Tools

Use `tools/list` for the current tool names and schemas. The server includes core, scheduling, messaging, marketplace and extension tools, but it is not an unconditional copy of every internal tool. `resolveToolVisibilityFor` filters Blocked actions for the caller when the per-request server is built (`apps/server/src/startup/steps/mcp-tasks-skills.ts`). Feature-specific tools can also depend on their service. Tool visibility does not replace invocation-time permission enforcement.

The `open_canvas` UI command accepts an optional `content` field. When `content` is omitted, the canvas opens with a splash screen. When provided, `content` is a `UiCanvasContent` object (markdown, code, etc.) displayed immediately. `preferredWidth` (20-80, percentage) is also optional.

### Resources

Alongside its tools, DorkOS exposes read-only `dorkos://` resources: the same underlying data as the tools above, addressed by URI instead of a tool call, for hosts that render resource catalogs (`resources/list`) directly. All resources return `application/json`.

**Both MCP servers register the same set**, from one place: `registerDorkOsResources` in `apps/server/src/services/core/mcp-resources/`. The external `/mcp` server and the in-session `dorkos` tool server each call it once, so an in-session agent can ask "what sessions are open?" exactly like a third-party MCP client (spec `agents-as-operators`). Session and skill reads are scoped to a project directory: the session's own working directory in-session, and the server's default project on `/mcp`, which has no per-request `cwd` to key on.

| URI                      | Kind     | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dorkos://sessions`      | Static   | Sessions across every registered runtime, aggregated like `GET /api/sessions` (degrades per runtime instead of failing). Each row carries the same metadata-only fields as the item template below — narrower than the route's `SessionSchema`; in particular `lastMessagePreview` is stripped.                                                                                                                                                                  |
| `dorkos://sessions/{id}` | Template | One session's metadata only — `id`, `title`, `runtime`, `cwd`, `updatedAt`. Never the transcript or message content.                                                                                                                                                                                                                                                                                                                                             |
| `dorkos://agents`        | Static   | Every agent registered with Mesh — the same manifests `mesh_list` returns                                                                                                                                                                                                                                                                                                                                                                                        |
| `dorkos://agents/{id}`   | Template | One agent's `.dork/agent.json` manifest, by ULID                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `dorkos://skills`        | Static   | Skills under `.agents/skills`, installed-package ones included — name and description only                                                                                                                                                                                                                                                                                                                                                                       |
| `dorkos://skills/{name}` | Template | One skill's full `SKILL.md` frontmatter and body, by name                                                                                                                                                                                                                                                                                                                                                                                                        |
| `dorkos://capabilities`  | Static   | The live capability catalog: every registry entry with its id, title, description, tier, input/output JSON Schema, and surfaces, plus a content-hash `catalogVersion`. The one surface that still serves the WHOLE catalog in one read: `list_capabilities` and `GET /api/capabilities/catalog` project it (compact by default, filtered, paged) so a discovery call cannot flood an agent's context, and a resource is pinned once rather than called per turn. |

Item templates (`{id}`/`{name}`) are not enumerated into `resources/list` — the corresponding collection resource already lists every valid id/name, so re-enumerating them individually would be redundant. Reading an unknown id/name returns a standard MCP `InvalidParams` error.

Neither server pushes `notifications/resources/list_changed`: the external one is stateless (a fresh `McpServer` per request, see above) and so cannot outlive the response it was created for, and the in-session one registers a fixed set that never changes during a query. Both `initialize` responses accordingly advertise `resources: { listChanged: false }`, which `registerDorkOsResources` sets explicitly because the MCP SDK's `registerResource()` otherwise advertises `true` with no opt-out. Resource _subscriptions_ (`resources/subscribe`) are not implemented at all, so that capability is never advertised either.

On `/mcp`, session and agent data flows through the same auth middleware chain as every tool (`validateMcpOrigin` → `requireMcpEnabled` → `honoMcpAuth` → `mcpRateLimiter` → the MCP router), so a resource read is authorized by that one chain — there is no separate resource-level auth gate. The login-off carve-out does not reach it: `resources/read` requires a credential even though a read-only `tools/call` does not. `dorkos://sessions` and `dorkos://sessions/{id}` include each session's `cwd`, matching what `GET /api/sessions` already returns to the same authenticated caller — not a new exposure, but called out here since it's the one field in these resources that names a filesystem path. Agent manifests (`dorkos://agents`, `dorkos://agents/{id}`) never include a filesystem path (`AgentManifest` has no `projectPath` field), matching `mesh_list`/`mesh_inspect`. The in-session surface is deliberately not gated further: those tools run in-process inside a session the user started, there is no HTTP hop to carry a token, and every payload is data the same agent can already reach through `mesh_list`, `GET /api/sessions`, or its own filesystem.

### Extension MCP Tools

Six tools enable agents to autonomously build and manage extensions:

#### `list_extensions`

- **Parameters**: None
- **Returns**: `{ extensions: ExtensionInfo[], count: number }`

Each extension includes: `id`, `name`, `version`, `status`, `scope`, `bundleReady`, optionally `description` and `error`.

#### `create_extension`

- **Parameters**:
  - `name` (string, required): Extension ID, kebab-case (e.g. `github-prs`). Must match `/^[a-z0-9][a-z0-9-]*$/`.
  - `description` (string, optional): Short description shown in settings UI
  - `template` (enum, optional): `dashboard-card` | `right-panel-tab` | `command` | `settings-panel` | `data-provider` (default: `dashboard-card`)
  - `scope` (enum, optional): `global` | `local` (default: `global`)
- **Returns**: `{ created: true, id, path, scope, template, status, bundleReady, files, message }`
- **Errors**: Directory already exists, no CWD for local scope, compilation failure (returns `created: true` with `status: 'compile_error'`)

#### `reload_extensions`

- **Parameters**:
  - `id` (string, optional): Extension ID for targeted hot-reload. Omit for full re-scan.
- **Returns** (single): `{ ok: true, extension: ReloadResult }`
- **Returns** (all): `{ ok: true, extensions: ExtensionRecordPublic[], count: number }`

Broadcasts an `extension_reloaded` SSE event to connected clients when extensions are successfully compiled.

#### `get_extension_errors`

- **Parameters**: None
- **Returns**: `{ errors: ExtensionInfo[], count: number }`

Filters to extensions with status `invalid`, `incompatible`, `compile_error`, or `activate_error`. Each error includes structured details.

#### `get_extension_api`

- **Parameters**: None
- **Returns**: Full ExtensionAPI type definitions and usage examples as markdown text

Always available even when the extension system is not initialized.

#### `test_extension`

- **Parameters**:
  - `id` (string, required): Extension ID to test
- **Returns** (success): `{ status: 'ok', id, contributions: Record<ExtensionPointId, number> }`
- **Returns** (error): `{ status: 'error', id, phase: 'compilation' | 'activation', errors?, error?, stack? }`

Compiles the extension and activates it against a server-side mock API. Reports per-slot contribution counts on success, or structured errors with file/line/column on failure.

### SSE Extension Events

**Endpoint**: `GET /api/extensions/events`

> **Still served; to be removed.** New code uses `GET /api/events` (event name: `extension_reloaded`). Under ADR `261123-170833` this stream is removed in the change that moves its callers onto `/api/events`.

**Event**: `extension_reloaded`

```json
{ "type": "extension_reloaded", "extensionIds": ["ext-id"], "timestamp": 1711461000000 }
```

- `extensionIds` — array of extension IDs that were reloaded
- `timestamp` — numeric epoch milliseconds (`Date.now()`)

Sent when extensions are recompiled via `reload_extensions` or `create_extension`. The client uses this to trigger a live reload of the extension bundle.

### Client Configuration

**Claude Code** (`~/.claude/settings.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "dorkos": {
      "type": "http",
      "url": "http://localhost:6242/mcp"
    }
  }
}
```

With API key:

```json
{
  "mcpServers": {
    "dorkos": {
      "type": "http",
      "url": "http://localhost:6242/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key-here"
      }
    }
  }
}
```

Via ngrok tunnel:

```json
{
  "mcpServers": {
    "dorkos": {
      "type": "http",
      "url": "https://your-tunnel.ngrok-free.app/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key-here"
      }
    }
  }
}
```

From another device `/mcp` is key-only: a per-user API key in the `Authorization` header. A sign-in cookie is ignored unless the request comes from this computer, and any query parameter named like a credential (`key`, `token`, `secret`, `auth`, `password`, `bearer`) is a `401` (`KEY_IN_QUERY` in `middleware/mcp-auth.ts`, DOR-3650).

**Cursor / Windsurf:** Add an MCP server in settings with URL `http://localhost:6242/mcp` and type `http`. If using an API key, configure the `Authorization: Bearer <key>` header in the MCP server settings.

## A2A Gateway

The A2A gateway implements Google's Agent-to-Agent protocol, exposing DorkOS agents to external A2A-compatible clients. Gated on the `a2a.enabled` setting (default `false`), which `DORKOS_A2A_ENABLED` overrules in both directions when present. Requires Relay.

Like the MCP endpoint, A2A is a protocol endpoint — it speaks JSON-RPC, not REST.

### Authentication

A2A rides the same middleware as `/mcp` — `honoMcpAuth('a2a')` — so the four credential acceptors are identical (the `MCP_API_KEY` override, a per-user Better Auth key or session, the legacy compat key, and the per-instance local token while login is off), all sent as `Authorization: Bearer <token>`. Only the no-match fallback differs, because A2A has no read/write annotation to carve on:

- **Login off:** an Agent Card `GET` passes tokenless — public discovery metadata, the `tools/list` analogue. Every JSON-RPC `POST` is `401` without a credential; **execution is always gated**, and has been since DOR-278 (`middleware/__tests__/mcp-auth.test.ts`).
- **Login on:** both are `401` without a credential — card discovery closes too. Unlike `/mcp`, `/a2a` is not an `isGatedPath` prefix, so `sessionGate` never runs on it and the `MCP_API_KEY` override does reach this surface.

Agent Cards describe the spec-standard `http`/`bearer` scheme **and advertise a `securityRequirements` entry for it unconditionally** (DOR-1824). That matches the gate: execution is token-gated in every posture, so the card says so in every posture, and a client that trusts the card alone attaches a bearer and is right. The requirement used to be derived from `authConfigured` — the network-reachable-credential signal the exposure guard keys on — which left the default login-off posture advertising nothing while every `POST` demanded the local token.

A card carrying that requirement does not claim the card endpoint is closed. A2A defines `securityRequirements` as the requirements for _contacting the agent_ — the endpoints in `supportedInterfaces` — so a tokenless card GET (the login-off row above) that declares a bearer requirement is the protocol-normal public card. The scheme's `description` names the header and nothing else: never a token value, never the local-token file path (`packages/a2a-gateway/src/__tests__/agent-card-generator.test.ts` pins that). The card/gate agreement is pinned across all three postures in `apps/server/src/__tests__/a2a-card-honesty.test.ts`. `authConfigured` in `index.ts` now feeds only the exposure guard.

### Deployment security

- **Closed to other devices.** Managed remote access and the own tunnel refuse `/a2a`, `/a2a/*` and `/.well-known/agent*` before routing (DOR-3650). The list is `REMOTE_REFUSED_PATHS` in `@dork-labs/cloud-api`, shared with any edge in front of the server; `isRefusedRemotePath` in `services/core/remote/managed-ingress.ts` applies it.
- **Exposure guard.** On a non-loopback `DORKOS_HOST` with no auth configured (no `MCP_API_KEY`, no legacy compat key, login disabled), the server refuses to mount the A2A gateway and its well-known card routes, logging the fix: set `MCP_API_KEY` or enable login. `DORKOS_ALLOW_INSECURE_BIND=true` overrides for containers that own their network boundary.
- **Rate limiting counts per connection, not per forwarded header.** JSON-RPC endpoints are limited to ~60 req/min and card endpoints to ~300 (`DORKOS_A2A_RPC_RATE_LIMIT` / `DORKOS_A2A_CARD_RATE_LIMIT` override). Every limiter keys on the TCP peer address through `middleware/rate-limit-key.ts` (DOR-1711); it used to key on `req.ip`, which the app's `trust proxy, 1` derives from `X-Forwarded-For`, so a caller on a direct bind could rotate spoofed values across unlimited buckets. Requests arriving through DorkOS's own tunnel share one bucket, because the ngrok agent runs in-process and forwards to the local port. Set `DORKOS_TRUST_PROXY=true` to get per-client buckets behind a proxy you control — and only then, since it means whoever reaches that proxy's upstream writes the key.
- **`contextId` is a caller-supplied partition key, not a per-principal boundary.** A2A-originated agent sessions are keyed on `agentId + contextId`: callers using distinct `contextId`s get distinct sessions, but under a shared credential (one static `MCP_API_KEY`) a caller who learns another caller's `contextId` can deliberately join that session. Treat `contextId` as a shared secret between a caller and the gateway (use unguessable values, e.g. UUIDs). Per-principal isolation is future work.
- **Advertised URLs.** Set `DORKOS_PUBLIC_URL` when DorkOS sits behind a proxy or tunnel so Agent Cards advertise a routable URL instead of the bind address (e.g. `http://0.0.0.0:4242`).

### GET /.well-known/agent-card.json

Fleet-level Agent Card describing all registered DorkOS agents as a single A2A-compatible agent. This is the standard A2A discovery endpoint (`AGENT_CARD_PATH` in the A2A spec). The pre-spec `/.well-known/agent.json` path is kept as a legacy alias during the transition.

**Responses:**

- `200` - A2A Agent Card (JSON) with agent name, description, URL, and supported capabilities

### GET /a2a/agents/:id/card

Per-agent Agent Card for a specific registered agent.

**Path parameters:**

| Parameter | Type   | Description                     |
| --------- | ------ | ------------------------------- |
| `id`      | string | Agent ID from the Mesh registry |

**Responses:**

- `200` - A2A Agent Card (JSON) for the specified agent
- `404` - Agent not found in the Mesh registry

### POST /a2a/agents/:id

Per-agent JSON-RPC 2.0 endpoint — the `url` advertised on each per-agent Agent Card. Binds the target agent from the URL, so no `metadata.agentId` is needed (a conflicting one is rejected). Returns a JSON-RPC 404 error for an unknown agent.

### POST /a2a

Fleet-level JSON-RPC 2.0 endpoint for A2A protocol messages. Every message must target one agent: set `metadata.agentId` on the message (or continue an existing task via `taskId`) — untargeted messages are rejected with an actionable JSON-RPC `-32602` error, never routed to an arbitrary agent. Supports the standard A2A methods:

| Method           | Description                                    |
| ---------------- | ---------------------------------------------- |
| `message/send`   | Send a message and receive a complete response |
| `message/stream` | Send a message and stream the response via SSE |
| `tasks/get`      | Get the current state of a task                |
| `tasks/cancel`   | Stop an in-progress task's turn (see below)    |

**Request body:** JSON-RPC 2.0 envelope:

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [{ "type": "text", "text": "Run the tests" }],
      "metadata": { "agentId": "01HZB1AGENTULID0000001" }
    }
  }
}
```

**Responses:**

- `200` - JSON-RPC 2.0 response (for `message/send`, `tasks/get`, `tasks/cancel`)
- `200` - SSE stream (for `message/stream`, `Content-Type: text/event-stream`)
- `400` - Invalid JSON-RPC request
- `404` - Unknown method

**Cancellation (DOR-791).** A turn runs inside a runtime adapter, not inside the gateway, so
`tasks/cancel` publishes an `agent_cancel` stop request to `relay.control.agent-cancel.{taskId}`
(payload names the turn by its per-execution reply subject; principal
`relay.system.a2a.gateway`, which the adapter's subscription enforces). The adapter aborts the
turn and calls the runtime's `interruptQuery` — abandoning the reply stream stops nothing. The
task is marked `canceled` only when a runner takes the stop; otherwise the gateway raises
`TaskNotCancelable` (-32002) and leaves the task in its current state, because it is still
running. The 2-minute response timeout publishes the same stop request with reason
`caller_timeout` and logs whether it was taken.
