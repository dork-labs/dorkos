/**
 * The drift gate that would have caught DOR-467, and its sibling on
 * `PATCH /api/config`.
 *
 * ## Why this shape, and what the previous shape could not see
 *
 * Enforcement used to be proven by a hand-maintained list of adapter paths
 * (`GATED_ADAPTER_PATHS`), each needing a probe. That list can only fail for a
 * path somebody already thought to put on it. Both real defects were paths that
 * were never on it: the legacy marketplace routes reached an uninstall with no
 * tier check, and `PATCH /api/config` reached `applyConfigPatch` with none of the
 * operator-only write policy its capability twin enforces. Nothing was missing
 * from the list, so the list stayed green.
 *
 * So this scan inverts the question. Instead of "is every surface we listed
 * gated?", it asks **"who can reach the guarded thing at all?"** — and pins that
 * answer. Each entry below names a PROTECTED EFFECT (a function that mutates
 * posture-bearing or irreversible state) and the exact set of production modules
 * allowed to call it. A new route, service, or adapter that reaches one of them
 * turns this test red and has to justify itself in review.
 *
 * The two halves are complementary and neither subsumes the other:
 *
 * - The conformance suite's `checkRegistryGateConformance` proves the gate is
 *   INSIDE `registry.invoke`, so anything reaching a capability through the
 *   registry is gated by construction — including adapters that do not exist yet.
 * - This scan covers what that cannot see: code that reaches the underlying
 *   effect WITHOUT touching the registry, which is exactly what both defects did.
 *
 * ## The list is the limit, and it is not complete
 *
 * Be honest about what this buys. It does NOT close the defect class; it narrows
 * it from SURFACES to EFFECTS. That is a real improvement — effects are fewer,
 * change far more slowly than the routes that reach them, and both known defects
 * touched an effect that is listed — but a scan cannot fail for an effect nobody
 * added, which is the same shape of hole `GATED_ADAPTER_PATHS` had one level up.
 *
 * That is not a theoretical worry: this file used to carry a live counterexample,
 * the ungated marketplace SOURCE routes, sitting in the prose because nobody had
 * decided what to do about them. They are gated now and listed below (DOR-502), so
 * the honest general statement is what remains — an effect is covered from the day
 * somebody adds it here, and not before. When you find the next one, add it rather
 * than describe it.
 *
 * ## What it does not catch
 *
 * A textual scan. It sees a call spelled the way the allowlist spells it, so an
 * alias (`const f = applyConfigPatch; f(...)`) or a dynamic dispatch slips past.
 * That is an acceptable floor: the defect class this exists for is an honest new
 * route calling an obvious function, twice now, not somebody smuggling one.
 *
 * @module services/core/capabilities/__tests__/gate-bypass-scan
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { codeOnly } from '../../../../../../../scripts/lib/code-only.mjs';

/** `apps/server/src`, resolved from this file rather than from the cwd. */
const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** One protected effect and the production modules allowed to reach it. */
interface ProtectedEffect {
  /** What the guard protects, in one line, for the failure message. */
  what: string;
  /** The call expression as it is written in source. */
  call: string;
  /** Paths relative to `apps/server/src`, each with why it is allowed. */
  allowed: Record<string, string>;
}

