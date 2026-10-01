# Tasks: managed-cloud-error-honesty

Spec: specs/managed-cloud-error-honesty/02-specification.md  
Generated: 2026-09-30T21:19:45Z  
Mode: full

## Phase 1: Contract

### Task 1.1: Add the legacy managed error-body schema and the operation display fields

- **Size:** small **Priority:** high
- **Dependencies:** none **Parallel with:** none

Add the shared, tested wire contract both the app and the private control-plane repo read.

**File: `packages/shared/src/connector-managed-schemas.ts`** (currently 280 lines, `zod`-based, exports things like `ManagedConnectorExecutionResponseSchema`). Add near the top, after the imports:

```ts
/** Known legacy managed-connector refusal codes the control plane sends in `error`. */
export const MANAGED_CONNECTOR_ERROR_CODES = {
  unauthorized: 'unauthorized',
  permissionUpgradeRequired: 'permission_upgrade_required',
  managedConnectorsUnavailable: 'managed_connectors_unavailable',
  invalidRequest: 'invalid_request',
  internalError: 'internal_error',
  notFound: 'not_found',
  conflict: 'conflict',
} as const;

/**
 * The legacy managed-connector error body the control plane sends on any
 * non-2xx response to `/api/instances/connectors/*`. Tolerant on read
 * (`.passthrough()`): an extra key the cloud adds later must never turn a
 * refusal into a parse failure of its own. This module's whole file is
 * vendored byte-for-byte by the private control-plane repo; a breaking
 * change here is a breaking change there.
 */
export const ManagedConnectorErrorBodySchema = z
  .object({
    error: z.string().min(1).max(100),
    reason: z.string().max(1_000).optional(),
  })
  .passthrough();
/** The legacy managed-connector error body. */
export type ManagedConnectorErrorBody = z.infer<typeof ManagedConnectorErrorBodySchema>;
```

**File: `packages/shared/src/connector-managed-discovery-schemas.ts`**, `ManagedConnectorOperationSchema` at lines 110-122 currently reads:

```ts
export const ManagedConnectorOperationSchema = z
  .object({
    hostedRevisionId: z.string().uuid(),
    providerInstanceId: ManagedWireIdSchema,
    toolkit: ManagedWireIdSchema,
    operationSlug: ManagedWireIdSchema,
    toolkitVersion: ManagedWireIdSchema,
    schemaHash: ManagedWireIdSchema,
    capabilityClassification: ConnectorOperationClassificationSchema,
    retryPolicy: ConnectorRetryPolicySchema,
    inputSchema: ConnectorJsonObjectSchema,
  })
  .strict();
```

Add two optional fields before the closing `.strict()`, keeping it `.strict()` otherwise:

```ts
    // Presentation hints only, optional until an app floor accepts them; the
    // cloud must not send them until then (ideation decision 7). Mirrors
    // ConnectorOperationPageSchema's own displayName/important in
    // packages/shared/src/connector-schemas.ts:213-217.
    displayName: z.string().min(1).max(200).optional(),
    important: z.boolean().optional(),
```

TSDoc on both new exports (and updated TSDoc on `ManagedConnectorOperationSchema`) must say the file is vendored by the private repo and that the cloud must not send the new operation fields until the app floor accepts them — copy the wording pattern already used on this module's header comment.

**Tests.** In `packages/shared/src/__tests__/connector-managed-schemas.test.ts`: assert `ManagedConnectorErrorBodySchema` parses `{error:'permission_upgrade_required'}`, `{error:'managed_connectors_unavailable', reason:'toolkit temporarily down'}`, tolerates an unrecognised extra key (parses successfully and keeps it, proving `.passthrough()`), rejects `{}` (missing `error`), rejects an `error` string over 100 characters, and rejects a `reason` string over 1,000 characters. In `packages/shared/src/__tests__/connector-managed-discovery-schemas.test.ts`: extend the existing `ManagedConnectorOperationSchema` fixture coverage to assert it accepts a fixture carrying `displayName`/`important`, still accepts a fixture without them, and still rejects an unrecognised extra key (still `.strict()`).

**Acceptance criteria:** `pnpm vitest run packages/shared/src/__tests__/connector-managed-schemas.test.ts packages/shared/src/__tests__/connector-managed-discovery-schemas.test.ts` is green; `pnpm --filter @dorkos/shared build` succeeds (every downstream package that imports these types needs the rebuilt dist); `pnpm --filter @dorkos/shared typecheck` and `lint` are green.

## Phase 2: Parser

### Task 2.1: Read the cloud's real error field, carry its code/status/reason, and log once per refusal

- **Size:** large **Priority:** high
- **Dependencies:** 1.1 **Parallel with:** none

Fix the field-name drift (the parser reads `body.code`; the cloud sends `error`) and make every managed-cloud refusal produce one structured log line, in `apps/server/src/services/core/auth/cloud-link-client.ts` (856 lines; no `logger` import today).

**Start with the two tests that encode the bug, red-first.** `apps/server/src/services/core/auth/__tests__/cloud-link-client.test.ts:432-452` currently sends a fake 403 body `JSON.stringify({ code: 'permission_upgrade_required', private: 'SECRET_HOSTED_ERROR' })`. Rewrite it to the real shape: `JSON.stringify({ error: 'permission_upgrade_required', reason: 'SECRET_HOSTED_ERROR' })`, and extend the `toMatchObject` assertion to also check `cloudCode: 'permission_upgrade_required'` and `reason: 'SECRET_HOSTED_ERROR'` are readable on the rejected error object, while asserting the thrown `.message` string itself never contains the reason text (the existing test's title, 'without leaking response text', stays true — `reason` is now a deliberate field, just never interpolated into `.message`). `apps/server/src/services/core/auth/__tests__/cloud-link.test.ts:157` has a mock authority body `{ code: 'permission_upgrade_required' }`; change the key to `error`. Run both files against the CURRENT, unmodified parser first and confirm they fail (the 403 branch does not yet recognise `body.error`) before changing `throwManagedConnectorCloudError`.

**Error type.** Replace:

```ts
export type ManagedConnectorCloudErrorCode =
  | 'unauthorized'
  | 'permission_upgrade_required'
  | 'not_found'
  | 'conflict'
  | 'network_error'
  | 'request_failed'
  | 'invalid_response';

