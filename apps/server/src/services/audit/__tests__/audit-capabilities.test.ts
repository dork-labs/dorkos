/**
 * `audit.verify` (spec `audit-trail`): one declaration, projected onto both MCP
 * servers, the CLI and HTTP, readable by anyone.
 */
import { describe, it, expect } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { composeRegistry } from '../../core/capabilities/registry.js';
import { AuditLog } from '../audit-log.js';
import { auditDomain } from '../audit-capabilities.js';

const LOGGER = { debug() {}, info() {}, warn() {}, error() {} };

describe('audit.verify', () => {
  it('is an observe capability on both MCP servers and GET /api/audit/verify', () => {
    const [capability] = auditDomain.capabilities;
    expect(capability).toMatchObject({
      id: 'audit.verify',
      tier: 'observe',
      area: null,
      surfaces: {
        mcp: { toolName: 'audit_verify', servers: ['in-session', 'external'] },
        http: { method: 'get', path: '/api/audit/verify' },
      },
    });
  });

  it('walks the real chain through the registry', async () => {
    const log = new AuditLog(createTestDb());
    log.record({
      actor: { accountId: 'system', kind: 'system', name: 'DorkOS' },
      source: { surface: 'system' },
      action: 'system.started',
      operation: 'execute',
      outcome: 'ok',
      summary: 'DorkOS started',
    });
    const registry = composeRegistry([auditDomain], { logger: LOGGER, auditDeps: { log } });
    await expect(registry.invoke('audit.verify', {}, {})).resolves.toMatchObject({
      ok: true,
      checked: 1,
      lastSeq: 1,
    });
  });
});
