/**
 * The per-session context-health merge resolver — the single place the list
 * reading (`Session.contextTokens` ÷ the model catalog window) and the live
 * `session_status` reading (retained in the store) are reconciled into ONE
 * row-level reading with **live-wins** precedence (spec §6). The pure core
 * ({@link resolveSessionContextHealth}) is shared by both the per-row gauge
 * (via {@link useSessionContextHealth}) and the fleet rollup, so there is
 * exactly one resolution rule — never a second copy that can drift.
 *
 * @module entities/session/model/use-session-context-health
 */
import type { Session } from '@dorkos/shared/types';
// Same-slice imports via sibling modules (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { deriveContextPercent, contextSeverity, type ContextSeverity } from '../lib/context-health';
import { useModels } from './use-models';
import { useSessionContextReading, type SessionContextReading } from './session-list-store';

/**
 * A resolved per-session context reading. `known` carries a `percent` +
 * `severity`; `unknown` carries neither (a codex/opencode closed row, or a
 * model with no catalog window) — never a fabricated 0%. `autoCompactedAt`
 * rides ALL branches so the discreet marker can show even on an unknown row.
 */
export interface SessionContextHealth {
  /** `known` when a percent resolved from a live or list reading; else `unknown`. */
  status: 'known' | 'unknown';
  /** Context-window utilization percent (0-100). Present only when `known`. */
  percent?: number;
  /** Severity band for {@link percent}. Present only when `known`. */
  severity?: ContextSeverity;
  /** ISO timestamp of the most recent auto-compaction in the tail, when present. */
  autoCompactedAt?: string;
  /** `true` when the reading came from the live `session_status` fan-out. */
  fresh: boolean;
  /** ISO stamp the reading is "as of" — the live receive time or `updatedAt`. */
  asOf: string;
}

/**
 * The pure §6 resolution rule, dependency-free so it can run inside a fold (the
 * fleet rollup) as well as a per-row hook. Precedence:
 *
 * 1. **Live** — a retained `reading` resolves to a percent ⇒ `known`, `fresh`,
 *    `asOf` = the reading's receive time.
 * 2. **List** — else `session.contextTokens` ÷ `window` resolves ⇒ `known`,
 *    NOT fresh, `asOf` = `session.updatedAt`.
 * 3. **Unknown** — neither resolves (no reading, no tokens, or no catalog
 *    window) ⇒ `unknown`. Never 0%.
 *
 * @param session - The session row (carries `contextTokens`, `lastAutoCompactAt`).
 * @param opts.reading - The retained live reading for this session, or `null`.
 * @param opts.window - The model's context window from the catalog, or nullish.
 */
export function resolveSessionContextHealth(
  session: Session,
  opts: { reading: SessionContextReading | null; window: number | null | undefined }
): SessionContextHealth {
  const autoCompactedAt = session.lastAutoCompactAt;

  // 1. Live wins — the retained session_status reading carries its own maxTokens.
  if (opts.reading) {
    const percent = deriveContextPercent(
      opts.reading.contextUsage.totalTokens,
      opts.reading.contextUsage.maxTokens
    );
    if (percent != null) {
      return {
        status: 'known',
        percent,
        severity: contextSeverity(percent),
        autoCompactedAt,
        fresh: true,
        asOf: opts.reading.receivedAt,
      };
    }
  }

  // 2. List reading — derived client-side against the model catalog window.
  const listPercent = deriveContextPercent(session.contextTokens, opts.window);
  if (listPercent != null) {
    return {
      status: 'known',
      percent: listPercent,
      severity: contextSeverity(listPercent),
      autoCompactedAt,
      fresh: false,
      asOf: session.updatedAt,
    };
  }

  // 3. Unknown — an honest muted state, never a fabricated 0%.
  return { status: 'unknown', autoCompactedAt, fresh: false, asOf: session.updatedAt };
}

/**
 * Resolve a single session's context health with live-wins precedence
 * (spec §6). Reads the retained live reading from the store and the model's
 * context window from the runtime catalog (`useModels`, cached + deduped by
 * query key across rows), then applies {@link resolveSessionContextHealth}.
 *
 * @param session - The session row to resolve.
 */
export function useSessionContextHealth(session: Session): SessionContextHealth {
  const reading = useSessionContextReading(session.id);
  const { data: models } = useModels({ runtime: session.runtime });
  const window = models?.find((m) => m.value === session.model)?.contextWindow ?? null;
  return resolveSessionContextHealth(session, { reading, window });
}
