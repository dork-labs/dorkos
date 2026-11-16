/**
 * The runtime capabilities matrix's safety-guard rows (DOR-3596): one per
 * guard a runtime can declare in `RuntimeCapabilities.guards`, each backed by
 * that declaration, so the census fails a runtime whose declared guards and
 * matrix cells disagree. Kept beside the matrix rather than in it, which is
 * over the line limit; `runtime-capability-matrix` spreads them in.
 *
 * @module test-utils/runtime-capability-guards
 */
import { declaresGuard, type RuntimeGuard } from '@dorkos/shared/agent-runtime';
import type { MatrixFlag, RuntimeCapability } from './runtime-capability-types.js';

/** Builds a flag from one declared guard. */
function guard(name: RuntimeGuard): MatrixFlag {
  return { label: `guards.${name}`, read: (caps) => declaresGuard(caps, name) };
}

const FIXTURE = {
  status: 'n/a',
  reason: 'test-mode is a scripted fixture with no backend behind it, and declares no guard.',
} as const;

/** The safety-guard rows, in id order. */
export const GUARD_CAPABILITIES: readonly RuntimeCapability[] = [
  {
    id: 'RT-GRD-01',
    group: 'GRD',
    title: 'Keep the agent off protected files',
    expected:
      'File tools refuse the shared protected list: its secrets at every level, the files that grant power below Full. Below Full, a shell command that reads a protected file, such as a browser profile’s sign-ins, goes to a person first.',
    flag: guard('protectedPaths'),
    cells: {
      'claude-code': { status: 'supported', evidence: ['U'] },
      codex: {
        status: 'planned',
        reason:
          'The sandbox denies protected paths only under the folders DorkOS names (DOR-3790), and file-change approvals are not checked against the list.',
        ticket: 'DOR-3597',
      },
      opencode: {
        status: 'planned',
        reason: 'Its file tools refuse the protected list; its shell is not checked against it.',
        ticket: 'DOR-4445',
      },
      doe: {
        status: 'planned',
        reason: 'Its file tools refuse the protected list; its shell is not checked against it.',
        ticket: 'DOR-4445',
      },
      'test-mode': FIXTURE,
    },
  },
  {
    id: 'RT-GRD-02',
    group: 'GRD',
    title: 'Keep the agent’s own setup closed below Full',
    expected:
      'Below Full, file tools cannot change the agent’s own hooks, skills, settings or MCP servers, and at any level they cannot change its `.dork/agent.json`. A shell command that plainly writes them is refused too.',
    flag: guard('ownFolder'),
    cells: {
      'claude-code': { status: 'supported', evidence: ['U'] },
      codex: {
        status: 'planned',
        reason: 'Its own `.codex/` and `.agents/` setup is not held below Full.',
        ticket: 'DOR-3598',
      },
      opencode: {
        status: 'planned',
        reason: 'Its own `opencode.json` and `.agents/` setup is not held below Full.',
        ticket: 'DOR-3598',
      },
      doe: {
        status: 'planned',
        reason:
          'An agent home in the data folder is closed to its file tools; an agent in a project folder, and its shell, are not held.',
        ticket: 'DOR-3598',
      },
      'test-mode': FIXTURE,
    },
  },
];
