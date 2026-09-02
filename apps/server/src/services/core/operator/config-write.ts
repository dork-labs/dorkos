/**
 * Every general-purpose door onto the user's settings, and the log line every
 * other writer leaves behind.
 *
 * ## The two shapes of config write, and why only one needs a door
 *
 * A **general-purpose door** takes a path the caller chose and writes whatever
 * it names: `PATCH /api/config`, the `config_patch` operator tool, and
 * `dorkos config set`. Any setting can come through one, including the ones
 * that decide whether a person is ever asked again, so a door has to ask three
 * questions before it writes — may this caller change settings that need login
 * on, may it change operator-only settings, and has this person been told what
 * Full autonomy means. {@link applyGuardedConfigWrite} is that sequence, in one
 * place, so the three doors cannot answer it differently.
 *
 * A **purpose-built writer** writes one known setting as part of doing
 * something else: the tunnel route recording that a tunnel is now running,
 * `hook-approval.ts` recording a package hook a person just approved. It cannot
 * be pointed at another setting, and it sits behind whatever gate its own
 * feature needs — which is often stricter than this one (starting a tunnel
 * requires login AND an owner account). Re-asking the path questions there
 * would either do nothing or refuse the writer its own job. So those keep their
 * own gate and take {@link logConfigWrite}, which leaves the same trail without
 * pretending to be a second policy.
 *
 * `contributing/configuration.md` carries the same split as a table, with every
 * writer on this install filed under one of the two.
 *
 * ## Why the audit line is the point, not a side effect
 *
 * `runtimes.claudeCode.defaultTrustStop` moved twice on a real install between
 * sign-offs and nothing on disk could say what moved it (DOR-1237). The route
 * got a line; the CLI, the operator tool and nine server-side writers did not,
 * so a silent log still meant nothing. Both lines below are `info`, name the
 * LEAVES that changed, name the writer, and never carry a value — see
 * {@link describeConfigWrite} for why paths only, and why even a path is
 * escaped.
 *
 * @module services/core/operator/config-write
 */
import type { UserConfig } from '@dorkos/shared/config-schema';
import { logger } from '../../../lib/logger.js';
import { configManager } from '../config-manager.js';
import {
  stampDisplayNameSource,
  type DisplayNameWriter,
} from '../../identity/display-name-provenance.js';
import { applyConfigPatch, deepMerge, describeConfigWrite } from './config-patch.js';
import {
  describeOperatorOnlyRefusal,
  findLoginRequiredPaths,
  findOperatorOnlyPaths,
  OPERATOR_ONLY_CONFIG_CODE,
  OPERATOR_ONLY_CONFIG_ERROR,
} from './config-write-policy.js';
import {
  AUTONOMY_ACK_REQUIRED_CODE,
  AUTONOMY_DEFAULT_ACK_MESSAGE,
  demoteAutonomyDefaultsOnAckClear,
  findUnacknowledgedAutonomyDefaults,
} from '../approvals/autonomy-consent.js';

/**
 * A write this caller may not make, in the one shape all three doors answer
 * with. The HTTP route sends it as a JSON body; the CLI prints `message` and
 * exits non-zero; the operator tool hands it to the model as a tool error.
 */
export interface ConfigWriteRefusal {
  /** HTTP status the route answers with. Ignored by callers that are not HTTP. */
  status: number;
  /** Machine-readable code, stable across the three doors. */
  code: string;
  /** The headline — short, and the same for every refusal of this kind. */
  error: string;
  /** One paragraph saying what was refused and what to do instead. */
  message: string;
  /** The settings that caused the refusal, named once each. */
  paths: string[];
}

