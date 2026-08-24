/**
 * @module layers/features/marketing/lib/comparisons
 *
 * The comparison catalog behind `/compare`. Each entry is one other product,
 * scored against a shared set of dimensions. DorkOS's own side of every
 * dimension is *derived* from the feature catalog (see {@link dorkosCellFor}),
 * never hand-written, so a page can never claim more than the catalog does.
 */
import { features, type Feature } from './features';

/**
 * How DorkOS relates to the other product, which decides the whole page
 * template:
 *
 * - `competitor` — a genuine rival; an honest "DorkOS vs X".
 * - `runtime` — an agent tool DorkOS runs for you; "DorkOS + X", never adversarial.
 * - `adjacent` — a different category with real overlap; the page is scoped to the overlap.
 * - `discontinued` — the product shut down; the page is "X alternatives".
 */
export type ComparisonFraming = 'competitor' | 'runtime' | 'adjacent' | 'discontinued';

/** Whether a product does the thing a dimension asks about. */
export type CapabilityVerdict = 'yes' | 'partial' | 'no';

/**
 * A shared axis every comparison is scored on.
 *
 * The first entry in {@link ComparisonDimension.featureSlugs} is the *lead*
 * feature: its tagline supplies the wording of DorkOS's derived cell, and the
 * rest of the list decides the verdict.
 */
export interface ComparisonDimension {
  /** Stable id; the key into {@link Competitor.cells}. */
  id: string;
  /** Short row label for the comparison table. */
  label: string;
  /** Feature slugs backing DorkOS's cell. Every slug must resolve in the feature catalog. */
  featureSlugs: string[];
  /** One-sentence framing of what this dimension means for the user. */
  question: string;
  /**
   * Finishes the sentence "you want …" in the recommendation column, so the
   * reason reads as something a person wants rather than a table row label.
   * No trailing period: the list renders it as a fragment.
   */
  wantPhrase: string;
  /**
   * Wording for DorkOS's cell where the lead feature's tagline does not answer
   * the question (price, for one, is not a feature). This changes the sentence
   * only: the verdict still comes from the backing features' status, and an
   * unproven feature still forces `partial` and gets named.
   */
  dorkosNote?: string;
  /**
   * A longer explanation of DorkOS's side, for the criterion section further
   * down the page. Set it only where there is genuinely more to say than the
   * table cell already says — sections with nothing extra are not rendered.
   */
  dorkosDetail?: string;
}

/** One product's answer on one dimension. */
export interface ComparisonCell {
  /** Whether the product does this. */
  verdict: CapabilityVerdict;
  /** One plain-language sentence saying what it actually does here. */
  note: string;
  /**
   * A longer explanation for the criterion section further down the page. Set it
   * only where there is more to say than the table cell says; a dimension where
   * neither side has a detail gets no section at all, rather than an empty
   * heading repeating the table.
   */
  detail?: string;
  /** URL backing a `yes` or `partial` claim. */
  source?: string;
}

/** One product DorkOS is compared against, and the page that renders it. */
export interface Competitor {
  /** Kebab-case slug; the page lives at `/compare/<slug>`. */
  slug: string;
  /** Product name as its maker writes it. */
  name: string;
  /** Company or person behind it. */
  maker: string;
  /** The product's own https site: the outbound link and the JSON-LD entity URL. */
  homepage: string;
  /** Which page template this entry gets. */
  framing: ComparisonFraming;
  /** Human category label, e.g. 'AI code editor'. */
  category: string;
  /** Meta-description-ready summary, 120-160 chars. */
  oneLiner: string;
  /** Short factual price summary, written for a reader who has never seen the pricing page. */
  pricing: string;
  /** Whether the product's own source code is public. */
  openSource: boolean;
  /** Two-to-four-sentence honest verdict; it leads the page. */
  verdict: string;
  /**
   * What the other product is good at, in its own right.
   *
   * Each entry finishes the sentence in that framing's recommendation heading
   * ("Use X if …", "Reach for X when …"), so it starts lowercase and reads as a
   * reason rather than a feature name. Rendered for `competitor` and `adjacent`
   * (where it is the honest concession) and for `runtime` (where it is a
   * compliment to an engine DorkOS runs). Required for those three, enforced by
   * the invariant suite. Omitted for `discontinued`: that page is about a
   * product that no longer exists, so there is nothing to recommend.
   */
  theirStrengths?: string[];
  /** Their cell for every dimension in {@link COMPARISON_DIMENSIONS}, keyed by dimension id. */
  cells: Record<string, ComparisonCell>;
  /** 2-5 questions, rendered visibly on the page and mirrored into FAQPage markup. */
  faq: { q: string; a: string }[];
  /** ISO date the facts were last checked; shown on the page and used as the sitemap's `lastModified`. */
  lastVerified: string;
  /** Non-empty list of https sources backing the page's claims. */
  sources: string[];
  /** Related feature slugs for cross-links; every slug must resolve in the feature catalog. */
  relatedFeatures?: string[];
}

