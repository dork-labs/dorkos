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
 * - `competitor`, a genuine rival; an honest "DorkOS vs X".
 * - `runtime`, an agent tool DorkOS runs for you; "DorkOS + X", never adversarial.
 * - `adjacent`, a different category with real overlap; the page is scoped to the overlap.
 * - `discontinued`, the product shut down; the page is "X alternatives".
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
   * table cell already says, sections with nothing extra are not rendered.
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
   * Replaces the plain open/closed wording where that would overstate things ,
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
   * before-and-after story, the engine on its own, then the same engine with
   * DorkOS around it, so their column goes on the left there.
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
    metaTitle: (name) => `DorkOS vs ${name}: an honest comparison`,
    intro: (name) => `${name} vs DorkOS, in plain words: what each one is for, and how to pick.`,
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
    metaTitle: (name) => `DorkOS + ${name}: one place to run ${name}`,
    intro: (name) =>
      `DorkOS runs ${name} for you: one place to start it, watch it, and schedule it.`,
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
    groupBlurb:
      'The agents DorkOS runs for you. Keep the tool you like, and gain one place to run it from.',
  },
  adjacent: {
    headline: (name) => `DorkOS vs ${name}`,
    metaTitle: (name) => `DorkOS vs ${name}: where they overlap`,
    intro: (name) =>
      `${name} vs DorkOS: different kinds of tool, so this page sticks to the ground they share.`,
    scopeNote: (name) =>
      `${name} and DorkOS are different kinds of tool. This page covers only the ground they share, not everything either one does.`,
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
    metaTitle: (name) => `${name} alternatives: what to use now`,
    intro: (name) => `${name} is gone: what happened, and where to go next.`,
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
    id: 'your-own-subscriptions',
    label: 'Runs on the plans you already pay for',
    featureSlugs: ['multi-runtime-cockpit', 'runtime-accounts'],
    question:
      'Does it work through the plans you already pay for, or sell you the model use again?',
    wantPhrase: 'to keep paying your own Claude or ChatGPT plan, with nothing added on top',
    dorkosNote:
      'Your own Claude, ChatGPT and OpenCode sign-ins do the work, so DorkOS adds nothing to your bill. You can send one agent, or one chat, to a different Claude account.',
  },
  {
    id: 'scheduling',
    label: 'Work that runs on a schedule',
    featureSlugs: ['task-scheduler', 'notifications'],
    question: 'Can you hand over a job that runs at a set time without you sitting there?',
    wantPhrase: 'jobs that start at a set time without you pressing anything',
    dorkosDetail:
      'You write the job once and say when it should run: every night, every Monday, every hour. DorkOS starts the agent at that time on your own machine and messages you when it finishes or needs a decision, so you are not the thing that has to remember.',
  },
  {
    id: 'self-scheduling-trust',
    label: 'Agents that book their own work',
    featureSlugs: ['schedule-approvals', 'task-scheduler', 'control-center'],
    question: 'Can an agent set up a repeating job, with you approving it first?',
    wantPhrase: 'agents that can book repeating work, but only with your say-so',
    dorkosDetail:
      'An agent can propose a repeating job, and it never starts one on its own. You get a card naming the agent, quoting the reason it gave, and showing the next three run times and the exact instructions. There is a button to run it once, supervised, before you agree to it forever.',
  },
  {
    id: 'coordination',
    label: 'Agents that work together',
    featureSlugs: ['relay-message-bus', 'rooms', 'mesh-agent-discovery'],
    question: 'Can several agents find each other and pass work along?',
    wantPhrase: 'agents that can hand work to each other instead of working alone',
    dorkosDetail:
      'Your agents share rooms the way people share a group chat. They can see each other, answer each other, and hand a job along. You set how often they may reply, per room, so a busy channel never turns into a runaway bill.',
  },
  {
    id: 'spend-guardrails',
    label: 'Limits on agents talking to agents',
    featureSlugs: ['room-reply-limits', 'control-center', 'rooms'],
    question: 'When your agents talk to each other, can you stop the bill running away?',
    wantPhrase: 'a limit that stops your agents answering each other all night',
    dorkosDetail:
      'Four dials cap the replies your agents may trade: how many in a row, how much of one conversation a single agent may take, how many per room each hour, and how many across every room each hour. Set them once, or set them room by room. The dial covering everything is the one no room can skip.',
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
    id: 'open-and-yours',
    label: 'Open, and yours to run',
    featureSlugs: ['cli', 'tunnel', 'workspaces'],
    question: 'Can you read the source, run it yourself, and skip making an account?',
    wantPhrase: 'to read the code, run it yourself, and never make an account',
    dorkosNote:
      'Free and open source under the MIT licence. It runs on your own machine, and there is no DorkOS account to make.',
  },
  {
    id: 'surfaces',
    label: 'Where you can use it',
    featureSlugs: ['mobile', 'chat-interface', 'notifications'],
    question: 'Can you open your agents and watch them work from any screen you are near?',
    wantPhrase: 'to open your agents from any screen you are near, not just the one they run on',
  },
  {
    id: 'approvals-anywhere',
    label: 'Saying yes from anywhere',
    featureSlugs: ['action-approvals', 'tool-approval', 'mobile', 'telegram-adapter'],
    question: 'When an agent stops to ask permission, can you answer from wherever you are?',
    wantPhrase: 'to say yes or no from your phone or your chat app, not just your desk',
    dorkosDetail:
      'An agent that needs permission asks, and the question follows you: the browser on your phone, a Telegram or Slack message, or a notification banner on your Mac. Only the person you name gets asked, so it is never broadcast to every chat you have connected.',
  },
  {
    id: 'attention-management',
    label: 'One list of what needs you',
    featureSlugs: ['notification-inbox', 'notifications', 'escalation-ladder'],
    question: 'Is there one place holding everything waiting on your answer?',
    wantPhrase: 'one list of everything waiting on you, instead of hunting through tabs',
    dorkosDetail:
      'One bell holds every question, approval and finished run, with the things waiting on you above the things that merely happened. What you have read stays read on your other devices. If a question sits unanswered for the few minutes you chose, it rings your phone.',
  },
  {
    id: 'extensibility',
    label: 'Adding your own tools',
    featureSlugs: ['marketplace', 'mcp-server', 'connections'],
    question: 'Can you add your own tools and share the setup with other people?',
    wantPhrase: 'to add your own tools and share the setup with other people',
    dorkosDetail:
      'Nothing here replaces a marketplace of editor add-ons built up over years. What DorkOS adds is the other half, you can package up a working agent, with its instructions and its tools, and hand the whole thing to someone else in one command. Signing those tools in to outside services is the part still finding its feet.',
  },
  {
    id: 'pricing',
    label: 'Price and openness',
    featureSlugs: ['cli'],
    question: 'What does the tool itself cost, and can you read its source code?',
    wantPhrase: 'a tool that costs nothing, so you only pay for the model plan you already have',
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
 * The dimensions where DorkOS fully delivers and the other product does not ,
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
    maker: 'SpaceX (Anysphere)',
    homepage: 'https://cursor.com',
    framing: 'competitor',
    category: 'AI code editor',
    oneLiner:
      'Cursor is an AI code editor. DorkOS is one place for every coding agent you already run. Here is what each one is for, in plain words.',
    pricing:
      'Free Hobby plan. Pro is $20 a month, with higher paid tiers above it and teams at $40 per person. Every plan includes some model use, and going past it costs extra.',
    openSource: false,
    verdict:
      'Cursor is a very good editor, and if you write code all day in one window, it is the better buy. DorkOS is not an editor. It is one place for every agent you already run: on your own machine, on a schedule, and on your phone when you are out. Those agents write code. They also send the email, plan the week, and book the call.',
    theirStrengths: [
      'you want one polished window for writing code with an agent beside you',
      'you want several of its agents at once, each on its own copy of your project',
      'you lean on VS Code habits, because it imports your settings and extensions',
      'you want the bigger crowd, so answers and shared habits are easy to find',
    ],
    cells: {
      'your-own-subscriptions': {
        verdict: 'no',
        note: 'You pay Cursor for the model use. The Claude or ChatGPT plan you already have does not carry the work.',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'There is no scheduler here at all, so no agent can ask you for one.',
      },
      'spend-guardrails': {
        verdict: 'no',
        note: 'Its agents work in separate copies of your project and never answer each other, so there is no such limit and nothing asking for one.',
      },
      'open-and-yours': {
        verdict: 'no',
        note: 'The code is closed, and you sign in to Cursor to use it.',
      },
      'approvals-anywhere': {
        verdict: 'no',
        note: 'Its phone app and Slack are for starting agents, following along, and reviewing the pull request at the end. Neither answers a permission prompt mid-run.',
      },
      'attention-management': {
        verdict: 'no',
        note: 'Its dashboard lists the agents you started. There is no one list of the things waiting on your answer.',
      },
      'multi-runtime': {
        verdict: 'no',
        note: 'Cursor runs its own agents inside Cursor. It does not drive Claude Code, Codex or OpenCode for you.',
        detail:
          'Cursor picks the model for its own agents, and that is the whole choice on offer: the agent is part of the editor. If you already run Claude Code in one terminal and Codex in another, Cursor does not gather them up, those stay separate tools you switch between by hand.',
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
        q: 'Can I use DorkOS and Cursor together?',
        a: 'Yes. Write in Cursor. Let DorkOS run and watch the longer jobs on the same folders.',
      },
      {
        q: 'Does DorkOS replace my code editor?',
        a: 'No. There is no editor in DorkOS. Keep the one you like, and let DorkOS run the agents.',
      },
      {
        q: 'Which should I pick if I only run one agent at a time?',
        a: 'Cursor. One window, one agent, the code right there. DorkOS starts paying off once several agents are running and you want one place to watch them.',
      },
      {
        q: 'Is Cursor owned by SpaceX now?',
        a: 'Yes. SpaceX bought Anysphere, the company that makes Cursor, in August 2026. Cursor keeps its name. It also means Cursor and Grok Bot now share an owner, so Grok Bot coming with some Cursor plans is one company bundling its own product.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://techcrunch.com/2026/08/15/spacex-officially-closes-its-cursor-acquisition/',
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
      'GitHub built something serious here. You can hand one issue to Copilot, to Claude and to Codex at once, then compare what three companies bring back, inside the repository your team already uses. The catch is where it happens: on GitHub’s computers, on code already pushed to GitHub, billed to your Copilot seat rather than the Claude or ChatGPT plan you already pay for. DorkOS drives the agents already signed in on your own machine, on any folder, and adds nothing to your bill.',
    theirStrengths: [
      'your work already lives in GitHub, beside the issues and pull requests you use anyway',
      'you want one issue handed to Copilot, Claude and Codex at once, so you can compare',
      'your company needs one place to say which agents are allowed, and a record of what they did',
      'you would rather have one bill, on the Copilot seat you already buy',
    ],
    cells: {
      'your-own-subscriptions': {
        verdict: 'no',
        note: 'Everything is billed to your Copilot seat, even the work Claude or Codex does, and metered on top of it.',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'You set an automation up yourself. No agent asks you to book one.',
      },
      'spend-guardrails': {
        verdict: 'partial',
        note: 'A budget caps what agent work may spend, though at organisation level it only stops the work if you switch the hard stop on. There is no dial for agents answering each other, because they do not.',
        source:
          'https://docs.github.com/en/copilot/tutorials/budgets/getting-started-with-budget-controls',
      },
      'open-and-yours': {
        verdict: 'no',
        note: 'Closed, and the whole thing runs on GitHub, under a GitHub account.',
      },
      'approvals-anywhere': {
        verdict: 'partial',
        note: 'Its phone app and Slack let you review an agent’s work and approve the pull request it opened. That is review after the fact, not a question mid-run.',
        source: 'https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent',
      },
      'attention-management': {
        verdict: 'partial',
        note: 'Its Agents page gathers every session in one list, including ones someone else started. Its documentation describes no way to narrow that down to what is waiting on your answer.',
        source:
          'https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents',
      },
      'multi-runtime': {
        verdict: 'yes',
        note: 'Yes. An issue can go to Copilot, to Anthropic’s Claude, to OpenAI’s Codex, or to all three at once. Both outside agents were still marked a preview when we checked.',
        detail:
          'This is real, and it is why this page exists: GitHub will run a rival’s agent for you, which almost nobody else does. Two things are worth knowing. The line-up is shorter than the announcement suggested, Google’s and Cognition’s agents were promised for "the coming months" and are still not there, and these are GitHub’s own hosted versions of Claude and Codex, billed through your Copilot seat. They are not the Claude Code or Codex you already have installed and signed in. DorkOS drives that copy instead, which is why the plan you already pay for is the one doing the work.',
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
          'This is the sharpest difference between the two, and it is not an oversight: living inside GitHub is the whole idea, and it is what makes the review, the permissions and the audit trail come free. The price is that the work has to be on GitHub before any of it can happen. DorkOS starts from a folder, any folder, on any host or none, and runs the agent next to it on the machine in front of you.',
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
        a: 'Not in any useful sense. The free tier allows a little of Copilot’s own agent work, and the $10 plan does not include the outside agents either. Handing a job to Claude or Codex needs the $39 plan or above, and the work is metered on top.',
      },
      {
        q: 'What is GitHub Mission Control?',
        a: 'It is the name GitHub’s blog gave the page where you hand out work and watch the agents doing it. The documentation does not use that name. Look for the Agents tab in a repository, or the Agents page.',
      },
      {
        q: 'Does Agent HQ work with Claude Code?',
        a: 'Not the Claude Code on your machine. It runs GitHub’s hosted version of Anthropic’s agent, billed through your Copilot seat. The copy you already installed and signed in is the one DorkOS drives.',
      },
      {
        q: 'Can it work on a folder that is not on GitHub?',
        a: 'Not this part of it. Agent HQ works on repositories that live on GitHub. DorkOS works on any folder on your machine, whether or not it has ever been pushed anywhere.',
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
      'Devin is the most independent thing on this list. You hand it a ticket and it works in its own cloud machine, with a terminal, an editor and a browser of its own, checking itself as it goes. That power is rented rather than owned: the work happens on Cognition’s computers, your code goes there, and the meter runs on what the agent does. DorkOS makes the opposite trade, with the agents on your own machine, on the plans you already pay for, and nothing for us to meter.',
    theirStrengths: [
      'you want a job done rather than a tool to run, and you are happy for that to be someone else’s computer',
      'you have a backlog of repetitive, similar tickets: migrations, lint sweeps, clean-ups',
      'you want one agent to split a job up, hand out the pieces, and put the results back together',
      'you need the enterprise paperwork: single sign-on, audit logs, access lists, a private install',
    ],
    cells: {
      'your-own-subscriptions': {
        verdict: 'partial',
        note: 'In its desktop editor you run agents you installed yourself, on your own accounts. The cloud Devin most people mean is metered by Cognition.',
        source: 'https://docs.devin.ai/desktop/acp',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'You set its automations up yourself. Nothing puts an agent’s own proposal in front of you first.',
      },
      'spend-guardrails': {
        verdict: 'yes',
        note: 'Each automation can carry a maximum budget per session, and Devin stops the session when it reaches the limit.',
        source: 'https://docs.devin.ai/product-guides/automations',
      },
      'open-and-yours': {
        verdict: 'no',
        note: 'Closed, and it wants an account before anything runs.',
      },
      'approvals-anywhere': {
        verdict: 'yes',
        note: 'Devin asks its questions in Slack and Teams, so you can answer one from a phone.',
        source: 'https://docs.devin.ai/integrations/slack',
      },
      'attention-management': {
        verdict: 'no',
        note: 'Its sessions page shows what is running. There is no separate list of what is waiting on you.',
      },
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
          'This is genuine coordination rather than parallel lanes, and each worker gets a machine of its own. It is a chain of command rather than a conversation, though: the manager talks to its workers, the workers do not talk to each other, and every one of them is a Devin, one company’s agents, all the way down.',
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
        a: 'There is a free tier, Pro at $20 a month and Max at $200. Teams start at $80 a month plus $40 per full seat. Those prices buy an allowance, and heavy use is metered on top, so the bill follows how much work you ask for.',
      },
      {
        q: 'Can Devin run on my own computer?',
        a: 'Partly. There is a command-line version and a desktop editor that work on your local files. The Devin most people mean still runs in Cognition’s cloud, with your code copied there.',
      },
      {
        q: 'Can Devin run Claude Code or Codex?',
        a: 'In its desktop editor, yes: it can host five other agents beside its own. You install those yourself, and Cognition says its terms and billing do not cover them. Devin’s cloud sessions run Devin only.',
      },
      {
        q: 'Why would I use DorkOS instead?',
        a: 'Because you would rather run the agents than rent them. DorkOS starts the Claude Code, Codex or OpenCode already signed in on your machine, on your own files, with no second bill. It is free and open source.',
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
      'Conductor is a beautifully made Mac app for running Claude Code, Codex, Cursor and OpenCode side by side, each in its own copy of your project. Three of the four come built in, with nothing to install. It has the best review screen of anything here: a real diff viewer with comments, and one tab holding your build, your pull request and its comments. What it will not do is start work without you, or let you look in from anywhere except that Mac.',
    theirStrengths: [
      'you only work on a Mac, and do not need something that runs anywhere else',
      'you want reviewing to be first class: a proper diff viewer, comments on the changes, and your build and pull request in one tab',
      'you want the agents to come with the app, with nothing extra to install',
      'you are happy to pay so the work keeps going in their cloud after you close the laptop',
    ],
    cells: {
      'your-own-subscriptions': {
        verdict: 'yes',
        note: 'Running agents on your own Mac uses the sign-ins already there, and costs nothing.',
        source: 'https://www.conductor.build/pricing',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'Nothing here runs on a clock, so there is no repeating job for an agent to ask about.',
      },
      'spend-guardrails': {
        verdict: 'no',
        note: 'Its workspaces are independent and never message each other, so there is no such limit and nothing asking for one.',
      },
      'open-and-yours': {
        verdict: 'no',
        note: 'Running agents on your own Mac is free, and the code is closed.',
      },
      'approvals-anywhere': {
        verdict: 'no',
        note: 'Its prompts live in the Mac app, so answering one means going back to that Mac.',
      },
      'attention-management': {
        verdict: 'no',
        note: 'Its background-tasks view shows when an agent is waiting, and only inside that Mac app.',
      },
      'multi-runtime': {
        verdict: 'yes',
        note: 'Yes. Claude Code, Codex, Cursor and OpenCode all run in it, and the first three are built into the app rather than installed separately.',
        detail:
          'This used to be a Claude Code app and is not one any more: Codex arrived in late 2025, Cursor and OpenCode in mid 2026. Bundling the agents is a real convenience and a real trade, you get whichever version they ship, rather than the one you have installed and signed in yourself. DorkOS goes the other way and drives the copies already on your machine, so your own accounts and settings are the ones in play.',
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
        q: 'Is Conductor free?',
        a: 'Running agents on your own Mac is free, using the accounts you already have. Pro is $50 a month and adds their cloud, shared work and an API. Team seats are $60 per person.',
      },
      {
        q: 'Does Conductor work with Codex?',
        a: 'Yes, and has since late 2025. It runs Claude Code, Codex, Cursor and OpenCode, and three of those are built into the app.',
      },
      {
        q: 'Does Conductor run on Windows?',
        a: 'No. Its own installation page says Windows and Linux are not available yet. DorkOS runs on both, though our Windows build is early and we say so.',
      },
      {
        q: 'Can Conductor run a job on a schedule?',
        a: 'No. There is no scheduler in it, so every job starts because you started it. That is the main thing DorkOS adds if you already like Conductor.',
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
      'Emdash is the closest thing to DorkOS that is also open source, and it is genuinely good: local, free, and built on the same belief that you should run any agent you like under your own accounts. Its documentation lists 34 of them, which is a wider list than DorkOS drives. The two part company after the agents start. Emdash gives each one a clean lane and leaves you as the place they meet. DorkOS puts them in shared rooms, caps how much they may say to each other, and puts the whole thing on a screen you can open from your phone.',
    theirStrengths: [
      'you want the widest choice of agents, because its documentation lists 34 command-line tools',
      'you want to set an outside tool up once and have every agent you installed pick it up',
      'you want the same app on Windows or Linux, not only on a Mac',
      'you want a job to run on another machine over SSH, on your own server or in a container',
    ],
    cells: {
      'your-own-subscriptions': {
        verdict: 'yes',
        note: 'It drives the agents you already installed, so the plan you already pay for does the work.',
        source: 'https://emdash.com/docs/providers',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'You write the automation yourself. Nothing in its documentation lets an agent propose one and wait for your answer.',
      },
      'spend-guardrails': {
        verdict: 'no',
        note: 'Its lanes work alone, so there is no agent chatter to cap and no setting for it.',
      },
      'open-and-yours': {
        verdict: 'yes',
        note: 'Open under the Apache licence, on your own machine, with no Emdash account at all.',
        source: 'https://emdash.com/docs/installation',
      },
      'approvals-anywhere': {
        verdict: 'no',
        note: 'Desktop only. It can send the work to another machine, but you still have to be at your desk to answer it.',
      },
      'attention-management': {
        verdict: 'no',
        note: 'Its task list shows what ran. We found no inbox or notification list gathering the things that need you.',
      },
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
        a: 'The desktop app is free and open source under the Apache licence. There is no pricing page. A hosted version and an enterprise version exist, and both ask you to get in touch rather than showing a price.',
      },
      {
        q: 'What agents does Emdash support?',
        a: 'Its documentation lists 34 command-line agents, including Claude Code, Codex, OpenCode, Cursor, Copilot and Cline. Its home page says "25+", so treat the exact number loosely. Each one has to be installed and signed in on your machine first.',
      },
      {
        q: 'Can Emdash run agents on a schedule?',
        a: 'Yes. Its automations start a job on a repeating schedule and keep a record of every run. If scheduling is the only thing you are shopping for, Emdash covers it.',
      },
      {
        q: 'What does DorkOS do that Emdash does not?',
        a: 'Three things. You can reach DorkOS from a phone, so approving a step does not mean going back to your desk. Its agents share rooms where they can answer each other, with dials capping how much. And an agent has to ask before it books itself a repeating job. Emdash has the wider agent list of the two.',
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
      'Claude Squad does one thing very well: every agent gets its own terminal session and its own copy of your project, so several can work at once without treading on each other. It costs nothing, needs no account, and will run whatever terminal agent you name. What it does not do is anything above that line. No schedule, no way to look in from a phone, no messages between the lanes, and joining the work back up is yours. That upper layer is the whole of what DorkOS is.',
    theirStrengths: [
      'you live in the terminal and want parallel agents without leaving it',
      'you want no account and no server: one small program and a short settings file',
      'you want to run any terminal agent at all, including one released this week, by naming its command',
      'you want what it makes to outlive it: plain terminal sessions and plain git branches',
    ],
    cells: {
      'your-own-subscriptions': {
        verdict: 'yes',
        note: 'It starts whatever agent you name, on the plan or the key you already have.',
        source: 'https://github.com/smtg-ai/claude-squad',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'It has no scheduler, so there is nothing for an agent to ask for.',
      },
      'spend-guardrails': {
        verdict: 'no',
        note: 'Each session is its own lane and none of them talk, so there is nothing to cap.',
      },
      'open-and-yours': {
        verdict: 'yes',
        note: 'Open under the AGPL. One small program, a settings file, no account, and no server.',
        source: 'https://github.com/smtg-ai/claude-squad/blob/main/LICENSE.md',
      },
      'approvals-anywhere': {
        verdict: 'no',
        note: 'Terminal only. Nothing reaches you anywhere else.',
      },
      'attention-management': {
        verdict: 'no',
        note: 'Its list shows your sessions. Whether one is stuck waiting is something you notice by looking.',
      },
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
        a: 'Yes. It is open source under the AGPL, with no account and nothing to buy. You still pay for the agent you run through it, with your own plan or key.',
      },
      {
        q: 'Does Claude Squad work on Windows?',
        a: 'Not reliably. A Windows build exists, but the project’s own issue tracker has an open report that it fails as soon as you start a session. macOS and Linux are where it works.',
      },
      {
        q: 'Can Claude Squad run agents on a schedule?',
        a: 'No. It has no scheduler. Its background mode only answers prompts in sessions you opened yourself. A job that starts on its own is the gap DorkOS fills.',
      },
      {
        q: 'What does DorkOS add over Claude Squad?',
        a: 'A screen you can open from a phone, jobs that start at a set time and message you when they finish, and one list that knows what each session is doing. Claude Squad is lighter, and if you only want parallel lanes in a terminal it is the simpler answer.',
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
    category: 'Service for running agents, with an API',
    oneLiner:
      'Omnara keeps agents running as a service you reach by API or from your phone. DorkOS runs the agents already installed on your own machine.',
    pricing:
      'Free and open source under the Apache licence if you run it yourself. They also sell a hosted version. Its price is not something we can quote: their pricing page came up blank for us, so ask them rather than trusting a number found elsewhere.',
    openSource: true,
    openSourceNote:
      'The platform is open under the Apache licence and you can run the whole thing yourself. The phone apps and the hosted service are not published.',
    verdict:
      'Omnara has changed shape, and that matters more than any row below. It began as a phone command centre for Claude Code and Codex, and those apps still ship. What it leads with now is something else: a way to run agents as a lasting service, with an API, organisations, roles, and machines it can borrow or rent. The real difference is where an agent lives. In Omnara it lives in a control plane and picks up a machine when it needs one, which is why a closed laptop cannot hurt it. In DorkOS the agent is the Claude Code already signed in on your own computer, and it is the screen that travels instead.',
    theirStrengths: [
      'you want an agent that survives a closed laptop or a restart, because its history lives in a database',
      'you are putting agents inside your own product, and want an API rather than a screen',
      'you need teams: organisations, projects, roles, and access handed out one grant at a time',
      'you want the work to run wherever suits: your laptop, your server, or a sandbox made on demand',
    ],
    cells: {
      'your-own-subscriptions': {
        verdict: 'partial',
        note: 'Its phone app steers the Claude Code and Codex on your own laptop, on your own plans. The platform it leads with runs agents you build, on keys you supply.',
        source: 'https://apps.apple.com/us/app/omnara-claude-codex-mobile/id6748426727',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'You create the trigger yourself. Nothing describes an agent asking to schedule itself.',
      },
      'spend-guardrails': {
        verdict: 'no',
        note: 'Agents run as separate conversations, and nothing caps how much they may say to each other.',
      },
      'open-and-yours': {
        verdict: 'partial',
        note: 'Open under the Apache licence, and you can run all of it yourself. The phone apps are not published, and the agent lives in a control plane rather than on your machine.',
        source: 'https://github.com/omnara-ai/omnara',
      },
      'approvals-anywhere': {
        verdict: 'partial',
        note: 'It documents an approvals and questions flow, answered from its dashboard or from Slack. The phone app that steered agents on your own laptop is no longer part of what it documents.',
        source: 'https://docs.omnara.com/events/interactions',
      },
      'attention-management': {
        verdict: 'partial',
        note: 'Its approvals and questions flow gathers what needs an answer, which is close. Whether what you have read stays read across your devices is not something its documentation spells out.',
        source: 'https://docs.omnara.com/events/interactions',
      },
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
        a: 'The service is, under the Apache licence, and you can run all of it on your own machines. They also sell a hosted version. We cannot tell you what that costs: their pricing page came up blank when we checked, so ask them rather than trusting a number found elsewhere.',
      },
      {
        q: 'Does Omnara work with Claude Code?',
        a: 'Through its phone app, yes: it watched and steered Claude Code and Codex on your own laptop. That app was last updated in April, and what Omnara documents today does not mention either agent.',
      },
      {
        q: 'Can Omnara run agents on a schedule?',
        a: 'Yes. A trigger takes an ordinary cron line and a time zone, and starts a fresh agent every time it goes off.',
      },
      {
        q: 'What does DorkOS do differently?',
        a: 'It runs the agents already on your computer, signed in to the plans you already pay for, and keeps the work there. Omnara runs agents you build, on machines it borrows or rents. Which is better depends on whether you are operating agents or shipping them.',
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
      'Amp sells an unusual bargain: you stop choosing. It picks between the frontier models for you, decides how hard to think about a problem, and adds no mark-up to what those models cost. On privacy it is more careful than most, saying plainly that it does not train on your data unless you switch that on. Two things separate it from DorkOS. It runs its own agent only, so Claude Code and Codex stay outside it. And it is built around its own servers, where you sign in and your history lives.',
    theirStrengths: [
      'you would rather not choose a model, because Amp picks between the frontier ones and adds no mark-up',
      'you care where your code goes: Amp says it does not train on your data unless you turn that on',
      'you want long jobs off your own laptop, on machines they run, with hours included in the price',
      'you want to hand a colleague the whole transcript of a piece of work as a link',
    ],
    cells: {
      'your-own-subscriptions': {
        verdict: 'partial',
        note: 'Amp sells you the agent use, and there is no free plan. You can link your own ChatGPT subscription, or bring an Anthropic key, instead of spending its credits.',
        source: 'https://ampcode.com/manual',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'Its agent arranges to wake itself up later, and does not ask you first.',
      },
      'spend-guardrails': {
        verdict: 'no',
        note: 'Its helper agents run inside one piece of work. We found no setting capping what they may spend between them.',
      },
      'open-and-yours': {
        verdict: 'no',
        note: 'Amp itself is closed, and you sign in to use it.',
      },
      'approvals-anywhere': {
        verdict: 'partial',
        note: 'It reaches you in Slack and in a browser on your phone, so a question need not wait for your desk.',
        source: 'https://ampcode.com/news/agents-everywhere',
      },
      'attention-management': {
        verdict: 'no',
        note: 'Its threads list what you have worked on. There is no inbox of things waiting on your answer.',
      },
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
        a: 'Not today. Their pricing page has no free plan. Megawatt is $20 a month, Gigawatt is $200, and students and teachers pay $10. There was a free allowance in the past and it has been cut back since.',
      },
      {
        q: 'Is Amp still part of Sourcegraph?',
        a: 'No. Amp spun out of Sourcegraph into its own company at the end of 2025. Write-ups calling it Sourcegraph’s agent are out of date.',
      },
      {
        q: 'Can I use the plan I already pay for?',
        a: 'Partly. Amp sells you its own agent use, and there is no free plan. You can link your own ChatGPT subscription, or bring an Anthropic key, instead of spending Amp credits.',
      },
      {
        q: 'Why would I use DorkOS instead?',
        a: 'Because you want the agents you already have, on the machine in front of you. DorkOS starts the Claude Code, Codex or OpenCode already signed in, keeps the work local, and costs nothing.',
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
      'Cline is the strongest free answer on this page. The agent is open under the Apache licence, works with your own key and no account, and reaches more models than anything else here, including ones running offline on your own machine. It also does two things people assume only a control screen does: jobs that start on a cron line with no terminal open, and agent teams where a lead hands pieces to specialists. That last one is ahead of where DorkOS is, and we would rather say so. What differs is shape: Cline is one agent in your editor, and DorkOS is the place around the agents you already installed.',
    theirStrengths: [
      'you want a free, open agent that works with your own key and no account at all',
      'you want the widest choice of models, down to one running offline on your own machine',
      'you want the agent inside the editor you already use, or in Zed, Neovim or Emacs',
      'you want agents that already work as a team, with a lead, a shared task board and a mailbox',
    ],
    cells: {
      'your-own-subscriptions': {
        verdict: 'yes',
        note: 'It can sign in through the Claude tool you already installed, so your Claude plan pays for the work. Your own key works too.',
        source: 'https://docs.cline.bot/provider-config/anthropic',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'You save the job yourself. Nothing puts an agent’s proposed schedule in front of you to approve.',
      },
      'spend-guardrails': {
        verdict: 'no',
        note: 'Its agent teams share a task board and a mailbox. We found no setting capping how many messages they may trade.',
      },
      'open-and-yours': {
        verdict: 'yes',
        note: 'Open under the Apache licence, and with your own key it needs no Cline account at all.',
        source: 'https://cline.bot/faq',
      },
      'approvals-anywhere': {
        verdict: 'no',
        note: 'Answering happens in the editor or the terminal in front of you. Its board reaches a phone only if you open it up to your network yourself.',
      },
      'attention-management': {
        verdict: 'no',
        note: 'Its task board runs on your own machine and shows the work. We found no inbox or notification list gathering what is waiting on your answer.',
      },
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
          'Cline is ahead of us on paper here, and it would be silly to pretend otherwise. DorkOS builds a different arrangement: rooms that hold people and agents together, rather than a lead handing work to its workers. What we add on top is a set of dials capping how much your agents may say to each other, which we could not find in theirs. Cline’s teams carry the same limit as its scheduler: the command line and the kit have them, the editor add-ons do not.',
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
        a: 'The agent is, under the Apache licence. You pay only for the models: your own key, credits bought from Cline, or an optional pass at $9.99 a month for a set of open models.',
      },
      {
        q: 'Can Cline run jobs on a schedule?',
        a: 'Yes. You save a job with an ordinary cron line and it keeps running across restarts with no terminal open. One catch: it works from the command line and the developer kit, not from the VS Code or JetBrains add-ons.',
      },
      {
        q: 'Does Cline work with Claude Code?',
        a: 'Not as an agent. It can sign in through the Claude command-line tool so your Claude subscription pays for the work, but Cline is still the one doing it. The actual Claude Code session is what DorkOS runs.',
      },
      {
        q: 'What does DorkOS add over Cline?',
        a: 'A screen you can open from a phone without exposing anything yourself, one list holding Claude Code, Codex and OpenCode side by side, and dials that cap how much your agents may say to each other. Cline is one agent with a great many models.',
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
      'Droid is aimed squarely at companies, and it shows in the good sense: single sign-on, audit trails, data kept in your part of the world, even an install with no way out to the internet. It reaches models from four companies plus a set of open ones, starts work on a cron line or from a Slack message, and its missions plan a large job into milestones and hand the pieces to workers that check each other. It is also closed, starts at $20 a month with no free plan, and runs its own agent rather than yours. DorkOS is the opposite bet: free, open, on your own machine, driving the agents you already signed in to.',
    theirStrengths: [
      'you work somewhere that needs the paperwork: single sign-on, audit trails, data kept in your region',
      'you want one subscription reaching models from four companies, switchable mid-job',
      'you want work to start on a clock, from a Slack message, or from something happening on GitHub',
      'you want a large job planned into milestones and carried out by workers whose output gets checked',
    ],
    cells: {
      'your-own-subscriptions': {
        verdict: 'partial',
        note: 'You can bring your own model keys, but a paid Factory plan is still required, and those keys do not reach its hosted surfaces.',
        source: 'https://docs.factory.ai/cli/byok/overview',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'You set the automation up. No approval step stands between an agent and a repeating job.',
      },
      'spend-guardrails': {
        verdict: 'no',
        note: 'Its missions pass work between workers. We found no dial capping that traffic; the limits it publishes are per plan.',
      },
      'open-and-yours': {
        verdict: 'no',
        note: 'Closed, and an account is required.',
      },
      'approvals-anywhere': {
        verdict: 'partial',
        note: 'It reaches you in Slack, in Teams and on a phone. Whether you can answer an agent mid-run from the phone is not something its documentation spells out.',
        source: 'https://docs.factory.ai/factory-app/overview',
      },
      'attention-management': {
        verdict: 'no',
        note: 'Sessions turn up across its many surfaces. None of them is one list of what is waiting on you.',
      },
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
          'This is a lead agent running a team, not just parallel lanes, and Factory is refreshingly honest about the limits. Their own writing says that doing things in order has beaten running everything at once, and lists whether working in parallel helps at all as a question they are still testing. Worth remembering whenever anyone, ourselves included, sells you a picture of ten agents working at once.',
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
        a: 'No. There is no free plan. Pro is $20 a month, Plus is $100 and Max is $200. You can bring your own model keys, and every individual plan allows some of that before it starts counting.',
      },
      {
        q: 'What is a Factory mission?',
        a: 'A way of handing over a large piece of work. You agree the plan first, broken into features and milestones. Droid then starts worker sessions for the parts, passes work between them through git, and checks each step before moving on.',
      },
      {
        q: 'Does Droid run Claude Code?',
        a: 'No. Droid is its own agent, though it will happily read the CLAUDE.md you already wrote. The Claude Code on your own machine, signed in to your own plan, is what DorkOS drives.',
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
      'This is the closest thing we have found to what DorkOS is trying to be. DeepSeek Harness sits above other coding agents and runs them: install a plugin and it starts a real Claude Code, or a real Codex, as workers inside its own session. Underneath, almost every part is a named piece you can swap out. Two honest things follow. It is very new and says so in capital letters, and every release so far is a release candidate. And it is a harness rather than a place to work from, with nothing that runs while the session is closed and nothing for a phone.',
    theirStrengths: [
      'you want to read the design before you trust it, because nearly every part is a named, swappable piece',
      'you want to replace those parts yourself, down to the model adapter and the loop the agent runs in',
      'you want Claude Code and Codex started through their makers’ own kits',
      'you want one command, a local address, no account, and the MIT licence',
    ],
    cells: {
      'your-own-subscriptions': {
        verdict: 'yes',
        note: 'You bring your own key, and the Claude Code it starts is the one signed in on your machine.',
        source:
          'https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'Its reminders are set by the agent inside a session that is already open, with no approval step, and they do nothing once it closes.',
      },
      'spend-guardrails': {
        verdict: 'no',
        note: 'Its agent teams are marked experimental, and we found no cap on the messages they leave each other.',
      },
      'open-and-yours': {
        verdict: 'yes',
        note: 'Open under the MIT licence. One command, a local address, and no account.',
        source: 'https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE',
      },
      'approvals-anywhere': {
        verdict: 'no',
        note: 'A web page on your own machine and a command line. Its worker runs cannot stop to ask you anything at all.',
      },
      'attention-management': {
        verdict: 'no',
        note: 'Its sessions cannot stop to ask you anything, so there is nothing to collect.',
      },
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
        a: 'An open source agent harness from DeepSeek, started with one command on your own machine. Its idea is that everything is a plugin: the model adapter, the tools, the session log, even the loop the agent runs in.',
      },
      {
        q: 'Does DeepSeek Harness run Claude Code and Codex?',
        a: 'Yes, and it is the most interesting thing about it. Both are separate plugins you install and switch on. Each run is one-shot, though: the agent cannot stop to ask you a question, and only its final answer comes back.',
      },
      {
        q: 'Is DeepSeek Harness ready to rely on?',
        a: 'Its own README answers that in capital letters: it is a developer preview, iterating rapidly, and there will be compatibility-breaking changes. Every version on its releases page so far is a release candidate.',
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
      'Claude Code is an excellent agent, and DorkOS does not try to replace it. DorkOS is the place you run it from: every Claude Code session in one list beside your Codex and OpenCode work, on your own machine, on a screen you can open from your phone. It is worth knowing what people actually do with it. Anthropic studied about 400,000 sessions and found only half were writing or fixing code, while the rest ran software, sorted data and wrote documents.',
    theirStrengths: [
      'you want an agent that can already split a job across several of its own workers',
      'you want work to run with your laptop closed, which its cloud routines do today',
      'you are already paying for a Claude plan, because Claude Code comes with it',
      'you want a deep set of add-ons: skills, hooks, plugins and outside tool connections',
    ],
    cells: {
      'your-own-subscriptions': {
        verdict: 'yes',
        note: 'It is your Claude plan doing the work, which is exactly the arrangement DorkOS keeps.',
        source: 'https://claude.com/pricing',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'You create the routine or the task. Nothing asks your permission on an agent’s behalf.',
      },
      'spend-guardrails': {
        verdict: 'no',
        note: 'Its agent teams are experimental and off until you turn them on. We found no setting capping how much they may say to each other.',
      },
      'open-and-yours': {
        verdict: 'no',
        note: 'Its code is not open, and it needs an Anthropic account.',
      },
      'approvals-anywhere': {
        verdict: 'yes',
        note: 'Its phone app reaches a running session, so you can answer one from anywhere.',
        detail:
          'Worth knowing if you last looked a while ago: in August 2026 Anthropic made Auto mode the default on the Pro, Max and Team plans, so Claude Code stops to ask you less often than it used to. DorkOS shows you where each session stops, and lets you change that for every agent from one panel.',
        source: 'https://code.claude.com/docs/en/mobile',
      },
      'attention-management': {
        verdict: 'no',
        note: 'Its view of background sessions is a research preview showing what is running. There is no cross-device list of what needs you.',
      },
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
        a: 'Yes. DorkOS uses the Claude Code already signed in on your machine, so your plan and your limits are the same as they were yesterday. You can also point one agent, or one chat, at a different Claude account.',
      },
      {
        q: 'Is this only useful for writing code?',
        a: 'No, and Anthropic’s own research says so. Across roughly 400,000 Claude Code sessions, only half were writing or fixing code. The rest ran software, analysed data and wrote documents. People run their inbox, their notes and their week through it, and many hand-build the scaffolding for that themselves: named agents, a schedule, and some way of being asked for approval. Those are the parts DorkOS already ships.',
      },
      {
        q: 'Claude Code can already schedule work. Why add DorkOS?',
        a: 'Because its schedules only ever start Claude Code. DorkOS schedules any of the three agents it drives, on your own machine, and messages you when one finishes or gets stuck.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://claude.com/pricing',
      'https://anthropic.com/research/claude-code-expertise',
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
      'Codex is a strong agent and one of the three DorkOS drives. On its own it already schedules work, runs jobs in the cloud, and reaches you on the web, in Slack and on your phone, so this page is not a list of things it cannot do. What DorkOS adds is the one thing Codex will not do for you: run it beside Claude Code and OpenCode, in a single list, on your own machine. Your ChatGPT plan stays exactly as it is.',
    theirStrengths: [
      'you want an agent whose code you can read, because the command-line tool is open source',
      'you want long jobs running in the cloud while your own machine stays free',
      'you already pay for ChatGPT, or you want to start on the free plan',
      'you want to kick off work from Slack, GitHub or your phone without opening a terminal',
    ],
    cells: {
      'your-own-subscriptions': {
        verdict: 'yes',
        note: 'It is your ChatGPT plan doing the work, or your own key if you would rather.',
        source: 'https://learn.chatgpt.com/docs/pricing',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'You create the automation. There is no step where an agent asks to book one.',
      },
      'spend-guardrails': {
        verdict: 'no',
        note: 'Its parallel jobs never talk to each other, so there is nothing to cap.',
      },
      'open-and-yours': {
        verdict: 'partial',
        note: 'The command-line tool is open under the Apache licence. You still sign in to ChatGPT or bring a key, and the cloud half is closed.',
        source: 'https://github.com/openai/codex',
      },
      'approvals-anywhere': {
        verdict: 'yes',
        note: 'Its iPhone app lets you review changes and approve steps away from your desk.',
        source: 'https://learn.chatgpt.com/docs/changelog?type=codex-app',
      },
      'attention-management': {
        verdict: 'no',
        note: 'Its apps show the jobs you started. There is no single list of things waiting on your answer.',
      },
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
        q: 'Do I need a different ChatGPT plan?',
        a: 'No. DorkOS uses the Codex already set up on your machine, with whatever plan or key you signed in with.',
      },
      {
        q: 'Codex already runs jobs in the cloud. What does DorkOS add?',
        a: 'Cloud jobs run on OpenAI’s machines and only ever run Codex. DorkOS runs work on your own machine, on your real folders, and the same schedule can start Claude Code or OpenCode instead.',
      },
      {
        q: 'Can I run Codex and Claude Code at the same time?',
        a: 'Yes, and that is the point. Each chat in DorkOS picks its own agent, so a Codex job and a Claude Code job run side by side in one list.',
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
      'your-own-subscriptions': {
        verdict: 'yes',
        note: 'Your own keys and your own choice of model, and a model on your own machine costs nothing at all.',
        source: 'https://opencode.ai/docs/providers/',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'There is no scheduler, so there is nothing for an agent to ask about.',
      },
      'spend-guardrails': {
        verdict: 'no',
        note: 'A helper agent answers its own main agent and nobody else, so there is no traffic to limit.',
      },
      'open-and-yours': {
        verdict: 'yes',
        note: 'Open under the MIT licence, no account, and it can work offline against a model on your own machine.',
        source: 'https://github.com/anomalyco/opencode',
      },
      'approvals-anywhere': {
        verdict: 'no',
        note: 'A terminal, a desktop app and an editor extension. All three sit at your desk.',
      },
      'attention-management': {
        verdict: 'no',
        note: 'Nothing here gathers what needs you into one place.',
      },
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
          'The pieces are there if you want to build it: OpenCode runs headless as a server with an HTTP interface, so your computer’s own timer can start a job on a schedule. What you would be signing up for is the plumbing around it, deciding what runs where, keeping a record of what happened, and arranging to hear about it when something needs you.',
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
        a: 'For the things a terminal cannot do: start a job at three in the morning, check on it from your phone, and keep it in one list with your Claude Code and Codex work. DorkOS is free and open source too.',
      },
      {
        q: 'Can these agents do anything besides code?',
        a: 'Yes. They run commands and touch files on your machine, so they can tidy your notes, pull a report together, or send the message once you connect the account. DorkOS is where you watch that happen and say yes before anything lasting.',
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
      'Buzz is Block’s team chat where agents join as members with their own identity. DorkOS is one place for the coding agents you run. This page compares the rooms.',
    pricing:
      'Free and open source under the Apache licence, and you can run the whole thing yourself. Block also runs an early-access server of its own, with no price published.',
    openSource: true,
    verdict:
      'Buzz is not trying to be what DorkOS is, so this page covers only the ground they share: rooms where people and agents talk. On that ground Buzz is strong, and ahead of us in one place. Every member, person or agent, holds their own key, so an identity belongs to whoever holds it. It also hands an agent a new instruction while it is still working, where we make you wait for the turn to end. What Buzz is not is a place to run and watch coding agents.',
    theirStrengths: [
      'you want every person and every agent to hold their own identity, rather than an account on someone else’s service',
      'you want to redirect an agent while it is still working, rather than waiting for the turn to end',
      'you want the chat itself to be something you run and own',
      'you want a desktop app on Mac, Windows and Linux',
    ],
    cells: {
      'your-own-subscriptions': {
        verdict: 'yes',
        note: 'The agent in a channel is one you installed and signed in yourself, so your own plan does the work.',
        source: 'https://github.com/block/buzz/blob/main/docs/remote-agents.md',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'Its workflows are set up by a person. Nothing describes an agent proposing one and waiting for an answer.',
      },
      'spend-guardrails': {
        verdict: 'no',
        note: 'Mentions are lined up per channel, so an agent works through them in turn. We found no setting capping how often agents may reply to each other.',
      },
      'open-and-yours': {
        verdict: 'yes',
        note: 'Open under the Apache licence, and you run the server and the database yourself.',
        source: 'https://github.com/block/buzz',
      },
      'approvals-anywhere': {
        verdict: 'no',
        note: 'Its phone apps are still being wired up, and its own notes say the approval step for scheduled work is unfinished.',
      },
      'attention-management': {
        verdict: 'no',
        note: 'Unread marks live per channel, the way a chat app does it. There is no list of what is waiting on your answer.',
      },
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
          'Agents are members of a channel rather than guests in it: you address one by name, and Buzz lines those mentions up per channel so an agent works through what it was asked in turn. Being straight about the scoreboard, this is the row where Buzz is closest to us, and ahead in one way: it can redirect an agent mid-job, where we make you wait for the turn to finish. What we have that we could not find in Buzz is a set of dials capping how much your agents may say to each other.',
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
        a: 'No. Goose was Block’s coding agent, but Block handed it to the Linux Foundation at the end of 2025. Buzz is a separate, newer Block project, and it is a chat workspace rather than a coding agent. Buzz can run Goose as one of its agents, which is probably where the mix-up starts.',
      },
      {
        q: 'Does Buzz replace Claude Code?',
        a: 'No. It runs Claude Code, or Codex, or Goose, as a member of a channel. The agent doing the work is still the one you already installed.',
      },
      {
        q: 'Can I use Buzz and DorkOS at the same time?',
        a: 'Yes, and they are not after the same job. Buzz is where a team talks. DorkOS is where you start a coding job, watch it run, and pick it up again from your phone.',
      },
      {
        q: 'Whose rooms are further along, honestly?',
        a: 'Buzz wins on one thing that matters: you can send an agent a new instruction while it is still working, and ours make you wait for the turn to finish. Ours answer back with dials that cap how much agents may say to each other, which we could not find in theirs.',
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
      'OpenClaw runs your whole digital life from the chat apps you already use. DorkOS is one place for the coding agents you run. Here is where the two overlap.',
    pricing:
      'Free, and open source under the MIT licence. You run it on your own machine and pay only for the model behind it, on a plan or a key you already have.',
    openSource: true,
    verdict:
      'These are different products with one honest overlap. OpenClaw is a personal assistant that lives in your chat apps and runs your whole digital life: your messages, your files, your calendar, the machine itself. DorkOS is one place for the coding agents you run. Where they meet is that both are yours, both run on your own computer, and both get on with work while you are not watching. If you want one assistant you can reach from WhatsApp, that is OpenClaw, and DorkOS is not competing for the job.',
    theirStrengths: [
      'you want one assistant for your whole digital life, not only the code part of it',
      'you would rather talk to it in WhatsApp or Telegram than open one more app',
      'you want it to run the machine itself, not just a project folder',
      'you want something you can reach from your phone today, through an app you already have',
    ],
    cells: {
      'your-own-subscriptions': {
        verdict: 'yes',
        note: 'You point it at your own plan or your own key, and pay nothing for the assistant itself.',
        source: 'https://github.com/openclaw/openclaw',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'It keeps its own list of jobs, and its documentation does not describe asking you before adding one.',
      },
      'spend-guardrails': {
        verdict: 'no',
        note: 'Its assistants join a group chat only when named. We found no cap on what they may say to each other.',
      },
      'open-and-yours': {
        verdict: 'yes',
        note: 'Open under the MIT licence, and you host it on your own machine.',
        source: 'https://github.com/openclaw/openclaw/blob/main/LICENSE',
      },
      'approvals-anywhere': {
        verdict: 'yes',
        note: 'It asks in whichever chat app you already use, so answering takes nothing new on your phone.',
        source: 'https://github.com/openclaw/openclaw/tree/main/docs/channels',
      },
      'attention-management': {
        verdict: 'no',
        note: 'It messages you in your chat apps, so anything waiting on you is spread across whichever ones you connected.',
      },
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
        a: 'Not really. It can edit files and run commands, so it will certainly touch code, but it is built to be an assistant for everything rather than a tool for working on projects. For a long piece of software work, a coding agent is still the right thing.',
      },
      {
        q: 'Can I use OpenClaw and DorkOS at the same time?',
        a: 'Yes, and they barely overlap in practice. OpenClaw handles your messages and your day. DorkOS runs the coding agents and shows you what they did. Both sit on your own machine.',
      },
      {
        q: 'Who looks after OpenClaw now?',
        a: 'A non-profit. The OpenClaw Foundation was announced in July 2026 to hold the project and keep it independent.',
      },
      {
        q: 'Which one should I pick?',
        a: 'They answer different questions. Want an assistant in your pocket for your whole life? OpenClaw. Want to run several coding agents on real projects and see what happened? DorkOS.',
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
      'Hermes Agent puts an assistant in Telegram, Discord, Slack and more. DorkOS is one place for the coding agents you run. This page sticks to the shared ground.',
    pricing:
      'The agent itself is free and open source, whatever else you buy. Nous sells credits for models and tools on top: a free tier, then $20 a month for Plus, $100 for Super and $200 for Ultra.',
    openSource: true,
    verdict:
      'Hermes Agent and DorkOS both put an agent somewhere you can actually reach it, and that is where the resemblance stops. Hermes lives in your chat apps: you talk to it in Telegram or Slack, it runs jobs on a schedule, and it is free and open under the MIT licence. It is not built around coding agents, so there is no list of sessions and no swapping between Claude Code, Codex and OpenCode. One thing deserves correcting, because older write-ups state it flatly. Hermes used to be the standing example of an agent that would not talk to another agent. Across its chat apps that is still deliberately true, but its desktop app now has a Bot Mode where a few bots pass work to each other, under firm limits.',
    theirStrengths: [
      'you want an assistant inside the chat app you already use, with nothing new to install on your phone',
      'you want to point it at any model you like, including one running on your own hardware',
      'you want scheduled jobs that report back into a chat where other people can see them',
      'you want something that will run happily on a very small server',
    ],
    cells: {
      'your-own-subscriptions': {
        verdict: 'yes',
        note: 'Point it at any model you like, including one on your own hardware. Nous sells credits if you would rather not.',
        source: 'https://github.com/NousResearch/hermes-agent',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'You set the schedule up yourself. No agent asks you for one.',
      },
      'spend-guardrails': {
        verdict: 'partial',
        note: 'Its Bot Mode caps a group of bots at ten messages a turn and three rounds, so a room cannot spin. That is in its desktop app, not its chat platforms.',
        source: 'https://github.com/NousResearch/Hermes-Bot-Mode',
      },
      'open-and-yours': {
        verdict: 'yes',
        note: 'Open under the MIT licence, and it runs on anything from a cheap server upwards.',
        source: 'https://github.com/NousResearch/hermes-agent/blob/main/LICENSE',
      },
      'approvals-anywhere': {
        verdict: 'yes',
        note: 'It lives in your chat apps, so its questions arrive where you already type.',
        source: 'https://github.com/NousResearch/hermes-agent',
      },
      'attention-management': {
        verdict: 'no',
        note: 'It reaches you in chat, so anything waiting on you sits in whichever chat app it used.',
      },
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
          'Worth getting right, because the internet is still repeating the old version. The refusal is real and deliberate, and it is about the chat platforms: their documentation says plainly that setting several Hermes profiles to reply to one another in a shared channel is not a supported arrangement, and the safe default ignores other bots entirely. Then, separately, Bot Mode arrived as a plugin for its desktop app, where a group of two to six bots can pull each other in by name, under hard caps of ten messages a turn and three rounds so a room cannot spin. So the honest summary is not "it cannot" but "not in the places you would first try, and with a ceiling where it can". DorkOS puts agents in shared rooms instead, with a ceiling of your own choosing rather than a fixed one.',
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
        a: 'In the chat apps, no, and that is on purpose: its documentation calls setting two Hermes bots to answer each other an unsupported arrangement. Inside its desktop app there is a Bot Mode where a small group of bots pass tasks to each other for a limited number of rounds. So the old line that Hermes flatly cannot do it is out of date, but the caution behind it is real.',
      },
      {
        q: 'Is Hermes Agent a coding agent?',
        a: 'No. It is a general assistant that happens to be very good at living in chat. For work on a codebase you would still reach for Claude Code, Codex or OpenCode, which is what DorkOS runs.',
      },
      {
        q: 'Can I use Hermes and DorkOS together?',
        a: 'Yes. They want different jobs and neither gets in the other one’s way. Hermes is your assistant in chat, and DorkOS is where coding work runs and gets watched.',
      },
      {
        q: 'Does DorkOS work in Telegram and Slack too?',
        a: 'Yes, for a narrower job: you talk to your agents and get told when something needs you. Hermes reaches more chat apps than we do, and we would rather say so.',
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
    maker: 'SpaceXAI (SpaceX)',
    homepage: 'https://docs.x.ai/grok-bot/overview',
    framing: 'adjacent',
    category: 'Cloud coworker with a computer of its own',
    oneLiner:
      'Grok Bot is SpaceXAI’s cloud coworker with a computer of its own. DorkOS is one place for the coding agents on your machine. Here is the shared ground.',
    pricing:
      'It needs a paid plan, and not the cheapest one. The plans listed as eligible are SuperGrok Plus or SuperGrok Heavy, which the App Store prices at $100 and $300 a month, or on the Cursor side Pro+ at $60, Ultra at $200, or a Teams seat from $40. Plain SuperGrok at $30 and Cursor Pro at $20 are not on that list.',
    openSource: false,
    verdict:
      'Grok Bot and DorkOS both take a job off your hands and carry on without you, and that is about where it stops. Grok Bot is a coworker SpaceXAI runs for you: each bot lives on a cloud computer with a browser, a terminal and files, signs into your tools with your accounts, and keeps working after you shut your laptop. The jobs put forward for it are office ones: sales outbound, recruiting, expenses, a chief of staff. Working on the code in your own repository is not among them. On one row it is plainly ahead of us, because several of its bots run at once and pass a job along today.',
    theirStrengths: [
      'you want a working computer in the cloud, with nothing to install and nothing to keep running yourself',
      'the work you want handed over is sales, recruiting, expenses or reporting rather than code',
      'you already pay for Cursor Pro+, Ultra or a Teams seat, because it comes with those',
      'you want several bots that message each other and pass work along, working now',
    ],
    cells: {
      'your-own-subscriptions': {
        verdict: 'no',
        note: 'It needs a paid Grok or Cursor plan. The Claude or ChatGPT plan you already pay for buys you nothing here.',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'You teach a bot a job and set a routine running. Nothing in its documentation puts a proposed schedule in front of you to approve first.',
      },
      'spend-guardrails': {
        verdict: 'no',
        note: 'Its bots message each other and share one computer. We found no dial capping how much of that they may do.',
      },
      'open-and-yours': {
        verdict: 'no',
        note: 'Closed, and it runs on their computer under a paid plan.',
      },
      'approvals-anywhere': {
        verdict: 'yes',
        note: 'Its iPhone app lets you answer a bot’s questions and approve steps. Editing a routine still sends you back to a desk.',
        source: 'https://docs.x.ai/grok-bot/get-started',
      },
      'attention-management': {
        verdict: 'no',
        note: 'Its app shows each bot and its runs. There is no one list of everything waiting on you.',
      },
      'multi-runtime': {
        verdict: 'no',
        note: 'It is SpaceXAI’s own bot and only that. There is no putting Claude Code on one job and Codex on the next, because the bot is the product.',
      },
      scheduling: {
        verdict: 'yes',
        note: 'Yes. You teach a bot a job once and it keeps that as a skill, and a routine then runs that skill on a schedule, on their computer rather than yours.',
        detail:
          'Worth knowing before you switch one on: their own advice is to test a routine first, and its warning is that a test run performs real work. In its words, it can navigate websites, change files, and call connected tools, so a test is a real send rather than a rehearsal. The difference from ours is where the job runs. Theirs runs in SpaceXAI’s cloud whether or not your laptop is open; ours needs your own machine to be awake.',
        source: 'https://docs.x.ai/grok-bot/skills-routines-and-automations',
      },
      coordination: {
        verdict: 'yes',
        note: 'Yes, and this is the row where it beats us. Several bots run at once, message each other, share context in threads or group chats, and pass ownership of a job along.',
        detail:
          'One thing to know about the shape of it, from their own security page. Every bot on your account uses the same cloud computer, so files and signed-in browser sessions are shared between them, and the page says plainly not to treat separate bots as a security boundary. So it is many bots on one machine rather than many machines. DorkOS puts agents in shared rooms on your own machine, and caps how much they may say to each other.',
        source: 'https://docs.x.ai/grok-bot/overview',
      },
      'local-first': {
        verdict: 'no',
        note: 'No. The work happens on a computer SpaceXAI runs. It can reach your own machine, but only for commands you switch on and approve under a local-computer policy.',
        detail:
          'This is the deepest difference between the two, and neither answer is wrong; they are answers to different questions. Grok Bot’s computer is the product: it is already set up, it holds your files and your signed-in browser sessions between jobs, and turning off what it may do on your laptop does not stop it working in the cloud. DorkOS has no cloud of ours for your work to sit in. Your projects, your sessions and your history stay on your own computer, under the accounts already signed in there.',
      },
      surfaces: {
        verdict: 'yes',
        note: 'Yes. A desktop app for Mac and Windows and an iPhone app, so you can pick a job up from your pocket. There is no Linux desktop app.',
        detail:
          'The phone is a real one rather than a viewer: you can start work, answer a bot’s questions, approve steps and review results from the iPhone app. They are straight about where it stops, though. Some advanced desktop controls and teach-by-demonstration are not on iPhone, and editing a routine’s schedule, changing a bot’s instructions, reviewing run history or deleting a routine all send you back to a desktop. It is iPhone only, too, not iPad or Android. So this row is close rather than level: both let you approve work from your pocket, and theirs asks you to finish some of it at a desk.',
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
        a: 'On some Cursor plans, yes: Pro+, Ultra, and Teams. Plain Cursor Pro, the $20 one, is not on that list. Worth knowing why they are bundled: SpaceX bought Cursor in August 2026, so Grok Bot and Cursor now share an owner. This is one company including its own product, not a deal between two.',
      },
      {
        q: 'Does Grok Bot work with my local code?',
        a: 'Not in the way you probably mean. It works on its own computer in the cloud, and only touches your machine if you switch that on and approve each command. Even then, the jobs put forward for it are office work rather than software work.',
      },
      {
        q: 'Is Grok Bot a coding agent?',
        a: 'No. The eight jobs used to describe it are sales outbound, talent scout, paid media, expense manager, product performance, bug reproduction, account health and chief of staff. Bug reproduction is the closest it gets to software, and even that is about turning a report into steps to follow, not writing the fix.',
      },
      {
        q: 'Can I use Grok Bot and DorkOS together?',
        a: 'Yes, and they are not after the same job. Grok Bot takes the office work. DorkOS is where you start a coding job on your own machine, watch it run, and pick it up from your phone.',
      },
    ],
    lastVerified: '2026-08-24',
    sources: [
      'https://en.wikipedia.org/wiki/SpaceXAI',
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
      'Terragon closed in February 2026, and if you liked it, that was a real loss. You handed it a task, it worked in its own cloud machine against your repository, and you reviewed a pull request at the end. Two things are worth knowing before you pick a replacement. Terragon did not tell anyone where to go next, so the pairing you may have seen suggested online came from a commenter rather than the company. And the code did not vanish: it was published as an open snapshot, so running it yourself is possible, with nobody maintaining it. DorkOS fits if you want agents getting on with work and you reviewing the result. It does not fit if what you liked was that none of it ran on your own computer.',
    cells: {
      'your-own-subscriptions': {
        verdict: 'yes',
        note: 'It did. You brought your own subscription or your own keys, which is the part DorkOS carries on.',
        source: 'https://github.com/terragon-labs/terragon-oss',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'Its automations were set up by a person, never proposed by an agent.',
      },
      'spend-guardrails': {
        verdict: 'no',
        note: 'Its feature list said several agents could work together, without describing any limit on how much.',
      },
      'open-and-yours': {
        verdict: 'partial',
        note: 'The code is open under the Apache licence, and nobody maintains it. While it ran, it was a cloud service you signed in to.',
        source: 'https://github.com/terragon-labs/terragon-oss',
      },
      'approvals-anywhere': {
        verdict: 'no',
        note: 'There was no phone app, and nothing we found describes approving an agent’s action from one.',
      },
      'attention-management': {
        verdict: 'no',
        note: 'It reported into Slack and GitHub, so whatever needed you landed wherever those did.',
      },
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
        note: 'Its own feature list said several agents could work together, though it never said much about what they actually did together.',
        source: 'https://github.com/terragon-labs/terragon-oss',
      },
      'local-first': {
        verdict: 'no',
        note: 'No, and this is the part that mattered most in the end. The work happened on Terragon’s computers, so when the company stopped, the product stopped with it.',
        detail:
          'We are not going to pretend this was a clever argument we made in advance. It is just what happened. A cloud service is someone else’s machine, and when the business behind it winds down, so does the thing you built your week around. The agents DorkOS drives are installed on your own computer, under your own accounts. The worst we can do to you is stop writing the screen around them.',
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
        a: 'No. We looked, because it is the first thing anyone wants to know, and there is no recommendation in what Terragon left behind. If you have seen a product named as the official next step, that came from a commenter on a forum.',
      },
      {
        q: 'Can I still run Terragon myself?',
        a: 'Yes, in the sense that the code is public under the Apache licence and nothing stops you. Nobody is maintaining it, and the snapshot comes with no promise that it is complete, so treat it as a starting point rather than a product.',
      },
      {
        q: 'Is DorkOS just Terragon again?',
        a: 'No, and it would be dishonest to sell it that way. Terragon put the work on its own machines so you never had to think about yours. DorkOS runs the agents on your computer, using the plans you already pay for. If having nothing on your own machine was what you liked, DorkOS is the wrong shape for you.',
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
      'Roo Code was a good agent in the editor, and losing it stung. It shut down on 15 May 2026, and its old address now forwards to a different product. Start with what Roo Code itself said, because the internet has muddled this. Its own notice names exactly two alternatives: Cline, which it was originally forked from, and ZooCode, a fork its community started. Kilo Code is the name you will see most often in write-ups, and Roo Code never named it. Now the honest part about us: DorkOS is not an editor extension and will not put an agent back in your editor. It is the place around agents like that one.',
    cells: {
      'your-own-subscriptions': {
        verdict: 'yes',
        note: 'It did. The extension was free and ran on your own key.',
        source: 'https://github.com/RooCodeInc/Roo-Code',
      },
      'self-scheduling-trust': {
        verdict: 'no',
        note: 'It had no scheduler at all, so there was nothing to approve.',
      },
      'spend-guardrails': {
        verdict: 'no',
        note: 'It handed work to itself, one mode at a time, and nothing capped how much.',
      },
      'open-and-yours': {
        verdict: 'partial',
        note: 'It was open under the Apache licence and ran in your own editor. The repository is archived now, so what is left is code to read.',
        source: 'https://github.com/RooCodeInc/Roo-Code',
      },
      'approvals-anywhere': {
        verdict: 'no',
        note: 'It asked before it changed anything, but only in the editor window on your desk.',
      },
      'attention-management': {
        verdict: 'no',
        note: 'It asked inside the editor, and nothing collected those requests anywhere else.',
      },
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
        a: 'It shut down on 15 May 2026. The repository was archived and made read-only the same day, and the listing in the VS Code Marketplace still carries the shutdown notice.',
      },
      {
        q: 'What did Roo Code tell people to use instead?',
        a: 'Two things, by name: Cline, the project it was originally forked from, and ZooCode, a fork started by its own community. Both are alive today, and that wording is still on the archived repository, so you can check it rather than take our word for it.',
      },
      {
        q: 'Is Kilo Code the official replacement?',
        a: 'Not officially, however often you see it described that way. Kilo Code published a guide for moving over and plenty of people took it, which is fine. It simply is not one of the two Roo Code named.',
      },
      {
        q: 'Does DorkOS replace Roo Code?',
        a: 'No, and we would rather say that plainly than win a click. Roo Code was an agent inside your editor. DorkOS has no editor and no extension: it runs agents like Claude Code and Codex on your machine and gives you one place to watch and schedule them. Most people replacing Roo Code want the editor part back first, and that is Cline, ZooCode or Kilo Code, not us.',
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
