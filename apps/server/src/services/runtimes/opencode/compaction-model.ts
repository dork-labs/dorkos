/**
 * The model OpenCode compaction runs on — resolved for `session.summarize`.
 *
 * ## Why this module exists
 *
 * `POST /session/{id}/summarize` REQUIRES a `{providerID, modelID}` body. The
 * `@opencode-ai/sdk` types it as `body?:` — hey-api generates every payload as
 * optional — so omitting it compiles, passes a mocked test, and then fails
 * against the real sidecar with
 * `{"name":"BadRequest","data":{"message":"Expected object, got undefined","kind":"Payload"}}`
 * (DOR-1668, found on a live sidecar, not by a mocked test). The shipped
 * 1.18.15 route declares `payload: Struct({providerID, modelID, auto?})` with
 * no `NoContent` arm, which is why an absent body is a 400 rather than a
 * default: routes that tolerate an absent body declare `payload: [NoContent, …]`
 * instead, as `session.create` and `session.fork` do.
 *
 * Unlike a prompt, compaction cannot fall back to OpenCode's own model
 * resolution — the caller has to name a model. This ladder reproduces the
 * resolution OpenCode itself performs for a session (its `SessionPrompt` model
 * lookup: session model → last user message's model → configured default), with
 * DorkOS's tracked session model standing in for the first rung because that is
 * the model DorkOS's own next prompt would use.
 *
 * @module services/runtimes/opencode/compaction-model
 */
import type { OpencodeClient, SessionMessagesResponse } from '@opencode-ai/sdk';
import { unwrap } from './session-mapper.js';
import { parseModelSelection } from './turn-input.js';

/** The `{providerID, modelID}` pair `session.summarize` takes as its body. */
export interface OpenCodeModelSelection {
  /** OpenCode provider id, e.g. `anthropic`, `ollama`, `openrouter`. */
  providerID: string;
  /** Model id within that provider, e.g. `claude-sonnet-4-5`. */
  modelID: string;
}

/**
 * What {@link resolveCompactionModel} needs to answer. An options object rather
 * than positional arguments because `ocSessionId`, `cwd` and `trackedModel` are
 * all strings: transposing two of them would type-check silently and compact on
 * the wrong thing.
 */
export interface CompactionModelInput {
  /** The OpenCode `ses_*` id being compacted. */
  ocSessionId: string;
  /**
   * The session's working directory. Load-bearing for rung 3: the sidecar
   * resolves config per directory and falls back to ITS OWN `process.cwd()`
   * when none is given (NOTES.md §1, §9) — which is the DorkOS server's cwd,
   * an unrelated folder, since `server-manager.ts` spawns the sidecar with no
   * `cwd` of its own.
   */
  cwd: string;
  /** The DorkOS-tracked session model (`provider/model`), when the session has one. */
  trackedModel: string | undefined;
}

/**
 * Resolve the model OpenCode should compact this session with.
 *
 * Three rungs, most specific first:
 *
 * 1. **The session's DorkOS model** — the operator's own pick, and exactly what
 *    the next `session.promptAsync` would carry. Compacting on a different
 *    model than the conversation runs on would be a surprise.
 * 2. **The last model this session actually ran on**, read back from the
 *    sidecar's own store. Covers sessions DorkOS never set a model on, and is
 *    the same rung OpenCode's automatic (context-overflow) compaction uses.
 * 3. **The sidecar's configured default** (`config.model`, `provider/model`).
 *    Covers a session with no model and no history — a `/compact` on a session
 *    that has not spoken yet.
 *
 * There is deliberately no fourth rung guessing a model out of the provider
 * catalog: that would spend the user's money on a model they never chose, and
 * the failure it would paper over ("nothing anywhere names a model") is worth
 * saying out loud.
 *
 * @param client - The sidecar client for this session's directory.
 * @param input - Which session to compact and what to compact it on.
 * @returns The `{providerID, modelID}` body for `session.summarize`.
 * @throws When no rung names a model — the honest outcome, since the sidecar
 *   would answer a bare 400 that says nothing about how to fix it.
 */
export async function resolveCompactionModel(
  client: OpencodeClient,
  input: CompactionModelInput
): Promise<OpenCodeModelSelection> {
  const tracked = parseModelSelection(input.trackedModel);
  if (tracked) return tracked;

  const lastRun = await readLastMessageModel(client, input.ocSessionId);
  if (lastRun) return lastRun;

  const configured = await readConfiguredDefaultModel(client, input.cwd);
  if (configured) return configured;

  throw new Error(
    'OpenCode compaction needs a model and nothing names one: this session has no model set in ' +
      'DorkOS, has not run a turn yet, and your OpenCode config sets no default `model`. Pick a ' +
      'model for the session, then compact again.'
  );
}

/**
 * How many messages off the tail rung 2 reads before falling back to the whole
 * transcript. The answer lives in the last user message, so a small window is
 * almost always enough — and the sessions that reach compaction are exactly the
 * ones whose full transcript (every message, every tool output) is expensive to
 * pull just to read a `{providerID, modelID}` off the end.
 */
const TAIL_WINDOW = 10;

/**
 * The model of the session's most recent user message — what the session last
 * ran on, as the sidecar itself recorded it. Session-scoped reads need no
 * `directory`: the server routes by the session's stored one (NOTES.md §1).
 *
 * Reads the TAIL first. Verified live against 1.18.15: `limit=N` returns the
 * NEWEST N messages, ascending within that window, and advertises a `before`
 * cursor for the older page — so a short window is the cheap end of the
 * transcript, not the wrong end. A full window with no user message in it is
 * the only case that can still be hiding one, and only that case pays for the
 * unbounded read.
 */
async function readLastMessageModel(
  client: OpencodeClient,
  ocSessionId: string
): Promise<OpenCodeModelSelection | undefined> {
  const window = unwrap(
    await client.session.messages({ path: { id: ocSessionId }, query: { limit: TAIL_WINDOW } }),
    'session.messages'
  );
  const found = findLastUserModel(window);
  if (found) return found;
  if (window.length < TAIL_WINDOW) return undefined;

  const entries = unwrap(
    await client.session.messages({ path: { id: ocSessionId } }),
    'session.messages'
  );
  return findLastUserModel(entries);
}

/** Scan a message window newest-first for the last user message that names a model. */
function findLastUserModel(entries: SessionMessagesResponse): OpenCodeModelSelection | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const info = entries[index]?.info;
    // `model` is typed required, but OpenCode's own resolver still guards it
    // (`role === 'user' && !!info.model`) — so a modelless user message keeps
    // the scan descending instead of raising a bare TypeError here.
    if (info?.role === 'user' && info.model) {
      return { providerID: info.model.providerID, modelID: info.model.modelID };
    }
  }
  return undefined;
}

/**
 * The configured default model for THIS SESSION'S directory (`model` in the
 * project's `opencode.json`, written `provider/model`). Absent for the many
 * installs that let OpenCode pick from its recent-model state instead — that
 * state is OpenCode's private file, not something DorkOS reads.
 *
 * `query.directory` is REQUIRED, not decoration. The server resolves the config
 * for `directory` → the `x-opencode-directory` header → its own `process.cwd()`,
 * and the sidecar is spawned with no `cwd` of its own, so omitting it answers
 * with whatever project the DorkOS server process happens to be sitting in.
 * Same reason `mcp-status.ts` passes it.
 */
async function readConfiguredDefaultModel(
  client: OpencodeClient,
  cwd: string
): Promise<OpenCodeModelSelection | undefined> {
  const config = unwrap(await client.config.get({ query: { directory: cwd } }), 'config.get');
  return parseModelSelection(config.model);
}
