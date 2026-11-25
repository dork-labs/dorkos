/**
 * Shared helpers for the config-disclosure tests: a dot-path reader, the
 * verdict and shape lookups, and a fully populated config whose every secret
 * carries a `LEAK-<n>` sentinel.
 */
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import {
  CONFIG_DISCLOSURE,
  type ConfigDisclosure,
  type SchemaLeafShape,
  configSchemaLeaves,
} from '../../config-disclosure.js';

/**
 * Read a dot-path out of a plain object, or `undefined` when any hop is missing.
 *
 * A `[]` segment reads the FIRST element in which the rest of the path resolves,
 * not simply element zero. `ui.sidebar.pinned` and friends hold a discriminated
 * union (sidebar-groups, DOR-579), so each element carries only its own branch's
 * fields — `path` on an agent, `roomId` on a room. An exposed per-element path
 * is therefore present in SOME element, and element-zero-only would report a
 * correctly-projected room field as missing.
 */
export function at(root: unknown, dotPath: string): unknown {
  return walkPath(
    root,
    dotPath.split('.').filter((segment) => segment.length > 0)
  );
}

/** Recursive half of {@link at}. */
function walkPath(node: unknown, segments: readonly string[]): unknown {
  const segment = segments[0];
  if (segment === undefined) return node;
  const rest = segments.slice(1);
  if (node === null || typeof node !== 'object') return undefined;
  const next = (node as Record<string, unknown>)[segment.replace(/\[\]$/, '')];
  if (!segment.endsWith('[]')) return walkPath(next, rest);
  if (!Array.isArray(next)) return undefined;
  for (const element of next) {
    const found = walkPath(element, rest);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Shape the walker assigned to each leaf of the live schema. */
export function schemaLeafShapes(): Map<string, SchemaLeafShape> {
  return new Map(configSchemaLeaves().map((leaf) => [leaf.path, leaf.shape]));
}

/** Dot-paths classified with the given verdict. */
export function pathsWithVerdict(verdict: ConfigDisclosure): string[] {
  return Object.entries(CONFIG_DISCLOSURE)
    .filter(([, v]) => v === verdict)
    .map(([k]) => k);
}

/**
 * A fully-populated, schema-valid config where every secret and credential
 * reference carries a unique `LEAK-<n>` sentinel, so a single sweep over the
 * serialized projection proves none of them escaped.
 *
 * Every nested shape is populated too (a smart sidebar group with all five rules,
 * both open records, and BOTH branches of the sidebar item-reference union in
 * each of the three membership lists), because an empty array or map — or a list
 * that only ever exercises one branch of a union — proves nothing about how the
 * projection treats what is inside one.
 */
export function fullyPopulatedConfig(): Record<string, unknown> {
  const base = UserConfigSchema.parse({ version: 1 }) as unknown as Record<string, unknown>;
  return {
    ...base,
    server: {
      port: 4242,
      cwd: '/Users/me/code',
      boundary: '/Users/me',
      open: true,
      lanAccess: false,
    },
    ui: {
      theme: 'dark',
      dismissedUpgradeVersions: ['0.55.0'],
      sidebar: {
        pinned: [
          { kind: 'agent', path: '/Users/me/code' },
          { kind: 'room', roomId: '01JPINNEDROOM' },
        ],
        pinnedApps: ['board', 'timesheet'],
        groups: [
          {
            id: 'group-1',
            name: 'Work',
            // Both branches of the item-reference union, so the projection is
            // exercised on an element that carries `path` and one that carries
            // `roomId` (each drops the other branch's field).
            items: [
              { kind: 'agent', path: '/Users/me/code' },
              { kind: 'room', roomId: '01JROOM' },
            ],
            sortMode: 'recent',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
            kind: 'smart',
            rules: {
              runtimes: ['claude-code'],
              namespaces: ['default'],
              statuses: ['active'],
              lastActiveWithinMs: 86_400_000,
              pathPrefix: '/Users/me',
            },
          },
        ],
        sections: { agents: { collapsed: true, sortMode: 'recent', displayFilter: 'active' } },
        muted: [
          { kind: 'agent', path: '/Users/me/noisy' },
          { kind: 'room', roomId: '01JMUTEDROOM' },
        ],
        gettingStarted: { retired: ['suggestion:ask-dorkbot'] },
        digest: { lastShownDate: '2026-08-09' },
      },
      promos: { dismissedIds: ['remote-access'] },
      shapes: {
        active: 'focus',
        agentDefaults: { '/Users/me/code': 'focus' },
        autoFollowAgent: false,
      },
      statusBar: { pins: ['cwd'] },
      composer: { richText: true },
      panelTabs: [
        {
          tab: 'social-queue:queue',
          show: { agents: ['01AGENT'], rooms: ['01JROOM'], pages: ['activity'] },
          hide: { agents: ['01OTHER'], rooms: ['01JHIDDEN'], pages: ['tasks'] },
        },
      ],
      trustNoticeSeenAt: '2026-10-07T11:15:00.000Z',
      dmView: true,
      showSessions: true,
      communityNavigation: {
        version: 1,
        owners: [
          {
            ownerKey: 'LEAK-13-owner',
            order: ['LEAK-14-community'],
            destinations: [
              {
                ref: 'LEAK-14-community',
                roomId: 'LEAK-15-private-room',
                threadId: 'LEAK-16-private-thread',
                scrollAnchorEntryId: 'LEAK-17-private-entry',
              },
            ],
          },
        ],
      },
    },
    profile: {
      roles: ['Engineer'],
      tools: ['Linear'],
      displayName: 'Dorian',
      // The `agent` branch of the provenance union, because it is the only one
      // that carries both leaves — an `operator` value has no `agentName`, so a
      // fixture built on it would leave that path unexercised (DOR-1022).
      displayNameSource: { kind: 'agent', agentName: 'DorkBot' },
      rolePromptDismissedAt: '2026-08-05T12:00:00.000Z',
      identityPromptDismissedAt: '2026-08-05T12:00:00.000Z',
      timezone: 'Europe/Berlin',
      workingHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
      away: { until: '2026-08-20T00:00:00.000Z', note: 'On holiday' },
    },
    workbench: { defaultViewers: { csv: 'file' }, terminalGraceTtlMinutes: 10, autoOpenDiff: true },
    tunnel: {
      enabled: true,
      domain: 'my.example.com',
      authtoken: 'LEAK-1-ngrok-authtoken',
      auth: 'LEAK-2-basic-auth',
    },
    mcp: {
      enabled: true,
      apiKey: 'LEAK-3-mcp-api-key',
      rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
    },
    cloud: {
      instanceToken: 'LEAK-4-cloud-instance-token',
      instanceName: 'my-box',
      linkedAccountLabel: 'LEAK-5-person@example.com',
      remote: {
        mode: 'managed',
        enrolmentId: 'LEAK-remote-enrolment',
        consentVersion: 'LEAK-remote-consent',
        instanceId: 'LEAK-remote-instance',
        credentialRef: 'file:LEAK-remote-tunnel-ref',
        credentialId: 'LEAK-remote-credential-id',
        fingerprint: 'LEAK-remote-fingerprint',
        hosts: ['LEAK-remote-host.example.com'],
        edgeProofRef: 'file:LEAK-remote-edge-ref',
        edgeProofHeader: 'leak-remote-edge-header',
      },
    },
    runtimes: {
      environment: {
        inherit: {
          claudeCode: ['LEAK_ENV_CLAUDE'],
          codex: ['LEAK_ENV_CODEX'],
          opencode: ['LEAK_ENV_OPENCODE'],
          doe: ['LEAK_ENV_DOE'],
        },
      },
      default: 'claude-code',
      maxAgentChats: 12,
      loadGate: {
        enabled: false,
        maxLoad: 12,
        slots: 2,
        maxWaitMinutes: 30,
        hardCapMinutes: 120,
        heavyCommands: { add: ['playwright test'], remove: ['git push'] },
      },
      // A global stop with one runtime overriding it, so the projection is
      // exercised on both halves of the override rather than on one.
      defaultTrustStop: 'act',
      // A populated roster, including an unnamed account, so the projection is
      // exercised on both `label` branches rather than on an empty array.
      claudeCode: {
        defaultAccount: '/Users/me/.claude2',
        accounts: [
          { id: 'acme-corp', path: '/Users/me/.claude', label: 'Acme Corp', color: '#12ab9f' },
          {
            id: 'claude2',
            path: '/Users/me/.claude2',
            label: null,
            color: null,
            noAutoMove: true,
            agentsMayPick: true,
          },
        ],
        defaultAccountColor: '#0d9488',
        dismissedFolders: ['/Users/me/.claude-old'],
        defaultModel: 'opus',
        defaultEffort: 'high',
        defaultTrustStop: null,
        persistentSession: true,
        maxWarmProcesses: 16,
      },
      doe: {
        enabled: true,
        defaultModel: 'md-preferred',
        defaultTrustStop: null,
        inference: {
          source: 'api-key',
          provider: 'openai',
          protocol: 'openai-chat-completions',
          endpoint: 'https://api.openai.com/v1',
          model: 'explicit',
          contextWindow: 8192,
          maxOutputTokens: 1024,
          credentialRef: 'env:LEAK_DOE_SECRET',
          credentialEndpoint: 'https://api.openai.com/v1',
        },
      },
      opencode: {
        enabled: true,
        binaryPath: '/opt/homebrew/bin/opencode',
        port: 0,
        provider: 'openrouter',
        baseURL: null,
        // No `defaultEffort` sibling: OpenCode's API takes no effort at all.
        defaultModel: 'openrouter/anthropic/claude-opus-4.6',
        defaultTrustStop: null,
      },
      codex: {
        enabled: true,
        binaryPath: '/opt/homebrew/bin/codex',
        credentialRef: 'file:LEAK-6-codex-key-file',
        transport: 'app-server',
        defaultModel: 'gpt-5.3-codex',
        defaultEffort: 'medium',
        defaultTrustStop: 'ask',
      },
    },
    providers: {
      anthropic: 'file:LEAK-7-anthropic-key-file',
      openrouter: 'env:LEAK-8-OPENROUTER_API_KEY',
    },
    connectors: {
      rawMcpServers: [
        {
          slug: 'notion',
          displayName: 'Notion',
          url: 'https://LEAK-10-user:LEAK-11-password@mcp.notion.example/mcp',
          transport: 'http',
        },
        {
          slug: 'calendar',
          displayName: 'Calendar',
          url: 'https://mcp.calendar.example/mcp?access_token=LEAK-12-query-token',
          transport: 'sse',
        },
      ],
    },
    mesh: { scanRoots: ['/Users/me/code', '/Users/me/work'] },
  };
}
