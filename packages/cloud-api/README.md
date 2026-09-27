# @dork-labs/cloud-api

The public wire contract for DorkOS Cloud: Zod schemas for the `/v1` surface, the types they
infer, the route table, and a thin `fetch` client.

This package is the agreement between the DorkOS app and the hosted service. Both sides build
against it, and neither side gets to change the wire without changing it here first.

```bash
npm install @dork-labs/cloud-api zod
```

## Three entry points

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

```ts
// One way to render an amount for a person. No Zod, no network code.
import { formatCharge, formatPosition } from '@dork-labs/cloud-api/display';
```

Every response is either the route's success schema or the `Problem` envelope. The client throws
`CloudApiProblemError` for a refusal the service described, and `CloudApiResponseError` when the
body is neither.

## What is in the contract

| Group                     | Covers                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session and account       | `GET /v1/session`, `GET /v1/account`, `POST /v1/account/export`                                                                                                                                                           |
| Device link               | `POST /v1/device/code`, `POST /v1/device/token` (RFC 8628)                                                                                                                                                                |
| Instances                 | heartbeat, revoke, list, organization re-link                                                                                                                                                                             |
| Managed connections       | catalog, toolkits, connections, authentication flows, authority commands, executions, the lease-based event pull and acknowledgement, usage, who a grant covers (one agent or every agent)                                |
| Billing                   | `GET /v1/entitlements`, `/v1/balance`, `/v1/usage`, `/v1/price-list`, `/v1/nudge`, `/v1/offers`, `POST /v1/checkout`, `/v1/topup`, `/v1/portal`, `GET /v1/statement`                                                      |
| Inference                 | `POST /v1/inference/tokens`, `GET /v1/inference/models`, token revocation                                                                                                                                                 |
| Seats, orgs and addresses | organizations, membership, invitations, agents and claims (an agent says whether a claim waits on approval, and which), seats, addresses, grants, add-ons, the seat inbox, presence, the seat activity event              |
| Remote access             | status, open/close, wake tokens, enrolment, canonical and custom addresses, designation and its read, usage against the published limits, instance credentials, the command stream and its acknowledgement, event batches |
| Hosted communities        | `GET`/`POST /v1/communities`, the short-name check, a fresh owner-claim link, keep (with a preview of what it holds) and restore, and moves: start, list, poll, cancel                                                    |
| Shared                    | the `Problem` envelope, bearer auth, cursor pagination, the `X-DorkOS-Wire: 1` header                                                                                                                                     |

### What is deliberately not in it

The browser-facing `/api/auth/*` endpoints, the account and admin pages, and
`POST /api/instances/pending` are a user interface of one application rather than a
machine-to-machine wire. Publishing them would freeze a dependency's internals into a machine
contract. The two device-code endpoints are the one exception: they live under `/api/auth/` today
but are a machine wire, so they are here.