const PROTECTED_EFFECTS: ProtectedEffect[] = [
  {
    what: 'writes user config, including the settings that decide who can reach this instance',
    call: 'applyConfigPatch(',
    allowed: {
      // Narrowed to ONE caller by DOR-1247. It used to be two — the REST route
      // and the capability handler — each running its own copy of the policy,
      // which is how `dorkos config set` came to run none of it. Now the bars,
      // the consent door and the audit line live in one function and every door
      // goes through it, so the entry below is what this list is really pinning.
      'services/core/operator/config-write.ts':
        'the guarded step — runs the login bar, the operator bar, the Full-autonomy consent door and the audit line before this is reached, and cannot be called without a caller authority',
      'services/core/operator/config-patch.ts': 'the definition itself',
    },
  },
  {
    // This scan reads `apps/server/src` only, so it cannot see the third caller:
    // `packages/cli/src/config-commands.ts`, which is `dorkos config set`. That
    // one is covered by the entry below instead — the authority it passes is the
    // permissive one, and this scan CAN prove no server surface reaches for it.
    what: 'writes user config through the guarded step, whose bars are only as strong as the authority the caller hands it',
    call: 'applyGuardedConfigWrite(',
    allowed: {
      'routes/config.ts':
        'the cockpit REST route — builds its authority from the request, refusing operator-only paths for any caller that is not a trusted caller (DOR-467), and with login on for any caller without a session cookie (DOR-505)',
      'services/core/operator/operator-tool-handlers.ts':
        'the agent capability — OPERATOR_TOOL_AUTHORITY refuses operator-only paths unconditionally (DOR-488)',
      'services/core/operator/config-write.ts': 'the definition itself',
    },
  },
  {
    // The one entry here whose allowlist holds nothing but the definition, and
    // the reason is worth stating: it is watched for who must NEVER reach it.
    //
    // `LOCAL_OPERATOR_AUTHORITY` clears both bars. That is right for
    // `dorkos config set`, where the caller IS the person at their own terminal
    // and the alternative is `dorkos config edit` with no policy at all
    // (`config-write.ts` argues it in full). It is wrong for every surface in
    // this server, because a request is not a person — that distinction is the
    // whole subject of DOR-467 and DOR-505. Handing it to an HTTP route would
    // silently reinstate both defects while every other check here stayed green.
    //
    // Matched as a bare identifier rather than a call, because it is a constant
    // that gets PASSED rather than invoked. Same textual floor as everything
    // else here: it catches the honest import, not a rebinding.
    what: "hands the guarded step the CLI's clear-both-bars authority, which is only true of a person at their own terminal",
    call: 'LOCAL_OPERATOR_AUTHORITY',
    allowed: {
      'services/core/operator/config-write.ts': 'the definition itself',
    },
  },
  {
    what: 'removes an installed package from disk, which cannot be undone',
    call: 'uninstallFlow.uninstall(',
    allowed: {
      'routes/marketplace.ts':
        'the cockpit + CLI REST route — runs the tier gate via authorizeCapability first (DOR-467)',
      'services/marketplace-mcp/tool-uninstall.ts':
        'the marketplace.uninstall capability handler — reached only through registry.invoke, which gates',
      'services/marketplace/marketplace-installer.ts':
        'the first half of an in-place update (uninstall then install); its callers are gated, not this',
    },
  },
  {
    what: 'points this install at a package feed it will fetch and run code from',
    call: 'sourceManager.add(',
    allowed: {
      'routes/marketplace.ts':
        'the cockpit + CLI REST route — refuses any caller the agent bar (resolveDecisionAuthority) turns away, with no approval that could unlock it (DOR-502). Deliberately NOT the cookie bar: `dorkos marketplace add` is a terminal verb whose only credential is an API key, so demanding a cookie is a lockout (source-write-policy.ts)',
      'services/marketplace-mcp/personal-marketplace.ts':
        'the boot-time bootstrap of the local personal marketplace; no request reaches it and the source it registers is always a file:// URL under this dork home',
    },
  },
  {
    what: 'drops a package feed, silently taking away every package it served',
    call: 'sourceManager.remove(',
    allowed: {
      'routes/marketplace.ts':
        'the cockpit + CLI REST route — refuses any caller the agent bar (resolveDecisionAuthority) turns away (DOR-502); see the add entry above for why the cookie bar is not copied here',
    },
  },
  {
    what: 'disables a package feed, which takes away every package it served just as removing it does — browse aggregates from ENABLED sources only',
    // Listed with an EMPTY allowlist, which is the only entry here that has one,
    // so say why. `MarketplaceSourceManager` has three mutators; DOR-502 gated the
    // two that had routes and left this one with no production caller at all. That
    // is the moment to list it, not later: the cockpit already RENDERS each
    // source's enabled state and the CLI already prints it, with nothing anywhere
    // that can flip it after the source is created, so a `PATCH /sources/:name`
    // toggle is the obvious next route on this router. Without this entry that
    // route would arrive ungated AND invisible to this scan — the exact "a scan
    // cannot fail for an effect nobody added" hole the module TSDoc above warns
    // about. With it, the route turns this red until its author gates it and
    // writes down why it is safe.
    call: 'sourceManager.setEnabled(',
    allowed: {},
  },
  {
    what: 'runs the tier gate for a caller that performs the effect itself, instead of via registry.invoke',
    call: 'authorizeCapability(',
    allowed: {
      'routes/marketplace.ts':
        'the legacy marketplace mutation routes, which own a response contract the cockpit and CLI depend on',
      'services/core/capabilities/tier-enforcement.ts': 'the definition itself',
    },
  },
  {
    what: 'decides a permission tier, and is therefore the whole gate',
    call: 'enforceCapabilityTier(',
    allowed: {
      'services/core/capabilities/registry.ts':
        'the registry choke point — every capability inherits the gate from inside invoke (DOR-467)',
      'services/core/mcp-tool-gate.ts':
        'the hand-registered MCP tools, which are not registry capabilities and so cannot inherit it (DOR-468)',
      'routes/shapes.ts':
        'POST /api/shapes/:name/apply, which owns its own effect and has no capability twin — shapes is not a registry domain, and minting one purely so authorizeCapability had something to look up would add an agent-invocable path to the effect being closed (DOR-625)',
      'services/core/capabilities/tier-enforcement.ts':
        'the definition itself, plus authorizeCapability next to it',
    },
  },
  {
    what: 'records the YES that lets a destructive action through, which is the whole gate',
    call: 'approvals.grant(',
    allowed: {
      'routes/approvals.ts':
        'the cockpit route a person answers on — runs the agent bar, the requester bar, and under login the cookie bar, so an API key cannot answer for a person (DOR-474)',
    },
  },
  {
    what: 'records a NO, which buries the card a person would otherwise have answered',
    call: 'approvals.deny(',
    allowed: {
      'routes/approvals.ts': 'the same route, guarded the same way — see the grant entry above',
    },
  },
  {
    what: "arms a Shape's schedules — created ENABLED, carrying the permission mode its manifest chose (bypassPermissions included) — and deletes the ones an earlier version of that Shape left behind",
    call: 'applyShape(',
    allowed: {
      'routes/shapes.ts':
        'the cockpit REST route — runs the tier gate first, and it is the ONLY entry point an agent can reach (DOR-625)',
      'index.ts':
        'the marketplace update hook: re-applies the ACTIVE Shape in place after an update replaced it. The name is read from config, never from a caller, and reaching it at all requires already having cleared the install gate',
      'services/shapes/apply-shape.ts': 'the definition itself',
    },
  },
  {
    what: 'mints the marker that skips the tier gate entirely',
    // Since DOR-474 a marker also requires a session cookie whenever login is on,
    // because the two-step path it stands in for (ask, then grant) requires one.
    // Two entries left this list for that reason rather than because they became
    // ungated: the package-source routes and the task write routes wanted the AGENT
    // bar, not this marker, and now read `resolveDecisionAuthority` directly. Their
    // effects are still watched below (`sourceManager.add(`, `createTask(`, and the
    // rest), so dropping them here narrows what this token means without narrowing
    // what the scan covers.
    call: 'trustedCaller(',
    allowed: {
      'routes/marketplace.ts': 'a person clicking Install or Uninstall in their own cockpit',
      'routes/config.ts': 'a person changing their own settings in their own cockpit',
      'routes/shapes.ts':
        'a person clicking a Shape in their own cockpit — applying one arms scheduled work, so an agent is asked first (DOR-625)',
      'routes/extensions-approval.ts':
        'a person allowing an extension to run its code inside DorkOS, in their own cockpit (DOR-516). Gated: both bars from `PATCH /api/config` for an operator-only setting, in the same order — the cookie bar under login, then this one — because the field it writes (`extensions.approvedToRun`) IS operator-only, plus a trusted-`Origin` bar the config route does not need because these two routes are reachable by a plain cross-site POST. There is no MCP twin to walk around, by design',
      'routes/tunnel.ts':
        'a person turning Remote Access on in their own cockpit, which publishes this machine and writes `tunnel.enabled` (DOR-1738). Gated: both bars from `PATCH /api/config` for an operator-only setting, in the same order — the cookie bar under login, then this one — because `tunnel.*` IS operator-only in config-write-policy and this route writes the flag straight through `configManager`, around the door that enforces that. `POST /api/tunnel/stop` deliberately runs neither bar and reaches no effect on this list: stopping only ever narrows exposure, and gating it stranded a running tunnel once already (DOR-574)',
      'services/core/capabilities/trusted-caller.ts': 'the definition itself',
    },
  },
  {
    what: 'sets how much a scheduled task may do unattended, and whether it is approved to run',
    call: 'createTask(',
    allowed: {
      'services/tasks/lifecycle/create-task.ts':
        'the ONE create sequence, shared by `POST /api/tasks` and by `tasks_create` on both MCP servers since DOR-1568 — on its parse-failure FALLBACK branch only, the happy path being upsertFromFile below. Both doors refuse operator-only task fields before reaching it, and it parks the task at pending_approval for any caller that did not clear the agent bar (DOR-504). Deliberately NOT the DOR-474 cookie bar: `dorkos task create` presents an API key, so a cookie demand would park every task the operator schedules while telling them it was created',
      'services/shapes/shape-schedule-service.ts':
        'applies a Shape package that DECLARES a schedule; the mode comes from installed content, not from the caller, and is NOT covered by the DOR-504 policy (see task-write-policy.ts)',
      'services/tasks/task-store.ts': 'the definition itself',
    },
  },
  {
    what: "writes a task's permission mode and status from a SKILL.md file on disk, which is the primary create path",
    call: 'upsertFromFile(',
    allowed: {
      'services/tasks/lifecycle/create-task.ts':
        'the shared create sequence, on its HAPPY path — this is how a created task normally reaches the DB, not createTask above (DOR-504); same agent bar as createTask',
      'services/tasks/task-file-watcher.ts':
        'syncs a file a person (or anything that can write a project file) edited on disk; the frontmatter path is deliberately NOT covered by the DOR-504 policy (see task-write-policy.ts)',
      'services/tasks/task-reconciler.ts': 'the periodic resync of the same files',
      'services/shapes/shape-schedule-service.ts':
        'applies a Shape package that DECLARES a schedule; the mode comes from installed content, not from the caller, and is NOT covered by the DOR-504 policy',
      'services/tasks/legacy-migration.ts':
        'the boot migration (DOR-1486), on ONE branch: a legacy file it could not read, which it leaves on disk and reports as a parked row so the person is told about it. Gated by the strongest gate there is — the call passes `source: discovery`, which cannot arm anything (`resolveFileArmStatus`), and the definition it hands over carries no cron and `enabled: false`, so even an approval produces a schedule with no timer. Every file the migration CAN read goes nowhere near this call: it is rewritten on disk and its row is moved by `rekeyMigratedFile`, which writes a path and a grant and never a permission mode. Deleted with the module at its sunset',
      'services/tasks/task-store.ts': 'the definition itself',
    },
  },
  {
    what: "changes a scheduled task's permission mode or approval status",
    call: 'updateTask(',
    allowed: {
      'routes/tasks.ts':
        'the cockpit REST route — refuses operator-only task fields unless the caller clears the agent bar (DOR-504); see the createTask entry for why the DOR-474 cookie bar stops short of here',
      'services/tasks/lifecycle/create-task.ts':
        'the shared create sequence, which parks a proposal and lifts the permission clamp for a trusted caller only — reached through a door that already refused operator-only fields (DOR-1568)',
      'services/runtimes/claude-code/mcp-tools/task-tools.ts':
        'the tasks_update handler shared by both MCP servers — refuses operator-only fields unconditionally (DOR-504)',
      'services/tasks/task-store.ts': 'the definition itself',
    },
  },
  {
    // Watched from DOR-1611, when a roster write stopped being operator-only.
    // Until then `requireOperator` was the whole story and there was nothing to
    // route around; now an agent the person armed can edit a roster, and every
    // rule that makes that safe — the owner is never removable by an agent, a
    // room holding two agents holds her too, a bridged room takes no second
    // agent, a system room keeps its owner — lives in `RoomService.addMember`
    // and `RoomService.removeMember` rather than in the store beneath them.
    //
    // So the effect to watch is the UNGUARDED write, one layer down. A second
    // caller reaching `RoomRoster` directly would assemble the room shape those
    // rules exist to forbid while every capability-level test stayed green,
    // which is this file's whole defect class.
    what: 'puts somebody in a room, beneath every rule about who may be in one together',
    call: 'roster.add(',
    allowed: {
      'services/rooms/room-service.ts':
        'the only caller, and the one that carries the guards: `requireRosterWriteAllowed`, the three-way rule, the bridged-room refusal and the seeding gate all run above this line',
    },
  },
  {
    what: 'takes somebody out of a room, beneath the rules about who may take whom',
    call: 'roster.remove(',
    allowed: {
      'services/rooms/room-service.ts':
        "the only caller, and the one that carries the guards: an agent may never remove the person, a system room keeps its owner, and the removed member's fallback seat and held turns are cleared with them",
    },
  },
];

