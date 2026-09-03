/**
 * The collapsed runtime card's one-line summary, rule by rule.
 *
 * The summary answers one question — *what will a new conversation on this
 * runtime do?* — so every row here is a claim the card makes to a person, and
 * the absences matter as much as the values. A summary that invents a segment
 * (a model name nobody configured, an effort a runtime cannot take, a billing
 * account that is really the default) is a lie the person cannot see through,
 * because the card is collapsed exactly when they are trusting the line.
 *
 * Table-driven and asserting the WHOLE segment array each time: a per-segment
 * assertion would pass while a neighbouring segment appeared out of nowhere.
 */
import { describe, it, expect } from 'vitest';
import type { RuntimeSettingsCapability } from '@dorkos/shared/agent-runtime';
import {
  buildRuntimeCardSummary,
  type RuntimeCardSummaryInput,
  type RuntimeSummarySegment,
} from '../RuntimeCardSummary';

/** Claude Code as it declares itself: config section, effort, a billing section. */
const CLAUDE_SETTINGS: RuntimeSettingsCapability = {
  configSection: 'claudeCode',
  supportsEffort: true,
  sections: [{ kind: 'claude-accounts' }],
};

/** OpenCode as it declares itself: no effort at all, a power-source section. */
const OPENCODE_SETTINGS: RuntimeSettingsCapability = {
  configSection: 'opencode',
  supportsEffort: false,
  sections: [{ kind: 'opencode-power-source' }],
};

/** Codex as it declares itself: effort, but no bespoke section. */
const CODEX_SETTINGS: RuntimeSettingsCapability = {
  configSection: 'codex',
  supportsEffort: true,
  sections: [],
};

