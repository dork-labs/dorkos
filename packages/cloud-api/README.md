# @dork-labs/cloud-api

The public wire contract for DorkOS Cloud: Zod schemas for the `/v1` surface, the types they
infer, the route table, and a thin `fetch` client.

This package is the agreement between the DorkOS app and the hosted service. Both sides build
against it, and neither side gets to change the wire without changing it here first.

```bash
npm install @dork-labs/cloud-api zod
```

## Two entry points

```ts
// Schemas, types and route paths. No network code, so you can validate
// a payload without pulling in a client.
import { EntitlementsSchema, ProblemSchema, V1_ROUTES, v1Path } from '@dork-labs/cloud-api';

// The thin fetch client. No Node-only import, so a CLI, a server and a
// browser can all use it.
import { createCloudApiClient } from '@dork-labs/cloud-api/client';

const cloud = createCloudApiClient({
  baseUrl: process.env.MY_CLOUD_ORIGIN!, // no origin is baked into this package
  token: () => myTokenStore.read(),
});

const entitlements = await cloud.get(V1_ROUTES.entitlements, EntitlementsSchema);
const seat = await cloud.get(v1Path.seat(seatId), SeatSchema);
```

Every response is either the route's success schema or the `Problem` envelope. The client throws
`CloudApiProblemError` for a refusal the service described, and `CloudApiResponseError` when the
body is neither.

## What is in the contract

| Group                     | Covers                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session and account       | `GET /v1/session`, `GET /v1/account`, `POST /v1/account/export`                                                                                                          |
| Device link               | `POST /v1/device/code`, `POST /v1/device/token` (RFC 8628)                                                                                                               |
| Instances                 | heartbeat, revoke, list, organization re-link                                                                                                                            |
| Managed connections       | catalog, toolkits, connections, authentication flows, authority commands, executions, the lease-based event pull and acknowledgement, usage                              |
| Billing                   | `GET /v1/entitlements`, `/v1/balance`, `/v1/usage`, `/v1/price-list`, `/v1/nudge`, `POST /v1/checkout`, `/v1/topup`, `/v1/refunds`, `/v1/portal`, `GET /v1/statement`    |
| Inference                 | `POST /v1/inference/tokens`, `GET /v1/inference/models`, token revocation                                                                                                |
| Seats, orgs and addresses | organizations, membership, invitations, agents and claims, seats, addresses, grants, add-ons, the seat inbox, presence, the seat activity event                          |
| Remote access             | status, open/close, wake tokens, enrolment, canonical and custom addresses, designation, instance credentials, the command stream and its acknowledgement, event batches |
| Hosted communities        | `GET`/`POST /v1/communities`, the short-name check, a fresh owner-claim link, keep (with a preview of what it holds) and restore, and moves: start, list, poll, cancel   |
| Shared                    | the `Problem` envelope, bearer auth, cursor pagination, the `X-DorkOS-Wire: 1` header                                                                                    |

### What is deliberately not in it

The browser-facing `/api/auth/*` endpoints, the account and admin pages, and
`POST /api/instances/pending` are a user interface of one application rather than a
machine-to-machine wire. Publishing them would freeze a dependency's internals into a machine
contract. The two device-code endpoints are the one exception: they live under `/api/auth/` today
but are a machine wire, so they are here.

The closed-address browser surface — the page an address serves while the machine is asleep,
and the authorized reopen path on it — is excluded on the same grounds. The omission is a
decision, not a gap.

## The rules this package holds itself to

### Additive within a major

Within `/v1`, the only changes allowed are **new endpoints and new optional fields**. The service
accepts the previous minor of this package, so a client one release behind keeps working.

Removing a field, or making an optional field required, is a `/v2` change, served beside `/v1`
for at least two releases. A change to a field's meaning is the same thing wearing a disguise:
if code that was correct before is wrong after, it is not additive.

A route may accept **more than one request shape**. Publishing a second one beside the first is
additive; withdrawing the first is not. `POST /v1/topup` is the worked example: it takes
`TopupRequestSchema`, which names an amount, and still takes the `HostedPageRequestSchema` body
it took before.

**The response direction has its own rule, and it is the one that bites.** New members appear on
existing enums in a minor — a new `Problem` code, a new refusal reason — so **a consumer must
tolerate a value it has never seen**: show it rather than treat the response as broken. Parse the
envelope, render `title` and `detail`, and branch only on the members you recognise. A client
that hard-fails on an unknown member is a client that breaks on a release that added one, and
this package cannot stop that from the schema side, because refusing to enumerate the members
would leave a consumer with nothing to branch on at all.

The thin client cannot soften this for you today: a body whose `code` is not in the published set
fails `ProblemSchema` and arrives as `CloudApiResponseError` rather than `CloudApiProblemError`.
The raw body is attached, so `error.body` still carries the `code` and the `title` the service
sent. Widening `code` to an open string, so an unrecognised one stays a `Problem`, is a real
improvement and a deliberate `/v2`-shaped decision about a published type, not something to slip
into a minor.

