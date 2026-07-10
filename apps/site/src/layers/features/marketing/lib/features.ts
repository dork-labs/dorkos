/** Lifecycle stage — drives badge rendering and catalog filtering. */
export type FeatureStatus = 'ga' | 'beta' | 'coming-soon';

/**
 * DorkOS product subsystem — used for tab filtering on /features.
 * `runtimes` leads because the multi-runtime cockpit is the headline story;
 * `marketplace` is the distribution flywheel.
 */
export type FeatureProduct =
  | 'runtimes'
  | 'console'
  | 'tasks'
  | 'relay'
  | 'marketplace'
  | 'mesh'
  | 'core';

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
  | 'cockpit'
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
    slug: 'multi-runtime-cockpit',
    name: 'Multi-runtime Cockpit',
    product: 'runtimes',
    category: 'agent-control',
    tagline: 'Run Claude Code, Codex, and OpenCode from one screen, any session',
    description:
      'Claude Code, Codex, and OpenCode are three different AI coding tools. DorkOS puts all three in one place, so you pick the right one for each job.',
    status: 'ga',
    featured: true,
    benefits: [
      'Run Claude Code, Codex, and OpenCode side by side',
      'Pick a different tool per session, not just at setup',
      'Switch tools without leaving your screen',
      'See every session in one list, whichever tool ran it',
      "Never build your whole workflow around one company's tool",
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

  // === CONSOLE ===
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
    name: 'Mobile Cockpit',
    product: 'console',
    category: 'agent-control',
    tagline: 'Real work from your phone, not just a screen to watch',
    description:
      'Most tools give your phone a read-only view. The Mobile Cockpit runs real sessions in any phone browser: watch live, and approve agent actions on the go.',
    status: 'ga',
    featured: true,
    benefits: [
      'Watch sessions stream live from your phone',
      'Approve or say no to an agent action on the go',
      'Works the same in any phone browser',
      'No app to download',
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
      'Close your laptop, reopen on your phone, restart the server: nothing is lost. Every message replays in order, so a live session survives a refresh.',
    status: 'ga',
    featured: true,
    benefits: [
      'Every message replays in the order it happened',
      'Refresh or reconnect with nothing lost',
      'Pick up on any device, mid-conversation',
      'Every open tab stays in sync automatically',
    ],
    moment:
      'You close the laptop mid-run and finish dinner. Reopen the tab on your phone and the session is exactly where it was, every message still in place.',
    media: {
      surface: 'chat-streaming',
      alt: 'A DorkOS session streaming output that survives a refresh or reconnect',
      loop: true,
      crop: 'top',
    },
    docsUrl: '/docs/concepts/sessions',
    relatedFeatures: ['chat-interface', 'multi-runtime-cockpit', 'canvas'],
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
    relatedFeatures: ['chat-interface', 'slack-adapter', 'telegram-adapter'],
    sortOrder: 5,
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
    media: {
      surface: 'cockpit',
      alt: 'The DorkOS screen scoped to one project workspace',
      crop: 'top',
    },
    docsUrl: '/docs/guides/workspaces',
    relatedFeatures: ['chat-interface', 'multi-runtime-cockpit'],
    sortOrder: 8,
  },

  // === TASKS ===
  {
    slug: 'task-scheduler',
    name: 'Tasks Scheduler',
    product: 'tasks',
    category: 'scheduling',
    tagline: "Schedule agents to run on their own, so they work while you don't",
    description:
      'Stop manually starting every agent run. Tasks lets you schedule any agent on any timetable, with a visual builder, ready-made presets, and a full history.',
    status: 'ga',
    featured: true,
    benefits: [
      'Build a schedule by picking days and times, no code needed',
      'Ready-made presets for common jobs, like a nightly test run',
      'See every run: its status, how long it took, and what happened',
      'Schedules respect your timezone automatically',
      'Point each schedule at the right project folder',
    ],
    moment:
      'At 2:47am a dependency alert lands. Your nightly check has already read it, opened the fix, and left a note waiting for you at breakfast.',
    docsUrl: '/docs/guides/task-scheduler',
    media: {
      surface: 'tasks',
      alt: 'The Tasks list showing schedules with their next run time and history',
      crop: 'top',
    },
    relatedFeatures: ['relay-message-bus', 'mesh-agent-discovery'],
    sortOrder: 1,
  },

  // === RELAY ===
  {
    slug: 'relay-message-bus',
    name: 'Relay Messaging',
    product: 'relay',
    category: 'messaging',
    tagline: 'Your agents can message you, and each other, on any channel',
    description:
      'Relay connects your agents to you and to each other. It routes messages to Telegram, Slack, and more, so no agent is working in silence.',
    status: 'ga',
    featured: true,
    benefits: [
      'Agents can message you, or message each other',
      'If an agent is offline, the message waits and delivers later',
      'See every message that was sent, and when',
      'Add new channels through plugins, not just Telegram and Slack',
      'Point specific agents at specific channels',
    ],
    moment:
      "Your deploy finishes while you're away from your desk. A Telegram message arrives with the result, and you answer its one question from the couch.",
    docsUrl: '/docs/concepts/relay',
    relatedFeatures: ['slack-adapter', 'telegram-adapter', 'mesh-agent-discovery'],
    sortOrder: 1,
  },
  {
    slug: 'slack-adapter',
    name: 'Slack Adapter',
    product: 'relay',
    category: 'integration',
    tagline: 'Chat with your agents in Slack, with no tab-switching',
    description:
      'The Slack adapter connects Relay to your Slack workspace. Send messages, get updates, and approve agent actions without ever leaving Slack.',
    status: 'beta',
    benefits: [
      'Message agents from any Slack channel',
      'Watch agent replies stream in, right in Slack',
      'Approve or answer agent questions with a Slack button',
      'Point specific agents at specific Slack channels',
    ],
    relatedFeatures: ['relay-message-bus', 'tool-approval'],
    sortOrder: 2,
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
    sortOrder: 3,
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
      'Tools like Claude Code and Cursor can browse and install from it too',
    ],
    moment:
      "You read about a code-review agent over coffee and install it before the cup is empty. One command later, it's running, with nothing to set up by hand.",
    media: {
      surface: 'marketplace',
      alt: 'The DorkOS marketplace browsing featured agents, plugins, and skill packs with install buttons',
      crop: 'top',
    },
    docsUrl: '/docs/marketplace',
    relatedFeatures: ['mcp-server', 'cli'],
    sortOrder: 1,
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
      'See which channel connects to which agent, drawn as lines',
      'Agents group by project, so a big team stays readable',
      'Click any agent to see its details and settings',
      'Slows down or turns off animation if your device asks for it',
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
    tagline: 'Names, faces, and personalities: a team, not a wall of IDs',
    description:
      'Give each agent a name, a face, and a job. Your agents read like a team you assembled, not a wall of IDs you have to decode one by one.',
    status: 'ga',
    benefits: [
      'A name, color, and avatar for every agent',
      'A short personality profile shapes how each agent responds',
      'Turns a list of IDs into a team you recognize',
      'System agents stay protected from accidental changes',
    ],
    moment:
      "Your team isn't a list of IDs. It's Lens on code review, Sentinel on the security watch, and Atlas on architecture, each with a name, a face, and a personality you set.",
    docsUrl: '/docs/guides/persona',
    media: {
      surface: 'personality',
      alt: "A DorkOS agent's identity panel with its name, avatar, personality, and a short profile chart",
      loop: true,
    },
    relatedFeatures: ['mesh-agent-discovery', 'mesh-topology'],
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
    relatedFeatures: ['marketplace', 'task-scheduler', 'relay-message-bus'],
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
      'Get a secure web address, protected by a password if you want',
      'Scan a QR code to open it on your phone instantly',
      'Works with Relay, so you can approve actions remotely too',
    ],
    docsUrl: '/docs/guides/tunnel-setup',
    relatedFeatures: ['cli', 'relay-message-bus'],
    sortOrder: 3,
  },
];

/**
 * Slug of the catalog's flagship feature — the multi-runtime cockpit, the
 * headline story (AGENTS.md market entry point: "mission control for every
 * coding agent you run"). It earns the wide, living hero tile in the bento.
 */
export const FLAGSHIP_SLUG = 'multi-runtime-cockpit';

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
