import { describe, expect, it } from 'vitest';
import {
  createCapabilityAuthorityBinding,
  isCapabilityAuthorityBinding,
} from '../capability-authority-binding.js';
import * as connectorService from '../../index.js';

describe('capability authority binding authenticity', () => {
  it('copies, freezes, and authenticates the exact process-minted scope', () => {
    const source = {
      digest: 'authority-a',
      ownerKind: 'local_install',
      ownerId: 'install-a',
      agentId: 'agent-a',
      sessionId: 'session-a',
      connectionId: 'connection-a',
      operationRevisionId: 'revision-a',
    } as const;
    const proof = createCapabilityAuthorityBinding(source);

    expect(isCapabilityAuthorityBinding(proof)).toBe(true);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.approvalScope)).toBe(true);
    expect(isCapabilityAuthorityBinding({ approvalScope: source })).toBe(false);
    expect(isCapabilityAuthorityBinding(JSON.parse(JSON.stringify(proof)))).toBe(false);
  });

  it('does not expose the mint or structural proof through the consumer barrel', () => {
    expect('createCapabilityAuthorityBinding' in connectorService).toBe(false);
    expect('isCapabilityAuthorityBinding' in connectorService).toBe(false);
  });
});
