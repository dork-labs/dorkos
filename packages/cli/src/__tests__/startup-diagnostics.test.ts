import { describe, it, expect } from 'vitest';
import {
  checkNodeVersion,
  diagnoseStartupError,
  formatDiagnostic,
  MIN_NODE_VERSION,
} from '../startup-diagnostics.js';

describe('startup-diagnostics', () => {
  // ---------------------------------------------------------------------------
  // checkNodeVersion
  // ---------------------------------------------------------------------------
  describe('checkNodeVersion', () => {
    it('returns null for the current supported Node.js runtime', () => {
      // Test is running on a supported Node.js version
      expect(checkNodeVersion()).toBeNull();
    });

    it('requires the first Node release supported by the Composio SDK', () => {
      expect(MIN_NODE_VERSION).toBe('22.22.3');
      expect(checkNodeVersion('22.21.9')).toMatchObject({ category: 'node-version' });
      expect(checkNodeVersion('22.22.2')).toMatchObject({
        category: 'node-version',
        headline: 'Node.js 22.22.2 is not supported',
      });
      expect(checkNodeVersion('22.22.3')).toBeNull();
      expect(checkNodeVersion('24.14.1')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // diagnoseStartupError — SDK mismatch
  // ---------------------------------------------------------------------------
  describe('SDK version mismatch', () => {
    it('detects missing export from claude-agent-sdk', () => {
      const err = new SyntaxError(
        "The requested module '@anthropic-ai/claude-agent-sdk' does not provide an export named 'forkSession'"
      );
      const diag = diagnoseStartupError(err);

      expect(diag.category).toBe('sdk-mismatch');
      expect(diag.headline).toContain('Claude Agent SDK');
      expect(diag.detail).toContain('forkSession');
      expect(diag.fix).toContain('npm install -g dorkos@latest');
    });

    it('detects cannot find claude-agent-sdk module', () => {
      const err = Object.assign(new Error("Cannot find module '@anthropic-ai/claude-agent-sdk'"), {
        code: 'MODULE_NOT_FOUND',
      });
      const diag = diagnoseStartupError(err);

      expect(diag.category).toBe('sdk-mismatch');
    });

    it('detects is not a function errors (runtime SDK mismatch)', () => {
      const err = new TypeError('sdkForkSession is not a function');
      const diag = diagnoseStartupError(err);

      expect(diag.category).toBe('sdk-mismatch');
    });
  });

  // ---------------------------------------------------------------------------
  // diagnoseStartupError — missing dependency
  // ---------------------------------------------------------------------------
  describe('missing dependency', () => {
    it('detects MODULE_NOT_FOUND for non-SDK modules', () => {
      const err = Object.assign(new Error("Cannot find module 'some-dep'"), {
        code: 'MODULE_NOT_FOUND',
      });
      const diag = diagnoseStartupError(err);

      expect(diag.category).toBe('module-not-found');
      expect(diag.headline).toContain('some-dep');
      expect(diag.fix).toContain('npm install -g dorkos@latest');
    });
  });

  // ---------------------------------------------------------------------------
  // diagnoseStartupError — port conflict
  // ---------------------------------------------------------------------------
  describe('port conflict', () => {
    it('detects EADDRINUSE', () => {
      const err = Object.assign(new Error('listen EADDRINUSE: address already in use :::4242'), {
        code: 'EADDRINUSE',
      });
      const diag = diagnoseStartupError(err);

      expect(diag.category).toBe('port-conflict');
      expect(diag.headline).toContain('4242');
      expect(diag.fix).toContain('lsof');
      expect(diag.fix).toContain('--port');
    });
  });

  // ---------------------------------------------------------------------------
  // diagnoseStartupError — permission errors
  // ---------------------------------------------------------------------------
  describe('permission errors', () => {
    it('detects EACCES', () => {
      const err = Object.assign(
        new Error("EACCES: permission denied, open '/root/.dork/dork.db'"),
        {
          code: 'EACCES',
        }
      );
      const diag = diagnoseStartupError(err);

      expect(diag.category).toBe('permission-denied');
      expect(diag.fix).toContain('chown');
    });

    it('detects EPERM', () => {
      const err = Object.assign(new Error('EPERM: operation not permitted'), {
        code: 'EPERM',
      });
      const diag = diagnoseStartupError(err);

      expect(diag.category).toBe('permission-denied');
    });
  });

  // ---------------------------------------------------------------------------
  // diagnoseStartupError — database errors
  // ---------------------------------------------------------------------------
  describe('database errors', () => {
    it('detects SQLite errors', () => {
      const err = new Error('SQLITE_CORRUPT: database disk image is malformed');
      const diag = diagnoseStartupError(err);

      expect(diag.category).toBe('db-error');
      expect(diag.fix).toContain('dork.db.bak');
    });

    it('detects migration errors', () => {
      const err = new Error('migration failed: column already exists');
      const diag = diagnoseStartupError(err);

      expect(diag.category).toBe('db-error');
    });
  });

  // ---------------------------------------------------------------------------
  // diagnoseStartupError — config errors
  // ---------------------------------------------------------------------------
  describe('config errors', () => {
    it('detects JSON config parse errors', () => {
      const err = new Error('config validation failed: JSON parse error at position 42');
      const diag = diagnoseStartupError(err);

      expect(diag.category).toBe('config-error');
      expect(diag.fix).toContain('dorkos config validate');
    });
  });

  // ---------------------------------------------------------------------------
  // diagnoseStartupError — unknown errors
  // ---------------------------------------------------------------------------
  describe('unknown errors', () => {
    it('falls through to unknown for unrecognized errors', () => {
      const err = new Error('something entirely unexpected');
      const diag = diagnoseStartupError(err);

      expect(diag.category).toBe('unknown');
      expect(diag.detail).toContain('something entirely unexpected');
      expect(diag.fix).toContain('logs');
    });

    it('handles non-Error values', () => {
      const diag = diagnoseStartupError('string error');

      expect(diag.category).toBe('unknown');
      expect(diag.detail).toBe('string error');
    });
  });

  // ---------------------------------------------------------------------------
  // formatDiagnostic
  // ---------------------------------------------------------------------------
  describe('formatDiagnostic', () => {
    it('produces a formatted string with headline, detail, and fix', () => {
      const diag = diagnoseStartupError(
        Object.assign(new Error('listen EADDRINUSE :::4242'), { code: 'EADDRINUSE' })
      );
      const output = formatDiagnostic(diag);

      expect(output).toContain(diag.headline);
      expect(output).toContain('How to fix:');
      expect(output).toContain('Node:');
    });
  });
});