/**
 * Per-framing page copy. The template reads every field from here, so adding a
 * product to a framing never means touching the route.
 */
export interface ComparisonFramingCopy {
  /** Page H1. */
  headline: (name: string) => string;
  /** Browser and search-result title. */
  metaTitle: (name: string) => string;
  /**
   * The line under the H1. For head-to-head pages it also carries the reversed
   * wording ("X vs DorkOS") that people search for, so one page answers both
   * without a second address.
   */
  intro: (name: string) => string;
  /** Scope banner above the verdict, where the page needs one to be honest. */
  scopeNote?: (name: string) => string;
  /** Heading over the dimension table. */
  tableHeading: string;
  /** Column header for the other product's side of the table. */
  theirColumn: (name: string) => string;
  /** Column header for DorkOS's side of the table. */
  ourColumn: string;
  /**
   * True when the other product's column reads first. Runtime pages tell a
   * before-and-after story — the engine on its own, then the same engine with
   * DorkOS around it — so their column goes on the left there.
   */
  theirColumnFirst: boolean;
  /** Heading over the reasons to reach for the other product. Each strength finishes this sentence. */
  theirReasonHeading: (name: string) => string;
  /** Heading over the reasons to reach for DorkOS. */
  ourReasonHeading: string;
  /** Heading over the whole recommendation block. */
  recommendationHeading: string;
  /** Hub section heading for this framing. */
  groupLabel: string;
  /** One line under the hub section heading. */
  groupBlurb: string;
}

/**
 * Copy for all four framings. Every framing is populated even where no entry
 * uses it yet, so a later batch adds data only.
 */
export const COMPARISON_FRAMING_COPY: Record<ComparisonFraming, ComparisonFramingCopy> = {
  competitor: {
    headline: (name) => `DorkOS vs ${name}`,
    metaTitle: (name) => `DorkOS vs ${name} — an honest comparison`,
    intro: (name) =>
      `Searching for ${name} vs DorkOS gets you this same page. Here is what each one does well, where they overlap, and how to choose.`,
    tableHeading: 'Side by side',
    theirColumn: (name) => name,
    ourColumn: 'DorkOS',
    theirColumnFirst: false,
    theirReasonHeading: (name) => `Use ${name} if`,
    ourReasonHeading: 'Use DorkOS if',
    recommendationHeading: 'Which one is for you',
    groupLabel: 'Head to head',
    groupBlurb: 'Tools that do a similar job, compared honestly.',
  },
  runtime: {
    headline: (name) => `DorkOS + ${name}`,
    metaTitle: (name) => `DorkOS + ${name} — mission control for ${name}`,
    intro: (name) =>
      `DorkOS runs ${name} for you. Keep the tool you already use, and gain one screen to start, watch and schedule it from.`,
    tableHeading: 'What DorkOS adds on top',
    theirColumn: (name) => `${name} on its own`,
    ourColumn: 'With DorkOS',
    // Before, then after: the engine alone reads first on a runtime page.
    theirColumnFirst: true,
    theirReasonHeading: (name) => `Reach for ${name} when`,
    // Parallel with the heading beside it, and free of a pronoun: the column
    // lists reasons on their own, so "DorkOS adds it when …" had nothing for
    // "it" to point at.
    ourReasonHeading: 'Add DorkOS when',
    recommendationHeading: 'What each part does',
    groupLabel: 'Agent tools DorkOS runs',
    groupBlurb: 'Coding agents DorkOS drives for you. Keep the tool, gain a control room.',
  },
  adjacent: {
    headline: (name) => `DorkOS vs ${name}`,
    metaTitle: (name) => `DorkOS vs ${name} — where they overlap`,
    intro: (name) =>
      `Searching for ${name} vs DorkOS gets you this same page. These are different kinds of tool, so this page sticks to the part they both cover.`,
    scopeNote: (name) =>
      `${name} and DorkOS are not the same kind of product. Below is only the ground they share, not a score of everything either one does.`,
    tableHeading: 'Where the two overlap',
    theirColumn: (name) => name,
    ourColumn: 'DorkOS',
    theirColumnFirst: false,
    theirReasonHeading: (name) => `Use ${name} if`,
    ourReasonHeading: 'Use DorkOS if',
    recommendationHeading: 'Which one is for you',
    groupLabel: 'Nearby tools',
    groupBlurb: 'Different kinds of product that still cover some of the same ground.',
  },
  discontinued: {
    headline: (name) => `${name} alternatives`,
    metaTitle: (name) => `${name} alternatives — what to use now`,
    intro: (name) =>
      `${name} is gone. Here is what happened, what your options are, and what moving to DorkOS would give you.`,
    scopeNote: (name) =>
      `${name} has shut down. The dates and details below come from its own announcement, linked at the bottom of this page.`,
    tableHeading: 'What you get if you move to DorkOS',
    theirColumn: (name) => `${name} (shut down)`,
    ourColumn: 'DorkOS',
    theirColumnFirst: true,
    // Never rendered: a shut-down product gets no recommendation block.
    theirReasonHeading: (name) => `What ${name} used to do`,
    ourReasonHeading: 'What DorkOS does instead',
    recommendationHeading: 'Your options now',
    groupLabel: 'Tools that shut down',
    groupBlurb: 'Where to go next when the tool you used is gone.',
  },
};

