/**
 * Lifecycle stage — drives badge rendering and catalog filtering.
 *
 * `alpha` marks a surface that is built but not yet verified by real users
 * (the demo-claim gate, `meta/positioning-202607/09-gtm-plan.md` §2.0):
 * earlier than `beta`, honest about it on the badge.
 */
export type FeatureStatus = 'ga' | 'beta' | 'alpha' | 'coming-soon';

/**
 * DorkOS product subsystem — used for tab filtering on /features.
 * `runtimes` leads because running every agent tool in one place is the headline
 * story; `marketplace` is the distribution flywheel.
 */
export type FeatureProduct =
  'runtimes' | 'console' | 'tasks' | 'relay' | 'marketplace' | 'mesh' | 'core';

/**
 * Display labels for each product tab on /features.
 * Insertion order is the tab order — lead with the headline subsystems.
 */
export const PRODUCT_LABELS: Record<FeatureProduct, string> = {
  runtimes: 'Runtimes',
  console: 'Console',
  tasks: 'Tasks',
  relay: 'Relay',
  marketplace: 'Marketplace',
  mesh: 'Mesh',
  core: 'Core',
};

/**
 * Feature type — describes what the feature *is* (its nature/function).
 * Used for badges on cards and feature pages.
 */
export type FeatureCategory =
  | 'chat'
  | 'agent-control'
  | 'scheduling'
  | 'messaging'
  | 'integration'
  | 'discovery'
  | 'visualization'
  | 'identity'
  | 'marketplace'
  | 'infrastructure';

/** Display labels for feature type badges. */
export const CATEGORY_LABELS: Record<FeatureCategory, string> = {
  chat: 'Chat',
  'agent-control': 'Agent Control',
  scheduling: 'Scheduling',
  messaging: 'Messaging',
  integration: 'Integration',
  discovery: 'Discovery',
  visualization: 'Visualization',
  identity: 'Identity',
  marketplace: 'Marketplace',
  infrastructure: 'Foundation',
};

/**
 * Wayfinding accent for a product family — a small color-key applied to the
 * product badge (dot + border) and the card hover edge. This is navigation, not
 * decoration: it lets you tell families apart at a scan.
 */
export interface ProductAccent {
  /** Filled dot inside the product badge. */
  dot: string;
  /** Badge border tint. */
  border: string;
  /** Card hover border tint. */
  hover: string;
}

/**
 * Product family → accent classes, drawn only from existing design-system
 * tokens. The four headline families take the four brand hues; the
 * distribution and infrastructure families take a graded neutral scale so all
 * seven stay distinguishable without introducing a new color.
 */
export const PRODUCT_ACCENT: Record<FeatureProduct, ProductAccent> = {
  runtimes: {
    dot: 'bg-brand-orange',
    border: 'border-brand-orange/30',
    hover: 'hover:border-brand-orange/40',
  },
  console: {
    dot: 'bg-brand-blue',
    border: 'border-brand-blue/30',
    hover: 'hover:border-brand-blue/40',
  },
  tasks: {
    dot: 'bg-brand-green',
    border: 'border-brand-green/30',
    hover: 'hover:border-brand-green/40',
  },
  relay: {
    dot: 'bg-brand-purple',
    border: 'border-brand-purple/30',
    hover: 'hover:border-brand-purple/40',
  },
  marketplace: {
    dot: 'bg-charcoal',
    border: 'border-charcoal/30',
    hover: 'hover:border-charcoal/40',
  },
  mesh: { dot: 'bg-warm-gray', border: 'border-warm-gray/30', hover: 'hover:border-warm-gray/40' },
  core: {
    dot: 'bg-warm-gray-light',
    border: 'border-warm-gray-light/40',
    hover: 'hover:border-warm-gray-light/50',
  },
};

/**
 * Product-capture surface — a key into the seeded assets under
 * `/public/product/`. Files resolve by convention:
 * `{surface}-{theme}.png` (still) and, for {@link LOOP_SURFACES}, `{surface}-dark.webm`.
 */
export type ProductSurface =
  | 'agents'
  | 'agent-discovery'
  | 'canvas'
  | 'canvas-editing'
  | 'chat-streaming'
  // Internal media key only, never rendered as words. DOR-1517 retired
  // "cockpit" from everything a visitor reads, but this name keys
  // `cockpit-light.png` in `public/product/manifest.json` and in every
  // archived per-version manifest, so renaming it would orphan that media.
  | 'cockpit'
  | 'control-center'
  | 'gen-ui-tictactoe'
  | 'gen-ui-widgets'
  | 'marketplace'
  | 'mobile-approval'
  | 'mobile-chat'
  | 'mobile-sessions'
  | 'multi-session'
  | 'personality'
  | 'subagents'
  | 'tasks'
  | 'tool-approval'
  | 'topology';

/** Surfaces that ship an animated loop (a dark webm plus a matching dark still poster). */
export const LOOP_SURFACES = [
  'agent-discovery',
  'canvas',
  'canvas-editing',
  'chat-streaming',
  'gen-ui-tictactoe',
  'gen-ui-widgets',
  'mobile-chat',
  'multi-session',
  'personality',
  'subagents',
  'topology',
] as const;

/**
 * Frame chrome for a capture. `desktop` wraps landscape captures in a
 * macOS-style browser frame; `phone` wraps portrait mobile captures in a
 * minimal phone shell (no traffic lights, thin bezel, portrait aspect).
 */
export type ProductFrameVariant = 'desktop' | 'phone';

/**
 * Vertical focal edge for cropped presentation. Some captures leave an empty
 * vertical center (a short conversation), so we bias the frame toward the edge
 * that holds the content: `top` for a streaming reply, `bottom` for an approval card.
 */
export type ProductCrop = 'top' | 'bottom';

/** Real product media for a feature, presented through the shared ProductFrame. */
export interface FeatureMedia {
  /** Capture surface — resolves to files under `/public/product/`. */
  surface: ProductSurface;
  /** Alt text (a11y + SEO). Always required. */
  alt: string;
  /** When true, a media-rich hero autoplays the dark loop; cards and reduced-motion use the still. */
  loop?: boolean;
  /** Focal edge for stills whose content sits at one edge. */
  crop?: ProductCrop;
  /** Frame chrome. Defaults to `desktop`; set `phone` for portrait mobile captures. */
  frame?: ProductFrameVariant;
}

