import { describe, it, expect } from 'vitest';
import {
  defaultsOn,
  isEnabled,
  setEnabled,
  type CoreExtensionInfo,
  type ExtensionsConfig,
} from '../extension-enable-resolution.js';

function coreMap(...infos: CoreExtensionInfo[]): Map<string, CoreExtensionInfo> {
  return new Map(infos.map((i) => [i.id, i]));
}

const ON_CORE: CoreExtensionInfo = { id: 'marketplace', defaultEnabled: true, canDisable: true };
const OFF_CORE: CoreExtensionInfo = { id: 'hello-world', defaultEnabled: false, canDisable: true };
const empty: ExtensionsConfig = { enabled: [], disabled: [], approvedToRun: [] };

describe('defaultsOn', () => {
  it('is true for a default-on core extension', () => {
    expect(defaultsOn('marketplace', coreMap(ON_CORE))).toBe(true);
  });

  it('is false for a default-off core extension', () => {
    expect(defaultsOn('hello-world', coreMap(OFF_CORE))).toBe(false);
  });

  it('is false for an extension absent from the core map (user/marketplace)', () => {
    expect(defaultsOn('some-user-ext', coreMap(ON_CORE, OFF_CORE))).toBe(false);
  });
});

describe('isEnabled — baselines', () => {
  it('default-on core absent from both lists → enabled', () => {
    expect(isEnabled('marketplace', empty, coreMap(ON_CORE))).toBe(true);
  });

  it('default-off core absent from both lists → disabled', () => {
    expect(isEnabled('hello-world', empty, coreMap(OFF_CORE))).toBe(false);
  });

  it('user extension absent from both lists → disabled', () => {
    expect(isEnabled('user-ext', empty, coreMap(ON_CORE, OFF_CORE))).toBe(false);
  });
});

describe('isEnabled — deviations', () => {
  it('default-on core in disabled → disabled', () => {
    expect(
      isEnabled(
        'marketplace',
        { enabled: [], disabled: ['marketplace'], approvedToRun: [] },
        coreMap(ON_CORE)
      )
    ).toBe(false);
  });

  it('default-off core in enabled → enabled (opt-in path)', () => {
    expect(
      isEnabled(
        'hello-world',
        { enabled: ['hello-world'], disabled: [], approvedToRun: [] },
        coreMap(OFF_CORE)
      )
    ).toBe(true);
  });

  it('user extension in enabled → enabled', () => {
    expect(
      isEnabled('user-ext', { enabled: ['user-ext'], disabled: [], approvedToRun: [] }, coreMap())
    ).toBe(true);
  });
});

describe('isEnabled — locked core extensions (canDisable: false)', () => {
  const LOCKED_ON: CoreExtensionInfo = {
    id: 'marketplace',
    defaultEnabled: true,
    canDisable: false,
  };

  it('resolves on even with a stale entry in disabled (pre-lock deviation, DOR-122)', () => {
    expect(
      isEnabled(
        'marketplace',
        { enabled: [], disabled: ['marketplace'], approvedToRun: [] },
        coreMap(LOCKED_ON)
      )
    ).toBe(true);
  });

  it('resolves to its default when absent from both lists', () => {
    expect(isEnabled('marketplace', empty, coreMap(LOCKED_ON))).toBe(true);
  });
});

describe('isEnabled — new core extension on upgrade (absent from both lists)', () => {
  it('newly-shipped default-on core resolves on', () => {
    const freshlyShipped: CoreExtensionInfo = {
      id: 'new-on',
      defaultEnabled: true,
      canDisable: true,
    };
    expect(isEnabled('new-on', empty, coreMap(freshlyShipped))).toBe(true);
  });

  it('newly-shipped default-off core resolves off', () => {
    const freshlyShipped: CoreExtensionInfo = {
      id: 'new-off',
      defaultEnabled: false,
      canDisable: true,
    };
    expect(isEnabled('new-off', empty, coreMap(freshlyShipped))).toBe(false);
  });
});

