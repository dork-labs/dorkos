/**
 * The single raw-GraphQL POST every feedback-intake Linear call goes through
 * (feedback-pipeline, decision 260803-205035).
 *
 * Raw `fetch`, no `@linear/sdk` — see `lib/feedback/linear.ts` for why. It
 * lives in its own module because two callers now need it (the issue create
 * and screenshot upload in `linear.ts`, the label lookup in
 * `reported-labels.ts`), and the one subtlety it encodes — the API key goes in
 * `Authorization` **raw**, never as `Bearer <key>` — is the kind of thing that
 * looks correct in a diff while silently failing every real request. One copy,
 * one place to get it right.
 *
 * @module lib/feedback/linear-graphql
 */

const LINEAR_API = 'https://api.linear.app/graphql';

/**
 * Default per-request timeout. The whole feedback sequence runs inside the
 * app's own 10s abort on `POST /api/feedback`, so an unbounded leg here does
 * not merely hang — it lets that abort fire while this route keeps going, and
 * the reporter is told the send failed while the Neon row and the Linear issue
 * both exist. They then refile, and triage gets a duplicate. Callers whose leg
 * matters less pass a smaller cap of their own.
 */
export const GRAPHQL_TIMEOUT_MS = 4_000;

/** A GraphQL envelope: `data` on success, `errors` when Linear rejected the operation. */
export interface GraphQLResponse<TData> {
  data?: TData;
  errors?: Array<{ message: string }>;
}

/**
 * POST a GraphQL operation to Linear. Throws on any non-success outcome (a
 * non-2xx status or a populated `errors[]`); callers decide how to degrade.
 *
 * @param apiKey - The Linear API key, raw and unprefixed.
 * @param query - The GraphQL document.
 * @param variables - Its variables.
 * @param timeoutMs - Per-request abort, defaulting to {@link GRAPHQL_TIMEOUT_MS}.
 */
export async function linearGraphQL<TData>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  timeoutMs: number = GRAPHQL_TIMEOUT_MS
): Promise<GraphQLResponse<TData>> {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    // The raw key, NOT `Bearer <key>` — Linear's API expects the API key
    // unprefixed in the Authorization header.
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Linear API error: ${res.status}`);
  }
  const json = (await res.json()) as GraphQLResponse<TData>;
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  return json;
}
