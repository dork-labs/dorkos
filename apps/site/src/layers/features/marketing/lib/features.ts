/** Lifecycle stage — drives badge rendering and catalog filtering. */
export type FeatureStatus = 'ga' | 'beta' | 'coming-soon';

/**
 * DorkOS product subsystem — maps 1:1 to architecture subsystems.
 * Used for tab filtering on /features.
 */
export type FeatureProduct = 'console' | 'pulse' | 'relay' | 'mesh' | 'core';

/** Display labels for each product tab on /features. */
export const PRODUCT_LABELS: Record<FeatureProduct, string> = {
  console: 'Console',
  pulse: 'Pulse',
  relay: 'Relay',
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
  infrastructure: 'Infrastructure',
};

/**
 * A single DorkOS product feature in the feature catalog.
 *
 * This interface is the authoritative source of truth for feature metadata.
 * TypeScript data is authoritative — MDX files (if added) only contribute body content.
 */
export interface Feature {
  /** URL key — immutable, lowercase-kebab. Used in /features/[slug] route. */
  slug: string;
  /** Display name, e.g. "Pulse Scheduler". */
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
  /** Optional media assets. */
  media?: {
    /** Path relative to /public, e.g. '/features/pulse-scheduler.png'. */
    screenshot?: string;
    /** YouTube embed ID or full URL. */
    demoUrl?: string;
    /** Required when screenshot or demoUrl is present (a11y + SEO). */
    alt?: string;
  };
  /**
   * Optional slug linking to a Fumadocs MDX collection entry.
   * When present, the MDX body renders below the structured section on the feature page.
   * This layer is deferred — do not implement in this spec.
   */
  mdxSlug?: string;
  /**
   * Explicit link to documentation, e.g. '/docs/pulse'.
   * Not derived — must be set manually to ensure it stays valid.
   */
  docsUrl?: string;
  /** Other feature slugs for cross-linking on the feature page. */
  relatedFeatures?: string[];
  /** Display order within category (lower = first). Defaults to insertion order. */
  sortOrder?: number;
}