/**
 * A single DorkOS product feature in the feature catalog.
 *
 * This interface is the authoritative source of truth for feature metadata.
 * TypeScript data is authoritative — MDX files (if added) only contribute body content.
 */
export interface Feature {
  /** URL key — immutable, lowercase-kebab. Used in /features/[slug] route. */
  slug: string;
  /** Display name, e.g. "Tasks Scheduler". */
  name: string;
  /** DorkOS product subsystem — used for tab filtering on catalog index. */
  product: FeatureProduct;
  /** Feature type — describes what this feature is (chat, scheduling, etc.). */
  category: FeatureCategory;
  /**
   * Benefit one-liner ≤80 chars.
   * Used in card hooks, OG title suffix. Must be benefit-led, not feature-led.
   */
  tagline: string;
  /**
   * Meta-description ready copy: 120-160 chars, problem-first.
   * This is the text used in `<meta description>` and OG description.
   */
  description: string;
  /** Lifecycle stage — drives badge rendering and catalog filtering. */
  status: FeatureStatus;
  /**
   * If true, this feature appears in the homepage FeatureCatalogSection.
   * Maximum 6 featured features at any time.
   */
  featured?: boolean;
  /**
   * 3-5 concrete capability statements, ≤12 words each.
   * Used in benefits bullets on feature pages and in JSON-LD featureList.
   */
  benefits: string[];
  /**
   * A grounded, two-sentence moment: what actually happens for the user.
   * Rendered as a callout on the detail page. Optional — omit gracefully.
   */
  moment?: string;
  /** Optional real product media. */
  media?: FeatureMedia;
  /**
   * Optional slug linking to a Fumadocs MDX collection entry.
   * When present, the MDX body renders below the structured section on the feature page.
   * This layer is deferred — do not implement in this spec.
   */
  mdxSlug?: string;
  /**
   * Explicit link to a real docs page, e.g. '/docs/guides/task-scheduler'.
   * Not derived — must map to an existing MDX page under `docs/` (guarded by a test).
   * Omit when no documentation page covers the feature.
   */
  docsUrl?: string;
  /** Other feature slugs for cross-linking on the feature page. */
  relatedFeatures?: string[];
  /** Display order within category (lower = first). Defaults to insertion order. */
  sortOrder?: number;
}

