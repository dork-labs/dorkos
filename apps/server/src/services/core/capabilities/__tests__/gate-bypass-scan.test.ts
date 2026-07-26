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
      'routes/config.ts':
        'the cockpit REST route — refuses operator-only paths for any caller that is not a trusted caller (DOR-467), and with login on for any caller without a session cookie (DOR-505)',
      'services/core/operator/operator-tool-handlers.ts':
        'the agent capability — refuses operator-only paths unconditionally (DOR-488)',
      'services/core/operator/config-patch.ts': 'the definition itself',
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
        'the cockpit + CLI REST route — refuses any caller that is not a trusted caller, with no approval that could unlock it (DOR-502)',
      'services/marketplace-mcp/personal-marketplace.ts':
        'the boot-time bootstrap of the local personal marketplace; no request reaches it and the source it registers is always a file:// URL under this dork home',
    },
  },
  {
    what: 'drops a package feed, silently taking away every package it served',
    call: 'sourceManager.remove(',
    allowed: {
      'routes/marketplace.ts':
        'the cockpit + CLI REST route — refuses any caller that is not a trusted caller (DOR-502)',
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
      'services/core/capabilities/tier-enforcement.ts':
        'the definition itself, plus authorizeCapability next to it',
    },
  },
  {
    what: 'mints the marker that skips the tier gate entirely',
    call: 'trustedCaller(',
    allowed: {
      'routes/marketplace.ts': 'a person clicking Install or Uninstall in their own cockpit',
      'routes/config.ts': 'a person changing their own settings in their own cockpit',
      'routes/tasks.ts':
        'a person approving a scheduled task, or setting how it runs, in their own cockpit (DOR-504)',
      'routes/extensions-approval.ts':
        'a person allowing an extension to run its code inside DorkOS, in their own cockpit (DOR-516). Gated: both bars from `PATCH /api/config` for an operator-only setting, in the same order — the cookie bar under login, then this one — because the field it writes (`extensions.approvedToRun`) IS operator-only, plus a trusted-`Origin` bar the config route does not need because these two routes are reachable by a plain cross-site POST. There is no MCP twin to walk around, by design',
      'services/core/capabilities/trusted-caller.ts': 'the definition itself',
    },
  },
  {
    what: 'sets how much a scheduled task may do unattended, and whether it is approved to run',
    call: 'createTask(',
    allowed: {
      'routes/tasks.ts':
        'the cockpit REST route, on its parse-failure FALLBACK branch only — the happy path is upsertFromFile below. Refuses operator-only task fields unless the caller is a trusted caller, and parks the task at pending_approval when it is not (DOR-504)',
      'services/runtimes/claude-code/mcp-tools/task-tools.ts':
        'the tasks_create handler shared by both MCP servers — refuses operator-only fields unconditionally (DOR-504)',
      'services/shapes/shape-schedule-service.ts':
        'applies a Shape package that DECLARES a schedule; the mode comes from installed content, not from the caller, and is NOT covered by the DOR-504 policy (see task-write-policy.ts)',
      'services/tasks/task-store.ts': 'the definition itself',
    },
  },
  {
    what: "writes a task's permission mode and status from a SKILL.md file on disk, which is the primary create path",
    call: 'upsertFromFile(',
    allowed: {
      'routes/tasks.ts':
        'the cockpit REST route, on its HAPPY path — this is how a created task normally reaches the DB, not createTask above (DOR-504)',
      'services/tasks/task-file-watcher.ts':
        'syncs a file a person (or anything that can write a project file) edited on disk; the frontmatter path is deliberately NOT covered by the DOR-504 policy (see task-write-policy.ts)',
      'services/tasks/task-reconciler.ts': 'the periodic resync of the same files',
      'services/shapes/shape-schedule-service.ts':
        'applies a Shape package that DECLARES a schedule; the mode comes from installed content, not from the caller, and is NOT covered by the DOR-504 policy',
      'services/tasks/task-store.ts': 'the definition itself',
    },
  },
  {
    what: "changes a scheduled task's permission mode or approval status",
    call: 'updateTask(',
    allowed: {
      'routes/tasks.ts':
        'the cockpit REST route — refuses operator-only task fields unless the caller is a trusted caller (DOR-504)',
      'services/runtimes/claude-code/mcp-tools/task-tools.ts':
        'the tasks_create and tasks_update handlers shared by both MCP servers — refuse operator-only fields unconditionally (DOR-504)',
      'services/tasks/task-store.ts': 'the definition itself',
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

/** Files that call `call`, as paths relative to `apps/server/src`. */
async function callersOf(call: string): Promise<string[]> {
  const hits: string[] = [];
  for (const file of SOURCES) {
    const text = await readFile(file, 'utf-8');
    // Ignore the token where it only appears inside prose: a TSDoc or a `//`
    // comment naming the function is documentation, not a call path.
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    // Matched on an identifier boundary, so `isTrustedCaller(` is not read as a
    // call to `trustedCaller(` — a plain substring match reports the guard itself
    // as a bypass. A leading `.` is deliberately allowed, because a receiver
    // (`deps.uninstallFlow.uninstall(`) is still that call.
    const pattern = new RegExp(`(?<![A-Za-z0-9_$])${call.replace('(', '\\(')}`);
    if (pattern.test(code)) hits.push(path.relative(SERVER_SRC, file));
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
    it(`${effect.call} is called only by modules that gate it`, async () => {
      const actual = await callersOf(effect.call);
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
