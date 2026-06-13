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
const empty: ExtensionsConfig = { enabled: [], disabled: [] };

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
      isEnabled('marketplace', { enabled: [], disabled: ['marketplace'] }, coreMap(ON_CORE))
    ).toBe(false);
  });

  it('default-off core in enabled → enabled (opt-in path)', () => {
    expect(
      isEnabled('hello-world', { enabled: ['hello-world'], disabled: [] }, coreMap(OFF_CORE))
    ).toBe(true);
  });

  it('user extension in enabled → enabled', () => {
    expect(isEnabled('user-ext', { enabled: ['user-ext'], disabled: [] }, coreMap())).toBe(true);
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
      { enabled: [], disabled: ['marketplace'] },
      coreMap(ON_CORE)
    );
    expect(next).toEqual({ enabled: [], disabled: [] });
  });

  it('default-on core disable → adds id to disabled', () => {
    const next = setEnabled('marketplace', false, empty, coreMap(ON_CORE));
    expect(next).toEqual({ enabled: [], disabled: ['marketplace'] });
  });

  it('default-off core enable → adds id to enabled', () => {
    const next = setEnabled('hello-world', true, empty, coreMap(OFF_CORE));
    expect(next).toEqual({ enabled: ['hello-world'], disabled: [] });
  });

  it('default-off core disable → removes id from enabled', () => {
    const next = setEnabled(
      'hello-world',
      false,
      { enabled: ['hello-world'], disabled: [] },
      coreMap(OFF_CORE)
    );
    expect(next).toEqual({ enabled: [], disabled: [] });
  });

  it('user extension enable → adds id to enabled', () => {
    const next = setEnabled('user-ext', true, empty, coreMap());
    expect(next).toEqual({ enabled: ['user-ext'], disabled: [] });
  });

  it('user extension disable → removes id from enabled', () => {
    const next = setEnabled('user-ext', false, { enabled: ['user-ext'], disabled: [] }, coreMap());
    expect(next).toEqual({ enabled: [], disabled: [] });
  });
});

describe('setEnabled — invariants', () => {
  it('does not mutate the input config', () => {
    const input: ExtensionsConfig = { enabled: ['a'], disabled: ['marketplace'] };
    const snapshot = JSON.parse(JSON.stringify(input));
    setEnabled('marketplace', true, input, coreMap(ON_CORE));
    expect(input).toEqual(snapshot);
  });

  it('does not duplicate an id when enabling an already-enabled default-off ext', () => {
    const next = setEnabled(
      'hello-world',
      true,
      { enabled: ['hello-world'], disabled: [] },
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