export class ManagedConnectorCloudError extends Error {
  constructor(
    readonly code: ManagedConnectorCloudErrorCode,
    readonly status?: number,
    options?: ErrorOptions
  ) {
    super(managedConnectorCloudErrorMessage(code), options);
    this.name = 'ManagedConnectorCloudError';
  }
}
```

with a new `'unavailable'` code (503/5xx, distinct from the existing `'network_error'` which stays for a failed fetch itself) and an options-object constructor so every call site can carry the cloud's own fields:

```ts
export type ManagedConnectorCloudErrorCode =
  | 'unauthorized'
  | 'permission_upgrade_required'
  | 'not_found'
  | 'conflict'
  | 'unavailable'
  | 'network_error'
  | 'request_failed'
  | 'invalid_response';

export interface ManagedConnectorCloudErrorOptions extends ErrorOptions {
  status?: number;
  cloudCode?: string;
  reason?: string;
  method?: string;
  /** No query string; a cursor or token must never reach a log line. */
  path?: string;
  /** `invalid_response` only. Zod issue paths, never the values that failed. */
  issuePaths?: string[];
}

export class ManagedConnectorCloudError extends Error {
  readonly code: ManagedConnectorCloudErrorCode;
  readonly status?: number;
  readonly cloudCode?: string;
  readonly reason?: string;
  readonly method?: string;
  readonly path?: string;
  readonly issuePaths?: string[];

  constructor(code: ManagedConnectorCloudErrorCode, options?: ManagedConnectorCloudErrorOptions) {
    super(managedConnectorCloudErrorMessage(code), options);
    this.name = 'ManagedConnectorCloudError';
    this.code = code;
    this.status = options?.status;
    this.cloudCode = options?.cloudCode;
    this.reason = options?.reason?.slice(0, 200);
    this.method = options?.method;
    this.path = options?.path;
    this.issuePaths = options?.issuePaths;
  }
}
```

Add a message case: `case 'unavailable': return 'DorkOS\u2019s servers aren\u2019t answering right now.';` (the existing `request_failed` message, 'DorkOS\u2019s servers turned the request down.', stays for the other 4xx/unmapped cases — status belongs in the log, not in the thrown message).

Move every existing `new ManagedConnectorCloudError(code, status)` / `(code, undefined, {cause})` call site in this file (there are 12: lines 202, 217, 219, 222, 225, 227, 237, 276, 282, 548, 579, plus `cloud-link.ts:847`) onto the options-object form, e.g. `new ManagedConnectorCloudError('unauthorized', { status: response.status })`.

**Parser.** `throwManagedConnectorCloudError(response: Response)` currently reads `body.code` on a 403 only and drops `reason` everywhere. Give it a second `request: { kind: string; method: string; path: string }` parameter, read the body ONCE through `ManagedConnectorErrorBodySchema.safeParse` (from task 1.1), and map every status, not just 403:

```ts
async function throwManagedConnectorCloudError(
  response: Response,
  request: { kind: string; method: string; path: string }
): Promise<never> {
  const text = await response.text().catch(() => undefined);
  let cloudCode: string | undefined;
  let reason: string | undefined;
  if (text) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const parsed = ManagedConnectorErrorBodySchema.safeParse(json);
    if (parsed.success) {
      cloudCode = parsed.data.error;
      reason = parsed.data.reason;
    }
  }
  const common = {
    status: response.status,
    cloudCode,
    reason,
    method: request.method,
    path: request.path,
  };
  const code: ManagedConnectorCloudErrorCode =
    response.status === 401
      ? 'unauthorized'
      : response.status === 403
        ? cloudCode === 'permission_upgrade_required'
          ? 'permission_upgrade_required'
          : 'request_failed'
        : response.status === 404
          ? 'not_found'
          : response.status === 409
            ? 'conflict'
            : response.status === 503 || response.status >= 500
              ? 'unavailable'
              : 'request_failed';
  logManagedCloudRefusal({ kind: request.kind, code, ...common });
  throw new ManagedConnectorCloudError(code, common);
}
```

Add the shared, no-throw logging helper once in this file (import `logger` from `'../../../lib/logger.js'` \u2014 this file currently has no such import):

```ts
function logManagedCloudRefusal(details: {
  kind: string;
  method: string;
  path: string;
  status?: number;
  cloudCode?: string;
  reason?: string;
  code: ManagedConnectorCloudErrorCode;
}): void {
  logger.warn('[CloudLink] Managed cloud request refused', {
    ...details,
    path: details.path.split('?')[0],
    reason: details.reason?.slice(0, 200),
  });
}
```

Call it from EVERY place in this file that produces a `ManagedConnectorCloudError` for a genuine refusal, so the total is one line per refusal:

- Inside `throwManagedConnectorCloudError` (above \u2014 covers every status-code branch for both callers below).
- `parseManagedAuthorityStatus(response, request)` \u2014 give it the same `request: {kind, method, path}` parameter; when `!response.ok` it calls `throwManagedConnectorCloudError(response, request)` (already logs); when its own `ManagedConnectorAuthorityCommandStatusSchema.parse(await response.json())` fails, that is an `invalid_response`, not a refusal \u2014 log a DIFFERENT line there: `logger.warn('[CloudLink] Managed cloud answered something unexpected', { kind: request.kind, status: response.status, issuePaths })` where `issuePaths = error instanceof ZodError ? error.issues.map(i => i.path.join('.')) : undefined`, then `throw new ManagedConnectorCloudError('invalid_response', { status: response.status, issuePaths, ...request })`.
- `requestManagedConnectorResource` \u2014 add a `kind: string` field to its `opts` type (its 13 exported callers in this file each pass a short label naming themselves, e.g. `requestManagedConnectorCatalog` passes `'catalog'`, `requestManagedConnectorToolkitVersion` passes `'toolkit_version'`, `requestManagedConnectorOperationSchemas` passes `'operation_schemas'`, `requestManagedConnectorAccounts` passes `'accounts'`, `requestManagedConnectorAccount` passes `'account'`, `requestManagedConnectorAuthentication`/`...AuthenticationState` pass `'authentication_start'`/`'authentication_state'`, and so on for the remaining exported functions that call it). Its network-error catch (currently `throw new ManagedConnectorCloudError('network_error', undefined, { cause: error })`) must call `logManagedCloudRefusal` before throwing; its response-not-ok branch calls `throwManagedConnectorCloudError(response, { kind: opts.kind, method: opts.method ?? 'GET', path: opts.path.split('?')[0] })` (already logs); its own JSON-parse-failure branch logs the same 'answered something unexpected' line as `parseManagedAuthorityStatus` above, with `issuePaths`.
- `submitManagedConnectorAuthorityCommand` (line ~535, POST `/api/instances/connectors/authority-commands`) and `readManagedConnectorAuthorityCommand` (line ~562, GET `/api/instances/connectors/authority-commands/{commandId}`) each have their OWN network-error catch around a raw `fetchImpl` call, BEFORE they reach `parseManagedAuthorityStatus` \u2014 their `throw new ManagedConnectorCloudError('network_error', undefined, { cause: error })` at lines 548 and 579 must also call `logManagedCloudRefusal` (kind `'authority_submit'` / `'authority_read'`) first, or a network failure on either of these two calls would silently skip the one-line-per-refusal guarantee.

**Do not** add a second log call in `apps/server/src/services/core/auth/cloud-link.ts`'s `afterRefusal` (lines 840-848) \u2014 it only re-wraps an error `throwManagedConnectorCloudError` already logged once. Update it only to carry the new fields forward instead of losing them:

```ts
private async afterRefusal(error: unknown, context: LinkContext): Promise<unknown> {
  if (!(error instanceof ManagedConnectorCloudError) || error.code !== 'unauthorized') return error;
  await this.confirmKey(context);
  return this.ownsContext(context)
    ? new ManagedConnectorCloudError('request_failed', {
        status: error.status, cloudCode: error.cloudCode, reason: error.reason,
        method: error.method, path: error.path, cause: error,
      })
    : error;
}
```

**Acceptance criteria:** `pnpm vitest run apps/server/src/services/core/auth/__tests__/cloud-link-client.test.ts apps/server/src/services/core/auth/__tests__/cloud-link.test.ts` is green. A fed 403 body `{error:'permission_upgrade_required'}` now produces code `permission_upgrade_required` (today it produces `request_failed`, the relink-recovery bug). A fed 503 body `{error:'managed_connectors_unavailable', reason:'...'}` produces code `unavailable` with `cloudCode`/`reason` populated. A non-JSON 502 produces code `unavailable`. Exactly one `logger.warn` fires per refusal (assert with a spy across a representative sample of the call sites above); no logged object contains a bearer token or an un-truncated `reason`; a `reason` over 200 characters is truncated before it is ever logged. `pnpm --filter @dorkos/server typecheck`.

## Phase 3: Route mapping

### Task 3.1: Add the shared managed-cloud route helper, wire it into every route, and stop app-actions from discarding its cause

- **Size:** large **Priority:** high
- **Dependencies:** 2.1 **Parallel with:** 3.2

Give every Express route that can hit the managed cloud one honest status/code mapping, instead of the current mix of a silent rethrow-to-500, a no-log 500, and a blanket 502.

**New file `apps/server/src/routes/managed-cloud-error.ts`** exports `sendManagedCloudError(res, error): boolean` \u2014 `true` means it answered the response and the caller must return immediately; `false` means `error` was not a `ManagedConnectorCloudError` and the caller keeps mapping its own error types:

```ts
import type { Response } from 'express';
import {
  ManagedConnectorCloudError,
  type ManagedConnectorCloudErrorCode,
} from '../services/core/auth/cloud-link-client.js';