/**
 * The axes every comparison is scored on, in table order. Each one names the
 * features that back DorkOS's answer, so the answer can never drift from what
 * the product actually ships.
 */
export const COMPARISON_DIMENSIONS: ComparisonDimension[] = [
  {
    id: 'multi-runtime',
    label: 'Many agent tools, one place',
    featureSlugs: ['multi-runtime-cockpit', 'session-durability'],
    question: 'Can you run more than one company’s coding agent from the same screen?',
    wantPhrase: 'every coding agent you run on one screen, not one company’s',
    dorkosDetail:
      'Each chat picks its own agent tool, so you can start a job on Claude Code, run the next on Codex, and keep a third on OpenCode without leaving the tab or changing any setup. Sessions from all three land in one list, and closing your laptop does not end them.',
  },
  {
    id: 'scheduling',
    label: 'Work that runs on a schedule',
    featureSlugs: ['task-scheduler', 'notifications'],
    question: 'Can you hand over a job that runs at a set time without you sitting there?',
    wantPhrase: 'work that happens while you are asleep or away',
    dorkosDetail:
      'You write the job once and say when it should run: every night, every Monday, every hour. DorkOS starts the agent at that time on your own machine and messages you when it finishes or needs a decision, so you are not the thing that has to remember.',
  },
  {
    id: 'coordination',
    label: 'Agents that work together',
    featureSlugs: ['relay-message-bus', 'rooms', 'mesh-agent-discovery'],
    question: 'Can several agents find each other and pass work along?',
    wantPhrase: 'agents that can hand work to each other instead of working alone',
    dorkosDetail:
      'Agents share rooms the way people share a group chat: they can see each other, answer each other, and pass a job along. This is the newest part of DorkOS and the part we are least willing to oversell, so the table says "partly" until everyday use proves it.',
  },
  {
    id: 'local-first',
    label: 'Runs on your machine',
    featureSlugs: ['cli', 'workspaces', 'tunnel'],
    question: 'Does the tool run on your own computer, with your work staying there?',
    wantPhrase: 'your projects and history to stay on your own computer',
    dorkosNote:
      'DorkOS runs on your own machine: your projects, your sessions and your history stay there, under your own accounts.',
  },
  {
    id: 'surfaces',
    label: 'Where you can use it',
    featureSlugs: ['mobile', 'chat-interface', 'notifications'],
    question: 'Can you check in and approve work away from your desk?',
    wantPhrase: 'to check in and approve work from your phone',
  },
  {
    id: 'extensibility',
    label: 'Adding your own tools',
    featureSlugs: ['marketplace', 'mcp-server', 'connections'],
    question: 'Can you add your own tools and share the setup with other people?',
    wantPhrase: 'to add your own tools and share the setup with other people',
    dorkosDetail:
      'This is the row where a code editor wins on breadth: nothing here replaces years of editor add-ons. What DorkOS adds is the other half — you can package up a working agent, with its instructions and its tools, and hand the whole thing to someone else in one command. Signing those tools in to outside services is the part still finding its feet.',
  },
  {
    id: 'pricing',
    label: 'Price and openness',
    featureSlugs: ['cli'],
    question: 'What does the tool itself cost, and can you read its source code?',
    wantPhrase: 'a free tool whose code you can read',
    dorkosNote: 'Free and open source. You pay only for the model plan your agents already use.',
  },
];

/** Statuses that mean a feature is built but not yet proven by everyday use. */
const UNPROVEN_STATUSES: ReadonlySet<Feature['status']> = new Set(['alpha', 'coming-soon']);

