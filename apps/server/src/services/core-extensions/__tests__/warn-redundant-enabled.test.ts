import { describe, it, expect, vi, afterEach } from 'vitest';
import { warnRedundantEnabledEntries } from '../warn-redundant-enabled.js';
import type { CoreExtensionInfo } from '../../extensions/extension-enable-resolution.js';
import { logger } from '../../../lib/logger.js';

const ON_CORE: CoreExtensionInfo = { id: 'marketplace', defaultEnabled: true, canDisable: true };
const OFF_CORE: CoreExtensionInfo = { id: 'hello-world', defaultEnabled: false, canDisable: true };

describe('warnRedundantEnabledEntries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns once when a default-on core id is in enabled', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    warnRedundantEnabledEntries([ON_CORE], ['marketplace']);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual(
      expect.arrayContaining([expect.stringContaining('extensions.disabled'), 'marketplace'])
    );
  });

  it('does not warn when a default-on core id is only in disabled (correct opt-out)', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // A default-on id belongs in `disabled` to turn it off — not `enabled`.
    warnRedundantEnabledEntries([ON_CORE], []);

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn for a default-off core id in enabled (correct opt-in)', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    warnRedundantEnabledEntries([OFF_CORE], ['hello-world']);

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once per offending id across a mixed set', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const secondOn: CoreExtensionInfo = { id: 'second-on', defaultEnabled: true, canDisable: true };

    warnRedundantEnabledEntries(
      [ON_CORE, OFF_CORE, secondOn],
      ['marketplace', 'hello-world', 'second-on']
    );

    // marketplace + second-on warn; hello-world (default-off) does not.
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