const TABLE: Record<
  ManagedConnectorCloudErrorCode,
  { status: number; code: string; error: string }
> = {
  unauthorized: {
    status: 401,
    code: 'cloud_link_required',
    error:
      'This computer isn\u2019t linked to your DorkOS account anymore. Link it again in Settings \u203a Access.',
  },
  permission_upgrade_required: {
    status: 409,
    code: 'cloud_link_needs_update',
    error:
      'This computer\u2019s link to your DorkOS account needs updating. Link it again in Settings \u203a Access.',
  },
  unavailable: {
    status: 503,
    code: 'cloud_unavailable',
    error:
      'DorkOS\u2019s servers aren\u2019t answering right now. Nothing changed. Try again in a few minutes.',
  },
  network_error: {
    status: 503,
    code: 'cloud_unavailable',
    error:
      'DorkOS\u2019s servers aren\u2019t answering right now. Nothing changed. Try again in a few minutes.',
  },
  request_failed: {
    status: 502,
    code: 'cloud_refused',
    error:
      'DorkOS\u2019s servers couldn\u2019t finish this. Nothing changed on this computer. Try again later.',
  },
  invalid_response: {
    status: 502,
    code: 'cloud_refused',
    error:
      'DorkOS\u2019s servers couldn\u2019t finish this. Nothing changed on this computer. Try again later.',
  },
  not_found: {
    status: 502,
    code: 'cloud_refused',
    error:
      'DorkOS\u2019s servers couldn\u2019t finish this. Nothing changed on this computer. Try again later.',
  },
  conflict: {
    status: 502,
    code: 'cloud_refused',
    error:
      'DorkOS\u2019s servers couldn\u2019t finish this. Nothing changed on this computer. Try again later.',
  },
};

/**
 * Answer an Express response for a refused managed-cloud call, honestly.
 *
 * @returns `true` when `error` was a `ManagedConnectorCloudError` and the response was answered;
 *   `false` when the caller must keep mapping its own error types.
 */
