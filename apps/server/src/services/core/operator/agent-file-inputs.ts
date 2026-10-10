/**
 * The convention files `update_agent` writes, as input fields: `SOUL.md`
 * (`soulContent`) and `HEARTBEAT.md` (`heartbeatContent`). Split out of
 * `operator-capabilities.ts` to keep that file inside its line budget.
 *
 * @module services/core/operator/agent-file-inputs
 */
import { z } from 'zod';
import { HEARTBEAT_MAX_CHARS, SOUL_MAX_CHARS } from '@dorkos/shared/convention-files';

/** `update_agent`'s convention-file fields, spread into its input schema. */
export const AGENT_FILE_INPUTS = {
  // Says what DorkOS does with it, because the honest answer is not "we
  // store this". The personality block at the top of SOUL.md is rendered
  // from `traits` and fenced by markers the turn regenerates in place; a
  // file saved without them has no block to regenerate, so the six dials
  // stop reaching the agent entirely. The server composes the file around
  // that block either way (`agent-updater.ts`), and this sentence is what
  // keeps a caller from spending its budget reproducing a block it does
  // not own. Found by the `agent-self-edit` eval, 2026-09-12.
  soulContent: z
    .string()
    .max(SOUL_MAX_CHARS)
    .optional()
    .describe(
      'SOUL.md: who this agent is, in prose. Send the prose only — DorkOS keeps the ' +
        'personality block at the top of the file and writes it from `traits`. That block ' +
        `spends several hundred of the ${SOUL_MAX_CHARS.toLocaleString('en-US')}-character ` +
        'file budget, so your text has a few hundred less than that; a refusal names the ' +
        'exact number for this agent.'
    ),
  // HEARTBEAT.md (spec `heartbeats` §2): the agent's own job, so act-then-
  // tell. The frontmatter is validated at the next beat; an invalid one
  // keeps the last good one in force and is recorded once.
  heartbeatContent: z
    .string()
    .max(HEARTBEAT_MAX_CHARS)
    .optional()
    .describe(
      'HEARTBEAT.md: how this agent wakes between conversations and what it watches. ' +
        'YAML frontmatter (wake: timed | events | off; watch; report: daily | weekly | off; ' +
        'sweep) then a markdown checklist. Replaces the whole file; applies at the next beat.'
    ),
};
