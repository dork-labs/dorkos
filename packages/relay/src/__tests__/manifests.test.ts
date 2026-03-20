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

    it('has type "telegram"', () => {
      expect(TELEGRAM_MANIFEST.type).toBe('telegram');
    });

    it('is a builtin adapter', () => {
      expect(TELEGRAM_MANIFEST.builtin).toBe(true);
    });

    it('supports multiple instances', () => {
      expect(TELEGRAM_MANIFEST.multiInstance).toBe(true);
    });

    it('has configFields keys matching TelegramAdapterConfig', () => {
      const keys = TELEGRAM_MANIFEST.configFields.map((f) => f.key);
      expect(keys).toContain('token');
      expect(keys).toContain('mode');
      expect(keys).toContain('webhookUrl');
      expect(keys).toContain('webhookPort');
    });

    it('marks token field as password type', () => {
      const tokenField = TELEGRAM_MANIFEST.configFields.find((f) => f.key === 'token');
      expect(tokenField?.type).toBe('password');
    });

    it('has category "messaging"', () => {
      expect(TELEGRAM_MANIFEST.category).toBe('messaging');
    });
  });

  describe('WEBHOOK_MANIFEST', () => {
    it('validates against AdapterManifestSchema', () => {
      const result = AdapterManifestSchema.safeParse(WEBHOOK_MANIFEST);
      expect(result.success).toBe(true);
    });

    it('has type "webhook"', () => {
      expect(WEBHOOK_MANIFEST.type).toBe('webhook');
    });

    it('is a builtin adapter', () => {
      expect(WEBHOOK_MANIFEST.builtin).toBe(true);
    });

    it('supports multiple instances', () => {
      expect(WEBHOOK_MANIFEST.multiInstance).toBe(true);
    });

    it('has configFields keys matching WebhookAdapterConfig nested structure', () => {
      const keys = WEBHOOK_MANIFEST.configFields.map((f) => f.key);
      expect(keys).toContain('inbound.subject');
      expect(keys).toContain('inbound.secret');
      expect(keys).toContain('outbound.url');
      expect(keys).toContain('outbound.secret');
      expect(keys).toContain('outbound.headers');
    });

    it('marks secret fields as password type', () => {
      const inboundSecret = WEBHOOK_MANIFEST.configFields.find((f) => f.key === 'inbound.secret');
      const outboundSecret = WEBHOOK_MANIFEST.configFields.find((f) => f.key === 'outbound.secret');
      expect(inboundSecret?.type).toBe('password');
      expect(outboundSecret?.type).toBe('password');
    });

    it('has category "automation"', () => {
      expect(WEBHOOK_MANIFEST.category).toBe('automation');
    });
  });

  describe('SLACK_MANIFEST', () => {
    it('validates against AdapterManifestSchema', () => {
      const result = AdapterManifestSchema.safeParse(SLACK_MANIFEST);
      expect(result.success).toBe(true);
    });

    it('has type "slack"', () => {
      expect(SLACK_MANIFEST.type).toBe('slack');
    });

    it('is a builtin adapter', () => {
      expect(SLACK_MANIFEST.builtin).toBe(true);
    });

    it('supports multiple instances', () => {
      expect(SLACK_MANIFEST.multiInstance).toBe(true);
    });

    it('has configFields keys matching SlackAdapterConfig', () => {
      const keys = SLACK_MANIFEST.configFields.map((f) => f.key);
      expect(keys).toContain('botToken');
      expect(keys).toContain('appToken');
      expect(keys).toContain('signingSecret');
    });

    it('has category "messaging"', () => {
      expect(SLACK_MANIFEST.category).toBe('messaging');
    });

    it('has a manifest URL that starts with the Slack API endpoint', () => {
      expect(SLACK_MANIFEST.actionButton?.url).toMatch(
        /^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_yaml=/
      );
    });

    it('manifest URL contains URL-encoded YAML with socket_mode_enabled', () => {
      const url = SLACK_MANIFEST.actionButton?.url ?? '';
      const encoded = url.split('manifest_yaml=')[1] ?? '';
      const decoded = decodeURIComponent(encoded);
      expect(decoded).toContain('socket_mode_enabled: true');
    });

    it('manifest URL includes reactions:write scope', () => {
      const url = SLACK_MANIFEST.actionButton?.url ?? '';
      const encoded = url.split('manifest_yaml=')[1] ?? '';
      const decoded = decodeURIComponent(encoded);
      expect(decoded).toContain('reactions:write');
    });

    it('has typingIndicator configField with select options', () => {
      const field = SLACK_MANIFEST.configFields.find((f) => f.key === 'typingIndicator');
      expect(field).toBeDefined();
      expect(field?.type).toBe('select');
      expect(field?.options).toEqual([
        { label: 'None', value: 'none' },
        { label: 'Emoji reaction', value: 'reaction' },
      ]);
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

    it('has type "claude-code"', () => {
      expect(CLAUDE_CODE_MANIFEST.type).toBe('claude-code');
    });

    it('is a builtin adapter', () => {
      expect(CLAUDE_CODE_MANIFEST.builtin).toBe(true);
    });

    it('does not support multiple instances', () => {
      expect(CLAUDE_CODE_MANIFEST.multiInstance).toBe(false);
    });

    it('has configFields keys matching ClaudeCodeAdapterConfig', () => {
      const keys = CLAUDE_CODE_MANIFEST.configFields.map((f) => f.key);
      expect(keys).toContain('maxConcurrent');
      expect(keys).toContain('defaultTimeoutMs');
    });

    it('has category "internal"', () => {
      expect(CLAUDE_CODE_MANIFEST.category).toBe('internal');
    });
  });

  describe('all manifests', () => {
    const manifests = [TELEGRAM_MANIFEST, WEBHOOK_MANIFEST, SLACK_MANIFEST, CLAUDE_CODE_MANIFEST];

    it('all have unique types', () => {
      const types = manifests.map((m) => m.type);
      expect(new Set(types).size).toBe(types.length);
    });

    it('all have non-empty configFields', () => {
      for (const manifest of manifests) {
        expect(manifest.configFields.length).toBeGreaterThan(0);
      }
    });

    it('all have displayName and description', () => {
      for (const manifest of manifests) {
        expect(manifest.displayName).toBeTruthy();
        expect(manifest.description).toBeTruthy();
      }
    });
  });
});
