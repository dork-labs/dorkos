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
   * Wording for DorkOS's cell where the lead feature's tagline does not answer
   * the question (price, for one, is not a feature). This changes the sentence
   * only: the verdict still comes from the backing features' status, and an
   * unproven feature still forces `partial` and gets named.
   */
  dorkosNote?: string;
}

/** One product's answer on one dimension. */
export interface ComparisonCell {
  /** Whether the product does this. */
  verdict: CapabilityVerdict;
  /** One plain-language sentence saying what it actually does here. */
  note: string;
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
   * Where they beat DorkOS. Required for `competitor` and `adjacent` framings,
   * and always rendered. Each entry finishes the sentence "Use X if …", so it
   * starts lowercase and reads as a reason, not a feature name.
   */
  theirStrengths: string[];
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
  },
  {
    id: 'scheduling',
    label: 'Work that runs on a schedule',
    featureSlugs: ['task-scheduler', 'notifications'],
    question: 'Can you hand over a job that runs at a set time without you sitting there?',
  },
  {
    id: 'coordination',
    label: 'Agents that work together',
    featureSlugs: ['relay-message-bus', 'rooms', 'mesh-agent-discovery'],
    question: 'Can several agents find each other and pass work along?',
  },
  {
    id: 'local-first',
    label: 'Runs on your machine',
    featureSlugs: ['cli', 'workspaces', 'tunnel'],
    question: 'Does the tool run on your own computer, with your work staying there?',
    dorkosNote:
      'DorkOS runs on your own machine: your projects, your sessions and your history stay there, under your own accounts.',
  },
  {
    id: 'surfaces',
    label: 'Where you can use it',
    featureSlugs: ['mobile', 'chat-interface', 'notifications'],
    question: 'Can you check in and approve work away from your desk?',
  },
  {
    id: 'extensibility',
    label: 'Adding your own tools',
    featureSlugs: ['marketplace', 'mcp-server', 'connections'],
    question: 'Can you add your own tools and share the setup with other people?',
  },
  {
    id: 'pricing',
    label: 'Price and openness',
    featureSlugs: ['cli'],
    question: 'What does the tool itself cost, and can you read its source code?',
    dorkosNote: 'Free and open source. You pay only for the model plan your agents already use.',
  },
];

/** Statuses that mean a feature is built but not yet proven by everyday use. */
const UNPROVEN_STATUSES: ReadonlySet<Feature['status']> = new Set(['alpha', 'coming-soon']);

/** Resolve a dimension's backing features, failing loudly on a slug that no longer exists. */
function backingFeatures(dimension: ComparisonDimension): Feature[] {
  if (dimension.featureSlugs.length === 0) {
    throw new Error(`Comparison dimension "${dimension.id}" has no backing features.`);
  }
  return dimension.featureSlugs.map((slug) => {
    const feature = features.find((f) => f.slug === slug);
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
 * @returns DorkOS's cell for that dimension.
 */
export function dorkosCellFor(dimension: ComparisonDimension): ComparisonCell {
  const backing = backingFeatures(dimension);
  const base = dimension.dorkosNote ?? backing[0].tagline;
  const unproven = backing.filter((feature) => UNPROVEN_STATUSES.has(feature.status));

  if (unproven.length === 0) {
    return { verdict: 'yes', note: base };
  }

  const names = unproven.map((feature) => feature.name).join(' and ');
  const verb = unproven.length === 1 ? 'is' : 'are';
  return {
    verdict: 'partial',
    note: `${base}. ${names} ${verb} still early: built, but not yet proven in everyday use.`,
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
      'you lean on VS Code extensions and shortcuts, which Cursor keeps',
      'you want the bigger crowd, so answers and shared habits are easy to find',
    ],
    cells: {
      'multi-runtime': {
        verdict: 'no',
        note: 'Cursor runs its own agents inside Cursor. It does not drive Claude Code, Codex or OpenCode for you.',
      },
      scheduling: {
        verdict: 'no',
        note: 'There is no built-in way to have a job start at a set time. You kick off every run yourself.',
      },
      coordination: {
        verdict: 'partial',
        note: 'Several agents can work side by side, each on its own copy of the project, but they work alone: there is no shared room where they pass work to each other.',
        source: 'https://www.deployhq.com/guides/cursor',
      },
      'local-first': {
        verdict: 'partial',
        note: 'The editor runs on your computer, but it is closed source, signs in to Cursor, and its background agents run on Cursor’s machines.',
        source: 'https://www.deployhq.com/guides/cursor',
      },
      surfaces: {
        verdict: 'partial',
        note: 'The desktop app is the way in. Background agents keep working in the cloud while you do something else.',
        source: 'https://www.deployhq.com/guides/cursor',
      },
      extensibility: {
        verdict: 'yes',
        note: 'It takes the same extensions as VS Code, and its agent can reach your own tools through MCP, the common way to plug outside tools into an agent.',
        source: 'https://www.morphllm.com/comparisons/cursor-vs-vscode',
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
      'https://www.deployhq.com/guides/cursor',
      'https://www.morphllm.com/comparisons/cursor-vs-vscode',
      'https://www.taskade.com/blog/cursor-review',
    ],
    relatedFeatures: ['multi-runtime-cockpit', 'task-scheduler', 'mobile', 'rooms'],
  },
];
