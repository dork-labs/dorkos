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
  /**
   * Replaces the plain open/closed wording where that would overstate things —
   * a product whose command-line tool is open but whose cloud service is not,
   * for one. Written as the whole answer, not an aside.
   */
  openSourceNote?: string;
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
  /**
   * Wording for the link out to the other product, under the verdict. It is a
   * framing decision rather than one sentence for every page: "see it for
   * yourself" invites the reader to go and look, which only works while there is
   * something there to look at. A shut-down product's address leads to whatever
   * the closure left behind, so its pages say that instead.
   */
  outboundLabel: (name: string) => string;
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
    outboundLabel: (name) => `See ${name} for yourself`,
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
    outboundLabel: (name) => `See ${name} for yourself`,
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
    outboundLabel: (name) => `See ${name} for yourself`,
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
      `${name} has shut down. This page covers what it did, where its users went next, and where DorkOS fits. Everything we checked is listed at the bottom.`,
    // Its own address now leads to whatever the closure left behind: a stub page,
    // or a repository marked read-only. Worth a look, but not a look at the product.
    outboundLabel: (name) => `See what is left of ${name}`,
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
      'Each chat picks its own agent tool, so you can start a job on Claude Code, run the next on Codex, and keep a third on OpenCode without leaving the tab or changing any setup. Sessions from all three land in one list, and they keep running for as long as DorkOS does.',
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
      'Nothing here replaces a marketplace of editor add-ons built up over years. What DorkOS adds is the other half — you can package up a working agent, with its instructions and its tools, and hand the whole thing to someone else in one command. Signing those tools in to outside services is the part still finding its feet.',
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
        note: 'Up to eight agents can work side by side, each on its own copy of the project, but each one reports back to you rather than to the others.',
        detail:
          'Cursor runs up to eight agents at once, keeping them apart with separate copies of your project so they do not tread on each other. That is parallel work rather than teamwork: each agent answers in its own context and hands the result back to your conversation, so none of them can ask another a question or pass it the next step.',
        source: 'https://cursor.com/changelog/2-0',
      },
      'local-first': {
        verdict: 'partial',
        note: 'The editor runs on your computer, but you sign in to Cursor, and its cloud agents run on Cursor’s own machines rather than yours.',
        source: 'https://cursor.com/help/ai-features/background-agents',
      },
      surfaces: {
        verdict: 'yes',
        note: 'Yes. Besides the desktop app there is a web dashboard, an iPhone and iPad app, and a Slack integration for starting and checking on its cloud agents.',
        detail:
          'You can start an agent from your phone, watch it work, and review and merge its pull request without opening a laptop. The iPhone and iPad app was still a public beta when we checked, with Android named as planned rather than shipped, and it is deliberately not an editor: it is for directing and reviewing agents, not writing code.',
        source: 'https://cursor.com/docs/cloud-agent/web-and-mobile',
      },
      extensibility: {
        verdict: 'yes',
        note: 'It imports your VS Code setup and installs editor extensions, and its agent can reach your own tools through MCP, the common way to plug outside tools into an agent.',
        detail:
          'Years of editor extensions carry over, with one caveat worth knowing: Cursor installs them from the Open VSX registry rather than the VS Code Marketplace, so a few will be missing. Its agent also connects to outside tools through MCP, so the things your team already runs are reachable from inside the editor.',
        source: 'https://cursor.com/docs/configuration/migrations/vscode',
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
    lastVerified: '2026-08-24',
    sources: [
      'https://cursor.com/pricing',
      'https://cursor.com/changelog/2-0',
      'https://cursor.com/help/ai-features/background-agents',
      'https://cursor.com/docs/cloud-agent/web-and-mobile',
      'https://cursor.com/docs/configuration/migrations/vscode',
      'https://cursor.com/docs/configuration/extensions',
      'https://cursor.com/docs/context/mcp',
    ],
    relatedFeatures: ['multi-runtime-cockpit', 'task-scheduler', 'mobile', 'rooms'],
  },
  {
    slug: 'github-copilot-agent-hq',
    name: 'GitHub Agent HQ',
    maker: 'GitHub',
    homepage: 'https://github.com/features/copilot',
    framing: 'competitor',
    category: 'Agent control centre built into GitHub',
    oneLiner:
      'Agent HQ runs Copilot, Claude and Codex inside your repositories, on GitHub’s computers. DorkOS runs the agents you already pay for, on yours.',
    pricing:
      'A free tier and a $10 Pro plan, neither of which includes the outside agents. Handing work to Claude or Codex starts at $39 a month. Business and enterprise plans are priced separately, and agent work is metered on top.',
    openSource: false,
    verdict:
      'This is the most head-on comparison on the site, and GitHub has built something serious: you can hand one issue to Copilot, to Anthropic’s Claude and to OpenAI’s Codex at once, then compare what three companies’ agents bring back, all inside the repository your team already works in. The catch is where it happens. The work runs on GitHub’s computers, on code that is already on GitHub, and it is billed by the token against your Copilot seat rather than the Claude or ChatGPT plan you already pay for. DorkOS drives the agents already signed in on your own machine, on any folder whether or not GitHub has ever seen it, and adds nothing to your bill. If your work lives in GitHub and your company needs one place to say which agents are allowed, Agent HQ is the better fit.',
    theirStrengths: [
      'your work already lives in GitHub, and agent sessions sit right beside the issues and pull requests you use anyway',
      'you want one issue handed to Copilot, Claude and Codex at the same time so you can compare what each one comes back with',
      'your company needs central control: rules about which agents are allowed, and a record of what they did',
      'you would rather have one bill, on the Copilot seat you already buy, with no other accounts to set up',
      'you want the security checks your repositories already run applied to the agents’ work too',
    ],
    cells: {
      'multi-runtime': {
        verdict: 'yes',
        note: 'Yes. An issue can go to Copilot, to Anthropic’s Claude, to OpenAI’s Codex, or to all three at once. Both outside agents were still marked a preview when we checked.',
        detail:
          'This is real, and it is why this page exists: GitHub will run a rival’s agent for you, which almost nobody else does. Two things are worth knowing. The line-up is shorter than the announcement suggested — Google’s and Cognition’s agents were promised for "the coming months" and are still not there — and these are GitHub’s own hosted versions of Claude and Codex, billed through your Copilot seat. They are not the Claude Code or Codex you already have installed and signed in. DorkOS drives that copy instead, which is why the plan you already pay for is the one doing the work.',
        source:
          'https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents',
      },
      scheduling: {
        verdict: 'yes',
        note: 'Yes. A saved job can repeat every hour, day or week, or start when an issue or pull request is opened. It will not work in a public repository: yours has to be private or internal.',
        detail:
          'The shape of it is a saved job on an hourly, daily or weekly repeat, which covers most of what people want it for. The catch is the one in the table: your repository has to be private or internal, so none of this works on open source. DorkOS takes the time in plain words and runs the job on your own machine, whoever owns the repository, and whether or not there is one.',
        source:
          'https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/create-automations',
      },
      coordination: {
        verdict: 'partial',
        note: 'Several agents can take on the same issue at once, each opening its own pull request to compare. They do not talk to each other, and nothing passes a job from one to the next.',
        detail:
          'Racing three agents at one problem and reading the three answers back is genuinely useful, and a pull request is a sensible place to compare them. It is competition rather than teamwork, though: no agent can ask another a question, or pick up where another one left off.',
        source:
          'https://github.blog/changelog/2026-02-26-claude-and-codex-now-available-for-copilot-business-pro-users/',
      },
      'local-first': {
        verdict: 'no',
        note: 'No. The work runs on GitHub’s computers, on code that is already on GitHub. GitHub does have a separate desktop app that works on local folders, but that is a different program from this one.',
        detail:
          'This is the sharpest difference between the two, and it is not an oversight: living inside GitHub is the whole idea, and it is what makes the review, the permissions and the audit trail come free. The price is that the work has to be on GitHub before any of it can happen. DorkOS starts from a folder — any folder, on any host or none — and runs the agent next to it on the machine in front of you.',
      },
      surfaces: {
        verdict: 'yes',
        note: 'Yes, on more screens than anything else here: the website, a phone app for iPhone and Android, several editors, the command line, and now Slack and Microsoft Teams.',
        source: 'https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent',
      },
      extensibility: {
        verdict: 'yes',
        note: 'Yes, and deeply. Outside tools set up per repository, custom agents written as files in your project, and a shared add-on standard GitHub publishes with other companies.',
        source:
          'https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/create-custom-agents',
      },
      pricing: {
        verdict: 'partial',
        note: 'There is a free tier, but neither it nor the $10 plan includes the outside agents: Claude and Codex need the $39 tier or above. Agent work is metered on top, and the code is closed.',
        source: 'https://github.com/features/copilot/plans',
      },
    },
    faq: [
      {
        q: 'Is Agent HQ free?',
        a: 'Not in any useful sense. The free tier allows a little of Copilot’s own agent work, and the $10 plan does not include the outside agents either. Handing a job to Anthropic’s Claude or OpenAI’s Codex needs the $39 plan or the $100 one, and what the agent does is metered on top of that.',
      },
      {
        q: 'What is GitHub Mission Control?',
        a: 'It is the name GitHub’s blog gave the page where you hand out work and watch the agents doing it. The documentation does not use that name: look for the Agents tab in a repository, or the Agents page. Same thing, two vocabularies.',
      },
      {
        q: 'Which agents can I actually use in Agent HQ today?',
        a: 'Copilot’s own agent, Anthropic’s Claude and OpenAI’s Codex, with the last two still marked a preview. Google’s and Cognition’s agents were named in the announcement but had not arrived when we checked.',
      },
      {
        q: 'Does Agent HQ work with Claude Code?',
        a: 'Not the Claude Code on your machine. It runs GitHub’s hosted version of Anthropic’s agent, billed through your Copilot seat. If what you want is the Claude Code you already installed and signed in, running on your own files, that is what DorkOS drives.',
      },
      {
        q: 'Can it work on a folder that is not on GitHub?',
        a: 'Not this part of it. Agent HQ works on repositories that live on GitHub. GitHub’s separate desktop app can open a local folder, and DorkOS works on any folder on your machine whether or not it has ever been pushed anywhere.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://github.blog/news-insights/company-news/welcome-home-agents/',
      'https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents',
      'https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent',
      'https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent',
      'https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/create-automations',
      'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing',
      'https://github.com/features/copilot/plans',
      'https://github.blog/changelog/2026-01-26-introducing-the-agents-tab-in-your-repository/',
    ],
    relatedFeatures: ['multi-runtime-cockpit', 'workspaces', 'cli', 'task-scheduler'],
  },
  {
    slug: 'devin',
    name: 'Devin',
    maker: 'Cognition',
    homepage: 'https://devin.ai',
    framing: 'competitor',
    category: 'AI software engineer you hire by the month',
    oneLiner:
      'Devin is Cognition’s AI software engineer, working in its own cloud machines. DorkOS runs the agents you already pay for, on your own computer.',
    pricing:
      'A free tier, then $20 a month for Pro and $200 for Max. Teams start at $80 a month with $40 per full seat, and Enterprise is priced by agreement. Heavy use is metered on top.',
    openSource: false,
    verdict:
      'Devin is the most autonomous thing on this list: you hand it a ticket and it works in its own cloud machine, with a terminal, an editor and a browser of its own, checking its work as it goes. That power is rented rather than owned — the work happens on Cognition’s computers, your code goes there to be worked on, and the meter runs on what the agent does. DorkOS makes the opposite trade: the agents run on your machine, under the plans you already pay for, and there is nothing for us to meter. If what you have is a backlog of repetitive tickets and you would rather buy the result than run the machinery, Devin is a serious answer and DorkOS is not trying to be one.',
    theirStrengths: [
      'you want a job done rather than a tool to run, and you are happy for that to be someone else’s computer',
      'you have a backlog of repetitive, similar tickets: migrations, lint sweeps, clean-ups',
      'you want one agent to break a job up, hand the pieces to copies of itself, and put the results back together',
      'you need enterprise paperwork: single sign-on, audit logs, access lists and a private deployment',
    ],
    cells: {
      'multi-runtime': {
        verdict: 'yes',
        note: 'Yes, in its desktop editor, which can run five other coding agents alongside its own: Claude, Codex, OpenCode, Gemini and JetBrains’ Junie. Devin’s cloud sessions still only ever run Devin.',
        detail:
          'This surprised us, and it is worth being exact about. Devin Desktop, the editor Cognition used to sell as Windsurf, can host five other companies’ coding agents through a shared protocol. You install those agents yourself, and Cognition says plainly that its own privacy terms and billing do not cover them: that part is between you and the other company. The cloud Devin everyone means when they say "Devin" runs Devin.',
        source: 'https://docs.devin.ai/desktop/acp',
      },
      scheduling: {
        verdict: 'yes',
        note: 'Yes, and thoroughly. Sessions can run on a repeating schedule, and its automations also start work from a message, a pull request or a webhook, with spending caps attached.',
        detail:
          'This is a strong version of the idea: as well as a plain repeating schedule, work can begin because someone wrote in Slack, because a check failed, or because a ticket changed. Caps on how much a run may spend are part of the setup, which matters when the agent bills by what it does. All of it starts Devin, on Cognition’s machines.',
        source: 'https://docs.devin.ai/product-guides/automations',
      },
      coordination: {
        verdict: 'yes',
        note: 'Yes. One session can act as a manager: it splits the job up, hands pieces to other Devins, watches them, sorts out clashes and puts the results back together.',
        detail:
          'This is genuine coordination rather than parallel lanes, and each worker gets a machine of its own. It is a chain of command rather than a conversation, though: the manager talks to its workers, the workers do not talk to each other, and every one of them is a Devin — one company’s agents, all the way down.',
        source: 'https://docs.devin.ai/work-with-devin/advanced-capabilities',
      },
      'local-first': {
        verdict: 'partial',
        note: 'Partly. There is now a command-line version and a desktop editor that work on your own files, but the Devin people mean by Devin runs in Cognition’s cloud, with your code copied there.',
        detail:
          'Cognition has moved a good way toward your machine: a command-line agent and a desktop editor both work on the files in front of you, and larger customers can have sessions run on their own servers. Even then the thinking happens in Cognition’s cloud, and the local versions do without some of what the cloud one has. DorkOS starts from the other end: everything runs where you already are, and nothing has to leave for the product to work.',
        source: 'https://docs.devin.ai/cli',
      },
      surfaces: {
        verdict: 'yes',
        note: 'Yes. It lives in a browser, in Slack and in Microsoft Teams, so you can hand it work and answer it from a phone. There is no phone app of its own.',
        source: 'https://docs.devin.ai/integrations/slack',
      },
      extensibility: {
        verdict: 'yes',
        note: 'Yes. It connects to outside tools both ways, keeps reusable instructions and playbooks, reads the same skill files other agents read, and has an API.',
        source: 'https://docs.devin.ai/work-with-devin/mcp',
      },
      pricing: {
        verdict: 'partial',
        note: 'There is a free tier and a $20 plan, but real work is metered on top of it, and the code is closed.',
        source: 'https://docs.devin.ai/admin/billing/self-serve',
      },
    },
    faq: [
      {
        q: 'How much does Devin cost?',
        a: 'There is a free tier, Pro at $20 a month and Max at $200. Teams start at $80 a month with $40 for each full seat, and Enterprise is priced by agreement. Those prices buy an allowance; heavy use is metered on top of it, so the bill follows how much work you ask for.',
      },
      {
        q: 'Can Devin run on my own computer?',
        a: 'Partly. There is a command-line version and a desktop editor that work on your local files, and big customers can have sessions run on their own servers. The Devin most people mean still runs in Cognition’s cloud, with your code copied there to be worked on.',
      },
      {
        q: 'Can Devin run Claude Code or Codex?',
        a: 'In its desktop editor, yes: it can host five other agents as well as its own — Claude, Codex, OpenCode, Gemini and JetBrains’ Junie. You install those yourself, and Cognition says its own terms and billing do not cover them. Devin’s cloud sessions run Devin only.',
      },
      {
        q: 'Can Devin work on a schedule?',
        a: 'Yes, and more than that: as well as repeating schedules, work can start from a Slack message, a pull request or a webhook, with a cap on what each run may spend.',
      },
      {
        q: 'Why would I use DorkOS instead?',
        a: 'Because you would rather run the agents than rent them. DorkOS starts the Claude Code, Codex or OpenCode already signed in on your machine, on your own files, with no second bill and nothing metered by us. It is free and open source, and you can read every line of it.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://docs.devin.ai/get-started/devin-intro',
      'https://docs.devin.ai/desktop/acp',
      'https://docs.devin.ai/cli',
      'https://docs.devin.ai/product-guides/automations',
      'https://docs.devin.ai/product-guides/scheduled-sessions',
      'https://docs.devin.ai/work-with-devin/advanced-capabilities',
      'https://docs.devin.ai/work-with-devin/mcp',
      'https://docs.devin.ai/admin/billing/self-serve',
      'https://docs.devin.ai/admin/billing/usage',
      'https://docs.devin.ai/integrations/slack',
    ],
    relatedFeatures: ['multi-runtime-cockpit', 'cli', 'workspaces', 'task-scheduler'],
  },
  {
    slug: 'conductor',
    name: 'Conductor',
    maker: 'Melty Labs',
    homepage: 'https://www.conductor.build',
    framing: 'competitor',
    category: 'Mac app for running coding agents in parallel',
    oneLiner:
      'Conductor runs parallel coding agents on your Mac, with the best review screen of the bunch. DorkOS runs the same work anywhere, on a schedule.',
    pricing:
      'Free for running agents locally on your Mac with your own accounts. Pro is $50 a month and adds their cloud, an API and shared work; Teams are $60 per person.',
    openSource: false,
    verdict:
      'First, the name: this is Melty Labs’ Conductor, the Mac app at conductor.build, and it has nothing to do with Microsoft’s tool of the same name for multi-agent workflows. It is a beautifully made app for running Claude Code, Codex, Cursor and OpenCode side by side, each in its own copy of your project, and three of those four come built in with nothing to install. It has the best reviewing screen of anything on this page: a real diff viewer with comments, and a tab that gathers your build, your pull request and its comments in one place. What it will not do is start work without you, or let you look in from anywhere except that Mac. DorkOS does less about reviewing and more about those two things, and it also runs on Windows and Linux.',
    theirStrengths: [
      'you work on a Mac and want the most polished app of this kind, made by people who clearly care',
      'you want reviewing to be first class: a proper diff viewer, comments on the changes, and your build and pull request in one tab',
      'you want the agents to come with the app: Claude Code, Codex and OpenCode are built in, with nothing extra to install',
      'you are happy to pay so the work keeps going in their cloud after you close the laptop',
    ],
    cells: {
      'multi-runtime': {
        verdict: 'yes',
        note: 'Yes. Claude Code, Codex, Cursor and OpenCode all run in it, and the first three are built into the app rather than installed separately.',
        detail:
          'This used to be a Claude Code app and is not one any more: Codex arrived in late 2025, Cursor and OpenCode in mid 2026. Bundling the agents is a real convenience and a real trade — you get whichever version they ship, rather than the one you have installed and signed in yourself. DorkOS goes the other way and drives the copies already on your machine, so your own accounts and settings are the ones in play.',
        source: 'https://www.conductor.build/docs/reference/harnesses',
      },
      scheduling: {
        verdict: 'no',
        note: 'No. Nothing in it runs on a clock: its scripts fire when you make a workspace or press run, and its API has no way to book work for later.',
        detail:
          'We looked for this carefully, because it is the kind of thing that hides in a changelog. Conductor has a "background tasks" feature, but that only shows you when an agent is waiting on something; and its dispatcher, despite the name, is a box for starting new work rather than anything that runs by itself. Work in Conductor starts when a person starts it.',
      },
      coordination: {
        verdict: 'no',
        note: 'No. Workspaces are deliberately independent, and nothing passes a message or a job from one agent to another.',
      },
      'local-first': {
        verdict: 'yes',
        note: 'Yes, and free that way: workspaces live on your own Mac and use the agent logins already there. Their paid cloud is the opposite arrangement, on their machines.',
        source: 'https://www.conductor.build/pricing',
      },
      surfaces: {
        verdict: 'no',
        note: 'A Mac app, and only that. Their paid cloud keeps agents working after you close the laptop, but the phone app is still listed as coming soon.',
        detail:
          'The cloud tier answers half of this: your agents keep going with the laptop shut. What it does not yet answer is where you watch them from, since the way in is still the Mac app on your desk. A phone app is promised on their pricing page, and until it ships that is a plan rather than a feature.',
      },
      extensibility: {
        verdict: 'yes',
        note: 'Yes. Each agent keeps its own outside-tool setup inside Conductor, there are setup and run scripts you can share with your team, and other agents can drive Conductor itself.',
        source: 'https://www.conductor.build/docs/reference/mcp',
      },
      pricing: {
        verdict: 'partial',
        note: 'Running agents on your own Mac is free. The cloud, the API and shared work cost $50 a month, and the code is closed.',
        source: 'https://www.conductor.build/pricing',
      },
    },
    faq: [
      {
        q: 'Is this the same Conductor as Microsoft’s?',
        a: 'No, and the mix-up is an easy one. Everything on this page is Melty Labs’ Mac app. Microsoft’s Conductor is a way of writing multi-agent workflows down in a file, and a third one, older than both and born at Netflix, runs business processes. Three products, one name, no connection between them.',
      },
      {
        q: 'Is Conductor free?',
        a: 'Running agents on your own Mac is free, using the accounts you already have. Pro is $50 a month and adds their cloud, shared work and an API; team seats are $60 per person.',
      },
      {
        q: 'Does Conductor work with Codex?',
        a: 'Yes, and has since late 2025. It runs Claude Code, Codex, Cursor and OpenCode, and Claude Code, Codex and OpenCode are built into the app so there is nothing to install.',
      },
      {
        q: 'Does Conductor run on Windows?',
        a: 'No. Its own installation page says it is not available for Windows or Linux yet. DorkOS runs on both, though our Windows build is early and we say so on the page.',
      },
      {
        q: 'Can Conductor run a job on a schedule?',
        a: 'No. There is no scheduler anywhere in it, so every job starts because you started it. That is the main thing DorkOS adds if you already like Conductor.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://www.conductor.build/docs',
      'https://www.conductor.build/docs/reference/harnesses',
      'https://www.conductor.build/docs/installation',
      'https://www.conductor.build/docs/concepts/git-worktrees',
      'https://www.conductor.build/docs/reference/scripts',
      'https://www.conductor.build/docs/reference/mcp',
      'https://www.conductor.build/docs/cloud',
      'https://www.conductor.build/pricing',
      'https://www.conductor.build/changelog',
    ],
    relatedFeatures: ['multi-runtime-cockpit', 'task-scheduler', 'mobile', 'workspaces'],
  },
  {
    slug: 'emdash',
    name: 'Emdash',
    maker: 'General Action',
    homepage: 'https://emdash.com',
    framing: 'competitor',
    category: 'Open source desktop app for parallel agents',
    oneLiner:
      'Emdash is an open source desktop app for running many coding agents at once. DorkOS does the same job on your machine, on a screen you can open anywhere.',
    pricing:
      'Free, and open source under the Apache licence. A hosted cloud version and an enterprise version both exist, and neither publishes a price: you ask them.',
    openSource: true,
    openSourceNote:
      'The desktop app is open under the Apache licence. Its cloud and enterprise versions are not published as open source.',
    verdict:
      'Emdash is the closest thing to DorkOS that is also open source, and it is genuinely good: local, free, and built on the same belief that you should be able to run any coding agent you like under your own accounts. Its documentation lists 34 of them, which is a wider roster than DorkOS drives. The two part company after the agents start. Emdash gives each one a clean lane and leaves you as the place they meet; DorkOS puts them in shared rooms and on a screen you can open from your phone, and that room part is the newest thing we ship.',
    theirStrengths: [
      'you want the widest choice of agents: its documentation lists 34 command-line tools it can drive',
      'you want to set up an outside tool once and have every agent you have installed pick it up',
      'you want the same app on Windows or Linux, not only on a Mac',
      'you want a job to run on another machine over SSH, on your own server or in a container',
    ],
    cells: {
      'multi-runtime': {
        verdict: 'yes',
        note: 'Yes, and more widely than DorkOS: its documentation lists 34 command-line agents it can drive, each signed in on your own machine under your own account.',
        detail:
          'Emdash finds the agent tools you already have installed and runs them through their own command-line programs, so the plan you already pay for is the one that does the work. That is the same bet DorkOS makes, made wider. DorkOS drives three agents closely and knows what each session is doing; Emdash drives many and treats them more alike. If the length of the list is what you are choosing on, this is the stronger one.',
        source: 'https://emdash.com/docs/providers',
      },
      scheduling: {
        verdict: 'yes',
        note: 'Yes. Automations start a job on a repeating schedule, and each run is kept with its status, timing and any error, so you can see what happened overnight.',
        detail:
          'This is a real scheduler, not a checkbox: runs are recorded, can be started by hand, and turn into ordinary tasks you can open and review. What its documentation does not describe is what happens when a scheduled job needs a decision from you halfway through. That is the part DorkOS spends most of its care on, because a job that quietly stops at three in the morning is worse than one that never started.',
        source: 'https://emdash.com/docs/automations',
      },
      coordination: {
        verdict: 'no',
        note: 'Each job gets its own branch and workspace and works alone. Nothing in its documentation lets one agent message another or hand work along.',
        detail:
          'This is the one real gap between the two products, and it is narrower than it sounds: parallel lanes are what most people want most days, and Emdash keeps clean ones. If your work divides neatly into separate jobs, you are unlikely to miss what is not here.',
      },
      'local-first': {
        verdict: 'yes',
        note: 'Yes. It runs on your own machine, keeps its records in a file there, needs no Emdash account at all, and its usage reporting switches off with one setting.',
        source: 'https://emdash.com/docs/installation',
      },
      surfaces: {
        verdict: 'no',
        note: 'Desktop only, on macOS, Windows and Linux. It can send the work to another machine over SSH, but there is no phone or browser screen to check in from.',
        detail:
          'This is the clearest split between the two. The Emdash remote feature changes where the work runs; it does not change where you have to be to watch it. DorkOS goes the other way round: the work stays on your own machine and the screen travels, so you can read what an agent did and approve the next step from a phone.',
      },
      extensibility: {
        verdict: 'yes',
        note: 'Yes. One place to set up outside tools for every agent you have installed, with a catalogue of 54 to pick from, plus reusable prompts and skills.',
        detail:
          'Setting an outside tool up once and having every installed agent pick it up is genuinely better than doing it agent by agent, and it is the kind of thing only a tool that drives several agents can offer. What it does not have is a way to wrap an agent up with its instructions and its tools and hand the whole thing to someone else, which is what the DorkOS marketplace is for.',
        source: 'https://emdash.com/docs/library/mcp',
      },
      pricing: {
        verdict: 'yes',
        note: 'The app is free and open source under the Apache licence. The cloud and enterprise versions carry no published price and are sold by talking to them.',
        source: 'https://emdash.com/cloud',
      },
    },
    faq: [
      {
        q: 'Is Emdash free?',
        a: 'The desktop app is free and open source under the Apache licence. There is no pricing page. A hosted cloud version and an enterprise version exist, and both ask you to get in touch rather than showing a price. You still pay for the agent plans you already have.',
      },
      {
        q: 'What agents does Emdash support?',
        a: 'Its documentation lists 34 command-line agents, including Claude Code, Codex, OpenCode, Cursor, Copilot, Cline, Goose and Jules. Its own home page says "25+", so treat the exact number loosely. Each agent has to be installed and signed in on your machine first.',
      },
      {
        q: 'Can Emdash run agents on a schedule?',
        a: 'Yes. Automations start a job on a repeating schedule and keep a record of every run. If scheduling is the only thing you are shopping for, Emdash covers it.',
      },
      {
        q: 'What does DorkOS do that Emdash does not?',
        a: 'Two things. You can reach DorkOS from a phone or a browser, so approving a step does not mean going back to your desk. And DorkOS agents share rooms where they can see and answer each other, rather than each working alone. Emdash has the wider agent list of the two.',
      },
      {
        q: 'Does Emdash work on Windows?',
        a: 'Yes. Every release ships a Windows installer alongside macOS and Linux builds. DorkOS runs on Windows too, though that build is early and we say so.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://emdash.com',
      'https://emdash.com/docs/providers',
      'https://emdash.com/docs/automations',
      'https://emdash.com/docs/tasks',
      'https://emdash.com/docs/installation',
      'https://emdash.com/docs/library/mcp',
      'https://emdash.com/docs/remote-development/remote-tasks',
      'https://emdash.com/cloud',
      'https://github.com/generalaction/emdash',
    ],
    relatedFeatures: ['multi-runtime-cockpit', 'mobile', 'rooms', 'marketplace'],
  },
  {
    slug: 'claude-squad',
    name: 'Claude Squad',
    maker: 'smtg-ai',
    homepage: 'https://github.com/smtg-ai/claude-squad',
    framing: 'competitor',
    category: 'Terminal manager for parallel agents',
    oneLiner:
      'Claude Squad runs several coding agents side by side in your terminal, free. DorkOS does that job in a screen you can open from anywhere, on a schedule.',
    pricing:
      'Free, with no account and nothing to buy. You still pay for whichever agent you point it at, using the plan or the key you already have.',
    openSource: true,
    openSourceNote:
      'Open under the AGPL. You can read and change it freely, and building a paid service on top of it means publishing your changes too.',
    verdict:
      'Claude Squad does one thing and does it very well: every agent gets its own terminal session and its own copy of your project, so several can work at once without treading on each other. It costs nothing, needs no account, and will run whatever terminal agent you name, which makes it the quickest way to try parallel agents at all. What it does not do is anything above that line — no schedule, no way to look in from a phone, no messages between the lanes, and joining the work back up is yours. That upper layer is the whole of what DorkOS is, so if you live in a terminal and only want parallelism, Claude Squad is genuinely enough.',
    theirStrengths: [
      'you live in the terminal and want parallel agents without leaving it',
      'you want no account and no server: one small program and a settings file with five things in it',
      'you want to run any terminal agent at all, including one released this week, by naming its command',
      'you want what it makes to outlive it: plain terminal sessions and plain git branches, still there if you stop using it',
    ],
    cells: {
      'multi-runtime': {
        verdict: 'yes',
        note: 'Yes. It starts whatever terminal command you name, so Claude Code, Codex, Gemini and Aider all work, and a brand new agent works the day it ships.',
        detail:
          'There is no per-agent wiring here, and that is the point: you hand it a command and it runs it. The trade is that Claude Squad cannot know anything about the agent it started, so every lane looks the same to it and the useful details stay inside each session. DorkOS supports fewer agents on purpose and knows what each session is actually doing, which is what lets one list hold them all.',
        source: 'https://github.com/smtg-ai/claude-squad',
      },
      scheduling: {
        verdict: 'no',
        note: 'No. Its background mode answers prompts in sessions you started yourself; nothing here ever starts on a clock.',
        detail:
          'The background mode is easy to mistake for scheduling. What it does is watch sessions you already opened and answer their questions for you, which the maintainers mark experimental and limit to two of the agents. Starting a job at three in the morning is still something you arrange yourself, with your computer’s own timer.',
      },
      coordination: {
        verdict: 'no',
        note: 'No. Each session is its own lane on its own branch. Nothing passes a message from one to another, so you are the part that joins the work back up.',
      },
      'local-first': {
        verdict: 'yes',
        note: 'Yes, completely. One program on your own machine, a small settings file beside it, no account, and no server of its own anywhere.',
        source: 'https://github.com/smtg-ai/claude-squad',
      },
      surfaces: {
        verdict: 'no',
        note: 'Terminal only, on macOS and Linux. There is no phone app and no browser screen, and its own issue tracker reports the Windows build failing as soon as you open a session.',
      },
      extensibility: {
        verdict: 'no',
        note: 'Nothing of its own: no add-ons, no hooks, no outside-tool setup. Whatever your agent already has keeps working, because all it does is start the agent.',
      },
      pricing: {
        verdict: 'yes',
        note: 'Free, and open source under the AGPL. The only bill is the agent you point it at.',
        source: 'https://github.com/smtg-ai/claude-squad/blob/main/LICENSE.md',
      },
    },
    faq: [
      {
        q: 'Is Claude Squad free?',
        a: 'Yes. It is open source under the AGPL, with no account and nothing to buy. You still pay for the agent you run through it, with your own plan or your own key.',
      },
      {
        q: 'Does Claude Squad work on Windows?',
        a: 'Not reliably. A Windows build is published, but the project’s own issue tracker has an open report that it fails as soon as you start a session, and it needs the tmux terminal tool, which is not native to Windows. macOS and Linux are where it works.',
      },
      {
        q: 'Can Claude Squad run agents on a schedule?',
        a: 'No. It has no scheduler. Its background mode only answers prompts in sessions you opened yourself. If you want a job to start on its own at a set time, that is the gap DorkOS fills.',
      },
      {
        q: 'Is Claude Squad still maintained?',
        a: 'Yes, at a gentle pace. When we checked, its latest release was four days old and most fixes were coming from people outside the project rather than a full-time team.',
      },
      {
        q: 'What does DorkOS add over Claude Squad?',
        a: 'A screen you can open from a phone or a browser, jobs that start at a set time and message you when they finish, and one list that knows what each session is doing. Claude Squad is lighter, and if you only want parallel lanes in a terminal it is the smaller, simpler answer.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://github.com/smtg-ai/claude-squad',
      'https://github.com/smtg-ai/claude-squad/blob/main/README.md',
      'https://github.com/smtg-ai/claude-squad/blob/main/LICENSE.md',
      'https://github.com/smtg-ai/claude-squad/releases',
      'https://github.com/smtg-ai/claude-squad/issues/275',
      'https://smtg-ai.github.io/claude-squad/',
    ],
    relatedFeatures: ['multi-runtime-cockpit', 'task-scheduler', 'mobile', 'session-durability'],
  },
  {
    slug: 'omnara',
    name: 'Omnara',
    maker: 'Omnara',
    homepage: 'https://omnara.com',
    framing: 'competitor',
    category: 'Platform for running agents, with a phone app',
    oneLiner:
      'Omnara keeps agents running as a service you reach by API or from your phone. DorkOS runs the agents already installed on your own machine.',
    pricing:
      'Free and open source under the Apache licence if you run it yourself. They also sell a hosted version. Its price is not something we can quote: their pricing page came up blank for us, so ask them rather than trusting a number found elsewhere.',
    openSource: true,
    openSourceNote:
      'The platform is open under the Apache licence and you can run the whole thing yourself. The phone apps and the hosted service are not published.',
    verdict:
      'Omnara has changed shape, and that matters more than any row in the table below. It began as a phone command centre for Claude Code and Codex, and those apps still ship: an iPhone app with an Apple Watch app beside it, which is more than DorkOS has. What Omnara leads with now is something else, a platform for running agents as a lasting service, with an API, organisations, roles, and machines it can borrow or rent. The real difference is where an agent lives. In Omnara it lives in a control plane and picks up a machine when it needs one, which is exactly why a closed laptop cannot hurt it. In DorkOS the agent is the Claude Code already signed in on your own computer, and it is the screen that travels instead.',
    theirStrengths: [
      'you want an agent that survives a closed laptop, a dropped connection or a restart, because its whole history lives in a database rather than in a running program',
      'you are putting agents inside your own product, and want an API and a code library rather than a screen',
      'you need teams: organisations, projects, roles, and access to secrets and machines handed out one grant at a time',
      'you want a real phone app, with an Apple Watch app beside it',
      'you want the work to run wherever suits: your own laptop, a server of yours, or a sandbox made on demand',
    ],
    cells: {
      'multi-runtime': {
        verdict: 'partial',
        note: 'Its phone app watches and steers Claude Code and Codex running on your own laptop. The platform they now lead with is about swapping models rather than agents, and its documentation mentions neither one.',
        detail:
          'This is where Omnara overlaps DorkOS most, and it is also the part that has gone quiet. The app in the store is still called Claude & Codex Mobile and still does what the name says, but it was last updated in April, and the platform Omnara writes about today does not mention either agent. Read plainly: Omnara now runs agents you build, and DorkOS runs the agents you already installed.',
        source: 'https://apps.apple.com/us/app/omnara-claude-codex-mobile/id6748426727',
      },
      scheduling: {
        verdict: 'yes',
        note: 'Yes. A trigger fires on an ordinary five-field cron line, in a time zone you name, and can either start a fresh agent or nudge a running one each time it goes off.',
        source:
          'https://docs.omnara.com/api-reference/endpoints/configs-and-profiles/create-cron-trigger',
      },
      coordination: {
        verdict: 'no',
        note: 'Agents run as separate conversations. Their built-in tools can message a person in Slack, but nothing lets one agent message another or hand work along.',
      },
      'local-first': {
        verdict: 'partial',
        note: 'The work can run on your own laptop, through a small program that dials out so nothing has to be opened up to the internet. The agent itself lives in a control plane: theirs, or one you run.',
        detail:
          'This is a genuinely good arrangement, and worth understanding before choosing between them. Your machine keeps no open door: the small program calls out, and an agent attaches to the machine and lets go of it again afterwards. The price is that the thinking and the history are not on your machine. Their own documentation puts it well, saying the machine does not own the agent, which is what makes a closed laptop harmless and also why DorkOS made the opposite choice.',
        source: 'https://docs.omnara.com/machines/overview',
      },
      surfaces: {
        verdict: 'yes',
        note: 'Yes, and it is their strongest side: an iPhone app with an Apple Watch app, an Android app, a web console, and Slack.',
        detail:
          'DorkOS has no app in either store. What it has is a screen built to work properly on a phone. Omnara ships real apps, and a watch app on top of them, which is more. The caveat is age: the iPhone app was last updated in April, and mobile has dropped out of the writing about the platform, so the best thing about Omnara may be the part it is no longer building on.',
        source: 'https://apps.apple.com/us/app/omnara-claude-codex-mobile/id6748426727',
      },
      extensibility: {
        verdict: 'yes',
        note: 'Yes. Outside tools connect with the sign-in handled for you, skills are shared out one grant at a time, and there is a large API with a code library beside it.',
        source: 'https://docs.omnara.com/tools/mcp',
      },
      pricing: {
        verdict: 'yes',
        note: 'The platform is free and open source under the Apache licence, and you can run all of it yourself. The hosted version has a price we could not read.',
        source: 'https://github.com/omnara-ai/omnara',
      },
    },
    faq: [
      {
        q: 'Is Omnara free?',
        a: 'The platform is, under the Apache licence, and you can run the whole thing on your own machines. They also sell a hosted version. We cannot tell you what that costs: their pricing page came up blank when we checked, so ask them rather than trusting a number you read somewhere else.',
      },
      {
        q: 'Does Omnara work with Claude Code?',
        a: 'Through its phone app, yes: it watches and steers Claude Code and Codex running on your own laptop. That app was last updated in April. The platform Omnara writes about today is about models rather than other companies’ agents, and mentions neither.',
      },
      {
        q: 'Does Omnara have an iPhone app?',
        a: 'Yes, with an Apple Watch app beside it, and an Android app as well. That is more than DorkOS ships: we have no app in either store, only a screen built to work properly on a phone.',
      },
      {
        q: 'Can Omnara run agents on a schedule?',
        a: 'Yes. A trigger takes an ordinary cron line and a time zone, and starts a fresh agent every time it goes off.',
      },
      {
        q: 'What does DorkOS do differently?',
        a: 'It runs the agents already on your computer, signed in to the plans you already pay for, and keeps the work there. Omnara runs agents you build, in a control plane, on machines it borrows or rents. Which is better depends on whether you are operating agents or shipping them.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://github.com/omnara-ai/omnara',
      'https://docs.omnara.com/introduction',
      'https://docs.omnara.com/machines/overview',
      'https://docs.omnara.com/agents/overview',
      'https://docs.omnara.com/tools/built-in',
      'https://docs.omnara.com/tools/mcp',
      'https://docs.omnara.com/api-reference/endpoints/configs-and-profiles/create-cron-trigger',
      'https://apps.apple.com/us/app/omnara-claude-codex-mobile/id6748426727',
    ],
    relatedFeatures: ['multi-runtime-cockpit', 'mobile', 'task-scheduler', 'session-durability'],
  },
  {
    slug: 'amp',
    name: 'Amp',
    maker: 'Amp Frontier',
    homepage: 'https://ampcode.com',
    framing: 'competitor',
    category: 'Coding agent that picks the model for you',
    oneLiner:
      'Amp chooses the model for you and runs the work on its own machines. DorkOS drives the agents already signed in on yours, for nothing.',
    pricing:
      'No free plan. Megawatt is $20 a month and Gigawatt $200, and each includes that much agent use before you pay what the model makers charge. Students and teachers pay $10.',
    openSource: false,
    openSourceNote:
      'Amp itself is closed. The pieces around it are open: its Neovim plugin, its Homebrew tap, and the shared collections of skills and tools published beside it.',
    verdict:
      'One thing first, because older write-ups get it wrong: Amp spun out of Sourcegraph into its own company at the end of 2025, so it is no longer Sourcegraph’s agent. What it sells is an unusual bargain, which is that you stop choosing. Amp picks between the frontier models for you, decides how hard to think about a problem, and charges no mark-up on what those models cost. On privacy it is more careful than most, saying plainly that it does not train on your data unless you switch that on, and that on its company plan it can never be switched on at all. Two things separate it from DorkOS. It runs its own agent only, so Claude Code and Codex stay outside it. And it is built around its own servers: you sign in, your history lives there, and its remote machines do the heavy work. If you want the model chosen for you and the work off your laptop, that is a fair offer at a fair price.',
    theirStrengths: [
      'you would rather not choose a model: Amp picks between the frontier ones for you, and adds no mark-up to what they cost',
      'you care where your code goes: Amp says it does not train on your data unless you turn that on, and on its company plan it can never be turned on',
      'you want long jobs off your own laptop, on machines they run, with hours included in the price',
      'you want to reach an agent from Slack, or by talking to it out loud',
      'you want to hand a colleague the whole transcript of a piece of work as a link',
    ],
    cells: {
      'multi-runtime': {
        verdict: 'no',
        note: 'Amp runs its own agent and picks between several companies’ models for you. It does not start Claude Code, Codex or OpenCode.',
        detail:
          'The choice on offer is which model thinks, not whose agent works, and Amp would rather make that choice than hand it to you. You can point your own ChatGPT subscription at it for extra allowance, which is an arrangement about billing rather than one agent running another. If your week already mixes Claude Code and Codex, those stay separate programs with separate histories.',
      },
      scheduling: {
        verdict: 'yes',
        note: 'Yes, in an unusual shape: the agent sets its own schedule and wakes itself up later, carrying on with the context it already had.',
        detail:
          'Most schedulers start a job from nothing at a set time. Amp’s agent instead arranges to be woken, and comes back knowing what it was in the middle of, which suits keeping an eye on something more than running a nightly chore. Because its remote machines do the work, none of it needs your laptop open. What we did not find is a plain place to write "every night at two" yourself.',
        source: 'https://ampcode.com/manual',
      },
      coordination: {
        verdict: 'partial',
        note: 'It starts its own helper agents inside a piece of work, and can ask a stronger model for a second opinion. Sharing a thread is for people, not agents: nothing hands work from one agent to another.',
        source: 'https://ampcode.com/manual',
      },
      'local-first': {
        verdict: 'partial',
        note: 'The command-line tool runs on your machine, but you sign in to Amp, your threads are kept on their servers, and its remote machines run work somewhere else entirely.',
        source: 'https://ampcode.com/security',
      },
      surfaces: {
        verdict: 'yes',
        note: 'Yes: the terminal, the web, the web on your phone, Slack, and a voice mode you can hold a conversation with. There is no separate phone app to install.',
        source: 'https://ampcode.com/news/agents-everywhere',
      },
      extensibility: {
        verdict: 'yes',
        note: 'Yes. Outside tools connect both on your machine and over the web, there is a plugin system for adding tools, commands and skills, and a kit for building Amp into your own programs.',
        source: 'https://ampcode.com/manual',
      },
      pricing: {
        verdict: 'no',
        note: 'There is no free plan on their pricing page: the cheapest is $20 a month, students and teachers pay $10, and the code is closed.',
      },
    },
    faq: [
      {
        q: 'Is Amp free?',
        a: 'Not today. Their pricing page has no free plan: Megawatt is $20 a month and Gigawatt is $200, and students and teachers can get it for $10. There was a free allowance in the past, paid for by ads for a while, and it has been cut back since. We would not count on it.',
      },
      {
        q: 'Is Amp still part of Sourcegraph?',
        a: 'No. Amp spun out of Sourcegraph into its own company at the end of 2025. Write-ups calling it Sourcegraph’s agent are out of date, though the old name still turns up in a few corners.',
      },
      {
        q: 'Does Amp train on my code?',
        a: 'Their security page says neither Amp nor the companies behind it train on your data unless you explicitly turn that on, and that on the company plan it can never be turned on. That plan also shortens how long the model makers keep anything you send.',
      },
      {
        q: 'How much does Amp cost?',
        a: 'Megawatt is $20 a month, Gigawatt is $200, and each includes that much agent use. Past it you pay what the model makers charge, with nothing added on top unless you are a company customer. There is also a pay-as-you-go arrangement where you bring your own keys.',
      },
      {
        q: 'Why would I use DorkOS instead?',
        a: 'Because you want the agents you already have, on the machine in front of you. DorkOS starts the Claude Code, Codex or OpenCode already signed in, keeps the work local, and costs nothing. Amp is the other bargain: one agent, models chosen for you, their servers.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://ampcode.com/manual',
      'https://ampcode.com/manual/sdk',
      'https://ampcode.com/pricing',
      'https://ampcode.com/security',
      'https://ampcode.com/news/agents-everywhere',
      'https://ampcode.com/news/amp-frontier-corporation',
      'https://github.com/ampcode',
    ],
    relatedFeatures: ['multi-runtime-cockpit', 'task-scheduler', 'cli', 'workspaces'],
  },
  {
    slug: 'cline',
    name: 'Cline',
    maker: 'Cline Bot',
    homepage: 'https://cline.bot',
    framing: 'competitor',
    category: 'Open source coding agent for your editor and terminal',
    oneLiner:
      'Cline is a free, open coding agent for your editor and terminal. DorkOS is the room around the agents you already installed, reachable anywhere.',
    pricing:
      'The agent is free and open source. You pay only for the models: your own key, credits bought from Cline, or an optional pass at $9.99 a month for a set of open models. Company plans are priced by agreement.',
    openSource: true,
    openSourceNote:
      'The agent, its command-line tool and its developer kit are open under the Apache licence. The account that sells model credits is a paid service, and its code is not published.',
    verdict:
      'Cline is the strongest free answer on this page. The agent is open under the Apache licence, works with your own key and no account at all, and reaches more models than anything else here, including ones running offline on your own machine. It also does two things people assume only a cockpit does: jobs that start on a cron line and keep running with no terminal open, and agent teams where a lead hands pieces to specialists who share a task board and a mailbox. That last one is ahead of where DorkOS is, and we would rather say so than hide it. What differs is shape. Cline is one agent living in your editor; DorkOS is the room around the agents you already installed, on a screen you can open from a phone. If you work in one editor and want one very good open agent, Cline is an easy recommendation.',
    theirStrengths: [
      'you want a free, open agent that works with your own key and no account at all',
      'you want the widest choice of models, from the big providers down to one running offline on your own machine',
      'you want the agent inside the editor you already use, or in Zed, Neovim or Emacs through a shared protocol',
      'you want agents that already work as a team, with a lead, a shared task board and a mailbox',
      'you want jobs that start on a cron line without paying anyone for the privilege',
      'you want to build an agent into your own product, on the same kit they build on',
    ],
    cells: {
      'multi-runtime': {
        verdict: 'no',
        note: 'Cline is one agent that works with a very long list of models, local ones included. It does not run Claude Code, Codex or OpenCode as agents.',
        detail:
          'One thing here looks like an exception and is not. Cline can sign in through the Claude command-line tool you already installed, so your Claude subscription pays for the work instead of an API bill. That is a way of paying, not a way of running Claude Code: Cline is still the agent doing the thinking. DorkOS starts the real thing and shows you everything it did.',
      },
      scheduling: {
        verdict: 'yes',
        note: 'Yes. A saved job takes an ordinary cron line, keeps running across restarts, and needs no terminal open. It works from the command line and the kit, not from the editor add-ons.',
        source: 'https://docs.cline.bot/cli/scheduling',
      },
      coordination: {
        verdict: 'yes',
        note: 'Yes, and further than most. One agent leads and hands pieces to specialists, who share a task board and a mailbox they leave messages in, and the team survives being closed and reopened.',
        detail:
          'This is a place where Cline is ahead of us on paper, and it would be silly to pretend otherwise. What DorkOS is building is a different arrangement, rooms that hold people and agents together rather than a lead and its workers, and it is the newest thing we ship, marked partly done in every table on this site. Cline’s teams carry the same limit as its scheduler: the command line and the kit have them, the editor add-ons do not.',
        source: 'https://docs.cline.bot/cli/agent-teams',
      },
      'local-first': {
        verdict: 'yes',
        note: 'Yes. It runs in the editor or terminal in front of you, and with your own key it needs no Cline account at all. Usage reporting is on until you switch it off.',
        source: 'https://cline.bot/faq',
      },
      surfaces: {
        verdict: 'no',
        note: 'Your editor, your terminal, and a task board that runs on your own machine. There is no phone app, and no screen of theirs to sign in to.',
        detail:
          'The board can be reached from a phone if you open it up to your network yourself, and their documentation is careful about what that means: whoever reaches it has your project and your terminal. That is the honest version of working from a phone. Doing that part safely is most of why DorkOS exists.',
      },
      extensibility: {
        verdict: 'yes',
        note: 'Yes, and it is a strong suit: a catalogue of outside tools you install in one click, project rules read from several files including the shared AGENTS.md, and a kit for building Cline into your own product.',
        source: 'https://cline.bot/mcp-marketplace',
      },
      pricing: {
        verdict: 'yes',
        note: 'Free, and open source under the Apache licence. You pay only for the models: your own key, credits from Cline, or an optional $9.99 a month pass.',
        source: 'https://cline.bot/pricing',
      },
    },
    faq: [
      {
        q: 'Is Cline free?',
        a: 'The agent is, openly so, under the Apache licence. You pay only for the models you use: your own key, credits bought from Cline, or an optional pass at $9.99 a month for a set of open models. Their pricing page has just two entries, the free open source one and a company plan priced by agreement.',
      },
      {
        q: 'Can Cline run jobs on a schedule?',
        a: 'Yes. You save a job with an ordinary cron line and it keeps running across restarts with no terminal open. One catch worth knowing: it works from the command line and the developer kit, not from the VS Code or JetBrains add-ons.',
      },
      {
        q: 'Does Cline work with Claude Code?',
        a: 'Not as an agent. It can sign in through the Claude command-line tool so that your Claude subscription pays for the work, but Cline is still the one doing it. If you want the actual Claude Code session, with everything it did in front of you, that is what DorkOS runs.',
      },
      {
        q: 'Can several Cline agents work together?',
        a: 'Yes. A lead agent hands pieces to specialists, and they share a task board and a mailbox. It is the strongest teamwork on this page, ours included: DorkOS rooms are newer, and we mark them partly done.',
      },
      {
        q: 'What does DorkOS add over Cline?',
        a: 'A screen you can open from a phone without exposing anything yourself, and one list holding Claude Code, Codex and OpenCode sessions side by side. Cline is one agent with a great many models; DorkOS is the room around the agents you already installed.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://cline.bot',
      'https://cline.bot/pricing',
      'https://cline.bot/faq',
      'https://cline.bot/mcp-marketplace',
      'https://docs.cline.bot/usage/cli-overview',
      'https://docs.cline.bot/cli/scheduling',
      'https://docs.cline.bot/cli/agent-teams',
      'https://docs.cline.bot/usage/acp',
      'https://docs.cline.bot/provider-config/anthropic',
      'https://cline.bot/cline-pass',
      'https://github.com/cline/cline',
    ],
    relatedFeatures: ['multi-runtime-cockpit', 'mobile', 'rooms', 'task-scheduler'],
  },
  {
    slug: 'factory-droid',
    name: 'Droid',
    maker: 'Factory',
    homepage: 'https://factory.ai',
    framing: 'competitor',
    category: 'Coding agent built for company teams',
    oneLiner:
      'Droid is Factory’s coding agent for company teams, with missions that plan big work. DorkOS runs the agents you already pay for, on your machine.',
    pricing:
      'No free plan. Pro is $20 a month, Plus $100 and Max $200, each allowing more work than the last. Team and company plans are priced by agreement.',
    openSource: false,
    verdict:
      'First the name, because it trips people up: the company is Factory and the agent is Droid, which is also what you type. Droid is aimed squarely at companies, and that shows in the good sense: single sign-on, audit trails, data kept in your part of the world, even an install with no way out to the internet. It reaches models from four companies plus a set of open ones, starts work on a cron line or from a Slack message, and its missions plan a large job into milestones and hand the pieces to worker sessions that check each other as they go. It is also closed, starts at $20 a month with no free plan, and like everything else on this page it runs its own agent rather than yours. DorkOS is the smaller, opposite bet: free, open, on your own machine, driving the agents you already signed in to.',
    theirStrengths: [
      'you work somewhere that needs the paperwork: single sign-on, audit trails, data kept in your part of the world, even an install with no way out to the internet',
      'you want one subscription reaching models from four companies plus a set of open ones, switchable in the middle of a job',
      'you want work to start on a clock, from a Slack message, or from something happening on GitHub',
      'you want a large job planned into milestones and carried out by workers whose output gets checked',
      'you want an agent that reads the CLAUDE.md and the skills you already wrote',
      'you want machines that keep their state between sessions, so nothing has to be set up twice',
    ],
    cells: {
      'multi-runtime': {
        verdict: 'no',
        note: 'Droid is one agent you can point at models from Anthropic, OpenAI, Google and xAI, plus a set of open ones. It does not start Claude Code, Codex or OpenCode.',
        detail:
          'Swapping the model in the middle of a job is genuinely useful, and their list is one of the longest anywhere. It is still a different thing from swapping the agent, and nothing in their documentation runs another company’s coding agent. Droid is unusually polite about what you already wrote, though: it reads a CLAUDE.md as happily as an AGENTS.md, so bringing your instructions across costs nothing.',
      },
      scheduling: {
        verdict: 'yes',
        note: 'Yes. A saved job runs on a cron line or a cadence written in plain words, and work can also start from a Slack message or from something happening on GitHub.',
        source: 'https://docs.factory.ai/software-factory/automations',
      },
      coordination: {
        verdict: 'yes',
        note: 'Yes. A mission plans a large job, starts worker sessions for the parts, passes work between them through git, and checks each step before going on.',
        detail:
          'This is real orchestration rather than parallel lanes, and Factory is refreshingly honest about its limits. Their own writing says doing things in order, with parallel work only where coordinating is cheap, has beaten running everything at once, and lists whether parallelism helps at all as a question they are still testing. Worth remembering whenever anyone, ourselves included, sells you a picture of ten agents working at once.',
        source: 'https://docs.factory.ai/docs/missions/overview',
      },
      'local-first': {
        verdict: 'partial',
        note: 'The command-line agent runs on your machine, and your own model keys stay there. An account is still required, and its lasting machines and hosted screens are theirs.',
        detail:
          'One catch if you bring your own model keys: their documentation says custom models work in the command-line tool and the desktop app, and do not appear on the hosted web and phone surfaces. So the widest reach and the most control are, for now, two different setups.',
        source: 'https://docs.factory.ai/cli/byok/overview',
      },
      surfaces: {
        verdict: 'yes',
        note: 'Yes, widely: the terminal, a desktop app, the web, VS Code and JetBrains and Zed, Slack and Teams, Linear and Jira, and a phone screen for reviewing work.',
        source: 'https://docs.factory.ai/factory-app/overview',
      },
      extensibility: {
        verdict: 'yes',
        note: 'Yes, and shaped like the tools you already know: outside tools, hooks on the agent’s lifecycle, custom droids written as plain Markdown, and a project file it reads as either AGENTS.md or CLAUDE.md.',
        source: 'https://docs.factory.ai/docs/harness/hooks',
      },
      pricing: {
        verdict: 'no',
        note: 'There is no free plan: the cheapest is $20 a month, and the code is closed.',
      },
    },
    faq: [
      {
        q: 'Is Droid free?',
        a: 'No. There is no free plan. Pro is $20 a month, Plus is $100 and Max is $200, and team and company plans are priced by agreement. You can bring your own model keys, and every individual plan allows some of that before it starts counting.',
      },
      {
        q: 'What is a Factory mission?',
        a: 'A way of handing over a large piece of work. You agree the plan first, broken into features and milestones, and Droid then starts worker sessions for the parts, passes work between them through git, and checks each step before moving on.',
      },
      {
        q: 'Does Droid run Claude Code?',
        a: 'No. Droid is its own agent, though it will happily read the CLAUDE.md you already wrote. If what you want is the Claude Code on your own machine, signed in to your own plan, that is what DorkOS drives.',
      },
      {
        q: 'Can Droid work on a schedule or in a build pipeline?',
        a: 'Both. Jobs run on a cron line or a cadence written in plain words, and there is a headless mode made for build pipelines that reports success or failure the way scripts expect.',
      },
      {
        q: 'Why would I use DorkOS instead?',
        a: 'Price, openness, and whose machine it is. DorkOS is free and open source, runs the agents already signed in on your computer, and adds nothing to your bill. Droid is the better answer if you need company controls and are happy to pay for them.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://factory.ai/pricing',
      'https://docs.factory.ai/pricing',
      'https://docs.factory.ai/docs/models',
      'https://docs.factory.ai/docs/missions/overview',
      'https://docs.factory.ai/software-factory/automations',
      'https://docs.factory.ai/cli/byok/overview',
      'https://docs.factory.ai/factory-app/overview',
      'https://docs.factory.ai/integrations/ide-integrations',
      'https://docs.factory.ai/docs/harness/hooks',
    ],
    relatedFeatures: ['multi-runtime-cockpit', 'task-scheduler', 'workspaces', 'cli'],
  },
  {
    slug: 'deepseek-harness',
    name: 'DeepSeek Harness',
    maker: 'DeepSeek',
    homepage: 'https://deepseek.com/harness',
    framing: 'competitor',
    category: 'Agent harness that can run other agents',
    oneLiner:
      'DeepSeek Harness can run Claude Code and Codex inside itself, and calls itself a developer preview. DorkOS does that job with a schedule and a phone.',
    pricing:
      'Free, and open source under the MIT licence. You pay only the model provider whose key you bring. It asks for a DeepSeek key first, and takes others instead.',
    openSource: true,
    verdict:
      'This is the closest thing we have found to what DorkOS is trying to be, and pretending otherwise would be silly. DeepSeek Harness sits above other coding agents and runs them: install a plugin and it will start a real Claude Code, through Anthropic’s own kit, or a real Codex, as workers inside its own session. Underneath, almost every part of it is a named piece you can swap out, written down in a way that will delight anyone who reads the source before trusting a tool. Two honest things follow. It is very new and says so in capital letters, its own words being that there will be compatibility-breaking changes, and every version on its releases page so far is a release candidate. And it is a harness rather than a control room, with nothing that runs while the session is closed, nothing for a phone, and a local web page as the way in. DorkOS is pointed at that second half of the problem, and we would rather you knew both existed.',
    theirStrengths: [
      'you want to read the design before you trust it: nearly every part is a named, swappable piece, listed in documentation generated from the code itself',
      'you want to replace those parts yourself, down to the model adapter, the session log and the loop the agent runs in',
      'you want Claude Code and Codex started through their makers’ own kits, rather than something pretending to type at them',
      'you are happy on a developer preview, and would rather have the newest ideas than a settled product',
      'you want one command, a local address, no account, and the MIT licence',
    ],
    cells: {
      'multi-runtime': {
        verdict: 'yes',
        note: 'Yes, and it is the point of the thing: plugins start a real Claude Code, through Anthropic’s own kit, or a real Codex, as workers inside a session. Both are optional, and off until you switch them on.',
        detail:
          'The details matter here, because this is the row where someone else matches us. Claude Code and Codex are separate plugins you install and then switch on in a preset, and the list is those two, anything speaking the shared agent protocol, and a second harness of its own run as a child. Each run is one-shot: a fresh process, no carrying a session on, no way for the child to stop and ask you a question, and only its final text comes back, so the reasoning and the tool calls stay inside. DorkOS drives three agents as first-class citizens, with the whole session visible, steerable mid-turn and resumable. Different depth, same good instinct.',
        source:
          'https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/README.md',
      },
      scheduling: {
        verdict: 'partial',
        note: 'Reminders inside a session that is still open: after so long, at a set time, or every so often with a five-minute floor. There are no cron lines, and nothing fires once the session is closed.',
        detail:
          'Their documentation is admirably exact about this, and worth repeating in their own terms: a reminder never leaves the session that owns it, and a closed session does no work at all. Reopening one makes anything overdue arrive late. It is a way for an agent to check back on something it is already watching, not a way to have a job run at three in the morning while you sleep.',
        source:
          'https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/schedule.md',
      },
      coordination: {
        verdict: 'partial',
        note: 'A lead session can start teammates, leave lasting messages in a shared mailbox, and track a shared list of tasks. It is a lead and its children rather than a room, and their own documentation calls it experimental.',
        source:
          'https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/agent-team.md',
      },
      'local-first': {
        verdict: 'yes',
        note: 'Yes, thoroughly. One command runs it on your own machine at a local address, its settings and keys are plain files in your home folder, and the history stays there too.',
        source: 'https://github.com/deepseek-ai/deepseek-harness',
      },
      surfaces: {
        verdict: 'no',
        note: 'A web page on your own machine, and a command line. Nothing for a phone, and reaching it from anywhere else means forwarding the port over SSH yourself.',
      },
      extensibility: {
        verdict: 'yes',
        note: 'Yes, and it is the whole idea: around sixty named parts you can replace, the model adapter and the session log and the agent loop among them, plus outside tools and skills.',
        detail:
          'This is the most impressive thing about the project. The list of swappable parts is generated from the code itself, so it cannot quietly drift from what is really there, and each entry says which part owns it and which parts use it. If you are the sort of person who reads the architecture before installing anything, start there. One limit worth knowing: it connects out to other people’s tools, and does not offer itself to other programs as one.',
        source:
          'https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/capability-seams.md',
      },
      pricing: {
        verdict: 'yes',
        note: 'Free, and open source under the MIT licence. The only bill is the model provider whose key you bring.',
        source: 'https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE',
      },
    },
    faq: [
      {
        q: 'What is DeepSeek Harness?',
        a: 'An open source agent harness from DeepSeek, started with one command on your own machine. Its idea is that everything is a plugin: the model adapter, the tools, the session log, even the loop the agent runs in. It can also start other companies’ coding agents as workers inside a session.',
      },
      {
        q: 'Does DeepSeek Harness run Claude Code and Codex?',
        a: 'Yes, and it is the most interesting thing about it. Both are separate plugins you install and switch on. Each run is one-shot, though: the agent cannot stop to ask you a question, and only its final answer comes back, so you do not see what it did along the way.',
      },
      {
        q: 'Is DeepSeek Harness ready to rely on?',
        a: 'Its own README answers that in capital letters: it is a developer preview, iterating rapidly, and there will be compatibility-breaking changes. On its releases page, every version so far is a release candidate. We say it the way we would want our own early parts described, and DorkOS has some of those too.',
      },
      {
        q: 'Is DeepSeek Harness free?',
        a: 'Yes, and open source under the MIT licence. You pay only the model provider whose key you give it. It asks for a DeepSeek key first, and will take Anthropic, OpenAI or others instead if you would rather.',
      },
      {
        q: 'How is DorkOS different?',
        a: 'Mostly in what surrounds the agents. DorkOS runs work while your session is closed, messages you when a job finishes or needs a decision, and puts the whole thing on a screen you can open from a phone. DeepSeek Harness goes deeper underneath, and is honest that it is early.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://deepseek.com/harness',
      'https://github.com/deepseek-ai/deepseek-harness',
      'https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md',
      'https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/README.md',
      'https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md',
      'https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/schedule.md',
      'https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/agent-team.md',
      'https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/capability-seams.md',
      'https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md',
      'https://github.com/deepseek-ai/deepseek-harness/releases',
      'https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE',
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
    openSourceNote: 'The command-line tool is open. The cloud service, apps and models are not.',
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
        detail:
          'The pieces are there if you want to build it: OpenCode runs headless as a server with an HTTP interface, so your computer’s own timer can start a job on a schedule. What you would be signing up for is the plumbing around it — deciding what runs where, keeping a record of what happened, and arranging to hear about it when something needs you.',
        source: 'https://opencode.ai/docs/server/',
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
  {
    slug: 'buzz',
    name: 'Buzz',
    maker: 'Block',
    homepage: 'https://buzz.xyz',
    framing: 'adjacent',
    category: 'Team chat where agents are members',
    oneLiner:
      'Buzz is Block’s team chat where agents join as members with their own identity. DorkOS is a cockpit for coding agents. This page compares the rooms.',
    pricing:
      'Free and open source under the Apache licence, and you can run the whole thing yourself. Block also runs an early-access server of its own, with no price published.',
    openSource: true,
    verdict:
      'Buzz is not trying to be what DorkOS is, so this page covers only the ground they share: rooms where people and agents talk to each other. On that ground Buzz is strong, and in one place ahead of us. Every member, person or agent, holds their own key, so an identity belongs to whoever holds it rather than to an account on someone else’s platform, and the messages travel over a server you run. It also does something our rooms cannot do yet: hand an agent a new instruction while it is still working, instead of making you wait for it to finish. What Buzz is not is a place to run and watch coding agents. It can host them, and it has no screen for driving them.',
    theirStrengths: [
      'you want every person and every agent to hold their own identity, instead of an account on someone else’s platform',
      'you want to redirect an agent while it is still working, rather than waiting for the turn to end',
      'you want the chat itself to be something you run and own',
      'you want a desktop app on Mac, Windows and Linux',
    ],
    cells: {
      'multi-runtime': {
        verdict: 'partial',
        note: 'Its agent bridge will drive Goose, Codex or Claude Code. It runs them out of sight, though: there is no screen for picking one or watching them side by side.',
        detail:
          'The pluggable part is real, and it is the reason this row is not a plain no: Buzz talks to coding agents through a shared protocol, so the agent in a channel can be Claude Code today and Codex tomorrow. The difference is what you get to see. In Buzz the agent is a member that posts when it has something to say, and the work happens somewhere you do not watch. In DorkOS the run itself is the thing on screen, with the sessions from all three tools in one list.',
        source: 'https://github.com/block/buzz/blob/main/docs/remote-agents.md',
      },
      scheduling: {
        verdict: 'yes',
        note: 'Yes. A workflow can start on a schedule, on a message, on a reaction or on a webhook, and a timer checks every minute for anything due.',
        source: 'https://github.com/block/buzz/blob/main/ARCHITECTURE.md',
      },
      coordination: {
        verdict: 'yes',
        note: 'This is the whole point of Buzz. Agents are ordinary members of a channel, and you set one working by mentioning it.',
        detail:
          'Agents are members of a channel rather than guests in it: you address one by name, and Buzz lines those mentions up per channel so an agent works through what it was asked in turn. Being straight about the scoreboard, this row is where Buzz is furthest ahead of us. Our rooms work, but they are the newest thing we ship and are still marked early, and Buzz can already redirect an agent mid-job where we would make you wait for it to finish.',
        source: 'https://github.com/block/buzz/blob/main/ARCHITECTURE.md',
      },
      'local-first': {
        verdict: 'yes',
        note: 'Yes. You run the server and the database yourself, and every message is signed by the key of whoever sent it.',
        source: 'https://github.com/block/buzz',
      },
      surfaces: {
        verdict: 'no',
        note: 'Desk only, for now. There is a desktop app for Mac, Windows and Linux, and the phone apps are listed as still being wired up.',
        detail:
          'Two halves of this question, and Buzz answers no to both today. There is no phone app yet: its own status table puts the iPhone and Android clients under the things still being wired up, and lists the desktop app as the one that works. Nor is there a place to approve an agent’s action before it happens, the way you might tap yes on your phone while queuing for coffee. Buzz has approval gates for its scheduled workflows, and its architecture notes, linked below, say that wiring is not finished, so a run reaching one is marked failed.',
        source: 'https://github.com/block/buzz/blob/main/README.md',
      },
      extensibility: {
        verdict: 'no',
        note: 'There is no add-on system. What a workflow is allowed to do is a fixed list built into Buzz, and there is no marketplace for adding more.',
      },
      pricing: {
        verdict: 'yes',
        note: 'Free, and open under the Apache licence. Nothing is held back for a paid tier, because there is no paid tier.',
        source: 'https://github.com/block/buzz/blob/main/LICENSE',
      },
    },
    faq: [
      {
        q: 'Is Buzz the same thing as Goose?',
        a: 'No, and they are not even from the same place any more. Goose was Block’s coding agent, but Block handed it to the Linux Foundation’s Agentic AI Foundation at the end of 2025, and it is now run there rather than by Block. Buzz is a separate and newer Block project, and it is a chat workspace, not a coding agent. Buzz can run Goose as one of its agents, which is probably where the mix-up starts.',
      },
      {
        q: 'Does Buzz replace Claude Code?',
        a: 'No. It runs Claude Code, or Codex, or Goose, as a member of a channel. The agent doing the work is still the one you already installed.',
      },
      {
        q: 'Can I use Buzz and DorkOS at the same time?',
        a: 'Yes, and they are not fighting over the same job. Buzz is where a team talks. DorkOS is where you start a coding job, watch it run, and pick it up again from your phone.',
      },
      {
        q: 'Whose rooms are further along, honestly?',
        a: 'Buzz’s are, in one way that matters: you can send an agent a new instruction while it is still working. Ours make you wait for the turn to finish. Our rooms are the newest part of DorkOS and we mark them as early on purpose.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://buzz.xyz',
      'https://github.com/block/buzz',
      'https://github.com/block/buzz/blob/main/README.md',
      'https://github.com/block/buzz/blob/main/ARCHITECTURE.md',
      'https://github.com/block/buzz/blob/main/docs/remote-agents.md',
      'https://block.xyz/inside/introducing-buzz-where-humans-and-agents-work-together',
      'https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation',
    ],
    relatedFeatures: ['rooms', 'relay-message-bus', 'agent-identity', 'mesh-agent-discovery'],
  },
  {
    slug: 'openclaw',
    name: 'OpenClaw',
    maker: 'OpenClaw Foundation',
    homepage: 'https://openclaw.ai',
    framing: 'adjacent',
    category: 'Personal assistant that lives in your chat apps',
    oneLiner:
      'OpenClaw runs your whole digital life from the chat apps you already use. DorkOS is a control room for coding agents. Here is where the two overlap.',
    pricing:
      'Free, and open source under the MIT licence. You run it on your own machine and pay only for the model behind it, on a plan or a key you already have.',
    openSource: true,
    verdict:
      'These are different products with one honest overlap, and everything below is scoped to that overlap rather than to everything either one does. OpenClaw is a personal assistant that lives in your chat apps and runs your whole digital life: your messages, your files, your calendar, the machine itself. DorkOS is a control room for coding agents. Where they meet is that both are yours, both run on your own computer, and both will get on with work while you are not watching. If you want one assistant you can reach from WhatsApp that does a bit of everything, that is OpenClaw, and DorkOS is not competing for the job. If what you want is Claude Code, Codex and OpenCode running on real projects with somewhere to watch them, that is the part OpenClaw was never built for.',
    theirStrengths: [
      'you want one assistant for your whole digital life, not only the code part of it',
      'you would rather talk to it in WhatsApp or Telegram than open one more app',
      'you want it to run the machine itself, not just a project folder',
      'you want something you can reach from your phone today, through an app you already have',
    ],
    cells: {
      'multi-runtime': {
        verdict: 'no',
        note: 'It chooses which model answers you, not which coding agent runs. Claude Code, Codex and OpenCode are not engines it swaps between.',
        detail:
          'This is the clearest line between the two, and it is a difference of purpose rather than a gap someone forgot to fill. OpenClaw is model-agnostic, so you can point it at Anthropic, at OpenAI, or at something running on your own machine, and that choice is about which brain answers the assistant. DorkOS swaps the whole agent underneath a job: the same chat can run on Claude Code today and Codex tomorrow, using the tools already signed in on your computer.',
      },
      scheduling: {
        verdict: 'yes',
        note: 'Yes. It keeps a list of jobs, wakes the agent when one is due, and can send the result to a chat channel or a webhook.',
        source: 'https://docs.openclaw.ai/automation',
      },
      coordination: {
        verdict: 'partial',
        note: 'You can run several separate assistants side by side, and each joins a group chat only when it is named. What its documentation does not describe is two of them holding a conversation with each other.',
        source: 'https://docs.openclaw.ai/concepts/multi-agent',
      },
      'local-first': {
        verdict: 'yes',
        note: 'Yes, and it is a point they make loudly. You host it yourself, and your data and your models stay on your own machine.',
        source: 'https://github.com/openclaw/openclaw',
      },
      surfaces: {
        verdict: 'yes',
        note: 'Yes, and it is the strongest thing about it: 29 chat apps have their own setup page in its documentation, so it reaches you wherever you already type. There is a dashboard in the browser as well.',
        detail:
          'Nothing on this site reaches more places than OpenClaw does. Because it arrives as a message in an app you already have, there is nothing new to install on your phone and nothing new to learn, which is a genuinely better answer than ours for an assistant you want with you all day. DorkOS goes the other way: one screen built for watching agents work, which happens to fit a phone. Different shapes, and each is right for its own job.',
        source: 'https://github.com/openclaw/openclaw/tree/main/docs/channels',
      },
      extensibility: {
        verdict: 'yes',
        note: 'Yes. Skills written as plain files, a kit for building new channels, and a hub for sharing both.',
        source: 'https://docs.openclaw.ai/tools/skills',
      },
      pricing: {
        verdict: 'yes',
        note: 'Free, and open under the MIT licence. You pay for the model behind it, nothing for the assistant.',
        source: 'https://github.com/openclaw/openclaw/blob/main/LICENSE',
      },
    },
    faq: [
      {
        q: 'Is OpenClaw a coding agent?',
        a: 'Not really. It can edit files and run commands on your machine, so it will certainly touch code, but it is built to be an assistant for everything rather than a tool for working on projects. If the job is a long piece of software work, a coding agent is still the right thing, and OpenClaw is not one.',
      },
      {
        q: 'Can I use OpenClaw and DorkOS at the same time?',
        a: 'Yes, and they barely overlap in practice. OpenClaw handles your messages and your day. DorkOS runs the coding agents and shows you what they did. Both sit on your own machine.',
      },
      {
        q: 'Who looks after OpenClaw now?',
        a: 'A non-profit. The OpenClaw Foundation was announced in July 2026 to hold the project and keep it independent. Its creator, who joined OpenAI earlier in 2026, still leads the technical side.',
      },
      {
        q: 'Which one should I pick?',
        a: 'They answer different questions, so the honest answer is usually neither-instead-of-the-other. Want an assistant in your pocket for your whole life? OpenClaw. Want to run several coding agents on real projects and see what happened? DorkOS.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://openclaw.ai',
      'https://github.com/openclaw/openclaw',
      'https://github.com/openclaw/openclaw/tree/main/docs/channels',
      'https://docs.openclaw.ai/automation',
      'https://docs.openclaw.ai/concepts/multi-agent',
      'https://docs.openclaw.ai/web/control-ui',
      'https://docs.openclaw.ai/tools/skills',
      'https://openclaw.ai/blog/introducing-openclaw-foundation',
      'https://en.wikipedia.org/wiki/OpenClaw',
    ],
    relatedFeatures: ['multi-runtime-cockpit', 'task-scheduler', 'chat-interface', 'marketplace'],
  },
  {
    slug: 'hermes',
    name: 'Hermes Agent',
    maker: 'Nous Research',
    homepage: 'https://hermes-agent.nousresearch.com',
    framing: 'adjacent',
    category: 'Assistant that lives in your chat apps',
    oneLiner:
      'Hermes Agent puts an assistant in Telegram, Discord, Slack and more. DorkOS is a cockpit for coding agents. This page sticks to the shared ground.',
    pricing:
      'The agent itself is free and open source, whatever else you buy. Nous sells credits for models and tools on top: a free tier, then $20 a month for Plus, $100 for Super and $200 for Ultra.',
    openSource: true,
    verdict:
      'Hermes Agent and DorkOS both put an agent somewhere you can actually reach it, and that is where the resemblance stops. Hermes lives in your chat apps: you talk to it in Telegram or Slack, it remembers what you told it, it runs jobs on a schedule, and it is free and open under the MIT licence. It is not built around coding agents and it has no cockpit: no list of sessions, no place to watch a long job, no swapping between Claude Code, Codex and OpenCode. One thing deserves correcting, because older write-ups still state it flatly. Hermes used to be the standing example of an agent that would not talk to another agent. Across its chat platforms that is still deliberately true. Inside its desktop app it now has a Bot Mode where a few bots can pass work to each other, with firm limits on how far that goes.',
    theirStrengths: [
      'you want an assistant inside the chat app you already use, with nothing new to install on your phone',
      'you want to point it at any model you like, including one running on your own hardware',
      'you want scheduled jobs that report back into a chat where other people can see them',
      'you want something that will run happily on a very small server',
    ],
    cells: {
      'multi-runtime': {
        verdict: 'no',
        note: 'It swaps models, not coding agents. Nothing in it puts Claude Code on one job and Codex on the next.',
      },
      scheduling: {
        verdict: 'yes',
        note: 'Yes. A built-in scheduler runs jobs unattended and delivers what they produced into whichever chat platform you picked.',
        source: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/cron',
      },
      coordination: {
        verdict: 'partial',
        note: 'Two answers, depending where you look. In the chat apps, no: its own documentation calls wiring two Hermes bots to answer each other an unsupported setup. In its desktop app, a Bot Mode lets a small group of bots hand tasks to each other by name.',
        detail:
          'Worth getting right, because the internet is still repeating the old version. The refusal is real and deliberate, and it is about the chat platforms: their documentation says plainly that setting several Hermes profiles to reply to one another in a shared channel is not a supported arrangement, and the safe default ignores other bots entirely. Then, separately, Bot Mode arrived as a plugin for its desktop app, where a group of two to six bots can pull each other in by name, under hard caps of ten messages a turn and three rounds so a room cannot spin. So the honest summary is not "it cannot" but "not in the places you would first try, and with a ceiling where it can". DorkOS puts agents in shared rooms instead, and we mark that part early on purpose.',
        source: 'https://github.com/NousResearch/Hermes-Bot-Mode',
      },
      'local-first': {
        verdict: 'yes',
        note: 'Yes. You run it yourself, from a cheap server up to your own machine, and it is yours from there.',
        source: 'https://github.com/NousResearch/hermes-agent',
      },
      surfaces: {
        verdict: 'yes',
        note: 'Yes. Seven ways in, counting the terminal: Telegram, Discord, Slack, WhatsApp, Signal and email, so your phone is covered by whatever is already on it.',
        source: 'https://github.com/NousResearch/hermes-agent',
      },
      extensibility: {
        verdict: 'yes',
        note: 'Yes. It reaches outside tools through MCP, the common standard for that, and skills are shared files you can add to.',
        source: 'https://github.com/NousResearch/hermes-agent',
      },
      pricing: {
        verdict: 'yes',
        note: 'The agent is free and open under the MIT licence. The paid tiers buy credits for models and tools, not features of the agent itself.',
        source: 'https://github.com/NousResearch/hermes-agent/blob/main/LICENSE',
      },
    },
    faq: [
      {
        q: 'Can two Hermes agents talk to each other?',
        a: 'In the chat apps, no, and that is on purpose: its documentation calls setting two Hermes bots to answer each other an unsupported arrangement, and by default a bot ignores other bots. Inside its desktop app there is a Bot Mode where a small group of bots can pass tasks to each other for a limited number of rounds. So the old line that Hermes flatly cannot do it is out of date, but the caution behind it is still real.',
      },
      {
        q: 'Is Hermes Agent a coding agent?',
        a: 'No. It is a general assistant that happens to be very good at living in chat. For work on a codebase you would still reach for Claude Code, Codex or OpenCode, which is what DorkOS runs.',
      },
      {
        q: 'Can I use Hermes and DorkOS together?',
        a: 'Yes. They want different jobs and neither gets in the other one’s way. Hermes is your assistant in chat, DorkOS is where coding work runs and gets watched.',
      },
      {
        q: 'Does DorkOS work in Telegram and Slack too?',
        a: 'Yes, for a narrower job: you can talk to your agents and get told when something needs you. Telegram has been in use the longest; Slack is newer. Hermes reaches more chat apps than we do, and we would rather say so.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://hermes-agent.nousresearch.com',
      'https://github.com/NousResearch/hermes-agent',
      'https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/discord.md',
      'https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.16.2',
      'https://github.com/NousResearch/Hermes-Bot-Mode',
      'https://hermes-agent.nousresearch.com/docs/user-guide/features/cron',
      'https://portal.nousresearch.com',
    ],
    relatedFeatures: ['telegram-adapter', 'slack-adapter', 'task-scheduler', 'rooms'],
  },
  {
    slug: 'grok-bot',
    name: 'Grok Bot',
    maker: 'xAI',
    homepage: 'https://docs.x.ai/grok-bot/overview',
    framing: 'adjacent',
    category: 'Cloud coworker with a computer of its own',
    oneLiner:
      'Grok Bot is xAI’s cloud coworker with a computer of its own. DorkOS is a cockpit for coding agents on your machine. Here is the shared ground.',
    pricing:
      'It needs a paid plan, and not the cheapest one. The plans xAI lists as eligible are SuperGrok Plus or SuperGrok Heavy, which the App Store prices at $100 and $300 a month, or on the Cursor side Pro+ at $60, Ultra at $200, or a Teams seat from $40. Plain SuperGrok at $30 and Cursor Pro at $20 are not on that list.',
    openSource: false,
    verdict:
      'Grok Bot and DorkOS both take a job off your hands and carry on without you, and that is about where the resemblance stops. Grok Bot is a coworker xAI runs for you: each bot lives on a cloud computer with a browser, a terminal and files, signs into your tools with your own accounts, and keeps working after you shut your laptop. The jobs xAI puts forward for it are office ones: sales outbound, recruiting, expenses, a chief of staff. Working on the code in your own repository is not among them. On one row it is plainly ahead of us: several of its bots run at once, message each other and hand a job along, and that works today, while our rooms are still marked early. What it does not do is run Claude Code, Codex or OpenCode against the projects on your own machine, which is the whole of what DorkOS is for.',
    theirStrengths: [
      'you want a working computer in the cloud with nothing to install and nothing to keep running yourself',
      'the work you want handed over is sales, recruiting, expenses or reporting rather than code',
      'you already pay for Cursor Pro+, Ultra or a Teams seat, because it comes with those',
      'you want several bots that message each other and pass work along, working now rather than marked early',
    ],
    cells: {
      'multi-runtime': {
        verdict: 'no',
        note: 'It is xAI’s own bot and only that. There is no putting Claude Code on one job and Codex on the next, because the bot is the product.',
      },
      scheduling: {
        verdict: 'yes',
        note: 'Yes. You teach a bot a job once and it keeps that as a skill, and a routine then runs that skill on a schedule, on xAI’s computer rather than yours.',
        detail:
          'Worth knowing before you switch one on: xAI’s own advice is to test a routine first, and its warning is that a test run performs real work. In its words, it can navigate websites, change files, and call connected tools, so a test is a real send rather than a rehearsal. The difference from ours is where the job runs. Theirs runs in xAI’s cloud whether or not your laptop is open; ours needs your own machine to be awake.',
        source: 'https://docs.x.ai/grok-bot/skills-routines-and-automations',
      },
      coordination: {
        verdict: 'yes',
        note: 'Yes, and this is the row where it beats us. Several bots run at once, message each other, share context in threads or group chats, and pass ownership of a job along.',
        detail:
          'Straight about the scoreboard: this works for them today and ours is still marked early. One thing to know about the shape of it, from xAI’s own security page. Every bot on your account uses the same cloud computer, so files and signed-in browser sessions are shared between them, and the page says plainly not to treat separate bots as a security boundary. So it is many bots on one machine rather than many machines. DorkOS puts agents in shared rooms instead, and we hold that at "partly" until everyday use proves it.',
        source: 'https://docs.x.ai/grok-bot/overview',
      },
      'local-first': {
        verdict: 'no',
        note: 'No. The work happens on a computer xAI runs. It can reach your own machine, but only for commands you switch on and approve under a local-computer policy.',
        detail:
          'This is the deepest difference between the two, and neither answer is wrong; they are answers to different questions. Grok Bot’s computer is the product: it is already set up, it holds your files and your signed-in browser sessions between jobs, and turning off what it may do on your laptop does not stop it working in the cloud. DorkOS has no cloud of ours for your work to sit in. Your projects, your sessions and your history stay on your own computer, under the accounts already signed in there.',
      },
      surfaces: {
        verdict: 'yes',
        note: 'Yes. A desktop app for Mac and Windows and an iPhone app, so you can pick a job up from your pocket. There is no Linux desktop app.',
        detail:
          'The phone is a real one rather than a viewer: you can start work, answer a bot’s questions, approve steps and review results from the iPhone app. xAI is straight about where it stops, though. Some advanced desktop controls and teach-by-demonstration are not on iPhone, and editing a routine’s schedule, changing a bot’s instructions, reviewing run history or deleting a routine all send you back to a desktop. It is iPhone only, too, not iPad or Android. So this row is close rather than level: both let you approve work from your pocket, and theirs asks you to finish some of it at a desk.',
        source: 'https://docs.x.ai/grok-bot/get-started',
      },
      extensibility: {
        verdict: 'partial',
        note: 'Partly. A Plugins screen installs supported connectors and packaged skills, and connectors are how a bot reaches an outside tool. What its documentation does not describe is a public marketplace, or a way to hand your setup to someone else.',
        detail:
          'Skills are reusable instructions a bot can keep and reuse, which is the same idea we build on, and connectors are installed for the whole account. Its overview page adds that a bot can use connectors and MCP tools where they are available, so the common standard for reaching outside tools is in the picture. The half we could not find any account of is sharing: nothing in its documentation describes publishing a skill for other people, or installing one somebody else wrote. That may simply be early. It is why this row is "partly" rather than a yes, and we would rather say we could not find it than say it does not exist.',
        source: 'https://docs.x.ai/grok-bot/skills-routines-and-automations',
      },
      pricing: {
        verdict: 'no',
        note: 'Neither free nor readable. The cheapest way in is a Cursor Teams seat at $40 a month, or Cursor Pro+ at $60 for one person, and none of it is open source.',
      },
    },
    faq: [
      {
        q: 'Is Grok Bot included in Cursor?',
        a: 'On some Cursor plans, yes. xAI lists Cursor Pro+, Cursor Ultra and Cursor Teams, Standard or Premium, among the plans that can use it. Plain Cursor Pro, the $20 one, is not on that list. Pro+ is $60 a month, Ultra is $200, and Teams starts at $40 a seat. If you are already on one of those, Grok Bot is not an extra bill.',
      },
      {
        q: 'Does Grok Bot work with my local code?',
        a: 'Not in the way you probably mean. It works on its own computer in xAI’s cloud, and it only touches your machine if you switch that on and approve each command, or set it to always allow. Even then, the jobs xAI puts forward for it are office work rather than software work. For an agent working through your own repository, you want a coding agent, which is what DorkOS runs.',
      },
      {
        q: 'Is Grok Bot a coding agent?',
        a: 'No. The eight jobs xAI uses to describe it are sales outbound, talent scout, paid media, expense manager, product performance, bug reproduction, account health and chief of staff. Bug reproduction is the closest it gets to software, and even that is about turning a bug report into steps someone can follow, not writing the fix.',
      },
      {
        q: 'Which Grok plan do I actually need?',
        a: 'SuperGrok Plus or SuperGrok Heavy, going by xAI’s own list of eligible plans. On the App Store those are $100 and $300 a month. The cheaper Grok subscriptions, SuperGrok at $30 and SuperGrok Lite at $10, are not on the list, so paying for Grok does not by itself get you Grok Bot.',
      },
      {
        q: 'Can I use Grok Bot and DorkOS together?',
        a: 'Yes, and they are not after the same job. Grok Bot takes the office work: the outreach, the expenses, the weekly report. DorkOS is where you start a coding job on your own machine, watch it run, and pick it up again from your phone.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://docs.x.ai/grok-bot/overview',
      'https://docs.x.ai/grok-bot/get-started',
      'https://docs.x.ai/grok-bot/mobile',
      'https://docs.x.ai/grok-bot/computer-and-apps',
      'https://docs.x.ai/grok-bot/skills-routines-and-automations',
      'https://docs.x.ai/grok-bot/approvals-security-and-privacy',
      'https://docs.x.ai/grok-bot/use-cases',
      'https://docs.x.ai/developers/release-notes',
      'https://cursor.com/docs/account/pricing',
      'https://apps.apple.com/us/app/grok/id6670324846',
    ],
    relatedFeatures: ['multi-runtime-cockpit', 'cli', 'task-scheduler', 'rooms'],
  },
  {
    slug: 'terragon',
    name: 'Terragon',
    maker: 'Terragon Labs',
    homepage: 'https://www.terragonlabs.com',
    framing: 'discontinued',
    category: 'Cloud service that ran coding agents for you',
    oneLiner:
      'Terragon ran coding agents in the cloud until it closed in February 2026. What it did, what it left behind, and where DorkOS does and does not fit.',
    pricing:
      'It was a paid subscription while it ran. We could find no surviving pricing page, so we are not going to repeat a figure we cannot check.',
    openSource: true,
    openSourceNote:
      'Open under the Apache licence. The team published a snapshot of the whole thing on the way out, so the code is still there to read, and to run yourself if you want to.',
    verdict:
      'Terragon closed in February 2026, and if you liked it, that was a real loss: you handed it a task, it worked in its own cloud machine against your repository, and you reviewed a pull request at the end. Two things are worth knowing before you pick a replacement. The first is that Terragon did not tell anyone where to go next. Its own parting words recommend nothing, and the pairing you may have seen suggested online came from a commenter, not from Terragon, so treat it as someone’s opinion rather than the company’s advice. The second is that the code did not vanish. Terragon published an open snapshot under the Apache licence, so self-hosting it is genuinely possible, with nobody maintaining it. As for DorkOS: it fits if what you want back is the part where agents get on with work and you review the result, and it does not fit if what you liked was that none of it ran on your own computer. That was Terragon’s whole shape, and it is the opposite of ours.',
    cells: {
      'multi-runtime': {
        verdict: 'yes',
        note: 'It did, and this is the part DorkOS carries on. You could point it at Claude Code, OpenAI Codex, Amp or Gemini, bringing your own subscription or your own keys.',
        detail:
          'Terragon got this right early, and it is why its users are worth talking to: it never asked you to give up the agent you already liked. That is the same bet DorkOS makes. The difference is only where the agent runs. Terragon started a fresh cloud machine and worked against your repository there; DorkOS starts the Claude Code or Codex already signed in on your own computer, on any folder, whether or not it has been pushed anywhere.',
        source: 'https://github.com/terragon-labs/terragon-oss',
      },
      scheduling: {
        verdict: 'yes',
        note: 'It did. Its automations ran on a repeat, or started when something happened in your project, like a new issue.',
        source: 'https://github.com/terragon-labs/terragon-oss',
      },
      coordination: {
        verdict: 'partial',
        note: 'Its own feature list named multi-agent support, though it never said much about what those agents did together.',
        source: 'https://github.com/terragon-labs/terragon-oss',
      },
      'local-first': {
        verdict: 'no',
        note: 'No, and this is the part that mattered most in the end. The work happened on Terragon’s computers, so when the company stopped, the product stopped with it.',
        detail:
          'We are not going to pretend this is a clever argument we made in advance. It is just what happened. A cloud service is someone else’s machine, and when the business behind it winds down, the thing you built your week around goes with it. The agents DorkOS drives are installed on your own computer under your own accounts, so the worst we can do to you is stop writing the cockpit. Your code and your history stay where they already are.',
      },
      surfaces: {
        verdict: 'partial',
        note: 'There was no phone app, but it hooked into Slack and GitHub, so work could be started from a message or from an issue.',
        source: 'https://github.com/terragon-labs/terragon-oss',
      },
      extensibility: {
        verdict: 'partial',
        note: 'It spoke MCP, the common way of plugging outside tools into an agent, so other tools could hand it work. There was no marketplace beyond that.',
        source: 'https://github.com/terragon-labs/terragon-oss',
      },
      pricing: {
        verdict: 'partial',
        note: 'It was a paid subscription while it ran, and the code is open now under the Apache licence, which is more than most closed services leave behind.',
        source: 'https://github.com/terragon-labs/terragon-oss',
      },
    },
    faq: [
      {
        q: 'What happened to Terragon?',
        a: 'Terragon Labs wound the product down in February 2026. The website is now a single line saying it has shut down, and the team published the code as an open snapshot before they went.',
      },
      {
        q: 'Did Terragon say what to use instead?',
        a: 'No. We looked, because it is the first thing anyone wants to know, and there is no recommendation in what Terragon left behind. If you have seen Claude Code on the web or Codex named as the official next step, that came from a commenter on a forum rather than from Terragon. Both are real products and either may suit you: just do not take it as advice Terragon gave.',
      },
      {
        q: 'Can I still run Terragon myself?',
        a: 'Yes, in the sense that the code is public under the Apache licence and nothing stops you. Nobody is maintaining it, and the snapshot is offered with no promise that it is complete, so treat it as a starting point rather than a product.',
      },
      {
        q: 'Is DorkOS just Terragon again?',
        a: 'No, and it would be dishonest to sell it that way. Terragon put the work on its own machines so you never had to think about yours. DorkOS runs the agents on your computer, using the plans you already pay for. If having nothing on your own machine was what you liked, DorkOS is the wrong shape for you.',
      },
      {
        q: 'Where can I read the shutdown notice?',
        a: 'Not at the original address any more: that documentation site is offline, and its security certificate expired with it. An archived copy is listed with our sources below, and the code snapshot Terragon published is still up on GitHub.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://www.terragonlabs.com',
      'https://github.com/terragon-labs/terragon-oss',
      'https://web.archive.org/web/20260119142256/https://docs.terragonlabs.com/docs/resources/shutdown',
    ],
    relatedFeatures: ['multi-runtime-cockpit', 'task-scheduler', 'workspaces', 'cli'],
  },
  {
    slug: 'roo-code',
    name: 'Roo Code',
    maker: 'Roo Code, Inc.',
    homepage: 'https://github.com/RooCodeInc/Roo-Code',
    framing: 'discontinued',
    category: 'Coding agent that lived in VS Code',
    oneLiner:
      'Roo Code shut down in May 2026, and its own notice names Cline and ZooCode. Here is what happened, and where DorkOS honestly does not replace it.',
    pricing:
      'The extension was free, and you paid only the model provider with your own key. There was a paid cloud add-on as well, whose prices we could not confirm from anything Roo Code still controls.',
    openSource: true,
    openSourceNote:
      'Open under the Apache licence. The repository is archived and read-only now, but every line of it is still there to read or fork.',
    verdict:
      'Roo Code was a good agent in the editor with a following to match, and losing it stung, because a lot of people had it set up exactly how they liked. It shut down on 15 May 2026, and its old address now forwards to a different product called Roomote. Start with what Roo Code itself said, because the internet has muddled this badly. Its own notice, still readable today on GitHub and on the Marketplace listing, names exactly two alternatives: Cline, which Roo Code was originally forked from, and ZooCode, a fork the community started. Kilo Code is the name you will see most often in write-ups, and it published its own guide for moving across, but Roo Code never named it. Now the honest part about us: DorkOS is not a VS Code extension and will not put an agent back in your editor. It is the room around agents like that one. If what you miss is the agent inside VS Code, take the notice’s advice first, and come back for the part it never did.',
    cells: {
      'multi-runtime': {
        verdict: 'no',
        note: 'No. It was one agent living in your editor. It could talk to plenty of model providers, but it did not run other companies’ coding agents for you.',
      },
      scheduling: {
        verdict: 'no',
        note: 'No. Nothing in it started a job at a set time: you were in the editor, watching, for every run.',
      },
      coordination: {
        verdict: 'partial',
        note: 'Its Orchestrator mode split a big job into smaller ones, ran each in its own mode with its own context, and reported back. That is one agent handing work to itself rather than separate agents talking.',
        source: 'https://docs.roocode.com/features/boomerang-tasks',
      },
      'local-first': {
        verdict: 'yes',
        note: 'Yes, and this is what people liked. It ran inside VS Code on your own machine, with your own key, asking before it changed anything.',
        source: 'https://github.com/RooCodeInc/Roo-Code',
      },
      surfaces: {
        verdict: 'no',
        note: 'No. Roo Code lived in the editor window on your desk, and there was no phone app to check in from.',
      },
      extensibility: {
        verdict: 'yes',
        note: 'Yes. It had a marketplace built into the extension for adding outside tools through MCP, and for custom modes.',
        source: 'https://docs.roocode.com/features/marketplace',
      },
      pricing: {
        verdict: 'yes',
        note: 'The extension itself was free and open under the Apache licence. You paid for the model, with your own key.',
        source: 'https://github.com/RooCodeInc/Roo-Code',
      },
    },
    faq: [
      {
        q: 'What happened to Roo Code?',
        a: 'It shut down on 15 May 2026. The repository was archived and made read-only the same day, and the listing in the VS Code Marketplace still carries the shutdown notice. If you type the old web address you will land on a different product called Roomote, which is where roocode.com now forwards.',
      },
      {
        q: 'What did Roo Code tell people to use instead?',
        a: 'Two things, by name: Cline, the project Roo Code was originally forked from, and ZooCode, a fork started by its own community. Both are alive today. That wording is still on the archived repository and on the Marketplace listing, so you can check it rather than take our word for it.',
      },
      {
        q: 'Is Kilo Code the official replacement for Roo Code?',
        a: 'Not officially, no, however often you see it described that way. Kilo Code published a guide for moving over from Roo Code and plenty of people took it, which is fine and it is a real project. It simply is not one of the two Roo Code named. Worth knowing if you are choosing based on what the team endorsed.',
      },
      {
        q: 'Does DorkOS replace Roo Code?',
        a: 'No, and we would rather say that plainly than win a click. Roo Code was an agent inside your editor. DorkOS has no editor and no extension: it runs coding agents like Claude Code and Codex on your machine and gives you one place to watch and schedule them. Most people replacing Roo Code want the editor part back first, and that is Cline, ZooCode or Kilo Code, not us.',
      },
      {
        q: 'Can I still install or read the code?',
        a: 'The code yes, the extension no. The repository is archived but public under the Apache licence, so you can read or fork all of it. The Marketplace listing survives as a notice rather than a working download.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://github.com/RooCodeInc/Roo-Code',
      'https://marketplace.visualstudio.com/items?itemName=RooVeterinaryInc.roo-cline',
      'https://docs.roocode.com/features/boomerang-tasks',
      'https://docs.roocode.com/features/marketplace',
      'https://github.com/Zoo-Code-Org/Zoo-Code',
      'https://cline.bot',
      'https://roomote.dev',
    ],
    relatedFeatures: ['multi-runtime-cockpit', 'task-scheduler', 'mobile', 'tool-approval'],
  },
];
