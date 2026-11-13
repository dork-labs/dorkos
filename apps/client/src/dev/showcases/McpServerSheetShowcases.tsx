/**
 * A global MCP server's sheet, "Who uses it without asking" and "What it can do" (DOR-4118),
 * drawn without a server: each state is the real `McpServersTab` over a playground transport
 * that answers with made-up servers, agents and tools. Open the row to open the real sheet.
 *
 * @module dev/showcases/McpServerSheetShowcases
 */
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  GlobalMcpServerView,
  GlobalMcpStandingAllow,
  GlobalMcpToolsCheck,
} from '@dorkos/shared/global-mcp-schemas';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { McpServersTab } from '@/layers/features/global-mcp-servers';
import { InboxRow } from '@/layers/features/inbox';
import { TransportProvider } from '@/layers/shared/model';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { createPlaygroundTransport } from '../playground-transport';

/** A server as the list reads it: on, pinned, nothing secret. */
function server(name: string, enabled = true): GlobalMcpServerView {
  return {
    name,
    enabled,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'notion-demo-mcp@1.4.0'],
    env: [],
    headers: [],
    excludedAgents: [],
    addedAt: new Date(Date.UTC(2026, 9, 22)).toISOString(),
    skippedOn: [],
    warnings: [],
  };
}

/** One agent's standing yes for `name`: the whole server, or one tool on it. */
function allow(
  agentName: string,
  name: string,
  tool?: string,
  file: GlobalMcpStandingAllow['file'] = 'settings.local.json'
): GlobalMcpStandingAllow {
  return {
    agentId: `agent-${agentName.split(/\W/)[0]!.toLowerCase()}`,
    agentName,
    rule: tool === undefined ? `mcp__${name}` : `mcp__${name}__${tool}`,
    breadth: tool === undefined ? 'server' : 'tool',
    ...(tool === undefined ? {} : { tool }),
    file,
  };
}

const TOOLS: GlobalMcpToolsCheck = {
  status: 'ok',
  tools: [
    { name: 'search_pages', description: 'Find pages by title or text.', isNew: false },
    { name: 'create_page', description: 'Add a page under a parent page.', isNew: false },
    { name: 'export_workspace', description: 'Export every page as Markdown.', isNew: true },
  ],
  added: ['export_workspace'],
  omitted: 0,
};

const LONG_SERVER = 'notion-demo-shared-workspaces-for-a-team';
const LONG_AGENT = 'Atlas, the quarterly planning researcher';
const LONG_TOOL = 'search_pages_in_every_shared_team_folder';

const LONG_TOOLS: GlobalMcpToolsCheck = {
  status: 'ok',
  tools: [
    {
      name: LONG_TOOL,
      description:
        'Searches every page in every shared team folder, including archived pages and pages shared from other workspaces, and returns <b>titles</b>, owners, last-edited dates and the first paragraph of each match.',
      isNew: true,
    },
    { name: 'create_page', description: 'Add a page under a parent page.', isNew: false },
  ],
  added: [LONG_TOOL],
  omitted: 0,
};

/** What one state's made-up transport answers. */
interface SheetScenario {
  server: GlobalMcpServerView;
  tools: GlobalMcpToolsCheck;
  allows: GlobalMcpStandingAllow[];
  /** Undo's refusal, if it is refused; otherwise Undo removes the rule. */
  undoRefusal?: string;
}

