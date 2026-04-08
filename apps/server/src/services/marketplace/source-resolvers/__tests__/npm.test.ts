/**
 * Tests for the npm source resolver stub. Verifies the structured deferred
 * error shape — no filesystem or network access.
 */
import { describe, it, expect } from 'vitest';
import { npmResolver, NpmSourceNotSupportedError } from '../npm.js';
import type { FetchPackageOptions } from '../../package-fetcher.js';

const opts: FetchPackageOptions = {
  packageName: 'foo',
  source: { source: 'npm', package: '@dorkos/foo' },
};

describe('npmResolver', () => {
  it('throws NpmSourceNotSupportedError', async () => {
    await expect(npmResolver({ type: 'npm', package: '@dorkos/foo' }, opts)).rejects.toBeInstanceOf(
      NpmSourceNotSupportedError
    );
  });

  it('error includes package name in message and property', async () => {
    try {
      await npmResolver({ type: 'npm', package: '@dorkos/foo', version: '^1.0.0' }, opts);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NpmSourceNotSupportedError);
      const npmErr = err as NpmSourceNotSupportedError;
      expect(npmErr.name).toBe('NpmSourceNotSupportedError');
      expect(npmErr.package).toBe('@dorkos/foo');
      expect(npmErr.version).toBe('^1.0.0');
      expect(npmErr.docs).toBe('https://docs.dorkos.ai/marketplace/source-types#npm');
      expect(npmErr.message).toContain('@dorkos/foo');
      expect(npmErr.message).toContain('marketplace-06-npm-sources');
    }
  });

  it('error has docs URL', async () => {
    try {
      await npmResolver({ type: 'npm', package: 'bare-pkg' }, opts);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as NpmSourceNotSupportedError).docs).toMatch(/source-types#npm/);
    }
  });
});