/** The complete DorkOS feature catalog, sorted by category then sortOrder. */
export const features: Feature[] = [
  // === RUNTIMES ===
  {
    slug: 'every-agent-one-place',
    name: 'Every Agent, One Place',
    product: 'runtimes',
    category: 'agent-control',
    tagline: 'Claude Code, Codex, and OpenCode, all on one screen',
    description:
      'Claude Code, Codex, and OpenCode are three different AI coding tools. DorkOS puts all three in one place, so you pick the right one for each job.',
    status: 'ga',
    featured: true,
    benefits: [
      'Run Claude Code, Codex, and OpenCode side by side',
      'Pick a different tool for each job, not just at setup',
      'One list shows every session and how much room it has left',
      'They write the code, send the email, and plan the week',
      "Never build your week around one company's tool",
    ],
    moment:
      'You open the same screen you always do. One session runs on Claude Code, the next on Codex, a third on OpenCode, and you never had to leave the tab to switch.',
    media: {
      surface: 'multi-session',
      alt: "Four DorkOS sessions running side by side, each showing whether it's working or done",
      loop: true,
    },
    docsUrl: '/docs/guides/runtimes',
    relatedFeatures: ['chat-interface', 'session-durability', 'agent-identity'],
    sortOrder: 1,
  },
  {
    slug: 'runtime-accounts',
    name: 'Claude Accounts',
    product: 'runtimes',
    category: 'agent-control',
    tagline: 'Bill one agent, or one chat, to a different Claude account',
    description:
      'Work and personal on one machine gets awkward. Add more than one Claude account, then say which one an agent bills, or which one a single chat bills.',
    status: 'ga',
    benefits: [
      'Add more than one Claude account in Settings',
      'Pin an agent to the account that should pay for it',
      'Send one chat to a different account, just this once',
      'Switch accounts without restarting anything',
      'Once a chat has started, its account never changes',
    ],
    moment:
      'Your work agent bills the work account, and your side project bills your own. You choose once per agent, and every session it starts follows that choice.',
    relatedFeatures: ['every-agent-one-place', 'control-center', 'workspaces'],
    sortOrder: 2,
  },

  // === CONSOLE ===
  {
    slug: 'team-room',
    name: 'Team Room',
    product: 'console',
    category: 'messaging',
    tagline: 'Open DorkOS and land in one room with every agent you run',
    description:
      'A dashboard of tiles tells you nothing. DorkOS opens on #team, a room holding you and every agent you run, so you start by talking, not hunting.',
    status: 'ga',
    benefits: [
      'Open DorkOS and land in a room with your whole team',
      'The sidebar leads with whatever is waiting on you',
      'Press ⌘K to jump to any conversation by name',
      'One line of news when you come back after hours away',
      'The room marks real events, like a new agent joining',
    ],
    moment:
      'You come back after a few hours and open DorkOS. The room greets you with one line on what got done while you were gone, and anything waiting on you sits at the top of the sidebar.',
    media: {
      surface: 'cockpit',
      alt: 'The DorkOS Home tab open on the #team room, with every agent listed in the sidebar',
      crop: 'top',
    },
    docsUrl: '/docs/concepts/rooms',
    relatedFeatures: ['rooms', 'chat-interface', 'agent-identity', 'agent-attribution'],
    // First in the Console tab: it is the screen you land on.
    sortOrder: 0,
  },
  {
    slug: 'chat-interface',
    name: 'Chat Interface',
    product: 'console',
    category: 'chat',
    tagline: 'Watch your agent work in a browser tab, not a terminal window',
    description:
      'Stop opening a terminal to check on your agent. The Console gives every session a chat window in your browser, with live updates as the agent works.',
    status: 'ga',
    benefits: [
      'Live output streams in as the agent writes it',
      'Big jobs split into several agents working at once',
      'Expand any step to see exactly what it did',
      'Come back anytime and the history is still there',
      'Works from any browser: laptop, phone, or tablet',
    ],
    moment:
      'You ask for one change and the session splits into a few agents working at the same time. You watch them go, and the whole job finishes faster than one agent alone could manage.',
    media: {
      surface: 'subagents',
      alt: "A DorkOS chat session with several agents working at once, each showing what it's doing",
      loop: true,
    },
    relatedFeatures: ['session-durability', 'tool-approval', 'question-prompts', 'file-uploads'],
    sortOrder: 1,
  },
  {
    slug: 'mobile',
    name: 'DorkOS on Your Phone',
    product: 'console',
    category: 'agent-control',
    tagline: 'Real work from your phone, not just a screen to watch',
    description:
      'Most tools give your phone a read-only view. DorkOS runs real sessions in any phone browser, so you can watch live and answer your agents on the go.',
    status: 'ga',
    featured: true,
    benefits: [
      'Watch sessions stream live from your phone',
      'Approve or say no to an agent action on the go',
      'Add DorkOS to your home screen, like an app',
      'Get a push alert when an agent needs you',
      'Stop a run from your phone if it goes wrong',
    ],
    moment:
      "You're on the train when an agent stops to ask before touching something risky. You read what it wants to do on your phone, say yes, and it keeps going.",
    media: {
      surface: 'mobile-sessions',
      alt: 'The DorkOS screen on a phone, showing a live session and a pending approval',
      frame: 'phone',
    },
    relatedFeatures: ['chat-interface', 'tool-approval', 'tunnel'],
    sortOrder: 2,
  },
  {
    slug: 'session-durability',
    name: 'Session Durability',
    product: 'console',
    category: 'infrastructure',
    tagline: 'Refresh, restart, reconnect: your session is right where you left it',
    description:
      'Refresh the tab, swap to your phone, restart the server: nothing is lost. Every message replays in order, so a live session survives the interruption.',
    status: 'ga',
    featured: true,
    benefits: [
      'Every message replays in the order it happened',
      'Refresh or reconnect with nothing lost',
      'Pick up on any device, mid-conversation',
      'Every open tab stays in sync automatically',
    ],
    moment:
      'You lose Wi-Fi mid-run and the tab goes quiet. A minute later it reconnects, and the session is exactly where it was, every message still in place.',
    media: {
      surface: 'chat-streaming',
      alt: 'A DorkOS session streaming output that survives a refresh or reconnect',
      loop: true,
      crop: 'top',
    },
    docsUrl: '/docs/concepts/sessions',
    relatedFeatures: ['chat-interface', 'every-agent-one-place', 'canvas'],
    sortOrder: 3,
  },
  {
    slug: 'canvas',
    name: 'Canvas',
    product: 'console',
    category: 'visualization',
    tagline: 'A Notion-style editor beside the chat, saving straight to real files',
    description:
      'Your agent opens a document beside the chat, and you edit it like Notion: type live, watch the formatting appear, and every keystroke saves to disk.',
    status: 'ga',
    benefits: [
      'Type and format live, Notion-style, as you write',
      'Markdown formatting renders the moment you type it',
      'Every edit saves straight to the file on disk',
      'The agent follows your changes in the same document',
      "Works no matter which agent tool you're running",
    ],
    moment:
      'You open the design doc beside the chat and start typing, and the markdown formats itself as you go. You fix a heading and rename a value, and the file on disk already has your edits.',
    media: {
      surface: 'canvas-editing',
      alt: 'A DorkOS canvas document being edited live with markdown formatting, backed by a file on disk',
      loop: true,
    },
    relatedFeatures: ['chat-interface', 'file-uploads'],
    sortOrder: 4,
  },
  {
    slug: 'workbench',
    name: 'Workbench',
    product: 'console',
    category: 'visualization',
    tagline: 'A terminal, your files, and a browser, right beside the chat',
    description:
      'Stop alt-tabbing to check what your agent did. Open a real terminal, browse and edit project files, and preview pages without leaving DorkOS.',
    status: 'ga',
    benefits: [
      "Run a real shell in your session's working directory",
      'Open several terminals in tabs; they survive a page refresh',
      'Browse, create, rename, and edit project files in place',
      'Preview any URL, local page, or dev server in an embedded browser',
      'Agents can open files, reveal the terminal, or drive the browser',
    ],
    moment:
      'Your agent says the tests pass. You pop open the Terminal tab, run one command to double-check, and close it, without ever leaving the session.',
    docsUrl: '/docs/guides/workbench',
    relatedFeatures: ['canvas', 'chat-interface'],
    sortOrder: 5,
  },
  {
    slug: 'tool-approval',
    name: 'Tool Approval',
    product: 'console',
    category: 'agent-control',
    tagline: "Say yes or no to an agent's action, before it happens",
    description:
      'Sometimes an agent should check with you first. Tool Approval shows what it wants to do, in real time, so you stay in control without slowing it down.',
    status: 'ga',
    benefits: [
      'See the exact file and action before you decide',
      'Approve one action, or approve everything for a session',
      'Answer from the header, the sidebar, or the home screen',
      'If you step away, the agent keeps going after a short wait',
      'Get the same prompt in Slack or Telegram',
    ],
    moment:
      'Your agent pauses before it changes a database file and asks first. You see the exact file and what it wants to do, tap approve, and it keeps moving.',
    media: {
      surface: 'tool-approval',
      alt: 'A DorkOS approval prompt showing the file and action, with approve and deny buttons',
      crop: 'bottom',
    },
    docsUrl: '/docs/guides/tool-approval',
    relatedFeatures: ['chat-interface', 'slack-adapter', 'telegram-adapter', 'action-approvals'],
    sortOrder: 5,
  },
  {
    slug: 'action-approvals',
    name: 'Action Approvals',
    product: 'console',
    category: 'agent-control',
    tagline: 'An agent asks before it does something you cannot take back',
    description:
      'Removing a package, deleting a scheduled task, removing an agent: before any of those run, DorkOS puts a card in front of you and waits for your answer.',
    status: 'ga',
    benefits: [
      'Read what would run, in plain words, before deciding',
      'One yes covers one exact action, then it is spent',
      'Answer from a Telegram or Slack message, not just the app',
      'Only the person you name gets asked, not every chat',
      'Say yes right from the notification banner on your Mac',
    ],
    moment:
      'Your agent wants to remove a package, saved data and all. A marker appears in the header wherever you happen to be, you read the one sentence describing it, and you decide.',
    docsUrl: '/docs/guides/action-approvals',
    relatedFeatures: ['tool-approval', 'agent-attribution', 'capability-catalog', 'marketplace'],
    sortOrder: 6,
  },
  {
    slug: 'agent-attribution',
    name: 'Agent Attribution',
    product: 'console',
    category: 'identity',
    tagline: 'See which agent ran a DorkOS action, not just that it happened',
    description:
      'When several agents share one DorkOS, "something changed" is no answer. Your feed names the agent behind each DorkOS action it can attribute.',
    status: 'ga',
    benefits: [
      'DorkOS actions a Claude Code or Codex agent runs are named',
      'Refused and waiting attempts are recorded too',
      'See what an agent tried, not only what it finished',
      'Filter the feed down to agent activity alone with one flag',
    ],
    moment:
      'A setting is not what you left it as. You open your activity feed and it names the agent, the change, and the minute, so you know who to go ask.',
    docsUrl: '/docs/guides/operating-dorkos',
    relatedFeatures: ['action-approvals', 'agent-identity', 'capability-catalog'],
    sortOrder: 7,
  },
  {
    slug: 'question-prompts',
    name: 'Question Prompts',
    product: 'console',
    category: 'agent-control',
    tagline: "Agents ask questions when they're stuck; you answer from anywhere",
    description:
      'When an agent needs to know something, it asks instead of guessing. Answer in the Console, Slack, or Telegram, and the agent picks up right away.',
    status: 'ga',
    benefits: [
      'Multiple-choice questions, so answering takes one tap',
      'Answer from the Console, Slack, or Telegram',
      'Every past answer is saved in the conversation',
      'The agent picks up the moment you answer',
    ],
    docsUrl: '/docs/concepts/answering-agents',
    relatedFeatures: ['chat-interface', 'tool-approval'],
    sortOrder: 6,
  },
  {
    slug: 'file-uploads',
    name: 'File Uploads',
    product: 'console',
    category: 'chat',
    tagline: 'Drop a file into the chat, and your agent reads it',
    description:
      'Paste a spec, attach a screenshot, or upload a log file. File uploads give your agent what it needs without copying and pasting into a terminal.',
    status: 'ga',
    benefits: [
      'Drag a file in, or click to choose one',
      'Files show up right in the conversation',
      'Works with images, PDFs, text, and code files',
    ],
    relatedFeatures: ['chat-interface', 'canvas'],
    sortOrder: 7,
  },
  {
    slug: 'workspaces',
    name: 'Workspaces',
    product: 'console',
    category: 'agent-control',
    tagline: 'Point a session at a project, and the right agent is already there',
    description:
      'Bind a workspace to a project folder, and the right agent loads with it already there. No re-explaining which project you mean, every time you start.',
    status: 'ga',
    benefits: [
      'Link a session to a project folder',
      'The right agent loads for the right project automatically',
      "No need to re-explain which project you're working in",
      'Each workspace keeps its own settings and context',
    ],
    moment:
      'You open a session for the API project and the right agent is already loaded. You never had to point it at the folder again; the workspace remembered for you.',
    docsUrl: '/docs/guides/workspaces',
    relatedFeatures: ['chat-interface', 'every-agent-one-place'],
    sortOrder: 8,
  },
  {
    slug: 'generative-ui',
    name: 'Generative UI',
    product: 'console',
    category: 'visualization',
    tagline: 'Your agent replies with charts and buttons you can click, not walls of text',
    description:
      'Long replies are slow to read. Generative UI lets your agent answer with a live card instead: stats, a chart, a timeline, and buttons you can click.',
    status: 'ga',
    benefits: [
      'Compose widgets from a 24-piece catalog: stats, charts, tables, timelines',
      'Buttons and forms send your choice straight back to the agent',
      'Invalid widget JSON shows a friendly error card, never breaks chat',
      'Claude Code, Codex, and OpenCode all render widgets the same way',
    ],
    moment:
      "You're waiting on a build, so you challenge your agent to tic-tac-toe right in the chat. You click a square, your mark draws itself, and the agent's comeback streams in with the win-line already drawn.",
    media: {
      surface: 'gen-ui-tictactoe',
      alt: 'A DorkOS chat session playing tic-tac-toe against the agent, with a drawn win-line and a celebrating mood face',
      loop: true,
    },
    docsUrl: '/docs/guides/generative-ui',
    relatedFeatures: ['chat-interface', 'canvas'],
    sortOrder: 9,
  },
  {
    slug: 'notifications',
    name: 'Notifications',
    product: 'console',
    category: 'agent-control',
    tagline: 'Get pinged when an agent needs you, and answer from the alert itself',
    description:
      "An agent waiting on you in another tab is easy to miss. Notifications sound a soft knock, alert your desktop, and escalate to your phone if you don't answer.",
    status: 'ga',
    benefits: [
      'One Inbox in the top right holds every alert, read or not',
      'A soft knock sound plays the moment an agent needs you',
      'Answer right from the desktop notification banner on Mac',
      'No response in a couple minutes escalates to your phone',
      'A daily Shift Report catches you up on what you missed',
    ],
    moment:
      'You come back from lunch to a Shift Report on Home summing up what happened while you were away. Later, an agent proposes a new schedule on a card showing who asked, why, and the exact times, with a test run before you approve it.',
    relatedFeatures: ['team-room', 'tool-approval', 'task-scheduler', 'question-prompts'],
    sortOrder: 10,
  },
  {
    slug: 'control-center',
    name: 'Control Center',
    product: 'console',
    category: 'agent-control',
    tagline: "Check and change every agent's power settings, in one panel",
    description:
      'Power settings hide across Settings, Runtimes, and Tasks. Control Center puts every dial in one panel, open with ⌘⇧L from anywhere in DorkOS.',
    status: 'ga',
    benefits: [
      'See where new sessions stop for approval, at a glance',
      'Let agents message across projects with one switch',
      "Make 'stop asking' stick for one agent, one action",
      'Keep agents warm between messages, and cap concurrent scheduled runs',
      'An Exceptions list links straight to what to fix',
    ],
    moment:
      "You open Control Center to check who's running at full power. Two sessions show up in Exceptions, each one a click from the setting that put them there.",
    media: {
      surface: 'control-center',
      alt: 'The DorkOS Control Center panel open over the main screen, showing where new sessions stop for approval and the switches under it',
      crop: 'top',
    },
    relatedFeatures: [
      'tool-approval',
      'action-approvals',
      'every-agent-one-place',
      'task-scheduler',
    ],
    sortOrder: 11,
  },
  {
    slug: 'notification-inbox',
    name: 'Inbox',
    product: 'console',
    category: 'agent-control',
    tagline: 'One list of everything waiting on you, and everything that happened',
    description:
      'Alerts spread across tabs are easy to miss. One bell holds every question, approval and finished run, and what you have read stays read on every device.',
    status: 'ga',
    benefits: [
      'One bell holds every question, approval, and finished run',
      'Read it on your laptop, and your phone agrees',
      'Things waiting on you sit above things that merely happened',
      'Press ⌘⇧Y to jump to the next thing waiting on you',
      'Every agent has its own page of alerts, if you want it',
    ],
    moment:
      'You come back to a bell with a number on it. Two agents finished, one is waiting on an answer, and the waiting one is at the top. You clear it on your laptop, and your phone already agrees.',
    relatedFeatures: ['notifications', 'escalation-ladder', 'action-approvals', 'activity-feed'],
    sortOrder: 12,
  },
  {
    slug: 'escalation-ladder',
    name: 'Alerts That Reach You',
    product: 'console',
    category: 'agent-control',
    tagline: 'If nobody answers, the alert moves to your phone',
    description:
      'An agent stuck waiting on you is easy to miss. When a question sits unanswered for a few minutes, DorkOS sends it to your phone and your chat apps.',
    status: 'ga',
    benefits: [
      'A question nobody answers rings your phone',
      'You pick the wait: one, two, five, or fifteen minutes',
      'Turn the chasing off entirely if you would rather not be chased',
      'Answering inside DorkOS calls off the chase',
      'A daily Shift Report sums up the last day',
    ],
    moment:
      'You step away and miss a question. Two minutes later your phone buzzes with it. You open DorkOS, answer, and the chasing stops.',
    relatedFeatures: ['notification-inbox', 'notifications', 'mobile', 'telegram-adapter'],
    sortOrder: 13,
  },
  {
    slug: 'activity-feed',
    name: 'Activity Feed',
    product: 'console',
    category: 'visualization',
    tagline: 'A running record of what your agents did, and when',
    description:
      'With several agents on one machine, "something changed" is no answer. The feed lists what happened, grouped by day, with the past week drawn at the top.',
    status: 'ga',
    benefits: [
      'See what happened, newest first, grouped by day',
      'Narrow it to tasks, messages, agents, settings, or system',
      'A small bar chart shows the last seven days at a glance',
      'A banner catches you up on what changed since your last visit',
      'Send someone a filtered view: the address carries the filter',
    ],
    moment:
      'You open the feed after a day away. A bar chart shows the week, a banner sums up what changed since you last looked, and the list below says who did what.',
    relatedFeatures: ['agent-attribution', 'notification-inbox', 'team-room'],
    sortOrder: 14,
  },
  {
    slug: 'message-search',
    name: 'Message Search',
    product: 'console',
    category: 'discovery',
    tagline: 'Find any message by what was said in it, across every agent',
    description:
      'You remember the sentence, not where you said it. One search reads your channels, your DMs, and every Claude Code, Codex and OpenCode conversation.',
    status: 'ga',
    benefits: [
      'Press Cmd-Shift-F and type what you remember somebody saying',
      'Covers rooms, Claude Code, Codex and OpenCode at once',
      'Reads chats you had outside DorkOS, in the plain CLI',
      'Click a result and land on that exact message',
      'Never indexes tool output or file contents, only what was said',
    ],
    moment:
      'You half-remember deciding something about retries, weeks ago, in some chat. One search finds the sentence, and one click puts you on the line that said it.',
    relatedFeatures: ['team-room', 'chat-interface', 'agent-memory', 'activity-feed'],
    sortOrder: 15,
  },

  // === TASKS ===
  {
    slug: 'task-scheduler',
    name: 'Scheduled Tasks',
    product: 'tasks',
    category: 'scheduling',
    tagline: "Schedule agents to run on their own, so they work while you don't",
    description:
      'Stop manually starting every agent run. A scheduled task puts any agent on any timetable, with a visual builder, ready-made presets, and a full history.',
    status: 'ga',
    featured: true,
    benefits: [
      'Build a schedule by picking days and times, no code needed',
      'Every schedule says which agent asked for it, and why',
      'A scheduled run never gets more power than you allowed',
      'See every run: its status, how long it took, what happened',
      'A crash or a restart does not lose your schedules',
    ],
    moment:
      'At 2:47am a dependency alert lands. Your nightly check has already read it, opened the fix, and left a note waiting for you at breakfast.',
    docsUrl: '/docs/guides/task-scheduler',
    media: {
      surface: 'tasks',
      alt: 'The Scheduled tasks list showing each task with its next run time and history',
      crop: 'top',
    },
    relatedFeatures: ['relay-message-bus', 'mesh-agent-discovery'],
    sortOrder: 1,
  },
  {
    slug: 'schedule-approvals',
    name: 'Schedule Approvals',
    product: 'tasks',
    category: 'scheduling',
    tagline: 'An agent has to ask before it books itself a repeating job',
    description:
      'An agent that can schedule itself is a surprise bill waiting to happen. Here it has to ask first, and you see who asked, why, and what would run.',
    status: 'ga',
    benefits: [
      'See which agent asked, and the reason it gave',
      'Read the exact instructions before you agree',
      'See the next three run times, worked out for you',
      'Run it once, supervised, before you agree to it forever',
      'Reject by mistake and you get a few seconds to undo',
    ],
    moment:
      'An agent proposes a nightly clean-up. The card names it, quotes the reason it gave, shows the next three run times, and lets you try it once before you decide.',
    docsUrl: '/docs/guides/task-scheduler',
    relatedFeatures: ['task-scheduler', 'action-approvals', 'control-center', 'notification-inbox'],
    sortOrder: 2,
  },

  // === RELAY ===
  {
    slug: 'relay-message-bus',
    name: 'Relay Messaging',
    product: 'relay',
    category: 'messaging',
    tagline: 'Your agents can message you, and each other, wherever you already chat',
    description:
      'Relay connects your agents to you and to each other. It routes messages to Telegram, Slack, and more, so no agent is working in silence.',
    status: 'ga',
    featured: true,
    benefits: [
      'Agents can message you, or message each other',
      'If an agent is offline, the message waits and delivers later',
      'Cap how often your agents may ping you, so it stays quiet',
      'See every message that was sent, and every one that failed',
      'Point specific agents at specific chats',
    ],
    moment:
      "Your deploy finishes while you're away from your desk. A Telegram message arrives with the result, and you answer its one question from the couch.",
    docsUrl: '/docs/concepts/relay',
    relatedFeatures: ['rooms', 'slack-adapter', 'telegram-adapter', 'mesh-agent-discovery'],
    sortOrder: 1,
  },
  {
    slug: 'rooms',
    name: 'Rooms',
    product: 'relay',
    category: 'messaging',
    tagline: 'Talk with several agents at once, in channels and direct messages',
    description:
      'One chat with one agent only goes so far. Rooms give you channels and direct messages where you and several agents talk in one place.',
    status: 'ga',
    benefits: [
      'Make a channel and invite the agents you want',
      'Ask one agent, or the whole room, in one message',
      'Reply in a thread so a side topic stays put',
      'Set how often agents can reply, per room, or turn it off',
      'Direct-message a single agent when it is just the two of you',
    ],
    moment:
      'You ask a question in your #deploys channel. Two agents pick it up, one answers in a thread, and the whole exchange stays in one place you can read end to end.',
    docsUrl: '/docs/concepts/rooms',
    relatedFeatures: [
      'relay-message-bus',
      'team-room',
      'mesh-agent-discovery',
      'room-reply-limits',
    ],
    sortOrder: 2,
  },
  {
    slug: 'room-reply-limits',
    name: 'Reply Limits',
    product: 'relay',
    category: 'agent-control',
    tagline: 'Agents talk to each other without running up a bill',
    description:
      'Agents answering agents can loop all night. Four dials cap the replies they may trade: in a row, from one agent, per room each hour, and everywhere each hour.',
    status: 'ga',
    benefits: [
      'Cap how many replies your agents may trade in a row',
      'Cap how much of one conversation a single agent may take',
      'Cap replies per room each hour, and across every room',
      'Set the dials once, or set them room by room',
      'No room can skip the hourly cap that covers everything',
    ],
    moment:
      'Two agents get into a back-and-forth in a channel. The chain hits the limit you set, DorkOS stops it there, and leaves a note in the room saying why.',
    docsUrl: '/docs/concepts/rooms',
    relatedFeatures: ['rooms', 'relay-message-bus', 'control-center'],
    sortOrder: 3,
  },
  {
    slug: 'slack-adapter',
    name: 'Slack Adapter',
    product: 'relay',
    category: 'integration',
    tagline: 'Chat with your agents in Slack, with no tab-switching',
    description:
      'The Slack adapter connects Relay to your Slack workspace. Send messages, get updates, and approve agent actions without ever leaving Slack.',
    status: 'ga',
    benefits: [
      'Message agents from any Slack channel',
      'Watch agent replies stream in, right in Slack',
      'Approve or answer agent questions with a Slack button',
      'Point specific agents at specific Slack channels',
    ],
    relatedFeatures: ['relay-message-bus', 'tool-approval'],
    sortOrder: 4,
  },
  {
    slug: 'telegram-adapter',
    name: 'Telegram Adapter',
    product: 'relay',
    category: 'integration',
    tagline: 'Check on your agents and send them commands, from Telegram',
    description:
      'The Telegram adapter gives every agent its own Telegram bot. Watch runs, get notified, and send commands, all from your phone.',
    status: 'ga',
    benefits: [
      'Watch full agent replies stream in Telegram',
      'Approve actions right from a Telegram button',
      'Point specific agents at specific Telegram chats',
      'Works anywhere: check on agents from your phone',
    ],
    relatedFeatures: ['relay-message-bus', 'tool-approval'],
    sortOrder: 5,
  },

  // === MARKETPLACE ===
  {
    slug: 'marketplace',
    name: 'Marketplace',
    product: 'marketplace',
    category: 'marketplace',
    tagline: 'Install a working agent, plugin, or skill in one command',
    description:
      'Browse agents, plugins, and skills, then install them in one click or one command. What you find over coffee becomes something that actually runs.',
    status: 'ga',
    featured: true,
    benefits: [
      'Browse agents, plugins, skills, and connectors',
      'Install from the screen or straight from the command line',
      'Each install stays scoped to one project, so nothing leaks',
      'Claude Code and Cursor can browse and install from it too',
    ],
    moment:
      "You read about a code-review agent over coffee and install it before the cup is empty. One command later, it's running, with nothing to set up by hand.",
    media: {
      surface: 'marketplace',
      alt: 'The DorkOS marketplace browsing featured agents, plugins, and skill packs with install buttons',
      crop: 'top',
    },
    docsUrl: '/docs/marketplace',
    relatedFeatures: ['mcp-server', 'cli', 'shapes'],
    sortOrder: 1,
  },
  {
    slug: 'shapes',
    name: 'Shapes',
    product: 'marketplace',
    category: 'marketplace',
    tagline: 'Install a whole DorkOS setup, not just one piece of it',
    description:
      'Setting DorkOS up the way someone else did takes ages. A Shape packs the layout, the add-ons, the suggested agents and the schedules into one install.',
    status: 'ga',
    benefits: [
      'One install brings a layout, add-ons, agents, and schedules',
      'Installing changes nothing until you choose to apply it',
      'Agents are offered to you, never created behind your back',
      'Schedules arrive switched off, so nothing runs by surprise',
      'Make your own version of any Shape, and pass it on',
    ],
    moment:
      'You install a Shape someone built for writing. Nothing changes until you apply it. Then the panels and add-ons land, two agents are offered, and you take the one you want.',
    docsUrl: '/docs/marketplace/shapes',
    relatedFeatures: ['marketplace', 'control-center', 'task-scheduler'],
    sortOrder: 2,
  },

  // === MESH ===
  {
    slug: 'mesh-agent-discovery',
    name: 'Agent Discovery',
    product: 'mesh',
    category: 'discovery',
    tagline: 'DorkOS finds your agents: you just point it at a folder',
    description:
      'Mesh scans the projects you already have and lists them as agents automatically. No files to write by hand, and no IDs to keep track of.',
    status: 'ga',
    benefits: [
      'Point DorkOS at a folder and your agents show up',
      'See which tool runs each agent: Claude Code, Codex, Cursor, Windsurf',
      'DorkOS finds new agents on its own by checking your folders',
      'See at a glance which agents are online',
      'One list shows every agent and what it can do',
    ],
    moment:
      'You point DorkOS at a folder and the projects you already have show up as agents, each labeled with the tool it runs. Claude Code, Codex, Cursor, and Windsurf all show up side by side, with nothing to copy or write by hand.',
    docsUrl: '/docs/guides/agent-discovery',
    media: {
      surface: 'agent-discovery',
      alt: 'The DorkOS agent list showing discovered projects, each labeled with the tool it runs: Claude Code, Codex, Cursor, Windsurf',
      loop: true,
    },
    relatedFeatures: ['mesh-topology', 'agent-identity', 'relay-message-bus'],
    sortOrder: 1,
  },
  {
    slug: 'mesh-topology',
    name: 'Mesh Topology Graph',
    product: 'mesh',
    category: 'visualization',
    tagline: 'See every agent and connection in your team, at a glance',
    description:
      'The Topology view draws your whole agent network as a map: every agent, every connection, all in one picture. No digging through logs required.',
    status: 'ga',
    benefits: [
      'A map of every agent you run',
      'Watch messages travel along the wire as they arrive',
      'Agents group by project, so a big team stays readable',
      'Click any agent to see its details and settings',
      'One switch lets every agent on this machine reach every other',
    ],
    moment:
      "You open the map and see your whole team at once. Who's talking to whom, grouped by project, with the quiet ones easy to spot.",
    docsUrl: '/docs/concepts/mesh',
    media: {
      surface: 'topology',
      alt: 'The Mesh map grouping agents by project, showing the tool and abilities of each',
      loop: true,
    },
    relatedFeatures: ['mesh-agent-discovery', 'agent-identity', 'relay-message-bus'],
    sortOrder: 2,
  },
  {
    slug: 'agent-identity',
    name: 'Agent Identity',
    product: 'mesh',
    category: 'identity',
    tagline: 'Faces, handles, and profiles: a team you recognize, not a wall of IDs',
    description:
      'A wall of IDs tells you nothing. Every person and agent gets a photo and a handle that never changes, plus one profile you can open from anywhere.',
    status: 'ga',
    benefits: [
      'A photo and a lasting @handle for every person and agent',
      'One profile panel, with its personality, opens from any name',
      'A Team page listing you and every agent you run',
      'See who is working, who is quiet, and what runs them',
      'Agents always look like agents, never mistaken for a person',
    ],
    moment:
      "Your team isn't a list of IDs. It's Lens on code review and Sentinel on the security watch, each with a face, a handle, and a profile you can open from any message.",
    docsUrl: '/docs/guides/team',
    media: {
      surface: 'personality',
      alt: "The DorkOS Team page listing every agent, with one agent's profile panel open beside it",
      loop: true,
    },
    relatedFeatures: ['mesh-agent-discovery', 'mesh-topology', 'team-room'],
    sortOrder: 3,
  },

  // === CORE ===
  {
    slug: 'mcp-server',
    name: 'MCP Server',
    product: 'core',
    category: 'integration',
    tagline: 'Connect Cursor, Claude Code, or any MCP tool to DorkOS in one step',
    description:
      'DorkOS speaks MCP, the standard that lets AI tools talk to each other. Connect a tool once and it can run tasks, message agents, and check your mesh.',
    status: 'ga',
    benefits: [
      'Connect once, no custom integration code to write',
      'Works with Claude Code, Cursor, Windsurf, and any MCP client',
      'Full access to your Tasks, Relay, and Mesh tools',
      'Turn on an API key when you want extra protection',
      'Every tool is documented automatically, ready to browse',
    ],
    moment:
      'You point Cursor at your DorkOS server once. From then on it can kick off a task or check the agent mesh without you ever opening the DorkOS console.',
    docsUrl: '/docs/integrations/mcp-server',
    relatedFeatures: ['marketplace', 'task-scheduler', 'relay-message-bus', 'mcp-sign-in'],
    sortOrder: 1,
  },
  {
    slug: 'cli',
    name: 'CLI',
    product: 'core',
    category: 'infrastructure',
    tagline: 'One command installs and runs DorkOS, anywhere',
    description:
      'The `dorkos` command installs from npm and starts the whole system (server and Console) at once. Nothing to configure to get going.',
    status: 'ga',
    benefits: [
      'One command starts everything: `npx dorkos`',
      'Your own settings always win over the defaults',
      'Install once, or run it fresh each time with npx',
      'Also ships as a Docker image, for running on a server',
    ],
    docsUrl: '/docs/guides/cli-usage',
    relatedFeatures: ['tunnel', 'marketplace'],
    sortOrder: 2,
  },
  {
    slug: 'tunnel',
    name: 'Remote Tunnel',
    product: 'core',
    category: 'infrastructure',
    tagline: 'Reach your local DorkOS from anywhere, through a secure tunnel',
    description:
      'The built-in tunnel puts your local DorkOS server on the internet with one switch. Control your agents from your phone or any other machine.',
    status: 'ga',
    benefits: [
      'Turn on a tunnel with one click in Settings',
      'Get a secure web address, gated by owner login',
      'Scan a QR code to open it on your phone instantly',
      'Works with Relay, so you can approve actions remotely too',
    ],
    docsUrl: '/docs/self-hosting/tunnel-setup',
    relatedFeatures: ['cli', 'relay-message-bus'],
    sortOrder: 3,
  },
  {
    slug: 'capability-catalog',
    name: 'Capability Catalog',
    product: 'core',
    category: 'integration',
    tagline: 'Your agent asks DorkOS what it can do, and gets a live answer',
    description:
      'Agents guess from docs that go stale. One command asks your running DorkOS instead: the actions it accepts by name, and how risky each one is.',
    status: 'ga',
    benefits: [
      'One command lists the actions DorkOS accepts by name',
      'Each one says how risky it is up front',
      'Run any of them by name with `dorkos call`',
      'Reaches DorkOS from Codex and OpenCode, which get no in-app tools',
      'It says what it leaves out, so an agent looks elsewhere',
    ],
    moment:
      'Your Codex agent has no DorkOS tools at all. It runs one command, reads back the current list of actions, and gets to work, without you pasting anything out of the docs.',
    docsUrl: '/docs/guides/cli-usage',
    relatedFeatures: ['cli', 'mcp-server', 'action-approvals', 'agent-attribution'],
    sortOrder: 4,
  },
  {
    slug: 'connections',
    name: 'Connections',
    product: 'core',
    category: 'integration',
    tagline: 'Connect Gmail or Slack once, then let your agents act for you',
    description:
      "Your agents can't touch your email or chat until you let them. Connect a service like Gmail or Slack once, and you always see where your sign-in lives.",
    // Beta, not GA: the sign-in itself is brokered by third parties (Composio,
    // Nango), so the last mile is not ours to call proven.
    status: 'beta',
    benefits: [
      'Connect Gmail, Slack, or another service with one sign-in',
      'See where your sign-in lives before you connect',
      'Attach a connection to one session, not your whole system',
      'Disconnect an account any time, from one screen',
    ],
    docsUrl: '/docs/connections',
    relatedFeatures: ['marketplace', 'mcp-server', 'relay-message-bus', 'mcp-sign-in'],
    sortOrder: 5,
  },
  {
    slug: 'mcp-sign-in',
    name: 'Tool Server Sign-in',
    product: 'core',
    category: 'integration',
    tagline: 'Sign in to a tool your agent needs, right where it asks',
    description:
      'Some of the tool servers your agents use want you to sign in first. DorkOS puts that sign-in in front of you, then keeps you signed in after that.',
    status: 'ga',
    benefits: [
      "Sign in from the chat, or from the server's own row",
      'An agent can ask for a sign-in while it works',
      'Your sign-in survives a restart, so you do it once',
      'Access renews quietly, before it runs out',
      'Each server says in plain words whether it is ready',
    ],
    moment:
      'Your agent reaches for a tool that needs your permission and stops. A sign-in card appears in the chat, you sign in once, and it carries on.',
    relatedFeatures: ['mcp-server', 'connections', 'marketplace'],
    sortOrder: 6,
  },
  {
    slug: 'agent-memory',
    name: 'Agent Memory',
    product: 'core',
    category: 'agent-control',
    tagline: 'Tell an agent something once, and it still knows next week',
    description:
      'An agent that forgets every conversation makes you repeat yourself forever. Each one now keeps a short notes file it reads before every turn.',
    status: 'ga',
    benefits: [
      'Say it once in a DM, and a channel next week knows it',
      'Plain markdown you can open, correct, or delete by hand',
      'Every note records the conversation that taught it',
      'Small on purpose, so the agent tidies rather than hoards',
      'Lives on your machine, beside the agent it belongs to',
    ],
    moment:
      'You tell your agent in a DM that you deploy on Tuesdays, never Fridays. Next week, in a team channel, it plans around Friday without being asked.',
    docsUrl: '/docs/guides/agent-memory',
    relatedFeatures: ['agent-identity', 'message-search', 'team-room'],
    sortOrder: 7,
  },
];