/**
 * Who is asking, expressed as the two questions a general-purpose door has to
 * put to its caller. Each returns `undefined` to allow, or the refusal to
 * answer with — and each is asked ONLY when the patch actually touches a
 * setting of that kind, so an authority is never consulted about a plain
 * preference.
 *
 * It is a pair of callbacks rather than a caller enum because the evidence
 * lives in different places: the HTTP route reads a session cookie and two
 * headers off the request, the CLI reads nothing at all. Keeping the SEQUENCE
 * here and the EVIDENCE at the caller is what lets one implementation serve a
 * browser, a terminal and a model without any of them inheriting another's idea
 * of what counts as a person.
 */
export interface ConfigWriteAuthority {
  /**
   * May this caller write settings that exist only when local login is on
   * (`REQUIRES_LOGIN_CONFIG_PATHS`)?
   *
   * @param paths - The login-gated settings the patch touches.
   */
  refuseLoginRequired(paths: readonly string[]): ConfigWriteRefusal | undefined;
  /**
   * May this caller write `operator-only` settings — the ones whose change
   * removes or widens a control, or lets agents spend more on their own?
   *
   * @param paths - The operator-only settings the patch touches.
   */
  refuseOperatorOnly(paths: readonly string[]): ConfigWriteRefusal | undefined;
}

/**
 * The identity `dorkos config set` writes under: the operator, at their own
 * terminal, on their own machine.
 *
 * ## Why it clears both bars
 *
 * The CLI is the person. It runs under their shell, in their session, on the
 * data directory they own — which is exactly the trust the cockpit has in the
 * default login-off posture, where the server admits it cannot tell the cockpit
 * from any other local process (`caller-authority.ts`). Refusing the terminal
 * what the browser is allowed would not add a guarantee; it would only move the
 * person to `dorkos config edit`, which hands them the raw file with no policy,
 * no consent door and no log at all. A bar that is trivially walked around is
 * worse than none, because it reads like protection.
 *
 * The login bar is allowed for a sharper reason than that, and it is a decision
 * rather than an omission. `approvals.standingGrants` and its two siblings are
 * refused over HTTP while login is off because a caller could pre-arm them.
 * Applying the same rule here would refuse `dorkos config set
 * approvals.standingGrants false` — turning the switch OFF, the protective
 * direction, on the surface `standing-grant-posture.ts` names as the one that
 * has to work with no server running. The write is still recorded either way:
 * `ConfigManager` stamps `approvals.standingGrantsVoidBefore` on any narrowing
 * whichever process performs it, and boot re-checks the posture, so the CLI
 * cannot resurrect a permission by writing this file.
 *
 * ## What it does NOT clear
 *
 * The autonomy consent door, which is not an authority question at all. It asks
 * whether the person has been shown what Full autonomy means, and the answer is
 * the same whoever is typing — so `dorkos config set
 * runtimes.claudeCode.defaultTrustStop autonomy` is refused with the cockpit's
 * own sentence until the acknowledgement exists. That refusal is the one this
 * whole module was written for: it was reproduced against the built CLI on an
 * install whose `ui.autonomyAcknowledgedAt` was `null` (DOR-1247). The terminal
 * has its own way to satisfy it honestly — `dorkos config acknowledge-autonomy`
 * prints what the person is agreeing to and asks once — and the refusal names
 * that command, because a sentence with no next step is a dead end in a shell.
 *
 * ## THE RESIDUAL: a person with a shell can sign their own consent form
 *
 * State it plainly, next to the `curl` one below, because it is the same shape
 * and the same answer. `ui.autonomyAcknowledgedAt` is `operator-only`, and this
 * authority clears the operator bar — so `dorkos config set
 * ui.autonomyAcknowledgedAt <date>` followed by `dorkos config set …
 * defaultTrustStop autonomy` goes through, with the consent text never on
 * screen. Reproduced end to end.
 *
 * That is the trust model, not a hole in it. The CLI *is* the operator, and an
 * operator may record their own decision — the cockpit's own "Don't show this
 * again" checkbox is the same act through a different surface. What a ritual can
 * buy is that the DEFAULT path shows a person what they are agreeing to; what it
 * cannot buy is stopping somebody who already knows the field name from writing
 * it, any more than `dorkos config edit` could be stopped. An agent is a
 * different matter and is stopped by a different mechanism: `operator-only`
 * refuses it on the capability surface and over HTTP, and neither of those is
 * this authority.
 *
 * The mitigation is the same one the `curl` residual gets: both writes leave an
 * audit line naming the door, so the sequence is visible afterwards even though
 * nothing refuses it at the time. Turning on Require login narrows the HTTP half;
 * nothing narrows the terminal half, because the terminal is the person.
 */