/** Drop a trailing period so a note can be joined to another sentence cleanly. */
function withoutTrailingPeriod(sentence: string): string {
  return sentence.endsWith('.') ? sentence.slice(0, -1) : sentence;
}

/** Resolve a dimension's backing features, failing loudly on a slug that no longer exists. */
function backingFeatures(dimension: ComparisonDimension, catalog: Feature[]): Feature[] {
  if (dimension.featureSlugs.length === 0) {
    throw new Error(`Comparison dimension "${dimension.id}" has no backing features.`);
  }
  return dimension.featureSlugs.map((slug) => {
    const feature = catalog.find((f) => f.slug === slug);
    if (!feature) {
      throw new Error(
        `Comparison dimension "${dimension.id}" points at unknown feature "${slug}".`
      );
    }
    return feature;
  });
}

/**
 * Derive DorkOS's cell for a dimension from the backing features' own status.
 *
 * This is the demo-claim gate in code (`AGENTS.md`): a dimension can only score
 * `yes` when every feature behind it is generally available or in beta. If any
 * backing feature is still alpha or unreleased, the cell drops to `partial` and
 * the note names what is still early. DorkOS cells are never hand-authored, so
 * a comparison page cannot promise more than the feature catalog does.
 *
 * @param dimension - The dimension to score.
 * @param catalog - Feature catalog to score against. Defaults to the real one;
 *   a test passes its own so every lifecycle stage can be exercised, including
 *   stages the shipped catalog happens not to contain today.
 * @returns DorkOS's cell for that dimension.
 */
export function dorkosCellFor(
  dimension: ComparisonDimension,
  catalog: Feature[] = features
): ComparisonCell {
  const backing = backingFeatures(dimension, catalog);
  const base = dimension.dorkosNote ?? backing[0].tagline;
  const unproven = backing.filter((feature) => UNPROVEN_STATUSES.has(feature.status));
  const detail = dimension.dorkosDetail;

  if (unproven.length === 0) {
    return { verdict: 'yes', note: base, ...(detail ? { detail } : {}) };
  }

  const names = unproven.map((feature) => feature.name).join(' and ');
  const verb = unproven.length === 1 ? 'is' : 'are';
  return {
    verdict: 'partial',
    note: `${withoutTrailingPeriod(base)}. ${names} ${verb} still early: built, but not yet proven in everyday use.`,
    ...(detail ? { detail } : {}),
  };
}

/**
 * The dimensions where DorkOS fully delivers and the other product does not —
 * the honest case for DorkOS on a page. Derived from both sides' cells, so it
 * shrinks by itself the moment a rival catches up or a DorkOS feature is still
 * early.
 *
 * @param competitor - The product this page compares against.
 * @returns The dimensions DorkOS wins outright, in table order.
 */
export function dorkosAdvantages(competitor: Competitor): ComparisonDimension[] {
  return COMPARISON_DIMENSIONS.filter((dimension) => {
    if (dorkosCellFor(dimension).verdict !== 'yes') return false;
    return competitor.cells[dimension.id]?.verdict !== 'yes';
  });
}

/**
 * Every product DorkOS is compared against, one page each at `/compare/<slug>`.
 * Only this order matters for the hub; the framing decides the section it lands in.
 */