/**
 * Slug of the catalog's flagship feature — one place for every coding agent you
 * run, which is the headline story the whole site leads with. It earns the wide,
 * living hero tile in the bento.
 *
 * The slug is deliberately older than the name it renders: renaming it means
 * redirecting a published URL, which is scoped to DOR-1517.
 */
export const FLAGSHIP_SLUG = 'every-agent-one-place';

/**
 * Bento tile footprint for a feature card. A *presentation hint derived from
 * the feature's own shape*, never from its position in the grid — so reading
 * order stays owned by the caller's sort while height variation reads as
 * deliberate composition.
 *
 * - `wide`     the flagship headline tile; two columns on multi-column widths
 * - `tall`     a portrait phone capture; a second row so it never leaves a gap
 * - `standard` a landscape media tile; one cell with room for its 16/10 frame
 * - `compact`  a text-only tile; one cell that tightens to slot around media
 */
export type FeatureSpanKind = 'wide' | 'tall' | 'standard' | 'compact';

/**
 * Derive a feature's bento span from its own presentation shape.
 *
 * Portrait phone captures go tall, the flagship goes wide, landscape captures
 * are standard media tiles, and text-only features are compact. This sets only
 * the tile footprint; the catalog's sort still owns visual priority.
 *
 * @param feature - The feature to size within the bento grid.
 * @returns The tile footprint kind for {@link BENTO_SPAN_CLASS}.
 */
export function deriveFeatureSpan(feature: Feature): FeatureSpanKind {
  if (feature.media?.frame === 'phone') return 'tall';
  if (feature.slug === FLAGSHIP_SLUG) return 'wide';
  if (!feature.media) return 'compact';
  return 'standard';
}

/**
 * Bento footprint classes per span kind, drawn only from the standard grid
 * scale (no arbitrary positioning). `wide` claims a second column from the
 * `sm` breakpoint up; `tall` (the portrait phone card) claims a second row on
 * `lg` so its tall shell packs neighbors around it. `standard` and `compact`
 * stay a single cell. The grid stretches every card in a row to a common
 * height (`items-stretch`), and each card keeps its capture in a fixed-aspect
 * `shrink-0` block so only the text column grows — a stretched tile packs flush
 * with its row-mates without ever zoom-cropping its media. Applied to the
 * grid-item wrapper so the same rules drive the catalog and the homepage section.
 */
export const BENTO_SPAN_CLASS: Record<FeatureSpanKind, string> = {
  wide: 'sm:col-span-2 lg:col-span-2 lg:row-span-2',
  tall: 'lg:row-span-2',
  standard: '',
  compact: '',
};