export function sendManagedCloudError(res: Response, error: unknown): boolean {
  if (!(error instanceof ManagedConnectorCloudError)) return false;
  const row = TABLE[error.code];
  res.status(row.status).json({ error: row.error, code: row.code });
  return true;
}
```

That table: `unauthorized`\u2192401 `cloud_link_required`; `permission_upgrade_required`\u2192409 `cloud_link_needs_update`; `network_error`/`unavailable`\u2192503 `cloud_unavailable`; every other code (`request_failed`, `invalid_response`, `not_found`, `conflict`)\u2192502 `cloud_refused`.

**Wire it in, checked before the generic fallback in each mapper:**

- `apps/server/src/routes/connector-management.ts`, `sendManagementError` (lines ~208-270) currently ends with a bare `throw error;` for anything it does not recognise. Change the last two lines to:
  ```ts
  if (sendManagedCloudError(res, error)) return;
  throw error;
  ```
- `apps/server/src/routes/connector-execution.ts`, `sendProgramError` (lines ~124-162) has the identical `throw error;` ending \u2014 same two-line change.
- `apps/server/src/routes/connector-resources.ts`, `sendResourceError` (lines ~97-135): its trailing generic branch is currently `res.status(500).json({ error: 'DorkOS could not complete this connection request. Try again.' });` with NO log at all. Change it to:
  ```ts
  if (sendManagedCloudError(res, error)) return;
  logError(error); // this path never logged before
  res.status(500).json({ error: 'DorkOS could not complete this connection request. Try again.' });
  ```
  (import `logError` from `'../lib/logger.js'`.) Its `ConnectorAppActionsError` branch (lines ~118-121) currently answers `error.code === 'provider_not_found' ? 404 : 502` unconditionally for every other code. Since `'actions_unavailable'` can now carry a `ManagedConnectorCloudError` as its `cause` (see below), check that first:
  ```ts
  if (error instanceof ConnectorAppActionsError) {
    if (error.code === 'actions_unavailable' && sendManagedCloudError(res, error.cause)) return;
    res
      .status(error.code === 'provider_not_found' ? 404 : 502)
      .json({ error: error.message, code: error.code });
    return;
  }
  ```
  `GET /apps/:toolkit/actions` (connector-resources.ts:172-178) already routes its catch through `sendResourceError`, so it inherits this fix automatically \u2014 it still answers 502 `actions_unavailable` for a genuine provider outage (e.g. Composio down), but now passes a KNOWN cloud refusal through the honest table instead of masking it.

**Stop `app-actions-service.ts` from discarding the cause.** In `apps/server/src/services/connectors/resources/app-actions-service.ts`: the `ConnectorAppActionsError` class (lines ~50-59) has a `constructor(code, message)` with no way to carry a cause \u2014 add an options parameter: `constructor(code: ConnectorAppActionsError['code'], message: string, options?: ErrorOptions) { super(message, options); this.name = 'ConnectorAppActionsError'; this.code = code; }`. The `unavailable()` helper (lines ~462-467) takes no arguments today \u2014 change it to `function unavailable(cause?: unknown): ConnectorAppActionsError { return new ConnectorAppActionsError('actions_unavailable', 'DorkOS could not list this app\u2019s actions just now. Try again.', { cause }); }`. Its two `throw unavailable();` call sites inside `fetch()`'s `catch {}` blocks (line ~297, inside `resolveToolkitVersion`'s try, and line ~327, inside the page-listing loop) currently discard the caught error entirely \u2014 bind it and pass it through: `catch (error) { throw unavailable(error); }` and `catch (error) { if (actions.length === 0) throw unavailable(error); completeness = 'interrupted'; break; }`.

**Tests.** New `apps/server/src/routes/__tests__/managed-cloud-error.test.ts` unit-tests `sendManagedCloudError` for all 8 codes (exact status+code pair from the table) and asserts it returns `false` (and calls nothing on `res`) for a plain `Error`. Extend `apps/server/src/services/connectors/__tests__/connector-app-actions-service.test.ts` to assert a `ManagedConnectorCloudError` thrown by the underlying provider rides through as `.cause` on the resulting `ConnectorAppActionsError`. Extend one existing supertest route file per mapper (e.g. `apps/server/src/routes/__tests__/connector-management.test.ts` for a reconciliation-preview call, `apps/server/src/routes/__tests__/connector-resources.test.ts` for `/apps/:toolkit/actions`) to assert the end-to-end status/code when the underlying service throws each `ManagedConnectorCloudError` code, AND that a non-managed-cloud outage (e.g. a plain `ComposioCatalogError`-shaped failure) still answers exactly what it answers today (502 `actions_unavailable`, 404 `provider_not_found` unchanged).

**Acceptance criteria:** `pnpm vitest run apps/server/src/routes/__tests__/managed-cloud-error.test.ts apps/server/src/routes/__tests__/connector-management.test.ts apps/server/src/routes/__tests__/connector-resources.test.ts apps/server/src/routes/__tests__/connector-execution.test.ts apps/server/src/services/connectors/__tests__/connector-app-actions-service.test.ts` is green. `pnpm --filter @dorkos/server typecheck` and `lint`.

### Task 3.2: Name the cloud's status and code at every remaining log site that still swallows it into a generic message

- **Size:** medium **Priority:** medium
- **Dependencies:** 2.1 **Parallel with:** 3.1

Seven remaining log call sites reduce a managed-cloud (or `/v1`) refusal to its generic `.message` text, dropping the status and code that would make the log diagnosable. None of these needs new behaviour, only a wider log context object.

**`apps/server/src/services/connectors/providers/managed/managed-cloud.ts:318-333`** (inside the catch of `response = await this.#cloud.executeManagedConnectorOperation(...)`): every non-link-required error currently collapses straight to `terminalUnknown('MANAGED_EXECUTION_OUTCOME_UNKNOWN', ...)` with no log at all. Import `ManagedConnectorCloudError` alongside the existing `ManagedConnectorLinkRequiredError` import at line 7, import `logger` from `'../../../../lib/logger.js'` (4 levels up from `services/connectors/providers/managed/`), and add before the `return terminalUnknown(...)`:

```ts
logger.warn('[ManagedCloud] Execution outcome unknown', {
  code: error instanceof ManagedConnectorCloudError ? error.code : undefined,
  status: error instanceof ManagedConnectorCloudError ? error.status : undefined,
  cloudCode: error instanceof ManagedConnectorCloudError ? error.cloudCode : undefined,
});
```

**`apps/server/src/services/connectors/bootstrap.ts`**, three `logger.error` calls that currently log only a derived `message` string: line 684 (`` `[Connectors] ${spec.logLabel} stopped answering: ${message}` ``), line 1037 (`` `[Connectors] ${spec.logLabel} refused: ${message}` ``), line 1043 (`` `[Connectors] ${spec.logLabel} failed its connection check: ${message}` ``). `ManagedConnectorCloudError` is already imported at line 63. At each of the three sites, append the cloud detail when present:

```ts
const managedDetail =
  err instanceof ManagedConnectorCloudError
    ? ` (code=${err.code}, status=${err.status ?? 'n/a'})`
    : '';
logger.error(`[Connectors] ${spec.logLabel} stopped answering: ${message}${managedDetail}`);
```

(and the equivalent for the other two lines, each keeping its own existing verb).

**`apps/server/src/services/core/auth/cloud-link.ts:791`** (inside `notifyManagedProviderSync`'s catch): currently `logger.warn('[CloudLink] Managed provider registration failed', logError(error));`. Extend the context object:

```ts
const detail =
  error instanceof ManagedConnectorCloudError ? { code: error.code, status: error.status } : {};
logger.warn('[CloudLink] Managed provider registration failed', { ...logError(error), ...detail });
```

**`apps/server/src/middleware/error-handler.ts:18`**: `logger.error('[DorkOS Error]', err.message, err.stack);` inside `errorHandler(err, _req, res, next)` \u2014 the request parameter is named `_req` (declared-but-unused convention) and is never read. Rename it to `req` and log method/path/code/status beside the message:

```ts
export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction): void {
  ...
  logger.error('[DorkOS Error]', err.message, {
    method: req.method,
    path: req.path,
    ...(typeof (err as { code?: unknown }).code === 'string' ? { code: (err as { code: string }).code } : {}),
    ...(typeof (err as { status?: unknown }).status === 'number' ? { status: (err as { status: number }).status } : {}),
    stack: err.stack,
  });
```

(keep the existing `if (res.headersSent) { next(err); return; }` guard above this line untouched, and its `next(err)` call unaffected by the rename).

**`apps/server/src/routes/cloud.ts:110`** (`cloudReadFailed`, which already imports `problemOf` at line 50): `logger.warn(\`[Cloud] Could not read ${what}\`, logError(error));`\u2014 add the Problem's own code and status:`const problem = problemOf(error); logger.warn(\`[Cloud] Could not read ${what}\`, { ...logError(error), code: problem?.code, status: problem?.status });`.

**`apps/server/src/routes/cloud-communities.ts:210` and `:226`** (`writeFailed`'s no-Problem branch and `readFailed`, both already have `problemOf` imported at line 66): apply the same pattern \u2014 `const problem = problemOf(error);` then spread `code: problem?.code, status: problem?.status` into each existing `logger.warn(...)` call's context object (at line 210 `problem` will usually be `null` here since a real Problem already short-circuited earlier in `writeFailed`, at lines ~202-209 \u2014 that is fine; the point is every one of these four log sites now shares one consistent shape).

**`apps/server/src/services/core/cloud/credits-inference.ts:169`**: `logger.warn('[Cloud] Could not obtain an inference token', { status });` already computes `status` two lines above from `problemOf(error)?.status ?? (error instanceof CloudApiResponseError ? error.status : null)` but drops the Problem's `code`. Add it: `logger.warn('[Cloud] Could not obtain an inference token', { status, code: problemOf(error)?.code });`.

**Acceptance criteria:** `pnpm vitest run apps/server/src/services/connectors/providers/managed/__tests__/managed-cloud.test.ts apps/server/src/services/connectors/__tests__/bootstrap.test.ts apps/server/src/services/core/auth/__tests__/cloud-link.test.ts apps/server/src/middleware/__tests__/error-handler.test.ts apps/server/src/routes/__tests__/cloud.test.ts apps/server/src/routes/__tests__/cloud-communities.test.ts apps/server/src/services/core/cloud/__tests__/credits-inference.test.ts` is green (extend each with at least one assertion that the new fields appear in the logged context when the underlying error carries them). `pnpm --filter @dorkos/server typecheck` and `lint`. No response body changes in this task \u2014 every change here is log-only.

## Phase 4: Client

### Task 4.1: Show where a managed-cloud problem is and offer the one useful action

- **Size:** large **Priority:** high
- **Dependencies:** 3.1 **Parallel with:** none

Four client surfaces currently show fixed failure copy that ignores the error object entirely. Add one small helper that reads the route codes task 3.1 introduces, then wire it into all four.

**New file `apps/client/src/layers/entities/connectors/lib/cloud-failure.ts`** (the `entities/connectors/lib` directory already exists and holds sibling helpers). `fetchJSON` (`apps/client/src/layers/shared/lib/transport/http-client.ts:72-93`) already attaches `err.code = error.code` and `err.status = res.status` to every thrown error, so a query/mutation `.error` object already carries the server's `code` string (`cloud_link_required`, `cloud_link_needs_update`, `cloud_unavailable`, `cloud_refused`) when the route answered through `sendManagedCloudError`.

```ts
/** Copy for one managed-cloud refusal, or `null` to use the surface's own default copy. */
export interface CloudFailureCopy {
  title: string;
  description: string;
  /** Present only when there is one useful action: reopen Settings \u203a Access. */
  action?: 'relink';
}

const COPY: Record<string, CloudFailureCopy> = {
  cloud_link_required: {
    title: 'This computer isn\u2019t linked',
    description: 'Link this computer to your DorkOS account again to keep using it.',
    action: 'relink',
  },
  cloud_link_needs_update: {
    title: 'This computer\u2019s link needs updating',
    description: 'Link this computer to your DorkOS account again to pick up the update.',
    action: 'relink',
  },
  cloud_unavailable: {
    title: 'DorkOS\u2019s servers aren\u2019t answering',
    description: 'Nothing changed. Try again in a few minutes.',
  },
  cloud_refused: {
    title: 'DorkOS\u2019s servers couldn\u2019t finish this',
    description: 'Nothing changed on this computer. Try again later.',
  },
};

/** Read the failure copy for one query/mutation error, or `null` to keep the surface's own copy. */
export function cloudFailure(error: unknown): CloudFailureCopy | null {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === 'string' && code in COPY ? COPY[code] : null;
}
```

Run these four strings past the `writing-for-humans` skill before landing \u2014 the wording above is a starting sketch, not final copy.

**`apps/client/src/layers/features/connections/model/use-access-reconciliation.ts`**: the returned object (lines ~213-235) has `loadFailed: previewMutation.isError` but nothing exposes the error itself. Add a sibling field: `/** The error behind a failed load, for cloudFailure(). */ loadError: previewMutation.error,` right after `loadFailed`.

**`apps/client/src/layers/features/connections/ui/access/ConnectionAccessCard.tsx`** (lines ~281-291): the `access.loadFailed` branch renders a fixed `<QueryErrorState title="Couldn\u2019t load who can use it" description="Nothing changed. Try loading the current access again." .../>`. Import `cloudFailure` and `useSettingsDeepLink` (already imported the same way in `AccountPanel.tsx`), compute `const failure = cloudFailure(access.loadError);`, pass `title={failure?.title ?? 'Couldn\u2019t load who can use it'}` and `description={failure?.description ?? 'Nothing changed. Try loading the current access again.'}` into `QueryErrorState`, and render a relink button right after it when `failure?.action === 'relink'`: `<Button variant="outline" size="sm" onClick={() => settings.open('access')}>Open Settings \u203a Access</Button>`.

**`apps/client/src/layers/features/connections/ui/access/ConnectionAccessDialog.tsx`** (lines ~90-96): same pattern for its `access.loadFailed` branch, currently fixed title "Couldn\u2019t load account actions".

**`apps/client/src/layers/features/connections/ui/AppActions.tsx`** (the `actions.isError` branch, lines ~96-110, currently a fixed "Couldn\u2019t load what {appName} offers agents." line beside a Try again button): compute `const failure = cloudFailure(actions.error);` and swap only the text, keeping the existing compact one-line-plus-retry layout: `{failure?.description ?? \`Couldn\u2019t load what ${appName} offers agents.\`}`. This surface stays retry-only (no relink button) \u2014 it is an embedded list, not a place with room for a second navigation action.

**`apps/client/src/layers/features/connections/ui/panel/AccountPanel.tsx`**: the outer `AccountPanel` function's `detail.isError` branch (lines ~74-82, fixed title "Couldn\u2019t load this app") does not currently call `useSettingsDeepLink()` \u2014 only the inner `AccountPanelBody` does (line ~208). Add the hook call to the outer function too, compute `const failure = cloudFailure(detail.error);`, swap the title/description the same way as the access card, and add the same conditional relink button.

**Before landing any new string, grep `apps/e2e` for the FOUR old strings** ("Couldn\u2019t load who can use it", "Couldn\u2019t load account actions", "Couldn\u2019t load what", "Couldn\u2019t load this app") and for whatever new strings are chosen, to catch a literal-copy e2e assertion before it breaks in the merge queue (a repo-wide finding: browser specs assert literal strings, and the browser-test job is a queue-only pass-through). Run the `chromium-connections` e2e project locally if anything hits.

**Tests.** New colocated test for `cloudFailure` (e.g. `apps/client/src/layers/entities/connectors/lib/__tests__/cloud-failure.test.ts`): each of the 4 known codes returns its copy (and `action` present only for the two link codes); an unknown code and a non-object error both return `null`. Extend `apps/client/src/layers/features/connections/__tests__/ConnectionAccessCard.test.tsx` (RTL) with one case per code: the right title/description render, and the relink button is present only for `cloud_link_required`/`cloud_link_needs_update`.

**Acceptance criteria:** `pnpm vitest run apps/client/src/layers/entities/connectors/lib/__tests__/cloud-failure.test.ts apps/client/src/layers/features/connections/__tests__/ConnectionAccessCard.test.tsx` is green. `pnpm --filter @dorkos/client typecheck` and `lint`.

## Phase 5: Site fallback

### Task 5.1: Stop the site's managed-connector fallback from crashing on its own richer internal shapes, and split its 400/500 split honestly

- **Size:** large **Priority:** high
- **Dependencies:** 1.1 **Parallel with:** 2.1

The site's switchable managed-connector fallback (`apps/site/src/lib/connectors/managed/discovery-service.ts`, live whenever `DORKOS_CLOUD_MANAGED_CONNECTIONS_FORWARD` is off) spreads internal objects that carry MORE fields than the strict wire schema allows directly into `.strict()` schema parses. When an upstream service (Composio) supplies one of those extra fields \u2014 which is exactly what happened to managed Gmail \u2014 the `.parse()` throws and the route's catch-all turns it into either a wrongly-honest 400 or a masked 503, never the truth (our own mapping bug).

**The three crash sites, and why each one is live risk today:**

1. Line ~158, `resolveManagedToolkitVersion`: `return ManagedConnectorToolkitVersionResponseSchema.parse({ version: 1, ...result });` \u2014 `result` is `ConnectorToolkitVersionResult | ConnectorUnsupportedResult` (`packages/shared/src/connector-schemas.ts:279-285`, itself `.strict()` with exactly `{status, toolkit, toolkitVersion}` today, so this one happens to be safe right now, but nothing stops the next field anyone adds to that internal type from crashing this spread).
2. Lines ~117-141, `listManagedConnectorCatalog`'s `toolkits: result.toolkits.map(...)`: builds `{...toolkit, authentication: {...}}` where `toolkit` (after `configuredAuthentication`/`projectConnectorAuthentication`) is `ConnectorToolkit`-shaped (`packages/shared/src/connector-provider.ts:96-117`), which carries `logoUrl` (an https URL, up to 2000 chars) and `description` (up to 300 chars) \u2014 NEITHER is in `ManagedConnectorToolkitSchema.strict()` (`packages/shared/src/connector-managed-discovery-schemas.ts:37-46`, which allows only `{slug, displayName, authKind, authenticationSetup?, authentication?, maxAccountsPerUser?}`). Any toolkit Composio returns a logo or description for \u2014 which is most of them \u2014 throws here today.
3. Lines 222 and 258, `listManagedOperationSchemas`: `discovered.push({ ...operation, hostedRevisionId: current.id })` and `discovered.push({ ...operation, hostedRevisionId: revision.id })`. `operation` comes from `ConnectorOperationPage['operations']` (`packages/shared/src/connector-schemas.ts:206-219`), which carries `providerRevisionRef` (explicitly commented there as 'Private upstream revision identity, never included in public revision DTOs'), plus `displayName`/`important`. `ManagedConnectorOperationSchema.strict()` (lines 110-122, pre-task-1.1) allows none of these three, so an operation with any one of them throws. THIS is the exact mechanism that took a real Gmail operations lookup down: Composio gives many Gmail actions a `displayName`.

**Fix: replace every spread with an explicit mapper that only ever emits wire-legal fields.** Add near the top of `discovery-service.ts`:

```ts
function toWireToolkit(toolkit: ConnectorToolkit): ManagedConnectorToolkit {
  const trimmed = toolkit.displayName.trim().slice(0, 200);
  return {
    slug: toolkit.slug,
    displayName: trimmed.length > 0 ? trimmed : toolkit.slug,
    authKind: toolkit.authKind,
    ...(toolkit.authenticationSetup !== undefined && {
      authenticationSetup: toolkit.authenticationSetup,
    }),
    ...(toolkit.authentication !== undefined && { authentication: toolkit.authentication }),
    ...(toolkit.maxAccountsPerUser !== undefined && {
      maxAccountsPerUser: toolkit.maxAccountsPerUser,
    }),
  };
}

function toWireToolkitVersion(
  result: ConnectorToolkitVersionResult | ConnectorUnsupportedResult
): ManagedConnectorToolkitVersionResponse {
  return result.status === 'unsupported'
    ? { version: 1, status: 'unsupported', reason: result.reason }
    : { version: 1, status: 'ok', toolkit: result.toolkit, toolkitVersion: result.toolkitVersion };
}

function toWireOperation(
  operation: ConnectorOperationPage['operations'][number],
  hostedRevisionId: string
): ManagedConnectorOperation {
  return {
    hostedRevisionId,
    providerInstanceId: operation.providerInstanceId,
    toolkit: operation.toolkit,
    operationSlug: operation.operationSlug,
    toolkitVersion: operation.toolkitVersion,
    schemaHash: operation.schemaHash,
    capabilityClassification: operation.capabilityClassification,
    retryPolicy: operation.retryPolicy,
    inputSchema: operation.inputSchema,
    // displayName/important omitted on the wire until the app floor accepts
    // them (ideation decision 7); providerRevisionRef never leaves this
    // process (it is private upstream identity, never a public revision field).
  };
}
```

Use `toWireToolkit` in place of the current `{...toolkit, authentication: {...}}` object inside the `.map()` callback (apply it to the negotiated toolkit AFTER `projectConnectorAuthentication`'s own authKind/authentication negotiation, as the very last step before the array entry). Use `toWireToolkitVersion(result)` in place of `{ version: 1, ...result }`. Use `toWireOperation(operation, current.id)` / `toWireOperation(operation, revision.id)` in place of the two `{ ...operation, hostedRevisionId: ... }` spreads at lines 222 and 258.

**Split the 400/500 answer honestly in the three route files that share this catch shape** (`apps/site/src/app/api/instances/connectors/catalog/route.ts`, `.../toolkits/[toolkit]/operations/route.ts`, `.../toolkits/[toolkit]/version/route.ts`): each currently ends

```ts
} catch (error) {
  if (error instanceof ZodError || (error instanceof Error && error.message === 'invalid_managed_query')) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  return Response.json({ error: 'managed_connectors_unavailable' }, { status: 503 });
}
```

which answers 400 to a `ZodError` from EITHER the request-shape parse (the caller's fault) OR the final wire-response `.parse()` inside the service (our own mapping bug, now far less likely after the mappers above, but never impossible). Add a small tagged error in `discovery-service.ts` and use it ONLY for the request-shape parse:

```ts
/** A malformed managed-connector REQUEST \u2014 always the caller's fault, always 400. */
export class ManagedRequestShapeError extends Error {
  constructor(cause: unknown) {
    super('Malformed managed-connector request.', { cause });
    this.name = 'ManagedRequestShapeError';
  }
}

function parseRequestShape<T>(schema: z.ZodType<T>, rawRequest: unknown): T {
  try {
    return schema.parse(rawRequest);
  } catch (error) {
    throw new ManagedRequestShapeError(error);
  }
}
```

Replace the first line of `listManagedConnectorCatalog` (`ManagedConnectorCatalogRequestSchema.parse(input.rawRequest)`), `resolveManagedToolkitVersion` (`ManagedConnectorToolkitVersionRequestSchema.parse(input.rawRequest)`), and `listManagedOperationSchemas` (`ManagedConnectorOperationPageRequestSchema.parse(input.rawRequest)`) with `parseRequestShape(<TheSameSchema>, input.rawRequest)`. Then in each of the three route files, change the catch to:

```ts
} catch (error) {
  if (
    error instanceof ManagedRequestShapeError ||
    (error instanceof Error && error.message === 'invalid_managed_query')
  ) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (error instanceof ZodError) {
    console.error(
      '[managed-discovery] internal wire-mapping failure',
      error.constructor.name,
      request.method,
      new URL(request.url).pathname
    );
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
  return Response.json({ error: 'managed_connectors_unavailable' }, { status: 503 });
}
```

importing `ManagedRequestShapeError` from `@/lib/connectors/managed/discovery-service` beside each file's existing imports. Every other catch in this directory (e.g. `executions/route.ts`) is unaffected \u2014 its single `ZodError` check is unambiguously the request-shape parse only, since it runs before any service call.

**Tests.** New `apps/site/src/lib/connectors/managed/__tests__/discovery-service.wire-mapping.test.ts`: feed `listManagedConnectorCatalog`/`listManagedOperationSchemas`/`resolveManagedToolkitVersion` real fixtures through the REAL functions and REAL schemas (no schema mocking) where the underlying toolkit/operation carries `logoUrl`, `description`, `providerRevisionRef`, and (for an operation) `displayName`/`important`. Assert: (a) none of the three throws, (b) the parsed wire result never contains `logoUrl`, `description`, or `providerRevisionRef`, (c) an operation's `displayName`/`important` are accepted by the schema (task 1.1) but NOT forwarded onto the wire result (the cloud must not send them yet), (d) a toolkit `displayName` over 200 characters is trimmed to 200, and a blank/whitespace-only `displayName` falls back to the slug. Extend `apps/site/src/app/api/instances/connectors/__tests__/managed-discovery-routes.test.ts` with: the previously-crashing Gmail-shaped fixture (a toolkit with `logoUrl`+`description`, or an operation with `displayName`) now returns 200 instead of throwing; a malformed QUERY string still returns 400 `invalid_request`; and a case that forces the internal response-schema parse to fail (e.g. by injecting a fixture missing a required wire field the mapper does not backfill) returns 500 `internal_error` with the class-and-route `console.error`, never 400.

**Acceptance criteria:** `pnpm vitest run apps/site/src/lib/connectors/managed/__tests__/discovery-service.wire-mapping.test.ts apps/site/src/app/api/instances/connectors/__tests__/managed-discovery-routes.test.ts` is green. `pnpm --filter @dorkos/site typecheck` and `lint`.

## Phase 6: Ship

### Task 6.1: Write the changelog fragment, document the error contract, and run full verification

- **Size:** small **Priority:** medium
- **Dependencies:** 3.1, 3.2, 4.1, 5.1 **Parallel with:** none

Close out the programme: a changelog fragment a person can read, a short doc note for the next contributor, and the full verification ladder across every touched package.

**Changelog fragment.** Generate a fresh timestamp id with `node --experimental-strip-types .claude/scripts/id.ts` (do not hand-pick one; two branches must never collide) and create `changelog/unreleased/<id>-managed-cloud-error-honesty.md` following `changelog/README.md`'s format (optional `covers:` frontmatter, then Keep-a-Changelog headings). Run the bullets past the `writing-changelogs`/`writing-for-humans` skills; a starting sketch:

```md
---
covers:
  - 'fix(server): read the managed-cloud error field the servers actually send, and log what refused (DOR-2622)'
  - 'fix(server): answer every managed-cloud refusal with an honest status and a stable code (DOR-2622)'
  - 'fix(client): tell people where a managed-app problem is and what to do about it (DOR-2622)'
  - "fix(site): stop the managed-connector fallback from crashing on an app's own extra details (DOR-2622)"
---

### Fixed

- When DorkOS's servers can't answer, the app now says so and tells you what to do \u2014 whether the problem is on DorkOS's end, or this computer's account link needs updating \u2014 instead of a generic "something went wrong" (DOR-2622).
- Reconnecting a computer to your DorkOS account after its link needed updating now actually works; before, the app never recognized the message DorkOS's servers sent for that case (DOR-2622).
```

Run `prettier --write` on the fragment before committing (Hard Rule 5 \u2014 a hand-edited file inside `changelog/unreleased/` is exactly the case the `prettier-before-push` lesson warns about).

**Docs.** `contributing/adding-a-connector.md` has no section on managed-cloud error handling. Add a new `## Managed-cloud errors` heading between the existing `## Agent requests for an app` (line 191) and `## Common mistakes` (line 218) sections:

```md
## Managed-cloud errors

A managed-connector call the control plane refuses throws `ManagedConnectorCloudError` (`services/core/auth/cloud-link-client.ts`), never a bare `Error`. Every route that can reach the managed cloud maps it through `sendManagedCloudError` (`routes/managed-cloud-error.ts`) to an honest HTTP status and a stable `code` the client already branches on: `cloud_link_required`, `cloud_link_needs_update`, `cloud_unavailable`, `cloud_refused`. Never let a managed-cloud error fall through to a route's own generic 500 \u2014 call `sendManagedCloudError(res, error)` before any catch-all. The client reads the same `code` through `cloudFailure()` (`layers/entities/connectors/lib/cloud-failure.ts`).
```

**Full verification.** Run, in order, and fix anything red before calling this task done:

- `pnpm --filter @dorkos/shared build` (other packages import its dist; task 1.1's schema additions must be rebuilt before anything downstream typechecks).
- `pnpm vitest run packages/shared/src/__tests__/connector-managed-schemas.test.ts packages/shared/src/__tests__/connector-managed-discovery-schemas.test.ts apps/server/src/services/core/auth/__tests__/cloud-link-client.test.ts apps/server/src/services/core/auth/__tests__/cloud-link.test.ts apps/server/src/routes/__tests__/managed-cloud-error.test.ts apps/server/src/routes/__tests__/connector-management.test.ts apps/server/src/routes/__tests__/connector-resources.test.ts apps/server/src/routes/__tests__/connector-execution.test.ts apps/server/src/services/connectors/__tests__/connector-app-actions-service.test.ts apps/server/src/services/connectors/providers/managed/__tests__/managed-cloud.test.ts apps/server/src/services/connectors/__tests__/bootstrap.test.ts apps/server/src/middleware/__tests__/error-handler.test.ts apps/server/src/routes/__tests__/cloud.test.ts apps/server/src/routes/__tests__/cloud-communities.test.ts apps/server/src/services/core/cloud/__tests__/credits-inference.test.ts apps/client/src/layers/entities/connectors/lib/__tests__/cloud-failure.test.ts apps/client/src/layers/features/connections/__tests__/ConnectionAccessCard.test.tsx apps/site/src/lib/connectors/managed/__tests__/discovery-service.wire-mapping.test.ts apps/site/src/app/api/instances/connectors/__tests__/managed-discovery-routes.test.ts` \u2014 every test file touched or added across tasks 1.1-5.1 in one pass.
- `grep -rn "Couldn.t load who can use it\|Couldn.t load account actions\|Couldn.t load this app" apps/e2e` (and the final chosen copy strings); if anything hits, run the `chromium-connections` Playwright project locally before pushing.
- `pnpm verify` (the affected-only typecheck+lint+test loop-closer) from repo root.
- `pnpm --filter @dorkos/shared typecheck && pnpm --filter @dorkos/server typecheck && pnpm --filter @dorkos/client typecheck && pnpm --filter @dorkos/site typecheck` as a final explicit confirmation beyond whatever `pnpm verify` scoped as "affected".

**Acceptance criteria:** every command above exits 0; the changelog fragment passes `.claude/scripts/changelog_backfill.py --validate` (or the equivalent pre-commit changelog gate) if run locally; `contributing/adding-a-connector.md` renders its new section between the two named headings with no broken cross-references.
