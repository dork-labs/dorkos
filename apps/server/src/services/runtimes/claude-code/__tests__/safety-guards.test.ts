/**
 * Claude Code's safety guards, under the runtime capabilities matrix's own row ids
 * (`RT-GRD-*`, DOR-3596). The same proofs run in the shared guard conformance cases.
 *
 * @module services/runtimes/claude-code/__tests__/safety-guards
 */
import { describe, expect, it } from 'vitest';
import { declaresGuard } from '@dorkos/shared/agent-runtime';
import { CLAUDE_CODE_CAPABILITIES } from '../runtime-constants.js';
import { CLAUDE_CODE_GUARD_PROOFS } from './guard-proofs.js';

describe('Claude Code safety guards', () => {
  it('RT-GRD-01: keeps every file tool off the protected list, and the shell off its protected reads', async () => {
    expect(declaresGuard(CLAUDE_CODE_CAPABILITIES, 'protectedPaths')).toBe(true);
    await CLAUDE_CODE_GUARD_PROOFS.protectedPaths!();
  });

  it('RT-GRD-02: keeps the agent’s own setup closed below Full, and its agent.json closed always', async () => {
    expect(declaresGuard(CLAUDE_CODE_CAPABILITIES, 'ownFolder')).toBe(true);
    await CLAUDE_CODE_GUARD_PROOFS.ownFolder!();
  });
});