describe('setEnabled — six toggle→list-mutation cases', () => {
  it('default-on core enable → removes id from disabled', () => {
    const next = setEnabled(
      'marketplace',
      true,
      { enabled: [], disabled: ['marketplace'], approvedToRun: [] },
      coreMap(ON_CORE)
    );
    expect(next).toEqual({ enabled: [], disabled: [], approvedToRun: [] });
  });

  it('default-on core disable → adds id to disabled', () => {
    const next = setEnabled('marketplace', false, empty, coreMap(ON_CORE));
    expect(next).toEqual({ enabled: [], disabled: ['marketplace'], approvedToRun: [] });
  });

  it('default-off core enable → adds id to enabled', () => {
    const next = setEnabled('hello-world', true, empty, coreMap(OFF_CORE));
    expect(next).toEqual({ enabled: ['hello-world'], disabled: [], approvedToRun: [] });
  });

  it('default-off core disable → removes id from enabled', () => {
    const next = setEnabled(
      'hello-world',
      false,
      { enabled: ['hello-world'], disabled: [], approvedToRun: [] },
      coreMap(OFF_CORE)
    );
    expect(next).toEqual({ enabled: [], disabled: [], approvedToRun: [] });
  });

  it('user extension enable → adds id to enabled', () => {
    const next = setEnabled('user-ext', true, empty, coreMap());
    expect(next).toEqual({ enabled: ['user-ext'], disabled: [], approvedToRun: [] });
  });

  it('user extension disable → removes id from enabled', () => {
    const next = setEnabled(
      'user-ext',
      false,
      { enabled: ['user-ext'], disabled: [], approvedToRun: [] },
      coreMap()
    );
    expect(next).toEqual({ enabled: [], disabled: [], approvedToRun: [] });
  });
});

describe('setEnabled — invariants', () => {
  it('carries approvedToRun through untouched, on both enable and disable', () => {
    // `ExtensionManager` writes this return value with
    // `configManager.set('extensions', next)`, which REPLACES the whole subtree. A
    // version of `setEnabled` that built a fresh `{ enabled, disabled }` object
    // would therefore delete every load approval on the install, and the person
    // would be asked again for consent they had already given (DOR-516). Nothing
    // else in the codebase would have complained.
    const core = coreMap(ON_CORE, OFF_CORE);
    const config: ExtensionsConfig = {
      enabled: ['user-ext'],
      disabled: [],
      approvedToRun: ['user-ext', 'another-ext'],
    };

    expect(setEnabled('user-ext', false, config, core).approvedToRun).toEqual([
      'user-ext',
      'another-ext',
    ]);
    expect(setEnabled('hello-world', true, config, core).approvedToRun).toEqual([
      'user-ext',
      'another-ext',
    ]);
    expect(setEnabled('marketplace', false, config, core).approvedToRun).toEqual([
      'user-ext',
      'another-ext',
    ]);
  });

  it('carries through any future key under extensions, not just the ones it knows', () => {
    // The spread is what makes the guarantee general. Asserted with a key this
    // module has never heard of, so the next person to add one inherits the
    // protection instead of rediscovering the bug.
    const next = setEnabled(
      'user-ext',
      true,
      { enabled: [], disabled: [], approvedToRun: [], future: 'keep me' } as ExtensionsConfig & {
        future: string;
      },
      coreMap()
    ) as ExtensionsConfig & { future?: string };
    expect(next.future).toBe('keep me');
  });

  it('does not mutate the input config', () => {
    const input: ExtensionsConfig = {
      enabled: ['a'],
      disabled: ['marketplace'],
      approvedToRun: [],
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    setEnabled('marketplace', true, input, coreMap(ON_CORE));
    expect(input).toEqual(snapshot);
  });

  it('does not duplicate an id when enabling an already-enabled default-off ext', () => {
    const next = setEnabled(
      'hello-world',
      true,
      { enabled: ['hello-world'], disabled: [], approvedToRun: [] },
      coreMap(OFF_CORE)
    );
    expect(next.enabled.filter((id) => id === 'hello-world')).toHaveLength(1);
  });

  it('round-trips through isEnabled (enable then resolve)', () => {
    const core = coreMap(ON_CORE, OFF_CORE);
    let config: ExtensionsConfig = empty;
    config = setEnabled('marketplace', false, config, core);
    config = setEnabled('hello-world', true, config, core);
    expect(isEnabled('marketplace', config, core)).toBe(false);
    expect(isEnabled('hello-world', config, core)).toBe(true);
  });
});
