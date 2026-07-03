/**
 * Runtime + model identity formatting — the single source for the
 * "runtime · model" label shown wherever a session's identity appears (the
 * status chip, session-list marks, the "Run this with…" menu). One formatter so
 * every surface reads the same, degrading to the runtime alone when no model is
 * resolved yet — never a broken or empty model (spec
 * effortless-runtime-switching, decision 8).
 *
 * @module entities/runtime/lib/runtime-identity
 */
import { getRuntimeDescriptor } from '../config/runtime-descriptors';

/**
 * Reduce a model identifier to its human-facing short label.
 *
 * OpenCode encodes models as `provider/model` (e.g. `ollama/qwen2.5-coder`); the
 * identity shows only the model half so "OpenCode · qwen2.5-coder" reads clean.
 * Ids that carry no provider prefix (e.g. Claude's `claude-sonnet-5`) pass
 * through unchanged. Returns `null` for an absent or blank model so callers
 * degrade to the runtime alone rather than render an empty segment.
 *
 * @param model - The resolved model id, or nullish when none is selected yet.
 */
export function formatModelLabel(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;
  const slash = trimmed.lastIndexOf('/');
  const label = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  return label.length > 0 ? label : null;
}

/** A session's resolved identity, formatted for display. */
export interface RuntimeIdentityText {
  /** Runtime display label from the descriptor registry (e.g. `OpenCode`). */
  label: string;
  /** Short model label, or `null` when no model is resolved. */
  modelLabel: string | null;
  /** The combined identity: `"<label> · <model>"`, or just `<label>` when no model. */
  text: string;
}

/**
 * Format a session's identity as runtime + model.
 *
 * Visual identity (the runtime label) always comes from
 * {@link getRuntimeDescriptor} — the single source — so unknown runtimes degrade
 * to the neutral fallback here too. The model half is appended only when
 * resolved; otherwise the identity is the runtime alone (honest — never an
 * invented or blank model).
 *
 * @param params - The runtime type and the session's resolved model id.
 */
export function formatRuntimeIdentity(params: {
  runtime: string;
  model?: string | null;
}): RuntimeIdentityText {
  const label = getRuntimeDescriptor(params.runtime).label;
  const modelLabel = formatModelLabel(params.model);
  return {
    label,
    modelLabel,
    text: modelLabel ? `${label} · ${modelLabel}` : label,
  };
}
