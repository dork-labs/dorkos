/**
 * The carryover rules trusted by default adds (DOR-2739, ADR 261006-225605),
 * kept beside `protected-state.ts`, which spreads them into
 * `PROTECTIVE_CARRYOVERS`.
 *
 * A wipe lands on Trusted, so every way a person asked agents to ask first has
 * to survive one. So does the record that each once-per-install Trusted step
 * already ran: a step that ran twice would loosen something a person narrowed.
 *
 * @module services/core/safe-defaults/trusted-carryovers
 */
import type { ProtectiveCarryover } from './protected-state.js';

/** The Trusted entries of `PROTECTIVE_CARRYOVERS`. */
export const TRUSTED_CARRYOVERS: readonly ProtectiveCarryover[] = [
  {
    path: 'permissions.preset',
    direction: 'oneOf',
    protectiveValues: ['careful'],
    reason:
      'The preset ships Trusted, where agents work without asking. A person who chose Careful asked to be asked first, and a wipe that handed Trusted back would stop every one of those questions without a word.',
  },
  {
    path: 'permissions.defaults.areas',
    direction: 'entries',
    protectiveValues: ['ask', 'blocked'],
    reason:
      'An area a person set to Ask or Blocked on top of the preset. Under Trusted the preset allows it, so losing the change on a wipe would let agents do what the person had stopped.',
  },
  {
    path: 'permissions.defaults.actions',
    direction: 'entries',
    protectiveValues: ['ask', 'blocked'],
    reason:
      'The same, for one action rather than a whole area: a single thing a person asked to approve, or refused outright.',
  },
  {
    path: 'runtimes.defaultTrustStop',
    direction: 'oneOf',
    protectiveValues: ['ask', 'act'],
    // A Careful install keeps a stop of `null` (each runtime's own default,
    // which asks), so a stored `null` is carried as Ask, not lost to Full autonomy.
    nullMeans: 'ask',
    reason:
      'The stop a new session starts at ships at Full autonomy. A person who set Ask or Act, or who stayed on Careful with no stop of their own, wanted file edits or commands approved first, and a wipe must not hand Full autonomy back.',
  },
  {
    path: 'runtimes.claudeCode.defaultTrustStop',
    direction: 'oneOf',
    protectiveValues: ['ask', 'act'],
    reason:
      "Claude Code's own stop. `null` follows the global stop, which is Full autonomy on a fresh install, so a stop set to Ask or Act here is the only thing keeping that runtime asking.",
  },
  {
    path: 'runtimes.codex.defaultTrustStop',
    direction: 'oneOf',
    protectiveValues: ['ask', 'act'],
    reason:
      "Codex's own stop. `null` follows the global stop, which is Full autonomy on a fresh install, so a stop set to Ask or Act here is the only thing keeping that runtime asking.",
  },
  {
    path: 'runtimes.opencode.defaultTrustStop',
    direction: 'oneOf',
    protectiveValues: ['ask', 'act'],
    reason:
      "OpenCode's own stop. `null` follows the global stop, which is Full autonomy on a fresh install, so a stop set to Ask or Act here is the only thing keeping that runtime asking.",
  },
  // The once-per-install Trusted steps (DOR-2739): each stamp stops its step
  // running twice, and a second run would loosen something a person narrowed.
  {
    path: 'permissions.trustedStoresAppliedAt',
    direction: 'stamped',
    reason:
      'The open mesh rule is applied once per install. A wipe that forgot it ran would open the mesh again on the next boot, undoing a person who closed it in Team → Access.',
  },
  {
    path: 'permissions.sharedAppsAppliedAt',
    direction: 'stamped',
    reason:
      'Each connected app nobody held is shared with every agent once. A wipe that forgot the step ran would run it again, sharing an app the person had since stopped sharing.',
  },
];
