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
  infrastructure: 'Infrastructure',
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
    tagline: 'Claude Code, Codex, OpenCode: one cockpit, per-session choice',
    description:
      'Every coding agent has its own runtime. DorkOS puts Claude Code, Codex, and OpenCode in one cockpit, so you pick the right one per session.',
    status: 'ga',
    featured: true,
    benefits: [
      'Run Claude Code, Codex, and OpenCode side by side',
      'Pick a runtime per session, not per install',
      'Switch runtimes without leaving the cockpit',
      'One session view for every agent you run',
      'Never bet your workflow on a single vendor',
    ],
    moment:
      'You open the same cockpit you always do. One session runs on Claude Code, the next on Codex, a third on OpenCode, and you never left the tab to switch.',
    media: {
      surface: 'multi-session',
      alt: 'Four DorkOS sessions running side by side, each with a live status indicator',
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
    tagline: 'A web UI for every agent session, with streaming output in real time',
    description:
      'Stop SSH-ing into terminal windows to watch agents run. The Console gives every agent session a persistent, streaming chat UI accessible from any browser.',
    status: 'ga',
    benefits: [
      'Live streaming output with per-word text animation',
      'Sub-agents fan out in parallel with live tool counts',
      'Tool call cards with expand, collapse, and approval',
      'Persistent session history across restarts',
      'Works from any browser: laptop, phone, or tablet',
    ],
    moment:
      'You ask for one change and the session fans out into a handful of sub-agents, each running its own tool calls. You watch their counts tick up in parallel and the whole job lands faster than one agent could manage.',
    media: {
      surface: 'subagents',
      alt: 'A DorkOS chat session with sub-agents running in parallel, each showing its tool count and status',
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
    tagline: 'Your whole fleet from your phone: real work, not a read-only viewer',
    description:
      'Most tools give your phone a read-only view. The Mobile Cockpit runs full sessions in any mobile browser: watch streams live and approve tool calls on the go.',
    status: 'ga',
    featured: true,
    benefits: [
      'Watch sessions stream live from your phone',
      'Approve or reject tool calls on the go',
      'Full session parity in any mobile browser',
      'No native app to install',
    ],
    moment:
      'You are on the train when an agent stops to ask before touching a migration. You read the diff on your phone, approve it, and the session picks right back up.',
    media: {
      surface: 'mobile-sessions',
      alt: 'The DorkOS cockpit on a phone showing a live working session and a pending tool approval',
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
    tagline: 'Refresh, restart, reconnect: your session is exactly where you left it',
    description:
      'Close the laptop, reopen on your phone, restart the server. The durable stream replays every token in order, so a live session is never lost to a refresh.',
    status: 'ga',
    featured: true,
    benefits: [
      'Durable streams replay every token in order',
      'Refresh or reconnect with nothing lost',
      'Pick up on any device, mid-run',
      'Cross-client sync keeps every tab in step',
    ],
    moment:
      'You close the laptop mid-run and finish dinner. Reopen the tab on your phone and the session is exactly where it was, every streamed token in place.',
    media: {
      surface: 'chat-streaming',
      alt: 'A DorkOS session streaming output that survives refresh and reconnect',
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
      'Your agent opens a document beside the chat and you edit it like Notion: type live, format markdown as you go, and every keystroke saves to the file on disk.',
    status: 'ga',
    benefits: [
      'Type and format live, Notion-style, as you write',
      'Markdown formatting renders the moment you type it',
      'Every edit saves straight to the file on disk',
      'The agent follows your changes in the same doc',
      'Works across every runtime',
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
    tagline: 'Approve or reject agent tool calls before they execute',
    description:
      "Agents sometimes ask before they act. Tool Approval surfaces those requests in real time so you stay in the loop without blocking your agents' flow.",
    status: 'ga',
    benefits: [
      'Real-time approval prompts with full tool call context',
      'Approve, reject, or approve-all for a session',
      'Timeout handling: agents continue if you step away',
      'Slack and Telegram delivery via Relay adapters',
    ],
    moment:
      'Your agent pauses before it writes to a migration file and asks first. You see the exact path and operation, tap approve, and it keeps moving.',
    media: {
      surface: 'tool-approval',
      alt: 'A DorkOS tool-approval prompt showing the file path and operation with approve and deny',
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
    tagline: 'Agents ask questions; you answer from anywhere',
    description:
      'When an agent needs input, it surfaces a structured question prompt in the Console. Answer inline or via a chat adapter, and agents never stall.',
    status: 'ga',
    benefits: [
      'Structured question prompts with multiple-choice options',
      'Answer via Console, Slack, or Telegram',
      'Question history persisted in session transcript',
      'Agents resume immediately after your answer',
    ],
    relatedFeatures: ['chat-interface', 'tool-approval'],
    sortOrder: 6,
  },
  {
    slug: 'file-uploads',
    name: 'File Uploads',
    product: 'console',
    category: 'chat',
    tagline: 'Drop files into the chat, and agents read them as context',
    description:
      'Paste a spec, attach a screenshot, or upload a log file. File uploads give your agents rich context without terminal copy-paste gymnastics.',
    status: 'ga',
    benefits: [
      'Drag-and-drop or click-to-upload in chat input',
      'Files appear inline in the conversation history',
      'Supports images, PDFs, text, and code files',
    ],
    relatedFeatures: ['chat-interface', 'canvas'],
    sortOrder: 7,
  },
  {
    slug: 'workspaces',
    name: 'Workspaces',
    product: 'console',
    category: 'agent-control',
    tagline: 'Directory-scoped sessions: the right agent in the right project',
    description:
      'Bind a workspace to a project directory and the right agent is already there. No re-explaining which repo you mean, every session lands in context.',
    status: 'ga',
    benefits: [
      'Bind sessions to a project directory',
      'The right agent loads in the right project',
      'No re-explaining which repo you mean',
      'Scopes bindings and context per workspace',
    ],
    moment:
      'You open a session for the API repo and the right agent is already loaded. No re-pointing at the directory, the workspace kept the context for you.',
    media: {
      surface: 'cockpit',
      alt: 'The DorkOS cockpit dashboard scoped to a project workspace',
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
    tagline: "Schedule agents on any cron, so they work while you don't",
    description:
      'Stop manually triggering agent runs. Tasks lets you schedule any agent on any cron expression, with a visual builder, preset gallery, and full run history.',
    status: 'ga',
    featured: true,
    benefits: [
      'Visual cron builder with natural-language preview',
      'Preset gallery for common patterns (daily standup, weekly report)',
      'Run history with status, duration, and output',
      'Timezone-aware scheduling',
      'Per-schedule working directory configuration',
    ],
    moment:
      'At 2:47am a dependency advisory lands. Your nightly audit has already read it, opened the patch, and left a note waiting at breakfast.',
    docsUrl: '/docs/guides/task-scheduler',
    media: {
      surface: 'tasks',
      alt: 'The Tasks list showing schedules with next-run times and run history',
      crop: 'top',
    },
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
      'Relay is the DorkOS inter-agent message bus. It routes messages between agents, operators, and external services, so your agents are never isolated.',
    status: 'ga',
    featured: true,
    benefits: [
      'Pub/sub message routing between agents',
      'Dead-letter queue for undeliverable messages',
      'Message tracing and activity feed',
      'Pluggable adapter system for any channel',
      'Bindings link adapters to specific agents',
    ],
    moment:
      'Your deploy finishes while you are away from the keyboard. A Telegram message arrives with the result, and you answer its one question from the couch.',
    docsUrl: '/docs/concepts/relay',
    relatedFeatures: ['slack-adapter', 'telegram-adapter', 'mesh-agent-discovery'],
    sortOrder: 1,
  },
  {
    slug: 'slack-adapter',
    name: 'Slack Adapter',
    product: 'relay',
    category: 'integration',
    tagline: 'Chat with your agents in Slack, with no context switching',
    description:
      'The Slack adapter connects DorkOS Relay to your Slack workspace. Send messages, receive agent updates, and approve tool calls without leaving Slack.',
    status: 'beta',
    benefits: [
      'Send messages to agents from any Slack channel',
      'Receive streaming agent responses in Slack',
      'Tool approval and question prompts via Slack buttons',
      'Per-agent Slack binding routes specific agents to specific channels',
    ],
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
      'Works on mobile: monitor agents anywhere',
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
    tagline: 'Install a working agent, plugin, or skill pack in one command',
    description:
      'Browse agents, plugins, and skill packs, then install them in the cockpit or from the CLI. One command turns a package you just found into one that runs.',
    status: 'ga',
    featured: true,
    benefits: [
      'Browse agents, plugins, skill packs, and adapters',
      'Install in the cockpit or straight from the CLI',
      'Scoped installs keep each project clean',
      'Reachable as an MCP server from other tools',
    ],
    moment:
      'You read about a code-review agent over coffee and install it before the cup is empty. One command later it is running in your cockpit, no setup file to write.',
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
    tagline: 'DorkOS finds your agents: you just point it at a directory',
    description:
      'Mesh scans your filesystem for the projects you already have and registers them as agents, so there are no config files to write and no IDs to manage.',
    status: 'ga',
    benefits: [
      'Point DorkOS at a directory and agents appear',
      'Mixed harness badges: claude-code, codex, cursor, windsurf',
      'Automatic discovery via filesystem scan',
      'Health monitoring with online and offline status',
      'Agent registry with capabilities and metadata',
    ],
    moment:
      'You point DorkOS at a directory and the projects you already have appear as agents, each badged with the harness it runs. Claude-code, codex, cursor, and windsurf all show up side by side, with no IDs to copy and no config to hand-write.',
    docsUrl: '/docs/guides/agent-discovery',
    media: {
      surface: 'agent-discovery',
      alt: 'The DorkOS agent roster listing discovered projects, each badged with its harness: claude-code, codex, cursor, windsurf',
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
    tagline: 'See every agent and connection in your mesh at a glance',
    description:
      'The Topology panel renders your entire agent network as an interactive graph of nodes, bindings, and cross-namespace edges. No log reading required.',
    status: 'ga',
    benefits: [
      'Interactive graph of all agents',
      'Visual adapter–agent binding edges',
      'Namespace grouping for multi-project meshes',
      'Click-through to agent detail and settings',
      'Respects reduced-motion preferences',
    ],
    moment:
      'You open the topology view and see the whole team at once. Which agent talks to which, grouped by project, with the quiet ones easy to spot.',
    docsUrl: '/docs/concepts/mesh',
    media: {
      surface: 'topology',
      alt: 'The Mesh topology view grouping agents by namespace with their runtimes and capabilities',
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
    tagline: 'Names, colors, avatars, and personas: a team, not a process list',
    description:
      'Give each agent a name, a face, and a job. Your fleet reads like a team you assembled, not a wall of process IDs you have to decode.',
    status: 'ga',
    benefits: [
      'Names, colors, and avatars for every agent',
      'A personality radar shapes how each agent works',
      'Personas turn a process list into a team',
      'System agents stay protected from edits',
    ],
    moment:
      'Your fleet is not a list of process IDs. It is lens on code review, sentinel on the security watch, and atlas on architecture, each with a name, a face, and a personality you tuned.',
    docsUrl: '/docs/guides/persona',
    media: {
      surface: 'personality',
      alt: "A DorkOS agent's identity panel with its name, avatar, persona, and a personality radar",
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
    tagline: 'One command to install and run DorkOS anywhere',
    description:
      'The `dorkos` CLI installs via npm and starts the full DorkOS stack (server and Console) with a single command. Zero config required to get started.',
    status: 'ga',
    benefits: [
      'Single `npx dorkos` command to start everything',
      'Config precedence: flags > env vars > config file > defaults',
      'Global install or npx, no lockfile required',
      'Docker image available for containerized deployments',
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
