/**
 * The seam before each OpenCode turn (DOR-4394): it reads the session's rules
 * and the project's agents off the sidecar, adds what DorkOS's asks are
 * missing, and stops the turn when it cannot tell.
 */
import { describe, expect, it, vi } from 'vitest';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { keepDorkosAsks } from '../keep-asks.js';
import { resolveOpenCodeDataDir } from '../../opencode-data-dir.js';
import { dorkosSessionRules, HELPERS_REFUSED_NOTE } from '../session-rules.js';

const DORKOS_SESSION_RULES = dorkosSessionRules(resolveOpenCodeDataDir());

const DIR = '/demo/projects/northwind';

function client(opts: {
  rules?: unknown[];
  agents?: unknown;
  agentsFail?: boolean;
  updateFails?: boolean;
}) {
  const update = vi.fn(async () =>
    opts.updateFails ? { error: { name: 'BadRequest' } } : { data: {} }
  );
  const agents = vi.fn(async () =>
    opts.agentsFail ? { error: { name: 'BadRequest' } } : { data: opts.agents ?? [] }
  );
  const fake = {
    session: {
      get: vi.fn(async () => ({
        data: { id: 'oc-1', directory: DIR, ...(opts.rules ? { permission: opts.rules } : {}) },
      })),
      update,
    },
    app: { agents },
  };
  return { fake: fake as unknown as OpencodeClient, update, agents };
}

const runner = {
  name: 'runner',
  mode: 'subagent',
  permission: [...DORKOS_SESSION_RULES, { permission: 'bash', pattern: '*', action: 'allow' }],
};

describe('keeping DorkOS’s asks on an OpenCode session', () => {
  it('adds DorkOS’s asks to a session that has none, reading agents for its folder', async () => {
    const { fake, update, agents } = client({});
    await keepDorkosAsks(fake, 'oc-1', DIR);
    expect(agents).toHaveBeenCalledWith({ query: { directory: DIR } });
    expect(update).toHaveBeenCalledWith({
      path: { id: 'oc-1' },
      body: { permission: DORKOS_SESSION_RULES },
    });
  });

  it('writes nothing when the session already holds them', async () => {
    const { fake, update } = client({ rules: [...DORKOS_SESSION_RULES] });
    await keepDorkosAsks(fake, 'oc-1', DIR);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a project subagent that would skip the ask', async () => {
    const { fake, update } = client({ rules: [...DORKOS_SESSION_RULES], agents: [runner] });
    await keepDorkosAsks(fake, 'oc-1', DIR);
    expect(update).toHaveBeenCalledWith({
      path: { id: 'oc-1' },
      body: { permission: [{ permission: 'task', pattern: '*', action: 'deny' }] },
    });
  });

  it('tells the model its helpers are off, on the turn the deny is added and every turn after', async () => {
    const first = await keepDorkosAsks(
      client({ rules: [...DORKOS_SESSION_RULES], agents: [runner] }).fake,
      'oc-1',
      DIR,
      { systemPromptAppend: 'Run the nightly report.' }
    );
    expect(first?.systemPromptAppend).toBe(`Run the nightly report.\n\n${HELPERS_REFUSED_NOTE}`);
    // The deny persists in the session, so a later turn writes nothing and still says so.
    const denied = [...DORKOS_SESSION_RULES, { permission: 'task', pattern: '*', action: 'deny' }];
    const later = client({ rules: denied, agents: [runner] });
    expect((await keepDorkosAsks(later.fake, 'oc-1', DIR))?.systemPromptAppend).toBe(
      HELPERS_REFUSED_NOTE
    );
    expect(later.update).not.toHaveBeenCalled();
    // Still said, and still true in the past tense, once no agent is unsafe any more:
    // the deny stays on the session.
    const fixed = await keepDorkosAsks(client({ rules: denied, agents: [] }).fake, 'oc-1', DIR);
    expect(fixed?.systemPromptAppend).toBe(HELPERS_REFUSED_NOTE);
  });

  it('blames no project: the sidecar loads none, so the agent is one on this computer', () => {
    expect(HELPERS_REFUSED_NOTE).toBe(
      'Helpers (the task tool) are off in this chat. They were turned off because an OpenCode ' +
        "agent set up on this computer would have skipped DorkOS's approval asks. Do the work yourself."
    );
    expect(HELPERS_REFUSED_NOTE).not.toMatch(/project/i);
  });

  it('says nothing about helpers when the session does not refuse them', async () => {
    const opts = { systemPromptAppend: 'Run the nightly report.' };
    const kept = await keepDorkosAsks(client({}).fake, 'oc-1', DIR, opts);
    expect(kept).toBe(opts);
  });

  it('stops the turn when it cannot read the agents, write the rules, or read their shape', async () => {
    await expect(keepDorkosAsks(client({ agentsFail: true }).fake, 'oc-1', DIR)).rejects.toThrow(
      /app\.agents/
    );
    await expect(keepDorkosAsks(client({ updateFails: true }).fake, 'oc-1', DIR)).rejects.toThrow(
      /session\.update/
    );
    // An older sidecar's object-shaped permissions are not something to guess at.
    await expect(
      keepDorkosAsks(
        client({ agents: [{ name: 'build', mode: 'primary', permission: { bash: 'ask' } }] }).fake,
        'oc-1',
        DIR
      )
    ).rejects.toThrow();
  });
});