**What that looks like in practice.** A new field arrives optional, even when the service needs
it: `AddressCreateRequestSchema.subject` and `SeatAssignRequestSchema.handle` are things the
server cannot do without, and they are still optional here, because a client one release behind
has to keep working while the row lands. Equally, a grammar the service already enforces is
published as its own export (`HandleSchema`) rather than applied to a field a caller already
sends — narrowing `handle` would make a request that parsed before fail afterwards, which is a
`/v2` change however sensible it looks.

### Catalog blindness

**No type here enumerates the subscription catalog or the model catalog.** `planId`, `skuId`,
`modelId`, add-on kinds, `catalogVersion` and every other catalog-shaped identifier are opaque
strings. Not a `z.enum`, and equally not a union of literals, a `z.nativeEnum`, a hand-written
string-literal union, a `const` array a schema is derived from, or a value named in a
`.describe()`, a `.default()` or an `@example`. "A new exported enum" reads through a union,
because a union is how a named export would otherwise publish a set of literals without ever
being asked to justify them.

A _value_ a caller happens to be on is fine. The _set_ is not: this package publishes to public
npm, and a `.d.ts` that enumerates the ladder publishes it permanently.

The practical consequence for consumers: subscription-specific interface behaviour is driven by
the **limit values** and the **server-supplied display string**, never by a switch on `planId`.
There is no compile-time exhaustiveness over subscriptions here, deliberately.

Enums that are fine, because they describe mechanism rather than catalog: the `Problem` codes,
the remote `mode` and `state`, `remoteAccess`, `customAddress`, `support`, `costBasis`, the
`supports` booleans, `groupBy`, the refusal reasons, the RFC 8628 error set, and a hosted
community's lifecycle, hold reason and move stages. Each one is
listed by name with its reason in `src/__tests__/catalog-blindness.test.ts`, and a new exported
enum fails that test until somebody writes down why it is mechanism.

### A refusal names the way out

