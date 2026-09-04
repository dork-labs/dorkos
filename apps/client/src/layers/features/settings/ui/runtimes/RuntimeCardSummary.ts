/**
 * The collapsed runtime card's one-line summary, as data rather than a string.
 *
 * A card at rest is a header and this line: "Starts with **Opus 4.6** · **High
 * effort** · **Asks first** · billing **Personal**" (design §4). It answers one
 * question — *what will a new conversation on this runtime do?* — and it answers
 * it while the card is closed, which is exactly when nobody can check it. So the
 * rules live here, pure, and the view only styles what it is handed.
 *
 * Two properties are worth the separate module. **It returns segments, not a
 * joined string**, because the view renders the value half differently from the
 * separator and marks inherited values as inherited; a pre-joined line would put
 * that formatting back in a component and out of reach of a test. And **it is
 * React-free**, so every rule below is one table row instead of a rendered card.
 *
 * The absences are the contract. A runtime that takes no effort — or one whose
 * chosen model takes none — emits no effort segment (not an empty one); a
 * declared section with no value emits nothing;
 * and a runtime that cannot start a conversation emits no summary at all, because
 * a summary of what a disconnected runtime "will do" is a sentence about nothing.
 *
 * @module features/settings/ui/runtimes/RuntimeCardSummary
 */
import type { PermissionStop, RuntimeSettingsCapability } from '@dorkos/shared/agent-runtime';
import type { EffortLevel } from '@dorkos/shared/types';
import { effortLabel } from '@/layers/shared/lib';

/** Which rule produced a summary segment. */
export type RuntimeSummarySegmentKind = 'model' | 'effort' | 'trust' | 'section';

/** One piece of the collapsed card's summary line. */
export interface RuntimeSummarySegment {
  /** Which rule produced this segment. */
  kind: RuntimeSummarySegmentKind;
  /** The rendered value, e.g. `Opus 4.6`, `High effort`, `Asks first`. */
  label: string;
  /**
   * True when the value is inherited rather than set on this runtime — the view
   * renders those quieter. Carried on the two segments that can be inherited
   * (model, trust) and left off the two that cannot: an effort and a section
   * value are always this runtime's own.
   */
  inherited?: boolean;
}

/**
 * Everything the summary needs, already flattened by the card container.
 *
 * Every field but `ready` is optional, and each absence is read as "not asked
 * yet" rather than as a value — the capability map, the model catalog and the
 * config all arrive separately, and a half-loaded card must not claim things.
 */
export interface RuntimeCardSummaryInput {
  /**
   * Whether the runtime can start a conversation right now. False short-circuits
   * the whole line — see the module note.
   */
  ready: boolean;
  /**
   * The runtime's declared settings surface (`settingsForRuntime`), or undefined
   * while capabilities load. Undefined means the runtime has not said whether it
   * takes an effort or what sections it has, so neither is guessed.
   */
  settings?: RuntimeSettingsCapability | undefined;
  /** This runtime's configured default model id; null/undefined means inherit. */
  model?: string | null | undefined;
  /**
   * The runtime's model catalog as fetched, or undefined while it loads. An
   * EMPTY catalog is the same absence as a missing one — it resolves nothing, and
   * a configured model falls back to its raw id either way.
   */
  models?: readonly { value: string; displayName: string }[] | undefined;
  /** This runtime's configured default effort, or null/undefined when unset. */
  effort?: EffortLevel | null | undefined;
  /**
   * Whether the SELECTED model takes an effort setting, or undefined while the
   * catalog cannot say — the same question the expanded card's Effort row asks a
   * level below `supportsEffort`.
   *
   * Undefined is read as "not asked yet" and keeps the segment, matching the
   * row's own rule that evidence nobody has is never evidence against. An
   * explicit `false` is the one answer that silences it: the row says the model
   * takes none and offers to clear the stranded value, so a collapsed line still
   * promising "High effort" would contradict the card a click away.
   */
  modelTakesEffort?: boolean | undefined;
  /**
   * The stop that a new session on this runtime actually starts at — the runtime's
   * own override if it has one, else the global dial. Null/undefined means nobody
   * has answered (the runtime decides), which is not a stop and gets no segment.
   */
  trustStop?: PermissionStop | null | undefined;
  /** True when {@link trustStop} came from the global dial rather than this runtime. */
  trustInherited?: boolean | undefined;
  /**
   * The resolved display value for each declared section kind, or null when the
   * section has nothing to say (the default Claude account, no OpenCode provider
   * chosen). Resolution belongs to the container, which has the config; the
   * wording of the segment belongs here.
   */
  sectionValues?: Readonly<Record<string, string | null | undefined>> | undefined;
}