Refunds are not offered through this API.
Earlier releases published `POST /v1/refunds` with `RefundRequestSchema` and
`RefundResponseSchema`; no release of the service ever answered it, and it is **withdrawn**. See
[Withdrawn within `/v1`](#withdrawn-within-v1).

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

### Withdrawn within `/v1`

Because nothing published is deleted within `/v1`, a shape the service stops offering is
**withdrawn** rather than removed: it stays exported and parses exactly as it did, it carries
`@deprecated` in the types and `"deprecated": true` in its JSON Schema, and the service answers its
route with `not_found`. Do not build against a withdrawn shape. It is deleted in `/v2`.

| Withdrawn                                                                               | Why                                                                                  |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /v1/refunds` (`V1_ROUTES.refunds`, `RefundRequestSchema`, `RefundResponseSchema`) | Refunds are not offered through the API. No release of the service ever answered it. |

Two things stay with it for the same reason. The `refund_window_closed` problem code stays in
`ProblemCodeSchema`, because taking a member out narrows a published type; no release of the service
sends it. And its two example payloads, `fixtures/v1/billing/refund-request.json` and `refund.json`,
stay in the fixture corpus, because a fixture path is an export too.

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

### A missing thing, or an unreadable request

Two codes answer two different facts, so a client can tell whether the address it asked about
resolves without parsing the path:

| Code                   | The fact                                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `malformed_identifier` | The address named nothing. An identifier in the path is not one the service could have issued (`/v1/seats/not-an-id`). Say there is no such thing.                                                   |
| `malformed_request`    | The address resolves, and the request to it could not be read: a bad cursor, limit, window, period or body, including an identifier carried in the query or the body. Fix the request and ask again. |
| `not_found`            | The identifier is well formed, and nothing by that identifier exists (or the caller may not see it). Say there is no such thing.                                                                     |

`malformed_identifier` is newer than `malformed_request`. A service that predates it sends
`malformed_request` for both of the first two facts, so from an older service that code cannot
rule out the first one.

A client one release behind this package does not get its old `malformed_request` handling for
the new code. An unrecognised code fails `ProblemSchema`, so the thin client raises
`CloudApiResponseError` rather than `CloudApiProblemError`, with `error.body.code` still carrying
`malformed_identifier` (see "Additive within a major" above). Move to this release before relying
on the service to send it.

### Remote usage and the designation

`GET /v1/remote/usage` answers where the caller's account stands against each published
remote-access limit this period. It takes a bearer or the person's own browser session and
always answers for the caller's own account. Each entry carries `limit` and `used` already in
its `unit`, and a `fraction` the server computed: render it, never recompute it, so a page can
never round differently from the service that enforces the limit. `enforceable: false` means
`used` is the period's peak rather than a figure for now, and such a limit frees as soon as the
usage ends. An account that used nothing gets zeroes, never a 404. Nothing in it is money.

`GET /v1/orgs/{orgId}/remote/designation` reads which instance the organization keeps always
available, with every field nullable so "nobody holds it" is a state. `cooldownUntil` says when
it may next change, before anybody tries. No route withdraws a designation.

`RemoteStatusSchema` may echo the `instanceId` it is about, so answers read concurrently can be
matched to their instance. Each close report in `POST /v1/remote/events` may name its span
(`openedAt` beside `at`), the requests in that span and the bytes each way. Byte counts are
base-10 strings (`ByteCountSchema`), because a long window can move more bytes than a JavaScript
number holds exactly. A batch without these fields is accepted as before.

Every `POST /v1/remote/events` request names its batch in an `Idempotency-Key` header
(`REMOTE_EVENTS_IDEMPOTENCY_HEADER`, value `RemoteEventBatchKeySchema`): an opaque string you
choose, one per batch, at most 200 characters. A request without it is refused with
`malformed_request`. When a batch's acknowledgement is lost, send it again with the same key;
when the contents change, use a new key. A key whose batch was already accepted from your instance
is answered `200` with `{ accepted: 0 }`: the batch was already applied, and nothing in it is
counted twice. A batch that was refused or failed was not accepted, so retrying it with its key
applies it.

### Tunnel credentials: which hostnames, and how a replacement arrives

A credential from `POST /v1/remote/credentials/issue` may carry `hosts`: every hostname the
instance should serve with it, its own address first. Serve each one, and stop serving any
hostname that is no longer listed; compare without regard to case. When `hosts` is absent,
keep serving as before: absent is not an empty list, and a present list is never empty. `acl`
stays opaque; do not parse it for names. A `rotate` command's `credentialId` is an issue key,
not a credential id: present it as the issue call's `idempotencyKey` to receive the
replacement, then confirm the replacement with the `credentialId` that call returns. If that
call is refused, keep the current credential; the service may offer another later.

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
  communities shapes, or the conversion throws. The same holds for `OffersResponseSchema`, whose
  `interval` is tolerant, for `RemoteUsageResponseSchema`, whose `unit` and `state` are tolerant,
  and for `AgentSchema`, whose `claimStatus` is tolerant, all for the same reason.

Every link to a community is a runtime value.

### Money is never a number

Every amount is an **integer count of micro-units carried as a string** (`MicroAmountSchema`). A
`z.number()` on an amount is a precision bug, not a style choice. A micro-unit is a millionth of
the major unit of the currency the response names.

### Money or credits: every amount says which

An amount is one of two kinds, and a renderer has to know which before it shows it: the same
string read the wrong way prints a price as a credit balance.

- **`MoneyMicroSchema`** (and `PositiveMoneyMicroSchema` for an amount to pay): money paid,
  refunded, offered or capped. The auto-reload ceiling, the usage and statement list price, the
  nudge's suggested plan price and saving, an offer's price and the top-up amount are money, and
  so is the amount on the withdrawn refund answer.
- **`CreditMicroSchema`**: credits held, spent or priced. Included credits, the balance's
  granted, remaining, pending, held and owed amounts, the usage and statement DorkOS price, the
  price-list rates and the nudge's trailing spend are credits.

Both have exactly the wire shape of `MicroAmountSchema` and both infer `string`, so nothing on
the wire or in a consumer's types moves. The kind is a `.meta({ amountKind })` mark
(`AMOUNT_KIND_META`), which reaches the JSON Schema as an `amountKind` keyword.
`src/__tests__/amount-kinds.test.ts` fails on an amount field without a mark or with the wrong
one.

### The denomination is served, never assumed

The entitlements, balance, usage, price-list, nudge, offers and statement responses carry an optional
`denomination` (`DenominationSchema`):

- `currency`, an ISO 4217 code: what the micro-units are millionths of;
- `microPerCredit`, a positive integer string: how many micro-units one credit is.

This package publishes no value for either. The service sends them, so the scale can change
without a client release and two clients can never disagree about it. **A client that receives
no `denomination` must not guess one**: show the surface's "could not read this" state instead.
The fixtures use the ISO 4217 test code `XTS` and a placeholder scale, and a test fails if any
fixture carries another.

```json
{ "heldMicro": "4700", "denomination": { "currency": "XTS", "microPerCredit": "250" } }
```

### Rendering an amount: `@dork-labs/cloud-api/display`

One formatter for every client, so the same balance reads the same everywhere. Each function
takes the amount string and the response's `denomination`, and returns a string, or `null` for
a malformed amount or a missing or malformed denomination. It never guesses.

| Function                                            | Kind                                           | Rounding                                                                                                                                           |
| --------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formatPosition(micro, denomination)`               | what someone has or may still spend            | down to whole credits, so no page shows credit that cannot be spent                                                                                |
| `formatCharge(micro, denomination)`                 | what someone spent, was charged or is held for | half away from zero to whole credits; `0` for zero; `<1` (or `-<1`) for a non-zero amount under half a credit                                      |
| `formatRate(micro, denomination)`                   | a price per unit of something                  | never rounded: every significant digit, trailing zeros trimmed (`null` if the scale cannot write it as a finite decimal)                           |
| `formatMoney(micro, { currency })`                  | money paid, refunded or offered                | to the currency's minor unit, half away from zero; an exactly whole amount has no minor digits; a tiny non-zero amount reads `<` the smallest unit |
| `formatCap(micro, { currency })`                    | a money limit                                  | as money, but rounded down, so a limit never reads higher than the one enforced                                                                    |
| `formatMoneyRate(micro, { currency })`              | a price in money                               | exact, with at least the currency's minor digits                                                                                                   |
| `formatCreditsWithMoney(micro, denomination, kind)` | a credit figure with its money value beside it | `<n> credits (<money>)`; the money comes from the rounded credit count, so the two always agree                                                    |
| `formatTotal(lines, denomination, kind)`            | a total                                        | the exact sum of the lines, rounded once; never the sum of rounded lines, so it may differ from them by a credit or two                            |

```ts
import { formatCharge, formatCreditsWithMoney } from '@dork-labs/cloud-api/display';

const balance = BalanceSchema.parse(body);
if (!balance.denomination) return couldNotRead();
formatCharge(balance.heldMicro, balance.denomination); // "19" for the example above
formatCreditsWithMoney(balance.allowance.remainingMicro, balance.denomination, 'position');
```

A rate's money always shows the minor digits and a position's or charge's money drops them
when the amount is whole, so one credit can read `1 credit (XTS 1.00)` as a rate and
`1 credit (XTS 1)` as a position. That is deliberate: a price keeps its precision, a quantity
reads plainly.

Digits come from `BigInt` alone, so no amount ever becomes a JavaScript number. `Intl` is asked
only for a currency's symbol and its minor-unit digits, never to format an amount. Numbers are
grouped the way `en-US` groups them. The module imports nothing.

### No origin baked in

No host, origin or URL literal appears in this package. Inference endpoints are runtime values
the mint call returns, and the client takes its `baseUrl` from the caller.

No supplier is named anywhere. The two exceptions are the field names
`endpoints.anthropicMessages` and `endpoints.openaiChat`, and they are a deliberate carve-out
rather than an oversight: they name a **request format** a caller encodes in — both are de-facto
public standards — not a supplier a request is routed to. Which provider actually serves a
request is not part of this contract and is published nowhere.

### Where amounts appear, and where they do not

Five routes carry prices or charges, and it is worth being precise about which, because "no
prices here" would be a comfortable claim and a false one:

- **`GET /v1/price-list`** publishes the per-model list. That is its whole job.
- **`GET /v1/usage`** returns, per row and in the totals, both `listPriceMicro` (the upstream
  list price) and `dorkosPriceMicro` (what DorkOS charged). Publishing both means publishing the
  difference, and that is the point rather than an accident: somebody paying for inference
  through us can see exactly what the routing costs them without asking. If that ever stops
  being the intent, the field to drop is `listPriceMicro`, and dropping it is a `/v2` change.
- **`GET /v1/statement`** may carry the same projection as `GET /v1/usage`, one line per model
  for the statement's period, with `totals` that are the exact sum of the lines, and the `from`
  and `to` of the window the period covers (a period is labelled by a month, but it need not be a
  calendar month). The lines cover inference usage only: any other charge in the period is in the
  downloadable statement, so `totals` is not the whole bill when there are other charges. It is
  the caller's own bill, so it carries both prices for the same reason `GET /v1/usage` does.
  `lines` and `totals` arrive together or not at all, and a service that predates them answers
  with the download link alone.
- **`GET /v1/nudge`** returns one already-computed comparison — one subscription, one price, one
  subtraction the server already did. The client renders it and computes nothing.
- **`GET /v1/offers`** lists what the service will sell the caller: per offer, an opaque `skuId`
  (the one string `POST /v1/checkout` takes back, and the only place a client gets one), the
  opaque `planId` `GET /v1/entitlements` also publishes, the server's own `displayName`, the
  `interval` (`month` or `year`), the price per interval as money, and the published
  `EntitlementLimitsSchema`. It carries no "recommended" flag and no "current" flag: compare
  `planId` with the entitlement's to mark what the caller is on, and render the offers in the
  order served, without re-sorting. `interval` is tolerant, so an interval added later reads as
  `unrecognised` rather than failing the list. An account with nothing on sale gets an empty
  list, never a 404. It takes a bearer or the person's own browser session.

Each of those, and the balance and the entitlements, carries the optional
`denomination` above. The price list's entries also carry optional cache-read and cache-write
rates (`cacheReadMicro`, `cacheWriteMicro`) beside input and output, in the entry's existing
`unit`.

Nothing else carries an amount. In particular, no inference route does: not a rate, not a
multiplier, not a unit cost. And no route anywhere carries a supplier's terms.

`POST /v1/checkout` and `POST /v1/portal` accept either a bearer token or the person's own
browser session, with the same request and response shapes either way. A request authenticated
by a browser session must come from an origin the service trusts, or it is refused with
`forbidden`.

`POST /v1/topup` carries an amount in the request (`TopupRequestSchema`). It publishes neither a
minimum nor a first-purchase ceiling: those are server policy, and a request that misses one is
refused with `topup_below_minimum` or `first_purchase_cap` rather than described here.

Fields typed `SecretValueSchema` are returned **once**: hold them as credential references, never
as configuration strings, and never log them.

## Conformance fixtures

`fixtures/v1/**.json` is a shared corpus of example payloads, with `fixtures/v1/index.json`
naming the exported schema that validates each one. Both sides of the wire can implement against
the same examples; `src/__tests__/fixtures.test.ts` proves every example is valid and that the
manifest and the directory have not drifted apart.

The corpus covers responses, stream events, and the request shapes a caller has to build itself
(a top-up, a command acknowledgement). Every example is synthetic: opaque identifiers,
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