export const LOCAL_OPERATOR_AUTHORITY: ConfigWriteAuthority = {
  refuseLoginRequired: () => undefined,
  refuseOperatorOnly: () => undefined,
};

/**
 * The identity the `config_patch` operator tool writes under: an agent, acting
 * on the user's word, which may change preferences and nothing else.
 *
 * `refuseLoginRequired` allows, and that is not a hole: every path the login bar
 * guards is also `operator-only`, so the refusal below catches all three anyway.
 * Letting the operator-only bar answer is deliberate — "only a person can change
 * those settings" is the true and useful sentence for a model, where "turn
 * Require login on first" would send it to do something it also may not do.
 */
export const OPERATOR_TOOL_AUTHORITY: ConfigWriteAuthority = {
  refuseLoginRequired: () => undefined,
  refuseOperatorOnly: (paths) => ({
    status: 403,
    code: OPERATOR_ONLY_CONFIG_CODE,
    error: OPERATOR_ONLY_CONFIG_ERROR,
    message: describeOperatorOnlyRefusal(paths),
    paths: [...paths],
  }),
};

/** What a guarded write did, or the reason it did nothing. */
export type GuardedConfigWriteResult =
  | {
      /** The write landed. */
      ok: true;
      /** The stored config after the write. */
      config: UserConfig;
      /** Non-blocking notes — today, sensitive keys written in the clear. */
      warnings: string[];
    }
  | {
      /** Nothing was written. */
      ok: false;
      /** This caller may not make this write. */
      kind: 'refused';
      /** What to answer with. */
      refusal: ConfigWriteRefusal;
    }
  | {
      /** Nothing was written. */
      ok: false;
      /** The merged config would not have been a valid config. */
      kind: 'invalid';
      /** The headline, matching `applyConfigPatch`. */
      error: string;
      /** Per-field problems, when the schema produced any. */
      details?: string[];
    };

/** One general-purpose write, and who is making it. */
export interface GuardedConfigWrite {
  /** The raw patch the caller supplied — any shape; a non-object is refused. */
  patch: unknown;
  /** Who is asking. */
  authority: ConfigWriteAuthority;
  /**
   * How this write reached DorkOS, named the way the audit line should read it
   * (`PATCH /api/config`, `dorkos config set`). This is the answer to
   * "what wrote it?", so keep it specific enough to act on.
   */
  source: string;
  /**
   * Whether a person or an agent is making this write (DOR-1022).
   *
   * Required rather than defaulted, and that is the whole point of putting it
   * here: `source` is a sentence for a log and nothing may branch on it, so a
   * new door would otherwise inherit whichever answer the default happened to
   * be. The type forces the author to say.
   *
   * Read by exactly one thing today — the display-name provenance stamp — and
   * deliberately NOT a second copy of {@link ConfigWriteAuthority}. That pair
   * answers "may you", which OPERATOR_TOOL_AUTHORITY happens to answer the same
   * way an agent-writer would; this answers "who are you", and the two would
   * come apart the moment a second non-human authority existed.
   */
  writer: DisplayNameWriter;
}