/** Every `.ts` file under `apps/server/src`, excluding tests and declaration files. */
async function productionSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...(await productionSources(full)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

const SOURCES = await productionSources(SERVER_SRC);

/**
 * Every source, read and lexed ONCE, as `[relative path, code-only text]`.
 *
 * `codeOnly` is the repo's shared stripper (`scripts/lib/code-only.mjs`) — the
 * one place that knows how to tell code from prose, because three guards each
 * knowing it in a different, differently-broken way is what DOR-642 was. Read
 * its module doc before changing anything about what this scan can see. What
 * matters here: a token inside a comment or a string literal is not a call, and
 * a token inside a template SUBSTITUTION is.
 *
 * Hoisted because the corpus is static and the parser is not free: one lexing
 * pass over the 806 server sources costs ~1.3s (the regex pipeline it replaced
 * cost ~29ms over the 454 sources there were then). `callersOf` used to re-read
 * and re-lex all of them per protected effect, so the twelve assertions below
 * spent ~11.7s between them — against vitest's 5s DEFAULT per-test timeout.
 * Under load that failed three assertions on time alone, which is a flaky CI job
 * that says "ungated caller" when it means "slow". Lexing once is ~12x cheaper
 * and makes the whole file ~1s.
 *
 * The timeout is deliberately NOT raised instead: the work was gratuitous, and a
 * raised timeout would keep it while hiding the next regression in cost.
 *
 * What this lexing can and cannot see is asserted against this same corpus in
 * `code-only-corpus.test.ts` beside this file — including that every source
 * actually PARSES, since a file the parser chokes on scans as innocent.
 */
const LEXED: readonly (readonly [string, string])[] = await Promise.all(
  SOURCES.map(
    async (file) =>
      [path.relative(SERVER_SRC, file), codeOnly(await readFile(file, 'utf-8'), file)] as const
  )
);

/** Files that call `call`, as paths relative to `apps/server/src`. */
function callersOf(call: string): string[] {
  const hits: string[] = [];
  // The token is ignored where it only appears inside prose: a TSDoc or a `//`
  // comment naming the function is documentation, not a call path. That removal
  // already happened in `codeOnly`, when the corpus was lexed.
  // Matched on an identifier boundary, so `isTrustedCaller(` is not read as a
  // call to `trustedCaller(` — a plain substring match reports the guard itself
  // as a bypass. A leading `.` is deliberately allowed, because a receiver
  // (`deps.uninstallFlow.uninstall(`) is still that call.
  const pattern = new RegExp(`(?<![A-Za-z0-9_$])${call.replace('(', '\\(')}`);
  for (const [relative, code] of LEXED) {
    if (pattern.test(code)) hits.push(relative);
  }
  return hits.sort();
}

describe('no ungated path reaches a protected effect', () => {
  it('found the server sources to scan', () => {
    // A scan over an empty file list is vacuously green, which is the one way
    // this test could fail to do its job without saying so.
    expect(SOURCES.length).toBeGreaterThan(100);
  });

  for (const effect of PROTECTED_EFFECTS) {
    it(`${effect.call} is called only by modules that gate it`, () => {
      const actual = callersOf(effect.call);
      const allowed = Object.keys(effect.allowed).sort();
      const unexpected = actual.filter((f) => !allowed.includes(f));
      const missing = allowed.filter((f) => !actual.includes(f));

      expect(
        unexpected,
        unexpected.length
          ? `\n${unexpected.join('\n')}\n\n` +
              `These modules call ${effect.call} — which ${effect.what} — and are not on its ` +
              `allowlist in this file.\n\n` +
              `This is the DOR-467 defect class: a new surface reaching a guarded effect around ` +
              `the enforcement its capability twin honors. Either route it through ` +
              `registry.invoke (which gates), or gate it explicitly and add it here with the ` +
              `reason it is safe. Do not add it here without gating it.`
          : ''
      ).toEqual([]);

      // The reverse direction, so the allowlist cannot rot into a list of files
      // that no longer call this at all and quietly stop meaning anything.
      expect(
        missing,
        missing.length
          ? `\n${missing.join('\n')}\n\nThese are allowlisted for ${effect.call} but no longer ` +
              `call it. Remove them, so the allowlist keeps describing the real call graph.`
          : ''
      ).toEqual([]);
    });
  }
});
