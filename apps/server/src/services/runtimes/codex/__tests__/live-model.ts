/**
 * Which model a LIVE Codex run uses (`DORKOS_CODEX_LIVE=1` only).
 *
 * With no model chosen in DorkOS, Codex runs the model in the person's own
 * `~/.codex/config.toml`. That file can name a model the signed-in account
 * cannot use — measured 2026-10-05 on the operator's ChatGPT sign-in:
 * `config/read` reported `model = "gpt-6.1-sol"` from `type: user`, every turn
 * failed in two seconds with "not supported when using Codex with a ChatGPT
 * account", and `model/list`'s default for the account was a different model.
 * Both transports read that file, so the exec and app-server live legs failed
 * alike — and only the cases that need a reply could tell.
 *
 * A live run proves DorkOS, not the person's Codex config, so it runs on the
 * account's own default from `model/list` (free: no inference). The product
 * keeps its behaviour: a person's chosen model is theirs, and an unusable one
 * gets DorkOS's plain "choose another model" error.
 *
 * @module services/runtimes/codex/__tests__/live-model
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';

/**
 * The account's default model, as Codex's own model list marks it, or
 * `undefined` when the list is empty (the run then falls back to Codex's
 * configured model, as before).
 *
 * @param runtime - A runtime whose catalog reads the signed-in account.
 */
export async function accountDefaultModel(runtime: AgentRuntime): Promise<string | undefined> {
  const models = await runtime.getSupportedModels();
  return (models.find((model) => model.isDefault) ?? models[0])?.value;
}

/**
 * Make every turn sent to this runtime name `model` unless the caller chose
 * one. Applied only to live runtimes.
 *
 * @param runtime - The live runtime.
 * @param model - The model, or `undefined` to leave the runtime unchanged.
 */
export function onModel<T extends AgentRuntime>(runtime: T, model: string | undefined): T {
  if (model === undefined) return runtime;
  const send = runtime.sendMessage.bind(runtime);
  runtime.sendMessage = (sessionId, content, opts) =>
    send(sessionId, content, { ...opts, model: opts?.model ?? model });
  return runtime;
}
