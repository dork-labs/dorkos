/**
 * Before each turn, make sure the OpenCode session still carries DorkOS's
 * asks and refuses unsafe subagents (DOR-4394; the rules are in
 * `session-rules.ts`).
 *
 * The SDK's v1 types predate session rules and resolved agent rulesets, so
 * both are read off the wire and checked here. Anything this cannot read or
 * write stops the turn: a turn that might skip DorkOS's asks does not run.
 *
 * @module services/runtimes/opencode/messaging/keep-asks
 */
import { z } from 'zod';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import { unwrap } from '../sessions/session-mapper.js';
import { resolveOpenCodeDataDir } from '../opencode-data-dir.js';
import { HELPERS_REFUSED_NOTE, refusesTask, sessionRulesToAdd } from './session-rules.js';

const RuleSchema = z.object({
  permission: z.string(),
  pattern: z.string(),
  action: z.enum(['allow', 'ask', 'deny']),
});
const SessionRulesSchema = z.object({ permission: z.array(RuleSchema).optional() });
const AgentsSchema = z.array(
  z.object({
    name: z.string(),
    mode: z.enum(['primary', 'subagent', 'all']),
    permission: z.array(RuleSchema),
  })
);

/**
 * Add whatever DorkOS's asks are missing on one session, or throw.
 *
 * The `task` deny stays on the session once added, so the model is told on
 * every turn it holds, not only the turn it was added (DOR-4447): without
 * that, all it sees is OpenCode's bare refusal.
 *
 * @param client - The sidecar client.
 * @param ocSessionId - The OpenCode session about to take a turn.
 * @param directory - The session's directory, which decides the project's agents.
 * @param opts - The turn's options.
 * @returns The turn's options, with {@link HELPERS_REFUSED_NOTE} added to its
 *   system text while the session refuses `task`.
 */
export async function keepDorkosAsks(
  client: OpencodeClient,
  ocSessionId: string,
  directory: string,
  opts?: MessageOpts
): Promise<MessageOpts | undefined> {
  const [session, agents] = await Promise.all([
    client.session.get({ path: { id: ocSessionId } }),
    client.app.agents({ query: { directory } }),
  ]);
  const rules = SessionRulesSchema.parse(unwrap(session, 'session.get')).permission ?? [];
  const resolved = AgentsSchema.parse(unwrap(agents, 'app.agents'));
  const added = sessionRulesToAdd(rules, resolved, resolveOpenCodeDataDir());
  if (added.length > 0) {
    // The v1 body type has no `permission`; the sidecar takes it (pinned 1.19.3).
    unwrap(
      await client.session.update({
        path: { id: ocSessionId },
        body: { permission: added } as never,
      }),
      'session.update'
    );
  }
  if (!refusesTask([...rules, ...added])) return opts;
  const append = [opts?.systemPromptAppend, HELPERS_REFUSED_NOTE].filter(Boolean).join('\n\n');
  return { ...opts, systemPromptAppend: append };
}