/** The playground transport, plus the routes the MCP servers tab and its sheet read. */
function sheetTransport(scenario: SheetScenario): Transport {
  let allows = [...scenario.allows];
  return new Proxy(createPlaygroundTransport(), {
    get: (target, prop, receiver) => {
      if (prop === 'listGlobalMcpServers') return async () => ({ servers: [scenario.server] });
      if (prop === 'listMeshAgents') return async () => ({ agents: [] });
      if (prop === 'checkGlobalMcpServerTools') return async () => scenario.tools;
      if (prop === 'listGlobalMcpStandingAllows') return async () => ({ allows });
      if (prop === 'undoGlobalMcpStandingAllow') {
        return async (_name: string, agentId: string, rule: string) => {
          if (scenario.undoRefusal !== undefined) throw new Error(scenario.undoRefusal);
          allows = allows.filter((held) => !(held.agentId === agentId && held.rule === rule));
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** One state: its own cache and transport, so states never share a sheet. */
function SheetDemo({ testId, scenario }: { testId: string; scenario: SheetScenario }) {
  const client = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    []
  );
  const transport = useMemo(() => sheetTransport(scenario), [scenario]);
  return (
    <ShowcaseDemo>
      <QueryClientProvider client={client}>
        <TransportProvider transport={transport}>
          <div data-testid={testId} className="w-[min(36rem,100%)]">
            <McpServersTab />
          </div>
        </TransportProvider>
      </QueryClientProvider>
    </ShowcaseDemo>
  );
}

const NOBODY: SheetScenario = { server: server('notion-demo'), tools: TOOLS, allows: [] };

const MIXED: SheetScenario = {
  server: server('notion-demo'),
  tools: TOOLS,
  allows: [
    allow('Atlas', 'notion-demo'),
    allow('Juno', 'notion-demo', 'search_pages'),
    allow('Vega', 'notion-demo', 'create_page', 'settings.json'),
  ],
};

const LONG_NAMES: SheetScenario = {
  server: server(LONG_SERVER),
  tools: LONG_TOOLS,
  allows: [allow(LONG_AGENT, LONG_SERVER), allow('Juno', LONG_SERVER, LONG_TOOL)],
};

const OFF: SheetScenario = {
  server: server('notion-demo', false),
  tools: { status: 'not-checked' },
  allows: [allow('Juno', 'notion-demo', 'search_pages')],
};

const UNDO: SheetScenario = {
  server: server('notion-demo'),
  tools: TOOLS,
  allows: [allow('Atlas', 'notion-demo'), allow('Juno', 'notion-demo', 'search_pages')],
};

const UNDO_REFUSED: SheetScenario = {
  ...UNDO,
  undoRefusal: "This agent's settings file isn't a plain file in its folder, so it was left alone.",
};

/** The Inbox line a check leaves when a server everyone-allowed adds a tool. */
const TOOL_ADDED: NotificationDTO = {
  id: '01JZS00000000000000000001',
  kind: 'mcp-server.tool_added',
  tier: 'notable',
  subject: { type: 'system', id: 'mcp-server:notion-demo' },
  title: 'notion-demo added a tool. Atlas can use it without asking.',
  body: 'It allows every notion-demo tool, including new ones.',
  actions: [{ id: 'open', label: 'Review', style: 'primary' }],
  createdAt: new Date(Date.UTC(2026, 10, 13, 14, 0)).toISOString(),
};

/** The sheet's states, each opened from its row. */
export function McpServerSheetShowcases() {
  return (
    <>
      <PlaygroundSection
        title="MCP server sheet: who uses it"
        description="Open a row. Each agent's standing yes for the server, with Undo, and the tools the server lists, checked when the sheet opens."
      >
        <ShowcaseLabel>Long names: a 40-character server, agent and tool</ShowcaseLabel>
        <SheetDemo testId="mcp-sheet-long-names" scenario={LONG_NAMES} />
        <ShowcaseLabel>Nobody uses it without asking</ShowcaseLabel>
        <SheetDemo testId="mcp-sheet-nobody" scenario={NOBODY} />
        <ShowcaseLabel>Mixed: one agent has every tool, two have one tool each</ShowcaseLabel>
        <SheetDemo testId="mcp-sheet-mixed" scenario={MIXED} />
        <ShowcaseLabel>Off: its tools are not checked, and nothing starts</ShowcaseLabel>
        <SheetDemo testId="mcp-sheet-off" scenario={OFF} />
        <ShowcaseLabel>Undo: press it on a row and the rule goes</ShowcaseLabel>
        <SheetDemo testId="mcp-sheet-undo" scenario={UNDO} />
        <ShowcaseLabel>Undo refused: the agent&apos;s settings file is left alone</ShowcaseLabel>
        <SheetDemo testId="mcp-sheet-undo-refused" scenario={UNDO_REFUSED} />
      </PlaygroundSection>
      <PlaygroundSection
        title="MCP server sheet: new tool notice"
        description="The Inbox line when a server that an agent allows as a whole adds a tool."
      >
        <ShowcaseDemo>
          <div
            data-testid="mcp-tool-added-row"
            className="border-border/60 bg-background/60 w-[min(30rem,100%)] rounded-lg border p-2"
          >
            <InboxRow notification={TOOL_ADDED} onOpen={() => {}} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