/**
 * The `profile.displayNameSource` half of a patch that carries a display name,
 * or `undefined` when this write is no reason to touch the record (DOR-1022).
 *
 * ## Why it reads the PATCH rather than diffing the write
 *
 * The rule needs "what did this caller ask for", not "what changed". A patch
 * that names `profile.displayName` at all is a claim about the name — including
 * a person re-saving the one already in the field, which is exactly how they
 * say "that one is mine" and the only gesture that dismisses the hint. A diff
 * cannot see that gesture, because nothing moved.
 *
 * `undefined` from either step means the same thing and is passed straight
 * through: the caller did not name the field, or
 * {@link stampDisplayNameSource} judged this write not to be a new claim.
 *
 * @param patch - The merged patch, as it will be applied.
 * @param writer - Who is making the write.
 * @returns A patch fragment to fold in, or `undefined`.
 */
function displayNameSourcePatch(
  patch: Record<string, unknown>,
  writer: DisplayNameWriter
): Record<string, unknown> | undefined {
  const profile = patch.profile;
  if (profile == null || typeof profile !== 'object' || Array.isArray(profile)) return undefined;
  if (!('displayName' in profile)) return undefined;

  const requested = (profile as Record<string, unknown>).displayName;
  // A patch naming the field with something that is neither a name nor `null`
  // is about to fail validation. Deciding provenance for it would be deciding
  // about a write that never happens.
  if (requested !== null && typeof requested !== 'string') return undefined;

  const source = stampDisplayNameSource(
    configManager.get('profile').displayName,
    requested,
    writer
  );
  return source === undefined ? undefined : { profile: { displayNameSource: source } };
}

/**
 * Apply a general-purpose config write: the two policy bars, the autonomy
 * consent door, the write itself, and the audit line — in that order, once.
 *
 * ## The order, and what each step of it decides
 *
 * 1. **The login bar.** Asked first so neither of the others can change the
 *    answer. Only three settings reach it, and only because the login-off
 *    posture would leave them pre-armable.
 * 2. **The operator bar.** Which settings are the person's alone
 *    (`CONFIG_WRITE_POLICY`), and whether this caller counts as one.
 * 3. **The autonomy door.** Not an authority question: "may you" has already
 *    been answered, and this asks "were you told what this means". A Reset —
 *    clearing the acknowledgement — folds its demotion into the SAME patch, so
 *    the record and the defaults it licensed can never disagree, not even for
 *    one write.
 * 4. **The write**, through the one merge-and-validate implementation.
 * 5. **The line**, derived from what the store actually held before and after,
 *    so it says what HAPPENED rather than what was asked for.
 *
 * A refusal at any step writes nothing at all — the check runs before the merge
 * and the caller gets the reason, never a partial write.
 *
 * ## What is deliberately NOT here
 *
 * Ending standing permissions when a write narrows the posture
 * (`revokeStandingGrantsIfPostureNarrowed`) stays at the HTTP route. It acts on
 * an in-process store of live permissions, which exists in the server and
 * nowhere else; running it from `dorkos config set` would warn that a store it
 * never had is unwired. The invariant still holds for CLI writes by a different
 * route, spelled out in `standing-grant-posture.ts`: the gate re-reads the
 * switch on every call, boot re-checks the posture, and `ConfigManager` stamps
 * the void floor whichever process wrote.
 *
 * @param write - The patch, the caller's authority, and the source label.
 * @returns The stored config on success, or the refusal to answer with.
 */
