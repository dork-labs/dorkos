import { describe, it, expect } from 'vitest';
import { AdapterManifestSchema } from '@dorkos/shared/relay-schemas';
import { TELEGRAM_MANIFEST } from '../adapters/telegram/index.js';
import { WEBHOOK_MANIFEST } from '../adapters/webhook/index.js';
import { SLACK_MANIFEST } from '../adapters/slack/index.js';
import { CLAUDE_CODE_MANIFEST } from '../adapters/claude-code/index.js';

describe('Built-in adapter manifests', () => {
  describe('TELEGRAM_MANIFEST', () => {
    it('validates against AdapterManifestSchema', () => {
      const result = AdapterManifestSchema.safeParse(TELEGRAM_MANIFEST);
      expect(result.success).toBe(true);
    });
  });

  describe('WEBHOOK_MANIFEST', () => {
    it('validates against AdapterManifestSchema', () => {
      const result = AdapterManifestSchema.safeParse(WEBHOOK_MANIFEST);
      expect(result.success).toBe(true);
    });

    it('marks secret fields as password type', () => {
      const inboundSecret = WEBHOOK_MANIFEST.configFields.find((f) => f.key === 'inbound.secret');
      const outboundSecret = WEBHOOK_MANIFEST.configFields.find((f) => f.key === 'outbound.secret');
      expect(inboundSecret?.type).toBe('password');
      expect(outboundSecret?.type).toBe('password');
    });
  });

  describe('SLACK_MANIFEST', () => {
    it('validates against AdapterManifestSchema', () => {
      const result = AdapterManifestSchema.safeParse(SLACK_MANIFEST);
      expect(result.success).toBe(true);
    });

    it('manifest URL includes reactions:write scope', () => {
      const url = SLACK_MANIFEST.actionButton?.url ?? '';
      const encoded = url.split('manifest_yaml=')[1] ?? '';
      const decoded = decodeURIComponent(encoded);
      expect(decoded).toContain('reactions:write');
    });

    it('manifest URL does not contain user scopes section', () => {
      const url = SLACK_MANIFEST.actionButton?.url ?? '';
      const encoded = url.split('manifest_yaml=')[1] ?? '';
      const decoded = decodeURIComponent(encoded);
      // Must not have a "user:" key under scopes (user-level OAuth scopes)
      expect(decoded).not.toMatch(/^\s+user:\s*$/m);
      // Sanity check: bot scopes like "users:read" are fine and expected
      expect(decoded).toContain('users:read');
    });
  });

  describe('CLAUDE_CODE_MANIFEST', () => {
    it('validates against AdapterManifestSchema', () => {
      const result = AdapterManifestSchema.safeParse(CLAUDE_CODE_MANIFEST);
      expect(result.success).toBe(true);
    });
  });
});
