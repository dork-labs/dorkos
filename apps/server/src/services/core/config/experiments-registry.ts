/**
 * The staged opt-ins a person can switch on from Settings → Experiments.
 *
 * ## Why a registry, and why it is meant to shrink
 *
 * DorkOS ships features ON (ADR-0054: absence of configuration means enabled).
 * The exception is a feature that is not finished being proved — one that costs
 * memory, changes timing, or opens a surface — and those ship OFF behind a flag.
 * The flag's whole life is written down: it starts off, it graduates to on-by-
 * default once the evidence is in, and then the flag is DELETED (ADR-0062 for
 * Mesh, ADR-0171 for Relay and Pulse, ADR-0266 for hydration — three flags that
 * went through exactly that and are gone).
 *
 * What was missing was the middle. A flag that ships off is only reachable by
 * hand-editing `~/.dork/config.json`, so `runtimes.claudeCode.persistentSession`
 * shipped and stayed invisible: `GET /api/config` is a curated DTO, and nothing
 * curated it in. Nobody turned it on, so nothing was learned, so it could not
 * graduate. This registry is that middle — a staging area with a real switch in
 * it, so a flag can earn its graduation instead of aging quietly.
 *
 * **Every entry here is expected to disappear.** Graduating a flag means
 * deleting its entry in the same change that flips the default, and deleting
 * the flag itself once nothing reads it. An EMPTY registry is not a broken
 * feature — it is the success state, and the Experiments section says so in
 * plain words when it finds nothing to show.
 *
 * ## What an entry has to satisfy
 *
 * `__tests__/experiments-registry.test.ts` holds the line: every `path` resolves
 * to a real leaf of `UserConfigSchema`, that leaf is a boolean, it defaults to
 * `false`, and it carries a non-empty `graduationIssue`. The default check is the
 * one that matters most — an experiment whose default has already flipped to
 * `true` is not an experiment any more, and leaving it listed would offer
 * somebody a switch to turn OFF something the product now assumes.
 *
 * ## The prose
 *
 * `title`, `description` and `costNote` are read by a person who does not code,
 * so they follow the `writing-for-humans` standard: say what happens for them,
 * benefit before cost, no mechanism. "Your agent stays running between
 * messages", never "reuses a warm SDK query pump".
 *
 * @module services/core/config/experiments-registry
 */

/** One staged opt-in: the setting it writes, and how it reads to a person. */
export interface ExperimentEntry {
  /**
   * Dot-path of the boolean leaf in `UserConfigSchema` this switch writes.
   *
   * Also the entry's identity on the wire — the client builds its `PATCH
   * /api/config` body by splitting this, so it never has to know which
   * experiment it is rendering.
   */
  path: string;
  /** What the experiment is called, in the words a person would use. */
  title: string;
  /** What they get out of turning it on. Benefit first, one or two sentences. */
  description: string;
  /** What it costs them, when there is a real cost worth stating up front. */
  costNote?: string;
  /**
   * The environment variable that overrules {@link ExperimentEntry.path} on this
   * machine, when one exists.
   *
   * It lives on the entry rather than in the resolver because it is a fact about
   * the SETTING — the same fact `index.ts` acts on when it decides whether to
   * mount the subsystem — and a second table keyed by path would be one more
   * thing to keep in step. Its presence is what makes an entry report
   * `lockedByEnv`, so the switch can show reality and refuse to pretend it
   * decides.
   */
  envOverride?: string;
  /** The tracker issue that decides whether this graduates or goes away. */
  graduationIssue: string;
}

/**
 * The experiments on offer, in the order Settings shows them.
 *
 * Order is deliberate and hand-held rather than sorted: the section is short by
 * design, and the most useful thing to try goes first.
 */
export const EXPERIMENTS: readonly ExperimentEntry[] = [
  // `runtimes.claudeCode.persistentSession` GRADUATED here (DOR-1290, spec
  // `full-power-defaults`): warm agents ship on by default, so the entry went
  // out in the same change that flipped the default, exactly as the contract
  // above requires. The setting itself did not go away — its switch lives in the
  // Control Center (task 2.2), which has NOT landed yet — so between that PR
  // and this one the setting is reachable only through `PATCH /api/config` or
  // the config file. That gap is deliberate and short, and the changelog says so
  // rather than implying a switch that is not there.
  {
    path: 'a2a.enabled',
    title: 'Let outside agents reach yours',
    description:
      'Agents built by other people, on other systems, can send work to the agents here. DorkOS publishes a card describing them and opens an address those agents can post to. Needs Agent messaging on, and takes effect the next time DorkOS starts.',
    costNote:
      'Early alpha, and it opens a door: only turn it on when you know what is on the other side of it.',
    envOverride: 'DORKOS_A2A_ENABLED',
    graduationIssue: 'DOR-1304',
  },
];