export function applyGuardedConfigWrite(write: GuardedConfigWrite): GuardedConfigWriteResult {
  const { patch: requested, authority, source, writer } = write;

  const loginRequired = findLoginRequiredPaths(requested);
  if (loginRequired.length > 0) {
    const refusal = authority.refuseLoginRequired(loginRequired);
    if (refusal) return { ok: false, kind: 'refused', refusal };
  }

  const operatorOnly = findOperatorOnlyPaths(requested);
  if (operatorOnly.length > 0) {
    const refusal = authority.refuseOperatorOnly(operatorOnly);
    if (refusal) return { ok: false, kind: 'refused', refusal };
  }

  // The Reset demotion is merged ON TOP of the patch rather than written after
  // it: two writes would leave a window in which a session could be born
  // bypassed with no acknowledgement on file.
  const demotion = demoteAutonomyDefaultsOnAckClear(requested);
  const afterDemotion = demotion
    ? deepMerge(requested as Record<string, unknown>, demotion)
    : (requested as Record<string, unknown>);

  // …and so is the display-name provenance stamp, for a milder version of the
  // same reason (DOR-1022): folded in, the name and the record of who wrote it
  // land in one write, so no reader can catch a new name still carrying the
  // previous writer's stamp. It rides ABOVE the caller's patch for a second
  // reason too — `profile.displayNameSource` is `operator-only`, so a patch that
  // named it was already refused above, and nothing a caller sent can be
  // overwritten here.
  const provenance = displayNameSourcePatch(afterDemotion, writer);
  const patch = provenance ? deepMerge(afterDemotion, provenance) : afterDemotion;

  // Asked of the MERGED patch: a Reset that demotes a stop in the same breath
  // is not a request for autonomy.
  const unacknowledged = findUnacknowledgedAutonomyDefaults(patch);
  if (unacknowledged.length > 0) {
    return {
      ok: false,
      kind: 'refused',
      refusal: {
        // Nothing about the request is malformed; a precondition the caller can
        // go and satisfy is exactly what 428 says.
        status: 428,
        code: AUTONOMY_ACK_REQUIRED_CODE,
        error: AUTONOMY_DEFAULT_ACK_MESSAGE,
        message: AUTONOMY_DEFAULT_ACK_MESSAGE,
        paths: unacknowledged,
      },
    };
  }
  if (demotion) {
    logger.info(
      `[Config] Full-autonomy acknowledgement cleared by ${source}; standing defaults demoted`
    );
  }

  const result = applyConfigPatch(patch);
  if (!result.ok) {
    return {
      ok: false,
      kind: 'invalid',
      error: result.error,
      ...(result.details && { details: result.details }),
    };
  }

  // The before-state comes back with the write rather than being read again
  // here: the merge already held it, and a second read would trust that nothing
  // moved in between.
  const touched = describeConfigWrite(result.before, result.config);
  if (touched) {
    logger.info(`[Config] Patched by ${source}: ${touched}`);
  }

  return { ok: true, config: result.config, warnings: result.warnings };
}

/**
 * Record a write a purpose-built writer performed itself.
 *
 * Same line, same rules, different verb: `Set by` rather than `Patched by`,
 * because these writers were never handed a path — they write the one setting
 * their feature is about. Reading `Set by` in a log tells you the change came
 * with an action (a tunnel started, an extension enabled) rather than through a
 * settings door, which is usually the next question anyway.
 *
 * ## One section, and that is the invariant rather than a shortcut
 *
 * `before` and `after` are the SECTION, read either side of the write, and the
 * paths come out fully qualified because `section` is prefixed here. That is
 * exactly what a purpose-built writer can move, so a diff wider than its own
 * section would be reporting on nothing.
 *
 * The bound worth knowing: `ConfigManager.set` can move a leaf its caller never
 * named — it stamps `approvals.standingGrantsVoidBefore` when a write narrows
 * the standing-permission posture — and a section-scoped diff cannot see that.
 * It never bites today, because nothing on this list writes `auth` or
 * `approvals`. A writer that needs to should go through
 * {@link applyGuardedConfigWrite} instead, which diffs the whole config and
 * carries the policy that write would need anyway.
 *
 * Says nothing when nothing changed, so a writer that re-saves what is already
 * stored cannot fill the log.
 *
 * @param subsystem - What did the write, as a person would name it
 *   ("the tunnel route", "the agent creator").
 * @param section - The top-level config section this writer owns.
 * @param before - That section, read before the write.
 * @param after - The same section, read after it.
 */
export function logConfigWrite(
  subsystem: string,
  section: keyof UserConfig,
  before: unknown,
  after: unknown
): void {
  const touched = describeConfigWrite({ [section]: before }, { [section]: after });
  if (touched) {
    logger.info(`[Config] Set by ${subsystem}: ${touched}`);
  }
}
