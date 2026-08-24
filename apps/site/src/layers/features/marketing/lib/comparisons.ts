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
];