A refusal a larger allowance would lift is `entitlement_required`, whatever the allowance is: a
count of communities, members or storage, or anything added later. The service writes the
`title` and `detail`, and may add an `actionUrl` (with an `actionLabel`) for the page where a
person can act on it. The app renders those as given and opens the URL; it never knows what the
person bought or what would change it. Limits reach the app as numbers
(`limits.communities`, `used.communities`, and each hosted community's `limits` and `usage`),
so it can say "this community is full" without naming a plan.

### Hosted communities

The service starts a community on a Community server and hands ownership to a person through
that server's single-use owner claim; it never owns one itself.

- **Two credentials, each returned once.** The claim link and a move's upload token appear only
  in the answer that created them (a start, a move start, or `claim-link`), never in a list or
  a poll. Both carry the `ONE_TIME_CREDENTIAL_META` marker, which
  reaches the JSON Schema too, and `src/__tests__/communities.test.ts` pins exactly where they
  may appear. A lost claim link is replaced by `claim-link`, which revokes the last; a lost
  upload token by cancelling the move and starting a new one.
- **Relay the parsed value, never the raw body.** Objects here are not strict, so a field the
  schema does not define is dropped by `parse`. A server that relays these answers to a browser
  (the DorkOS server does) must serialize what it parsed, so a credential a service leaks into
  the wrong shape stops there.
- **Links are checked by scheme.** A link the service sends a person to (`actionUrl`) is
  `https:` only (`HttpsUrlSchema`). A link to a Community server (`communityUrl`, `claimUrl`,
  an upload `url`) is `https:`, or `http:` to a loopback address for local use
  (`ServerUrlSchema`). Both rules are
  also a `pattern` in the JSON Schema. A malformed `actionUrl` or `actionLabel` is dropped
  rather than failing the whole refusal.
- **Retries are safe.** A start or a move takes an idempotency key, scoped to the caller. A
  repeat answers `replayed: true` and without the credential.
- **The upload goes straight to the Community server**, so the file never passes through the
  service. A mismatched or broken upload leaves the move waiting and the token usable until the
  window closes. A closed window fails the move with `upload_expired`; a failed or cancelled
  move frees its short name at once, so starting again with the same name works.
- **New states do not break a page.** A hosted community's `state` and hold `reason`, and a
  move's `state` and `failureCode`, are tolerant (`tolerantEnum`): a value added in a later
  release reads as `unrecognised`, and every other item in the list still parses. Render it
  generically. The known members stay published as their own enums.
- **Generate JSON Schema with `{ io: 'input' }`.** `tolerantEnum` maps an unknown value with a
  transform, and Zod cannot express a transform's output in JSON Schema. Call
  `z.toJSONSchema(schema, { io: 'input' })` (or pass `unrepresentable: 'any'`) for the
  communities shapes, or the conversion throws.

Every link to a community is a runtime value.

### Money is never a number

Every amount is an **integer count of micro-units carried as a string** (`MicroAmountSchema`). A
`z.number()` on an amount is a precision bug, not a style choice.

### No origin baked in

No host, origin or URL literal appears in this package. Inference endpoints are runtime values
the mint call returns, and the client takes its `baseUrl` from the caller.

No supplier is named anywhere. The two exceptions are the field names
`endpoints.anthropicMessages` and `endpoints.openaiChat`, and they are a deliberate carve-out
rather than an oversight: they name a **request format** a caller encodes in — both are de-facto
public standards — not a supplier a request is routed to. Which provider actually serves a
request is not part of this contract and is published nowhere.

### Where amounts appear, and where they do not

Three routes carry amounts, and it is worth being precise about which, because "no prices here"
would be a comfortable claim and a false one:

- **`GET /v1/price-list`** publishes the per-model list. That is its whole job.
- **`GET /v1/usage`** returns, per row and in the totals, both `listPriceMicro` (the upstream
  list price) and `dorkosPriceMicro` (what DorkOS charged). Publishing both means publishing the
  difference, and that is the point rather than an accident: somebody paying for inference
  through us can see exactly what the routing costs them without asking. If that ever stops
  being the intent, the field to drop is `listPriceMicro`, and dropping it is a `/v2` change.
- **`GET /v1/nudge`** returns one already-computed comparison — one subscription, one price, one
  subtraction the server already did. The client renders it and computes nothing.

Nothing else carries an amount. In particular, no inference route does: not a rate, not a
multiplier, not a unit cost. And no route anywhere carries a supplier's terms.

`POST /v1/topup` carries an amount in the request (`TopupRequestSchema`), and `POST /v1/refunds`
answers with the amount that came back. Neither publishes a minimum, a first-purchase ceiling or
a refund window: those are server policy, and a request that misses one is refused with
`topup_below_minimum`, `first_purchase_cap` or `refund_window_closed` rather than described here.

Fields typed `SecretValueSchema` are returned **once**: hold them as credential references, never
as configuration strings, and never log them.

## Conformance fixtures

`fixtures/v1/**.json` is a shared corpus of example payloads, with `fixtures/v1/index.json`
naming the exported schema that validates each one. Both sides of the wire can implement against
the same examples; `src/__tests__/fixtures.test.ts` proves every example is valid and that the
manifest and the directory have not drifted apart.

The corpus covers responses, stream events, and the request shapes a caller has to build itself
(a top-up, a refund, a command acknowledgement). Every example is synthetic: opaque identifiers,
RFC 2606 `.invalid` hosts, and no real catalog value anywhere.

```ts
import entitlements from '@dork-labs/cloud-api/fixtures/v1/billing/entitlements-free.json' with { type: 'json' };
```

## Versioning, and the range to depend on

This package's version **equals the DorkOS app version**, published atomically with it or not at
all.

That has a consequence worth stating plainly, because it bites silently. Lockstep bumps this
package's **minor** on every app release, and on a `0.x` version npm reads `^0.75.0` as
`>=0.75.0 <0.76.0`. **A caret range would lock you out of every future release.** While this
package is pre-1.0, depend on it as:

```json
{ "dependencies": { "@dork-labs/cloud-api": ">=0.75.0 <1" } }
```

or as an exact pin your own release process bumps.

## Dependencies

`zod` is a **peer dependency** (`^4.6.2`), so a consumer that already has it gets one copy rather
than two — two copies mean two answers to `instanceof`, and schemas that silently stop
recognising each other. The range names the lowest version actually built and tested against,
not the whole major: this package uses `z.iso.datetime` and Zod 4's `.def` internals, and a range
wider than what CI resolves would be a compatibility claim nothing checks.

There are **zero workspace dependencies**. Nothing here imports another package in this
monorepo, and nothing in `dependencies`, `peerDependencies` or `optionalDependencies` resolves to
one, so the package installs from public npm into a checkout that has none of this repository in
it. `src/__tests__/packaging.test.ts` proves it from the manifest, from the imports, and from the
workspace lockfile. The shared ESLint and TypeScript configs are `devDependencies`, which npm
strips from the published tarball.

## Development

```bash
pnpm --filter @dork-labs/cloud-api build       # ESM + .d.ts into dist/
pnpm --filter @dork-labs/cloud-api typecheck
pnpm --filter @dork-labs/cloud-api lint
pnpm vitest run packages/cloud-api             # from the repo root
```

The catalog-blindness suite has one case that needs the real catalog values, which cannot live in
this repository. Supply them to run it:

```bash
DORKOS_CATALOG_BLINDNESS_VALUES="value-a,value-b" pnpm vitest run packages/cloud-api
```

Unset, that case is reported as skipped rather than passing quietly. Set but empty, it fails.