/** The complete DorkOS feature catalog, sorted by category then sortOrder. */
export const features: Feature[] = [
  // === CONSOLE ===
  {
    slug: 'chat-interface',
    name: 'Chat Interface',
    product: 'console',
    category: 'chat',
    tagline: 'A web UI for every agent session, with streaming output in real time',
    description:
      'Stop SSH-ing into terminal windows to watch agents run. The Console gives every agent session a persistent, streaming chat UI accessible from any browser.',
    status: 'ga',
    featured: true,
    benefits: [
      'Live streaming output with per-word text animation',
      'Persistent session history across restarts',
      'Tool call cards with expand/collapse and approval UI',
      'File attachment support for context sharing',
      'Works from any browser — laptop, phone, or tablet',
    ],
    docsUrl: '/docs/console',
    relatedFeatures: ['tool-approval', 'question-prompts', 'file-uploads'],
    sortOrder: 1,
  },
  {
    slug: 'tool-approval',
    name: 'Tool Approval',
    product: 'console',
    category: 'agent-control',
    tagline: 'Approve or reject agent tool calls before they execute',
    description:
      "Agents sometimes ask before they act. Tool Approval surfaces those requests in real time so you stay in the loop without blocking your agents' flow.",
    status: 'ga',
    benefits: [
      'Real-time approval prompts with full tool call context',
      'Approve, reject, or approve-all for a session',
      'Timeout handling — agents continue if you step away',
      'Slack and Telegram delivery via Relay adapters',
    ],
    docsUrl: '/docs/console/tool-approval',
    relatedFeatures: ['chat-interface', 'slack-adapter', 'telegram-adapter'],
    sortOrder: 2,
  },
  {
    slug: 'question-prompts',
    name: 'Question Prompts',
    product: 'console',
    category: 'agent-control',
    tagline: 'Agents ask questions; you answer from anywhere',
    description:
      "When an agent needs input, it surfaces a structured question prompt in the Console. Answer inline or via a chat adapter — agents don't stall.",
    status: 'ga',
    benefits: [
      'Structured question prompts with multiple-choice options',
      'Answer via Console, Slack, or Telegram',
      'Question history persisted in session transcript',
      'Agents resume immediately after your answer',
    ],
    docsUrl: '/docs/console/question-prompts',
    relatedFeatures: ['chat-interface', 'tool-approval'],
    sortOrder: 3,
  },
  {
    slug: 'file-uploads',
    name: 'File Uploads',
    product: 'console',
    category: 'chat',
    tagline: 'Drop files into the chat — agents read them as context',
    description:
      'Paste a spec, attach a screenshot, or upload a log file. File uploads give your agents rich context without terminal copy-paste gymnastics.',
    status: 'ga',
    benefits: [
      'Drag-and-drop or click-to-upload in chat input',
      'Files appear inline in the conversation history',
      'Supports images, PDFs, text, and code files',
    ],
    docsUrl: '/docs/console/file-uploads',
    relatedFeatures: ['chat-interface'],
    sortOrder: 4,
  },

  // === PULSE ===
  {
    slug: 'pulse-scheduler',
    name: 'Pulse Scheduler',
    product: 'pulse',
    category: 'scheduling',
    tagline: "Schedule agents to run on any cron — they work while you don't",
    description:
      'Stop manually triggering agent runs. Pulse lets you schedule any agent on any cron expression, with a visual builder, preset gallery, and full run history.',
    status: 'ga',
    featured: true,
    benefits: [
      'Visual cron builder with natural-language preview',
      'Preset gallery for common patterns (daily standup, weekly report)',
      'Run history with status, duration, and output',
      'Timezone-aware scheduling',
      'Per-schedule working directory configuration',
    ],
    docsUrl: '/docs/pulse',
    relatedFeatures: ['relay-message-bus', 'mesh-agent-discovery'],
    sortOrder: 1,
  },

  // === RELAY ===
  {
    slug: 'relay-message-bus',
    name: 'Relay Message Bus',
    product: 'relay',
    category: 'messaging',
    tagline: 'Agents send and receive messages across any channel',
    description:
      "Relay is the DorkOS inter-agent message bus. It routes messages between agents, operators, and external services — so your agents aren't isolated.",
    status: 'ga',
    featured: true,
    benefits: [
      'Pub/sub message routing between agents',
      'Dead-letter queue for undeliverable messages',
      'Message tracing and activity feed',
      'Pluggable adapter system for any channel',
      'Bindings link adapters to specific agents',
    ],
    docsUrl: '/docs/relay',
    relatedFeatures: ['slack-adapter', 'telegram-adapter', 'mesh-agent-discovery'],
    sortOrder: 1,
  },
  {
    slug: 'slack-adapter',
    name: 'Slack Adapter',
    product: 'relay',
    category: 'integration',
    tagline: 'Chat with your agents in Slack — no context switching required',
    description:
      'The Slack adapter connects DorkOS Relay to your Slack workspace. Send messages, receive agent updates, and approve tool calls without leaving Slack.',
    status: 'beta',
    benefits: [
      'Send messages to agents from any Slack channel',
      'Receive streaming agent responses in Slack',
      'Tool approval and question prompts via Slack buttons',
      'Per-agent Slack binding — route specific agents to specific channels',
    ],
    docsUrl: '/docs/relay/adapters/slack',
    relatedFeatures: ['relay-message-bus', 'tool-approval'],
    sortOrder: 2,
  },
  {
    slug: 'telegram-adapter',
    name: 'Telegram Adapter',
    product: 'relay',
    category: 'integration',
    tagline: 'Monitor and control your agents via Telegram bot',
    description:
      'The Telegram adapter gives every DorkOS agent a Telegram bot interface. Monitor runs, receive notifications, and send commands from your phone.',
    status: 'ga',
    benefits: [
      'Full streaming agent responses in Telegram',
      'Tool approval prompts with inline buttons',
      'Agent-to-adapter binding for targeted routing',
      'Works on mobile — monitor agents anywhere',
    ],
    docsUrl: '/docs/relay/adapters/telegram',
    relatedFeatures: ['relay-message-bus', 'tool-approval'],
    sortOrder: 3,
  },

  // === MESH ===
  {
    slug: 'mesh-agent-discovery',
    name: 'Agent Discovery',
    product: 'mesh',
    category: 'discovery',
    tagline: 'DorkOS finds your agents — you just point it at a directory',
    description:
      'Mesh scans your filesystem for running agents and registers them automatically. No config files, no IDs to manage — agents are discoverable instantly.',
    status: 'ga',
    featured: true,
    benefits: [
      'Automatic discovery via filesystem scan',
      'Registers agents from Claude Code, Cursor, and custom runtimes',
      'Health monitoring with online/offline status',
      'Cross-namespace agent visibility',
      'Agent registry with capabilities and metadata',
    ],
    docsUrl: '/docs/mesh',
    relatedFeatures: ['mesh-topology', 'relay-message-bus'],
    sortOrder: 1,
  },
  {
    slug: 'mesh-topology',
    name: 'Mesh Topology Graph',
    product: 'mesh',
    category: 'visualization',
    tagline: 'See every agent and connection in your mesh at a glance',
    description:
      'The Topology panel renders your entire agent network as an interactive graph — nodes, bindings, and cross-namespace edges. No log reading required.',
    status: 'ga',
    featured: true,
    benefits: [
      'Interactive force-directed graph of all agents',
      'Visual adapter–agent binding edges',
      'Namespace grouping for multi-project meshes',
      'Click-through to agent detail and settings',
      'Respects reduced-motion preferences',
    ],
    docsUrl: '/docs/mesh/topology',
    relatedFeatures: ['mesh-agent-discovery', 'relay-message-bus'],
    sortOrder: 2,
  },

  // === CORE ===
  {
    slug: 'mcp-server',
    name: 'MCP Server',
    product: 'core',
    category: 'integration',
    tagline: 'All DorkOS tools available to any MCP-compatible agent',
    description:
      'DorkOS exposes its full tool suite via a Streamable HTTP MCP server. Any MCP-compatible agent — Claude Code, Cursor, Windsurf — can call DorkOS tools directly.',
    status: 'ga',
    featured: true,
    benefits: [
      'Stateless Streamable HTTP transport — no persistent connections',
      'Optional API key authentication',
      'Full Pulse, Relay, and Mesh tool surface',
      'Works with Claude Code, Cursor, Windsurf, and any MCP client',
      'Auto-documented via OpenAPI at /api/docs',
    ],
    docsUrl: '/docs/mcp',
    relatedFeatures: ['pulse-scheduler', 'relay-message-bus', 'mesh-agent-discovery'],
    sortOrder: 1,
  },
  {
    slug: 'cli',
    name: 'CLI',
    product: 'core',
    category: 'infrastructure',
    tagline: 'One command to install and run DorkOS anywhere',
    description:
      'The `dorkos` CLI installs via npm and starts the full DorkOS stack — server and Console — with a single command. Zero config required to get started.',
    status: 'ga',
    benefits: [
      'Single `npx dorkos` command to start everything',
      'Config precedence: flags > env vars > config file > defaults',
      'Global install or npx — no lockfile required',
      'Docker image available for containerized deployments',
    ],
    docsUrl: '/docs/getting-started',
    relatedFeatures: ['tunnel'],
    sortOrder: 2,
  },
  {
    slug: 'tunnel',
    name: 'Remote Tunnel',
    product: 'core',
    category: 'infrastructure',
    tagline: 'Access your local DorkOS instance from anywhere via secure tunnel',
    description:
      'The built-in ngrok tunnel exposes your local DorkOS server to the internet with a single toggle. Control agents from your phone or any remote machine.',
    status: 'ga',
    benefits: [
      'One-click tunnel from the Settings panel',
      'Secure HTTPS URL with optional API key protection',
      'QR code for instant mobile access',
      'Works with Relay adapters for remote tool approval',
    ],
    docsUrl: '/docs/tunnel',
    relatedFeatures: ['cli', 'relay-message-bus'],
    sortOrder: 3,
  },
];