/**
 * What a card says when nobody has pinned a model: the runtime picks.
 *
 * The same word the rows' own inherit option carries, because the summary is
 * read as the answer to what those rows are set to. It used to say "Runtime's
 * choice", which spent the one word Settings never defines on a value that
 * only means "we did not choose" (DOR-1754).
 */
const INHERIT_MODEL_LABEL = 'Automatic';

/**
 * The stops in summary voice — what this runtime *does*, not what the control is
 * called.
 *
 * Deliberately not `stopLabel()` from the Trust Dial: that names the POSITION a
 * person picks ("Ask first", "Act") on a control they are looking at, while this
 * line is read as a sentence about behaviour ("Starts with Opus 4.6 · High
 * effort · Asks first"). The dial's noun phrases read as commands there and as
 * fragments here. Same three stops, one reading voice each; design §4 fixes this
 * wording.
 */
const STOP_SUMMARY_LABELS: Record<PermissionStop, string> = {
  ask: 'Asks first',
  act: 'Pauses at big steps',
  autonomy: 'Full autonomy',
};

/**
 * How each bespoke section writes its one value into the line.
 *
 * Keyed by the declared `kind`, so a section this client has no renderer for
 * also has no summary wording — it stays silent rather than leaking a raw value,
 * matching the section registry's forward-compatible rule that unknown kinds
 * render nothing.
 */
const SECTION_SUMMARY_LABELS: Record<string, (value: string) => string> = {
  'claude-accounts': (name) => `billing ${name}`,
  'opencode-power-source': (provider) => provider,
};

/**
 * Build the ordered segments of a collapsed runtime card's summary line.
 *
 * Order is fixed — model, effort, trust, then declared sections in declaration
 * order — so the cards read as one column rather than four sentences.
 *
 * @param input - The card's state, flattened by its container.
 * @returns The segments to render, or an empty array when the runtime is not
 *   ready and the view should say "One sign-in away." instead.
 */
export function buildRuntimeCardSummary(input: RuntimeCardSummaryInput): RuntimeSummarySegment[] {
  if (!input.ready) return [];

  const segments: RuntimeSummarySegment[] = [];

  const configured = input.model?.trim();
  if (configured) {
    // A configured model the catalog cannot name is reported as its raw id: that
    // is the honest interim truth both while the catalog loads and after a model
    // is retired, and it is never "Automatic", which would claim the person
    // set nothing.
    const known = input.models?.find((option) => option.value === configured);
    segments.push({ kind: 'model', label: known?.displayName ?? configured, inherited: false });
  } else {
    segments.push({ kind: 'model', label: INHERIT_MODEL_LABEL, inherited: true });
  }

  // Only when the runtime declares that it takes an effort at all AND the chosen
  // model has not said it takes none. A saved effort either of them will ignore
  // is stranded config: the expanded card offers to clear it, and the summary
  // stays quiet rather than promising something nothing will read.
  if (input.settings?.supportsEffort && input.effort && input.modelTakesEffort !== false) {
    segments.push({ kind: 'effort', label: `${effortLabel(input.effort)} effort` });
  }

  if (input.trustStop) {
    segments.push({
      kind: 'trust',
      label: STOP_SUMMARY_LABELS[input.trustStop],
      inherited: input.trustInherited ?? false,
    });
  }

  for (const section of input.settings?.sections ?? []) {
    const value = input.sectionValues?.[section.kind]?.trim();
    const write = SECTION_SUMMARY_LABELS[section.kind];
    if (value && write) segments.push({ kind: 'section', label: write(value) });
  }

  return segments;
}