export const comparisons: Competitor[] = [
  {
    slug: 'cursor',
    name: 'Cursor',
    maker: 'Anysphere',
    homepage: 'https://cursor.com',
    framing: 'competitor',
    category: 'AI code editor',
    oneLiner:
      'Cursor is an AI code editor. DorkOS is the control room for the coding agents you already run. Here is where each one fits, in plain words.',
    pricing:
      'Free Hobby plan. Pro is $20 a month, with higher paid tiers above it and teams at $40 per person. Every plan includes some model use, and going past it costs extra.',
    openSource: false,
    verdict:
      'Cursor is a very good AI code editor, and if you spend your day writing code in one window with an agent helping, it is probably the better buy. DorkOS is not an editor. It is the room you run and watch many coding agents from: Claude Code, Codex and OpenCode, on your own machine, on a schedule, from your phone if you are out. Plenty of people use both, writing in Cursor and letting DorkOS handle the long jobs.',
    theirStrengths: [
      'you want one polished window for writing code and directing an agent',
      'you want several of its own agents running at once, each on its own copy of your project',
      'you lean on VS Code habits: Cursor imports your settings and installs editor extensions',
      'you want the bigger crowd, so answers and shared habits are easy to find',
    ],
    cells: {
      'multi-runtime': {
        verdict: 'no',
        note: 'Cursor runs its own agents inside Cursor. It does not drive Claude Code, Codex or OpenCode for you.',
        detail:
          'Cursor picks the model for its own agents, and that is the whole choice on offer: the agent is part of the editor. If you already run Claude Code in one terminal and Codex in another, Cursor does not gather them up — those stay separate tools you switch between by hand.',
      },
      scheduling: {
        verdict: 'no',
        note: 'There is no built-in way to have a job start at a set time. You kick off every run yourself.',
        detail:
          'Cursor’s cloud agents keep working after you hand them a job, which is not the same as starting one on their own. Nothing in Cursor says "run this every night at two", so a recurring job needs you, awake, to press the button.',
      },
      coordination: {
        verdict: 'partial',
        note: 'Several agents can work side by side, each on its own copy of the project, but they work alone: there is no shared room where they pass work to each other.',
        detail:
          'Cursor 3 added an Agents Window that runs up to eight agents at once, each in its own copy of your project so they do not tread on each other. That is parallel work, not teamwork: no agent can see what another is doing, ask it a question, or hand it the next step.',
        source: 'https://www.deployhq.com/guides/cursor',
      },
      'local-first': {
        verdict: 'partial',
        note: 'The editor runs on your computer, but you sign in to Cursor, and its background agents run on Cursor’s machines rather than yours.',
        source: 'https://www.deployhq.com/guides/cursor',
      },
      surfaces: {
        verdict: 'partial',
        note: 'The desktop app is the way in. Background agents keep working in the cloud while you do something else.',
        source: 'https://www.deployhq.com/guides/cursor',
      },
      extensibility: {
        verdict: 'yes',
        note: 'It imports your VS Code setup and installs editor extensions, and its agent can reach your own tools through MCP, the common way to plug outside tools into an agent.',
        detail:
          'Years of editor extensions carry over, with one caveat worth knowing: Cursor installs them from the Open VSX registry rather than the VS Code Marketplace, so a few will be missing. Its agent also connects to outside tools through MCP, so the things your team already runs are reachable from inside the editor.',
        source: 'https://cursor.com/docs/configuration/extensions',
      },
      pricing: {
        verdict: 'partial',
        note: 'There is a free plan, but the paid plans bill you extra once you pass the model use they include, and the code is closed.',
        source: 'https://cursor.com/pricing',
      },
    },
    faq: [
      {
        q: 'Can I use DorkOS and Cursor at the same time?',
        a: 'Yes. Cursor is where you write code. DorkOS runs and watches agent sessions on the same folders, so you do not have to give either one up.',
      },
      {
        q: 'Does DorkOS replace my code editor?',
        a: 'No. DorkOS has no editor in it. Keep the one you like, and let DorkOS handle running, watching and scheduling the agents.',
      },
      {
        q: 'Which should I pick if I only run one agent at a time?',
        a: 'Cursor. One window, one agent, and the code is right there. DorkOS starts paying off when several agents are running and you want one place to watch them all.',
      },
      {
        q: 'What does DorkOS cost?',
        a: 'Nothing. It is free and open source. You still pay for whatever model plan your agents use, exactly as you do today.',
      },
    ],
    lastVerified: '2026-08-23',
    sources: [
      'https://cursor.com/pricing',
      'https://cursor.com/docs/configuration/extensions',
      'https://cursor.com/docs/context/mcp',
      'https://www.deployhq.com/guides/cursor',
    ],
    relatedFeatures: ['multi-runtime-cockpit', 'task-scheduler', 'mobile', 'rooms'],
  },
  {
    slug: 'claude-code',
    name: 'Claude Code',
    maker: 'Anthropic',
    homepage: 'https://claude.com/claude-code',
    framing: 'runtime',
    category: 'Coding agent for your terminal',
    oneLiner:
      'Claude Code is Anthropic’s coding agent for your terminal. DorkOS runs it for you: many sessions on one screen, on a schedule, from your phone.',
    pricing:
      'Comes with a paid Claude plan rather than being sold on its own. Pro is $20 a month, Max starts at $100, and team seats start at $20 per person. The free Claude tier does not include it.',
    openSource: false,
    verdict:
      'Claude Code is an excellent coding agent, and DorkOS does not try to replace it. DorkOS is the room you run it from: every Claude Code session in one list beside your Codex and OpenCode work, on your own machine, with a screen you can open from your phone. Claude Code already schedules its own work and already runs its own groups of agents, so what DorkOS adds sits a layer above any one company. If Claude Code is the only agent you use, you may not need anything around it yet.',
    theirStrengths: [
      'you want a coding agent that can already split a job across several of its own workers',
      'you want work to run with your laptop closed, which its cloud routines do today',
      'you are already paying for a Claude plan, because Claude Code comes with it',
      'you want a deep set of add-ons: skills, hooks, plugins and outside tool connections',
    ],
    cells: {
      'multi-runtime': {
        verdict: 'no',
        note: 'Claude Code runs Claude sessions. Its own guide is direct about it: to bring another tool in, you connect that tool to Claude rather than run the two side by side.',
        detail:
          'Anthropic gives you plenty of choice inside Claude Code, and none of it is about whose agent does the work: the workers are always Claude sessions. So if your week also involves Codex or OpenCode, those stay separate programs, in separate windows, with separate histories.',
      },
      scheduling: {
        verdict: 'yes',
        note: 'Yes, three ways: routines that run in Anthropic’s cloud with your laptop closed, tasks in the desktop app that run on your own machine, and a repeating loop inside an open session.',
        detail:
          'The cloud option is the strong one, and Anthropic still labels it a research preview. It works from a fresh copy of a project on GitHub rather than the folder on your desk, and it starts at most once an hour. The desktop option does see your local files, but only while the app is open and the computer is awake. Either way the schedule starts Claude Code, which is the honest limit: a nightly job that should run on Codex needs something else.',
        source: 'https://code.claude.com/docs/en/routines',
      },
      coordination: {
        verdict: 'yes',
        note: 'Yes. Helper agents inside one session, a screen for sessions running in the background, and teams whose members message each other and share one task list.',
        detail:
          'This is a real strength, with the caveats Anthropic prints itself: the screen for background sessions is a research preview, and agent teams are experimental and switched off until you turn them on. Every worker is a Claude session, so it is one company’s agents talking to each other.',
        source: 'https://code.claude.com/docs/en/agents',
      },
      'local-first': {
        verdict: 'yes',
        note: 'Yes. It runs on your computer and works on the files already there. You sign in with an Anthropic account, and your code goes to Anthropic’s models to be worked on.',
        source: 'https://code.claude.com/docs/en/desktop-scheduled-tasks',
      },
      surfaces: {
        verdict: 'yes',
        note: 'Yes. Besides the terminal there is a desktop app, a version in the browser, and a phone app you can use to reach a session and answer it.',
        source: 'https://code.claude.com/docs/en/mobile',
      },
      extensibility: {
        verdict: 'yes',
        note: 'Yes, and it is one of the richest sets anywhere: skills, hooks, plugins, helper agents, and connections to the tools your team already runs.',
        detail:
          'Skills, hooks and plugins all began here, and much of the wider ecosystem is built to Claude Code’s shape. Whatever you have already written for it keeps working exactly as it does today.',
        source: 'https://code.claude.com/docs/en/features-overview',
      },
      pricing: {
        verdict: 'no',
        note: 'It comes with a paid Claude plan and the free Claude tier does not include it. Its code is not open: the licence is Anthropic’s own.',
      },
    },
    faq: [
      {
        q: 'Does DorkOS replace Claude Code?',
        a: 'No. DorkOS drives it. Claude Code stays exactly as it is, and DorkOS gives you one place to start it, watch it, and schedule it from.',
      },
      {
        q: 'Can I use my existing Claude subscription?',
        a: 'Yes. DorkOS uses the Claude Code already signed in on your machine, so your plan and your limits are the same as they were yesterday.',
      },
      {
        q: 'Claude Code can already schedule work. Why add DorkOS?',
        a: 'Because its schedules only ever start Claude Code. DorkOS schedules any of the three agents it drives, on your own machine, and messages you when one finishes or gets stuck.',
      },
      {
        q: 'Do I have to give up the terminal?',
        a: 'No. Sessions you start in the terminal show up in DorkOS, and sessions you start in DorkOS are ordinary Claude Code sessions. Use whichever suits the moment.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://claude.com/pricing',
      'https://code.claude.com/docs/en/routines',
      'https://code.claude.com/docs/en/desktop-scheduled-tasks',
      'https://code.claude.com/docs/en/agents',
      'https://code.claude.com/docs/en/mobile',
      'https://code.claude.com/docs/en/features-overview',
    ],
    relatedFeatures: ['multi-runtime-cockpit', 'task-scheduler', 'mobile', 'session-durability'],
  },
  {
    slug: 'codex',
    name: 'Codex',
    maker: 'OpenAI',
    homepage: 'https://openai.com/codex/',
    framing: 'runtime',
    category: 'Coding agent from OpenAI',
    oneLiner:
      'Codex is OpenAI’s coding agent. DorkOS runs it beside Claude Code and OpenCode, so every agent you use shares one screen and one schedule.',
    pricing:
      'Included with ChatGPT plans, starting with the free one. Go is $8 a month, Plus $20, Pro from $100, and Business $20 per person. You can also skip the plan and pay per use with an API key.',
    openSource: true,
    verdict:
      'Codex is a strong coding agent and one of the three engines DorkOS drives. On its own it already schedules work, runs jobs in parallel in the cloud, and reaches you on the web, in Slack and on your phone, so this page is not a list of things it cannot do. What DorkOS adds is the one thing Codex will not do for you: run it beside Claude Code and OpenCode, in a single list, on your own machine. Your ChatGPT plan stays exactly as it is.',
    theirStrengths: [
      'you want a coding agent whose code you can read, because the command-line tool is open source',
      'you want long jobs running in the cloud while your own machine stays free',
      'you already pay for ChatGPT, or you want to start on the free plan',
      'you want to kick off work from Slack, GitHub or your phone without opening a terminal',
    ],
    cells: {
      'multi-runtime': {
        verdict: 'no',
        note: 'Codex runs OpenAI’s own models and its own jobs. It does not start a Claude Code or OpenCode session for you.',
        detail:
          'The choice Codex offers is which OpenAI model does the work, not whose agent does it. If your week already mixes Codex with Claude Code, those stay two programs with two histories, and remembering which job went where is left to you.',
      },
      scheduling: {
        verdict: 'yes',
        note: 'Yes. A job can repeat daily, weekly or on a pattern you write, either in the cloud or in the desktop app against a project on your computer.',
        detail:
          'Cloud runs happen on OpenAI’s machines and cannot open a folder on your computer. Desktop runs can, but they need the computer on and the app running. Either way the schedule starts Codex, so it is not where a job belongs if that job should run on Claude Code.',
        source: 'https://learn.chatgpt.com/docs/automations',
      },
      coordination: {
        verdict: 'partial',
        note: 'Several jobs can run at once, each in its own cloud sandbox, but they work alone: nothing passes a message or a task from one to another.',
        detail:
          'Running jobs in parallel is a genuine advantage when the pieces are independent: each gets its own sandbox, and none of them slows your own machine down. What they cannot do is talk, so a job that needs the answer from another job is still yours to line up by hand.',
        source: 'https://learn.chatgpt.com/docs/cloud',
      },
      'local-first': {
        verdict: 'yes',
        note: 'The command-line tool runs on your machine, on your own files, and its code is open. Cloud jobs are the other half of Codex, and those run on OpenAI’s machines.',
        source: 'https://github.com/openai/codex',
      },
      surfaces: {
        verdict: 'yes',
        note: 'Yes. Codex reaches you in the browser, in the desktop app, from Slack and GitHub, and on an iPhone where you can review changes and approve steps.',
        source: 'https://learn.chatgpt.com/docs/changelog?type=codex-app',
      },
      extensibility: {
        verdict: 'yes',
        note: 'Yes: skills, plugins, hooks, a project instructions file, and connections to outside tools that carry across its apps.',
        detail:
          'The setup follows you between surfaces: the same outside-tool connections work from the command line, the desktop app and the editor extension, so you write them down once.',
        source: 'https://learn.chatgpt.com/docs/extend/mcp',
      },
      pricing: {
        verdict: 'yes',
        note: 'The free ChatGPT plan includes Codex, paid plans start at $8 a month, and the command-line tool is open source under the Apache licence.',
        source: 'https://learn.chatgpt.com/docs/pricing',
      },
    },
    faq: [
      {
        q: 'Does DorkOS replace Codex?',
        a: 'No. DorkOS runs Codex for you. It is the screen around the agent, not another agent.',
      },
      {
        q: 'Do I need a different ChatGPT plan to use Codex through DorkOS?',
        a: 'No. DorkOS uses the Codex already set up on your machine, with whatever plan or key you signed in with.',
      },
      {
        q: 'Codex already runs jobs in the cloud. What does DorkOS add?',
        a: 'Cloud jobs run on OpenAI’s machines and only ever run Codex. DorkOS runs work on your own machine, on your real folders, and the same schedule can start Claude Code or OpenCode instead.',
      },
      {
        q: 'Can I run Codex and Claude Code at the same time?',
        a: 'Yes, and that is the point. Each chat in DorkOS picks its own agent, so a Codex job and a Claude Code job can run side by side in one list.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://learn.chatgpt.com/docs/pricing',
      'https://learn.chatgpt.com/docs/automations',
      'https://learn.chatgpt.com/docs/cloud',
      'https://learn.chatgpt.com/docs/extend/mcp',
      'https://learn.chatgpt.com/docs/changelog',
      'https://github.com/openai/codex',
    ],
    relatedFeatures: ['multi-runtime-cockpit', 'session-durability', 'workspaces', 'notifications'],
  },
  {
    slug: 'opencode',
    name: 'OpenCode',
    maker: 'Anomaly',
    homepage: 'https://opencode.ai',
    framing: 'runtime',
    category: 'Open source coding agent',
    oneLiner:
      'OpenCode is a free, open coding agent that works with any model. DorkOS runs it beside Claude Code and Codex, on one screen you can reach anywhere.',
    pricing:
      'Free, and open source under the MIT licence. You pay only the model provider you point it at, or nothing at all if you run a model on your own machine.',
    openSource: true,
    verdict:
      'OpenCode is free, open source, and works with almost any model, including ones running on your own machine. DorkOS is not an alternative to it. DorkOS adds the parts a terminal tool leaves to you: a set time for a job to start, a screen you can open from your phone, and one list that also holds your Claude Code and Codex sessions. Your keys and your models stay yours.',
    theirStrengths: [
      'you want to choose the model yourself, including one running offline on your own machine',
      'you want a tool with no account and no subscription, under a plain open source licence',
      'you want to read and change the code you are trusting with your projects',
      'you like working in the terminal, or in your editor through its extension',
    ],
    cells: {
      'multi-runtime': {
        verdict: 'no',
        note: 'OpenCode works with more than 75 model providers, which is a different kind of choice: one agent, many models. It does not run Claude Code or Codex for you.',
        detail:
          'If the model is the thing you want to swap, OpenCode is the best of the three at it, local models included. If the agent is the thing you want to swap, that is the gap DorkOS fills: one list holds a Claude Code session, a Codex session and an OpenCode session, and you pick per job.',
        source: 'https://opencode.ai/docs/providers/',
      },
      scheduling: {
        verdict: 'no',
        note: 'There is no built-in scheduler. It can run as a background server, so you could wire it to your computer’s own timer, but that is a job you do rather than a feature it ships.',
      },
      coordination: {
        verdict: 'partial',
        note: 'A main agent can hand a task to a helper agent and get the answer back. That is delegation inside one session, not a group of agents talking to each other.',
        detail:
          'Helper agents are good at keeping a long search or a noisy build out of your main conversation, which is what most people want them for. The relationship is always one agent and its helper inside a single session, so there is no group of equals comparing notes.',
        source: 'https://opencode.ai/docs/agents/',
      },
      'local-first': {
        verdict: 'yes',
        note: 'Yes, and more strictly than most: your own keys, your own choice of model, and it can work fully offline against a model on your own machine.',
        source: 'https://opencode.ai/docs/providers/',
      },
      surfaces: {
        verdict: 'no',
        note: 'OpenCode gives you a terminal, a desktop app and an editor extension. All three sit at your desk: there is no phone app or browser screen to check in from.',
      },
      extensibility: {
        verdict: 'yes',
        note: 'Yes. You can write plugins in JavaScript, connect outside tools, and it loads the right language tooling for your project on its own.',
        detail:
          'A plugin is a plain JavaScript file you drop in a folder, which is a low bar if you would rather bend the tool to your own habits than pick something off a shelf.',
        source: 'https://opencode.ai/docs/plugins/',
      },
      pricing: {
        verdict: 'yes',
        note: 'Free, and open source under the MIT licence. The only bill is whichever model provider you choose, and a local model costs nothing.',
        source: 'https://github.com/anomalyco/opencode',
      },
    },
    faq: [
      {
        q: 'Does DorkOS replace OpenCode?',
        a: 'No. DorkOS runs OpenCode for you and shows you what it is doing. The agent is still OpenCode.',
      },
      {
        q: 'Can I keep my own keys and my own models?',
        a: 'Yes. DorkOS starts the OpenCode already set up on your machine, so whatever provider or local model you chose is the one that does the work.',
      },
      {
        q: 'OpenCode is already free. Why add DorkOS?',
        a: 'For the things a terminal cannot do: start a job at three in the morning, check on it from your phone, and keep it in the same list as your Claude Code and Codex work. DorkOS is free and open source too.',
      },
      {
        q: 'Can I schedule OpenCode with DorkOS?',
        a: 'Yes. You write the job once and say when it should run, and DorkOS starts OpenCode on your own machine at that time and tells you how it went.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://opencode.ai/docs/providers/',
      'https://opencode.ai/docs/agents/',
      'https://opencode.ai/docs/plugins/',
      'https://opencode.ai/docs/server/',
      'https://github.com/anomalyco/opencode',
    ],
    relatedFeatures: ['multi-runtime-cockpit', 'task-scheduler', 'mobile', 'cli'],
  },
];
