/**
 * Discovers every gate the repo actually runs, straight from its sources.
 *
 * The census compares this list with `ci/gates.yaml` in both directions, so a
 * gate cannot exist without a stated purpose, and a stated purpose cannot
 * outlive its gate. It also derives which repo scripts each gate invokes, which
 * the ledger coverage check treats as pipeline sources.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { WorkflowModel } from './workflows.ts';

/** A gate found in a source file. */
export interface DiscoveredGate {
  id: string;
  /** Where the gate is defined, as `ci/gates.yaml` must record it. */
  source: string;
  /** Shell commands the gate runs, used to derive invoked scripts. */
  commands: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * One gate per job in every workflow: `wf.<file-stem>.<job-id>`.
 *
 * @param workflows - The parsed workflows.
 */
export function workflowGates(workflows: readonly WorkflowModel[]): DiscoveredGate[] {
  return workflows.flatMap((wf) =>
    wf.jobs.map((job) => ({
      id: `wf.${wf.stem}.${job.id}`,
      source: wf.path,
      commands: job.steps.flatMap((s) => (s.run ? [s.run] : [])),
    }))
  );
}

/**
 * One gate per lefthook command, script or named job: `lefthook.<hook>.<name>`.
 *
 * @param lefthookPath - Repo-relative path of the lefthook config.
 * @param text - Its YAML source.
 */
export function lefthookGates(lefthookPath: string, text: string): DiscoveredGate[] {
  const doc: unknown = parseYaml(text);
  const out: DiscoveredGate[] = [];
  if (!isObj(doc)) return out;
  for (const [hook, cfg] of Object.entries(doc)) {
    if (!isObj(cfg)) continue;
    for (const key of ['commands', 'scripts'] as const) {
      const group = cfg[key];
      if (!isObj(group)) continue;
      for (const [name, c] of Object.entries(group)) {
        const run = isObj(c) && typeof c.run === 'string' ? c.run : '';
        const command = key === 'scripts' ? `.lefthook/${hook}/${name}` : run;
        out.push({ id: `lefthook.${hook}.${name}`, source: lefthookPath, commands: [command] });
      }
    }
    if (Array.isArray(cfg.jobs)) {
      for (const j of cfg.jobs) {
        if (isObj(j) && typeof j.name === 'string') {
          const run = typeof j.run === 'string' ? j.run : '';
          out.push({ id: `lefthook.${hook}.${j.name}`, source: lefthookPath, commands: [run] });
        }
      }
    }
  }
  return out;
}

/**
 * The script a Claude hook command really runs, skipping known wrappers.
 *
 * @param command - The hook's `command` string.
 * @param wrappers - Repo-relative wrapper scripts to look past.
 */
function claudeHookScript(command: string, wrappers: readonly string[]): string | null {
  const wrapperNames = new Set(wrappers.map((w) => path.posix.basename(w)));
  const found = [...command.matchAll(/\.claude\/hooks\/[\w.-]+/g)].map((m) => m[0]);
  const real = found.filter((p) => !wrapperNames.has(path.posix.basename(p)));
  return real.at(-1) ?? null;
}

/**
 * One gate per distinct Claude hook script per event: `claude.<Event>.<basename>`.
 *
 * @param settingsPath - Repo-relative path of `.claude/settings.json`.
 * @param text - Its JSON source.
 * @param wrappers - Wrapper scripts that are not gates themselves.
 */
export function claudeHookGates(
  settingsPath: string,
  text: string,
  wrappers: readonly string[]
): DiscoveredGate[] {
  const settings: unknown = JSON.parse(text);
  const hooks = isObj(settings) && isObj(settings.hooks) ? settings.hooks : {};
  const byId = new Map<string, DiscoveredGate>();
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers) {
      const list = isObj(m) && Array.isArray(m.hooks) ? m.hooks : [];
      for (const h of list) {
        if (!isObj(h) || typeof h.command !== 'string') continue;
        const script = claudeHookScript(h.command, wrappers);
        if (!script) continue;
        const base = path.posix.basename(script).replace(/\.[^.]+$/, '');
        const id = `claude.${event}.${base}`;
        const existing = byId.get(id);
        if (existing) existing.commands.push(h.command);
        else byId.set(id, { id, source: settingsPath, commands: [h.command] });
      }
    }
  }
  return [...byId.values()];
}

/**
 * Repo files a set of shell commands invokes: any path-looking token that
 * names an existing file, plus the files named by any root `pnpm run <script>`
 * the commands call (one level deep).
 *
 * @param root - Repo root.
 * @param commands - Shell command strings.
 * @param rootScripts - The root `package.json` scripts map.
 */
export function invokedScripts(
  root: string,
  commands: readonly string[],
  rootScripts: Readonly<Record<string, string>>
): string[] {
  const found = new Set<string>();
  const scan = (text: string) => {
    for (const m of text.matchAll(/[\w.@/-]+\.(?:sh|bash|mjs|cjs|js|ts|mts|py)\b/g)) {
      const parts = m[0].split('/').filter((p) => p !== '' && p !== '.');
      for (let i = 0; i < parts.length; i++) {
        const candidate = parts.slice(i).join('/');
        if (candidate.startsWith('node_modules/')) break;
        if (existsSync(path.join(root, candidate))) {
          found.add(candidate);
          break;
        }
      }
    }
  };
  for (const cmd of commands) {
    scan(cmd);
    for (const m of cmd.matchAll(/\bpnpm\s+(?:run\s+)?([\w:.-]+)/g)) {
      const script = rootScripts[m[1]!];
      if (script) scan(script);
    }
  }
  return [...found].sort();
}

/**
 * Read the root `package.json` scripts map, or an empty map.
 *
 * @param root - Repo root.
 * @param packageJson - Repo-relative path of the root manifest.
 */
export function readRootScripts(root: string, packageJson: string): Record<string, string> {
  try {
    const pkg: unknown = JSON.parse(readFileSync(path.join(root, packageJson), 'utf8'));
    const scripts = isObj(pkg) && isObj(pkg.scripts) ? pkg.scripts : {};
    return Object.fromEntries(
      Object.entries(scripts).filter((e): e is [string, string] => typeof e[1] === 'string')
    );
  } catch {
    return {};
  }
}
