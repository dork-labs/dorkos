/** Account-aware launch selection on the same app-server process as the turn. */
import { z } from 'zod';
import type { StreamEvent, SessionSettings } from '@dorkos/shared/types';
import { listCodexModels } from '../model-catalog.js';
import type { CodexJsonRpcClient } from './json-rpc-client.js';
import type { CodexAppServerProcess } from './process-pool.js';
import type { CodexTurnRequest } from '../transport/codex-transport.js';

const ModelConfigSchema = z.object({
  model: z.string().nullable().optional(),
  model_provider: z.string().nullable().optional(),
  model_providers: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** A verified replacement, or the original settings when availability is unknown. */
export interface LaunchModel {
  settings: SessionSettings;
  replacement?: { from: string | undefined; to: string; label: string };
}

/**
 * Validate a built-in OpenAI account choice against its live model list.
 * Unknown discovery leaves Codex's existing typed model-error recovery in charge.
 *
 * @param client - Initialized process that will load and run the thread.
 * @param cwd - Project whose effective config Codex reads.
 * @param settings - Explicit DorkOS settings, ahead of the effective config default.
 * @param signal - Cancel waiting when the person stops the turn.
 */
export async function resolveLaunchModel(
  client: CodexJsonRpcClient,
  cwd: string,
  settings: SessionSettings,
  signal: AbortSignal
): Promise<LaunchModel> {
  try {
    const result = await client.request('config/read', { cwd }, { signal, timeoutMs: 15_000 });
    const config = ModelConfigSchema.parse(result.config);
    // Custom endpoints own their model names. Never replace them using OpenAI's catalog.
    const provider = config.model_provider ?? 'openai';
    if (provider !== 'openai' || config.model_providers?.[provider] !== undefined)
      return { settings };
    const chosen = settings.model ?? config.model ?? undefined;
    const models = await listCodexModels(client, { signal });
    if (chosen !== undefined && models.some((model) => model.value === chosen)) return { settings };
    const fallback = models.find((model) => model.isDefault);
    if (!fallback) return { settings };
    return {
      settings: { ...settings, model: fallback.value },
      replacement: { from: chosen, to: fallback.value, label: fallback.displayName },
    };
  } catch {
    // A failed query proves no model unavailable. Let Codex report its own error.
    return { settings };
  }
}

/** A model-selection persistence refusal, rendered by the turn's normal closing path. */
interface ModelSaveError {
  message: string;
  code: string;
}

/** Selection before a thread loads, then its report before inference starts. */
export interface PreparedLaunchModel {
  request: CodexTurnRequest;
  report(): AsyncGenerator<StreamEvent, ModelSaveError | undefined>;
}

/** Account model choices and their once-per-session notices at the launch seam. */
export class CodexLaunchModels {
  private readonly announced = new Map<string, string>();

  /** Resolve only personal prompt turns; credits and compaction retain their own model rules. */
  async prepare(
    process: CodexAppServerProcess,
    request: CodexTurnRequest,
    mode: 'turn' | 'compact'
  ): Promise<PreparedLaunchModel> {
    const selection =
      request.launch.home === 'person' && mode === 'turn'
        ? await resolveLaunchModel(process.client, request.cwd, request.settings, request.signal)
        : { settings: request.settings };
    return {
      request: { ...request, settings: selection.settings },
      report: () =>
        this.report(
          `${process.key}\u0000${request.sessionId}`,
          selection.replacement,
          request.onModelReplacement,
          request.signal
        ),
    };
  }

  private async *report(
    key: string,
    replacement: LaunchModel['replacement'],
    remember: CodexTurnRequest['onModelReplacement'],
    signal: AbortSignal
  ): AsyncGenerator<StreamEvent, ModelSaveError | undefined> {
    if (!replacement || signal.aborted) return;
    const { from, to, label } = replacement;
    try {
      const saving = remember?.(to);
      if (saving) await saving;
    } catch {
      return {
        message: 'Codex couldn’t save the model choice. Send your message again to retry.',
        code: 'codex_model_save_unavailable',
      };
    }
    const signature = JSON.stringify([from, to]);
    if (!signal.aborted && from !== undefined && this.announced.get(key) !== signature) {
      this.announced.set(key, signature);
      yield {
        type: 'model_substituted',
        data: { from, fromName: from, to, toName: label, reason: 'account-not-available' },
      };
    }
  }
}