/** A loaded catalog, as `GET /api/models` answers for a ready runtime. */
const CATALOG = [
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6' },
  { value: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5' },
];

/** One table row: a card state and the exact line it must produce. */
interface SummaryCase {
  /** What the row pins, in the words of the contract. */
  name: string;
  /** The card state handed to the builder. */
  input: RuntimeCardSummaryInput;
  /** Every segment, in order — nothing more, nothing less. */
  expected: RuntimeSummarySegment[];
}

const CASES: SummaryCase[] = [
  {
    name: 'fully configured Claude Code reads model · effort · trust · billing',
    input: {
      ready: true,
      settings: CLAUDE_SETTINGS,
      model: 'claude-opus-4-6',
      models: CATALOG,
      effort: 'high',
      trustStop: 'ask',
      trustInherited: true,
      sectionValues: { 'claude-accounts': 'Personal' },
    },
    expected: [
      { kind: 'model', label: 'Opus 4.6', inherited: false },
      { kind: 'effort', label: 'High effort' },
      { kind: 'trust', label: 'Asks first', inherited: true },
      { kind: 'section', label: 'billing Personal' },
    ],
  },
  {
    name: 'no configured model reads “Automatic”, marked inherited',
    input: {
      ready: true,
      settings: CODEX_SETTINGS,
      model: null,
      models: CATALOG,
      trustStop: 'act',
      trustInherited: true,
    },
    expected: [
      { kind: 'model', label: 'Automatic', inherited: true },
      { kind: 'trust', label: 'Pauses at big steps', inherited: true },
    ],
  },
  {
    name: 'a configured model missing from the catalog reads as its raw id, never as inherit',
    input: {
      ready: true,
      settings: CODEX_SETTINGS,
      model: 'gpt-5-retired',
      models: CATALOG,
      trustStop: 'ask',
      trustInherited: true,
    },
    expected: [
      { kind: 'model', label: 'gpt-5-retired', inherited: false },
      { kind: 'trust', label: 'Asks first', inherited: true },
    ],
  },
  {
    name: 'an unloaded catalog reads the configured model as its raw id',
    input: {
      ready: true,
      settings: CODEX_SETTINGS,
      model: 'claude-opus-4-6',
      models: undefined,
      trustStop: 'ask',
      trustInherited: true,
    },
    expected: [
      { kind: 'model', label: 'claude-opus-4-6', inherited: false },
      { kind: 'trust', label: 'Asks first', inherited: true },
    ],
  },
  {
    name: 'an EMPTY catalog is the same absence — still the raw id',
    input: {
      ready: true,
      settings: CODEX_SETTINGS,
      model: 'claude-opus-4-6',
      models: [],
      trustStop: 'ask',
      trustInherited: true,
    },
    expected: [
      { kind: 'model', label: 'claude-opus-4-6', inherited: false },
      { kind: 'trust', label: 'Asks first', inherited: true },
    ],
  },
  {
    name: 'a runtime that takes no effort emits none even with an effort stranded in config',
    input: {
      ready: true,
      settings: OPENCODE_SETTINGS,
      model: null,
      effort: 'high',
      trustStop: 'ask',
      trustInherited: true,
    },
    expected: [
      { kind: 'model', label: 'Automatic', inherited: true },
      { kind: 'trust', label: 'Asks first', inherited: true },
    ],
  },
  {
    name: 'a runtime that takes effort emits none when no effort is configured',
    input: {
      ready: true,
      settings: CODEX_SETTINGS,
      model: null,
      effort: null,
      trustStop: 'ask',
      trustInherited: true,
    },
    expected: [
      { kind: 'model', label: 'Automatic', inherited: true },
      { kind: 'trust', label: 'Asks first', inherited: true },
    ],
  },
  {
    name: 'a model that takes no effort silences the segment, even on a runtime that does',
    // The stranded-effort case the opened card already names: the Effort row
    // says the model does not take one and offers to clear it, so a collapsed
    // line still reading "High effort" would be the card contradicting itself.
    input: {
      ready: true,
      settings: CODEX_SETTINGS,
      model: 'claude-sonnet-4-5',
      models: CATALOG,
      effort: 'high',
      modelTakesEffort: false,
      trustStop: 'ask',
      trustInherited: true,
    },
    expected: [
      { kind: 'model', label: 'Sonnet 4.5', inherited: false },
      { kind: 'trust', label: 'Asks first', inherited: true },
    ],
  },
  {
    name: 'a model nobody has asked about yet keeps the effort segment',
    // Undefined is "not asked", never "no" — the same permissive rule the row
    // itself follows while a catalog is in flight.
    input: {
      ready: true,
      settings: CODEX_SETTINGS,
      model: 'claude-sonnet-4-5',
      models: CATALOG,
      effort: 'high',
      modelTakesEffort: undefined,
      trustStop: 'ask',
      trustInherited: true,
    },
    expected: [
      { kind: 'model', label: 'Sonnet 4.5', inherited: false },
      { kind: 'effort', label: 'High effort' },
      { kind: 'trust', label: 'Asks first', inherited: true },
    ],
  },
  {
    name: 'a model that does take an effort keeps the segment',
    input: {
      ready: true,
      settings: CODEX_SETTINGS,
      model: 'claude-sonnet-4-5',
      models: CATALOG,
      effort: 'high',
      modelTakesEffort: true,
      trustStop: 'ask',
      trustInherited: true,
    },
    expected: [
      { kind: 'model', label: 'Sonnet 4.5', inherited: false },
      { kind: 'effort', label: 'High effort' },
      { kind: 'trust', label: 'Asks first', inherited: true },
    ],
  },
  {
    name: 'a runtime that takes no effort stays quiet whatever the model says',
    input: {
      ready: true,
      settings: OPENCODE_SETTINGS,
      model: 'claude-sonnet-4-5',
      models: CATALOG,
      effort: 'high',
      modelTakesEffort: true,
      trustStop: 'ask',
      trustInherited: true,
    },
    expected: [
      { kind: 'model', label: 'Sonnet 4.5', inherited: false },
      { kind: 'trust', label: 'Asks first', inherited: true },
    ],
  },
  {
    name: 'a trust stop overridden on the runtime is not inherited',
    input: {
      ready: true,
      settings: CODEX_SETTINGS,
      model: null,
      trustStop: 'autonomy',
      trustInherited: false,
    },
    expected: [
      { kind: 'model', label: 'Automatic', inherited: true },
      { kind: 'trust', label: 'Full autonomy', inherited: false },
    ],
  },
  {
    name: 'a trust stop that came from the global dial is inherited',
    input: {
      ready: true,
      settings: CODEX_SETTINGS,
      model: null,
      trustStop: 'autonomy',
      trustInherited: true,
    },
    expected: [
      { kind: 'model', label: 'Automatic', inherited: true },
      { kind: 'trust', label: 'Full autonomy', inherited: true },
    ],
  },
  {
    name: 'no effective stop at all (nobody has answered) emits no trust segment',
    input: {
      ready: true,
      settings: CODEX_SETTINGS,
      model: null,
      trustStop: null,
      trustInherited: true,
    },
    expected: [{ kind: 'model', label: 'Automatic', inherited: true }],
  },
  {
    name: 'a runtime declaring no sections stays quiet even when a value is handed in',
    input: {
      ready: true,
      settings: CODEX_SETTINGS,
      model: null,
      trustStop: 'ask',
      trustInherited: true,
      sectionValues: { 'claude-accounts': 'Personal' },
    },
    expected: [
      { kind: 'model', label: 'Automatic', inherited: true },
      { kind: 'trust', label: 'Asks first', inherited: true },
    ],
  },
  {
    name: 'a declared billing section on the default account emits nothing',
    input: {
      ready: true,
      settings: CLAUDE_SETTINGS,
      model: null,
      trustStop: 'ask',
      trustInherited: true,
      sectionValues: { 'claude-accounts': null },
    },
    expected: [
      { kind: 'model', label: 'Automatic', inherited: true },
      { kind: 'trust', label: 'Asks first', inherited: true },
    ],
  },
  {
    name: 'OpenCode’s power source reads as the bare provider name',
    input: {
      ready: true,
      settings: OPENCODE_SETTINGS,
      model: null,
      trustStop: 'ask',
      trustInherited: true,
      sectionValues: { 'opencode-power-source': 'Anthropic' },
    },
    expected: [
      { kind: 'model', label: 'Automatic', inherited: true },
      { kind: 'trust', label: 'Asks first', inherited: true },
      { kind: 'section', label: 'Anthropic' },
    ],
  },
  {
    name: 'a section kind this client cannot write a line for stays silent',
    input: {
      ready: true,
      settings: {
        configSection: 'aider',
        supportsEffort: false,
        sections: [{ kind: 'aider-keys' }],
      },
      model: null,
      trustStop: 'ask',
      trustInherited: true,
      sectionValues: { 'aider-keys': 'something' },
    },
    expected: [
      { kind: 'model', label: 'Automatic', inherited: true },
      { kind: 'trust', label: 'Asks first', inherited: true },
    ],
  },
  {
    name: 'capabilities still loading: model and trust hold, effort and sections wait',
    input: {
      ready: true,
      settings: undefined,
      model: 'claude-opus-4-6',
      models: CATALOG,
      effort: 'high',
      trustStop: 'ask',
      trustInherited: true,
      sectionValues: { 'claude-accounts': 'Personal' },
    },
    expected: [
      { kind: 'model', label: 'Opus 4.6', inherited: false },
      { kind: 'trust', label: 'Asks first', inherited: true },
    ],
  },
  {
    name: 'a runtime that is not ready gets no summary at all',
    input: {
      ready: false,
      settings: CLAUDE_SETTINGS,
      model: 'claude-opus-4-6',
      models: CATALOG,
      effort: 'high',
      trustStop: 'ask',
      trustInherited: true,
      sectionValues: { 'claude-accounts': 'Personal' },
    },
    expected: [],
  },
];

describe('buildRuntimeCardSummary', () => {
  it.each(CASES)('$name', ({ input, expected }) => {
    expect(buildRuntimeCardSummary(input)).toEqual(expected);
  });

  it('emits one segment per declared section that has a value, in declared order', () => {
    // No shipped runtime declares two sections yet. The rule is per-section all
    // the same, so the day one does, the card does not silently drop the second.
    expect(
      buildRuntimeCardSummary({
        ready: true,
        settings: {
          configSection: 'claudeCode',
          supportsEffort: false,
          sections: [{ kind: 'opencode-power-source' }, { kind: 'claude-accounts' }],
        },
        model: null,
        trustStop: null,
        sectionValues: { 'claude-accounts': 'Work', 'opencode-power-source': 'Anthropic' },
      })
    ).toEqual([
      { kind: 'model', label: 'Automatic', inherited: true },
      { kind: 'section', label: 'Anthropic' },
      { kind: 'section', label: 'billing Work' },
    ]);
  });
});
