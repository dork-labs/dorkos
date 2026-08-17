import { LogIn, MoreHorizontal, Plus } from 'lucide-react';
import { Button, Switch } from '@/layers/shared/ui';
import type { McpSigninFlow } from '@/layers/entities/agent';
import {
  McpServerCard,
  McpServerCardDetails,
  McpSigninPanel,
  type McpCardStatus,
  type McpToolSummary,
} from '@/layers/features/agent-settings';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

/**
 * The width the cards actually get in the docked profile's right panel. Every state
 * below is shown at it, because the whole redesign exists because six controls
 * did not fit on one line here.
 */
const PANEL_WIDTH = 'w-[340px]';

/** A sign-in flow frozen at one step, so a static page can show a live surface. */
function frozenFlow(
  state: Partial<McpSigninFlow['state']> & { step: McpSigninFlow['state']['step'] }
): McpSigninFlow {
  return {
    state: {
      disclosure: null,
      authorizeUrl: null,
      error: null,
      errorDetail: null,
      canUseOwnCredentials: false,
      savingCredentials: false,
      credentialsError: null,
      retryNotice: null,
      toolCount: null,
      ...state,
    },
    start: () => {},
    authOpened: () => {},
    adopt: () => {},
    useOwnCredentials: () => {},
    reset: () => {},
  };
}

const CUSTODY_DISCLOSURE =
  'DorkOS keeps the resulting token encrypted on this computer and injects it for you. The agent never sees it.';

const LINEAR_TOOLS: McpToolSummary[] = [
  { name: 'create_issue', description: 'Create a new issue in a team' },
  { name: 'search_issues', description: 'Search issues by text and filters' },
  { name: 'get_issue', description: 'Fetch one issue with its comments' },
  { name: 'update_issue', description: 'Change an issue’s state or fields' },
  { name: 'list_teams', description: 'List the teams you can post to' },
];

/** The overflow menu, as a static trigger — the live one is a Radix menu. */
function OverflowButton({ name }: { name: string }) {
  return (
    <Button variant="ghost" size="sm" aria-label={`More actions for ${name}`} className="ml-auto">
      <MoreHorizontal className="size-4" aria-hidden />
    </Button>
  );
}

/** One card at panel width, so every demo below is measured the same way. */
function AtPanelWidth({ children }: { children: React.ReactNode }) {
  return <div className={PANEL_WIDTH}>{children}</div>;
}

/** The enable switch, as it sits on a managed card. */
function EnableSwitch({ name, on }: { name: string; on: boolean }) {
  return <Switch checked={on} onCheckedChange={() => {}} aria-label={`Enable ${name}`} />;
}

/** The four states that ask something of the person. */
function AttentionStatesSection() {
  return (
    <PlaygroundSection
      title="MCP cards: what needs you"
      description="Sorted to the top when the panel opens, and then frozen there — a card someone is mid-sign-in on must never move. The colored left edge is never the only signal; the chip says the state in words."
    >
      <ShowcaseLabel>Needs sign-in — the one action is Sign in</ShowcaseLabel>
      <ShowcaseDemo>
        <AtPanelWidth>
          <McpServerCard
            displayName="granola"
            rawName="granola"
            scope="agent"
            pluginName={null}
            status="needs-sign-in"
            sentence="Sign in to granola so this agent can use its tools."
            managed
            toggle={<EnableSwitch name="granola" on />}
            actions={
              <>
                <Button variant="default" size="sm" className="gap-1.5">
                  <LogIn className="size-3.5" aria-hidden />
                  Sign in
                </Button>
                <OverflowButton name="granola" />
              </>
            }
          />
        </AtPanelWidth>
      </ShowcaseDemo>

      <ShowcaseLabel>Signing in — one custody statement, in its trust panel</ShowcaseLabel>
      <ShowcaseDemo>
        <AtPanelWidth>
          <McpServerCard
            displayName="granola"
            rawName="granola"
            scope="agent"
            pluginName={null}
            status="signing-in"
            sentence={null}
            managed
            toggle={<EnableSwitch name="granola" on />}
          >
            <McpSigninPanel
              flow={frozenFlow({
                step: 'disclosure',
                disclosure: CUSTODY_DISCLOSURE,
                authorizeUrl: 'https://auth.example/authorize',
              })}
              serverName="Granola"
            />
          </McpServerCard>
        </AtPanelWidth>
      </ShowcaseDemo>

      <ShowcaseLabel>Can’t reach — a server that didn’t answer</ShowcaseLabel>
      <ShowcaseDemo>
        <AtPanelWidth>
          <McpServerCard
            displayName="weather"
            rawName="weather"
            scope="agent"
            pluginName={null}
            status="cant-reach"
            sentence="This server didn’t answer. It may be down."
            managed
            toggle={<EnableSwitch name="weather" on />}
            actions={
              <>
                <Button variant="outline" size="sm">
                  Try again
                </Button>
                <OverflowButton name="weather" />
              </>
            }
          />
        </AtPanelWidth>
      </ShowcaseDemo>

      <ShowcaseLabel>Setup problem — the verbatim error lives in Details</ShowcaseLabel>
      <ShowcaseDemo>
        <AtPanelWidth>
          <McpServerCard
            displayName="browser"
            rawName="plugin:playwright:browser"
            scope="plugin"
            pluginName="playwright"
            status="setup-problem"
            sentence="This server’s setup has a problem."
            managed
            toggle={<EnableSwitch name="browser" on />}
            actions={
              <>
                <Button variant="outline" size="sm">
                  Try again
                </Button>
                <OverflowButton name="browser" />
              </>
            }
            details={
              <McpServerCardDetails
                scope="plugin"
                pluginName="playwright"
                rawName="plugin:playwright:browser"
                displayName="browser"
                error='Validation failed: missing required field "command"'
              />
            }
          />
        </AtPanelWidth>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** The states where nothing is wrong. */
function WorkingStatesSection() {
  return (
    <PlaygroundSection
      title="MCP cards: working"
      description="Three different things a calm card can mean — a round trip that provably worked, a token held but never used, and a key the operator supplied themselves. Saying “Connected” for all three was the old surface’s central lie."
    >
      <ShowcaseLabel>Just connected — the payoff, in place</ShowcaseLabel>
      <ShowcaseDemo>
        <AtPanelWidth>
          <McpServerCard
            displayName="granola"
            rawName="granola"
            scope="agent"
            pluginName={null}
            status="connected"
            sentence="Signed in just now — 12 tools available."
            managed
            toggle={<EnableSwitch name="granola" on />}
            actions={<OverflowButton name="granola" />}
          />
        </AtPanelWidth>
      </ShowcaseDemo>

      <ShowcaseLabel>Connected, with Details open and the tool list</ShowcaseLabel>
      <ShowcaseDemo>
        <AtPanelWidth>
          <McpServerCard
            displayName="linear"
            rawName="linear"
            scope="agent"
            pluginName={null}
            status="connected"
            sentence="12 tools available."
            managed
            toggle={<EnableSwitch name="linear" on />}
            actions={<OverflowButton name="linear" />}
            defaultDetailsOpen
            details={
              <McpServerCardDetails
                connection={{
                  transport: 'http',
                  url: 'https://mcp.linear.app/mcp',
                  headers: {},
                  authKind: 'oauth2',
                }}
                authStatus="connected"
                scope="agent"
                pluginName={null}
                rawName="linear"
                displayName="linear"
                toolCount={12}
                tools={LINEAR_TOOLS}
                serverInfo="Linear MCP v2.1.0"
                alsoUsedBy="2 other agents"
              />
            }
          />
        </AtPanelWidth>
      </ShowcaseDemo>

      <ShowcaseLabel>Signed in, unverified — a token held, nothing contacted yet</ShowcaseLabel>
      <ShowcaseDemo>
        <AtPanelWidth>
          <McpServerCard
            displayName="posthog"
            rawName="posthog"
            scope="agent"
            pluginName={null}
            status="signed-in"
            sentence="DorkOS has a sign-in for this server. Test to check it responds."
            managed
            toggle={<EnableSwitch name="posthog" on />}
            actions={
              <>
                <Button variant="outline" size="sm">
                  Test
                </Button>
                <OverflowButton name="posthog" />
              </>
            }
          />
        </AtPanelWidth>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Uses your key — authenticated by a header the operator pasted in
      </ShowcaseLabel>
      <ShowcaseDemo>
        <AtPanelWidth>
          <McpServerCard
            displayName="internal-api"
            rawName="internal-api"
            scope="agent"
            pluginName={null}
            status="uses-your-key"
            sentence="You added an access key when setting this up."
            managed
            toggle={<EnableSwitch name="internal-api" on />}
            actions={
              <>
                <Button variant="outline" size="sm">
                  Test
                </Button>
                <OverflowButton name="internal-api" />
              </>
            }
          />
        </AtPanelWidth>
      </ShowcaseDemo>

      <ShowcaseLabel>Connecting — said only when a runtime really reports it</ShowcaseLabel>
      <ShowcaseDemo>
        <AtPanelWidth>
          <McpServerCard
            displayName="notion"
            rawName="notion"
            scope="agent"
            pluginName={null}
            status="connecting"
            sentence="Connecting to this server."
            managed
            toggle={<EnableSwitch name="notion" on />}
            actions={<OverflowButton name="notion" />}
          />
        </AtPanelWidth>
      </ShowcaseDemo>

      <ShowcaseLabel>Not checked yet — never a spinner that spins forever</ShowcaseLabel>
      <ShowcaseDemo>
        <AtPanelWidth>
          <McpServerCard
            displayName="filesystem"
            rawName="filesystem"
            scope="agent"
            pluginName={null}
            status="not-checked"
            sentence="Nothing has checked this server yet."
            managed
            toggle={<EnableSwitch name="filesystem" on />}
            actions={
              <>
                <Button variant="outline" size="sm">
                  Test
                </Button>
                <OverflowButton name="filesystem" />
              </>
            }
            details={
              <McpServerCardDetails
                connection={{ transport: 'stdio', command: 'npx', args: ['-y', 'fs-mcp'], env: {} }}
                scope="agent"
                pluginName={null}
                rawName="filesystem"
                displayName="filesystem"
              />
            }
          />
        </AtPanelWidth>
      </ShowcaseDemo>

      <ShowcaseLabel>Off — the switch is the whole affordance</ShowcaseLabel>
      <ShowcaseDemo>
        <AtPanelWidth>
          <McpServerCard
            displayName="old-tool"
            rawName="old-tool"
            scope="agent"
            pluginName={null}
            status="off"
            sentence="Turned off — the agent doesn’t see this server."
            managed
            toggle={<EnableSwitch name="old-tool" on={false} />}
          />
        </AtPanelWidth>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** One card per origin DorkOS does not own. */
function ElsewhereStatesSection() {
  const addAction = (name: string) => (
    <Button variant="outline" size="sm" aria-label={`Add ${name} to agent`} className="gap-1.5">
      <Plus className="size-3.5" aria-hidden />
      Add to agent
    </Button>
  );

  return (
    <PlaygroundSection
      title="MCP cards: from somewhere else"
      description="Servers the runtime loads that DorkOS does not manage. Same anatomy, quieter surface, no switch — and one action: add it to this agent. When the runtime will not say where a server came from, the card shows no badge and offers no Details, rather than guessing an origin or opening an empty box."
    >
      <ShowcaseLabel>From this project’s config</ShowcaseLabel>
      <ShowcaseDemo>
        <AtPanelWidth>
          <McpServerCard
            displayName="shadcn"
            rawName="shadcn"
            scope="project"
            pluginName={null}
            status="not-checked"
            sentence="From this project’s config. Add it to manage it here."
            managed={false}
            actions={addAction('shadcn')}
          />
        </AtPanelWidth>
      </ShowcaseDemo>

      <ShowcaseLabel>From a plugin — parsed name, raw id in Details</ShowcaseLabel>
      <ShowcaseDemo>
        <AtPanelWidth>
          <McpServerCard
            displayName="context7"
            rawName="plugin:context7"
            scope="plugin"
            pluginName="context7"
            status="connected"
            sentence="Comes with the context7 plugin. Add it to manage it here."
            managed={false}
            actions={addAction('context7')}
            details={
              <McpServerCardDetails
                scope="plugin"
                pluginName="context7"
                rawName="plugin:context7"
                displayName="context7"
              />
            }
          />
        </AtPanelWidth>
      </ShowcaseDemo>

      <ShowcaseLabel>Origin unknown — no badge, and no Details to open</ShowcaseLabel>
      <ShowcaseDemo>
        <AtPanelWidth>
          <McpServerCard
            displayName="my-server"
            rawName="my-server"
            scope={null}
            pluginName={null}
            status="connected"
            sentence="This agent’s runtime loads this server. Add it to manage it here."
            managed={false}
            actions={addAction('my-server')}
          />
        </AtPanelWidth>
      </ShowcaseDemo>

      <ShowcaseLabel>From your computer-wide config</ShowcaseLabel>
      <ShowcaseDemo>
        <AtPanelWidth>
          <McpServerCard
            displayName="granola-notes"
            rawName="granola-notes"
            scope="computer"
            pluginName={null}
            status="not-checked"
            sentence="From your computer-wide config. Add it to manage it here."
            managed={false}
            actions={addAction('granola-notes')}
          />
        </AtPanelWidth>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** The whole panel in its opening order, so the sort is visible as a whole. */
function OpeningOrderSection() {
  const cards: Array<{ name: string; status: McpCardStatus; sentence: string; managed: boolean }> =
    [
      {
        name: 'granola',
        status: 'needs-sign-in',
        sentence: 'Sign in to granola so this agent can use its tools.',
        managed: true,
      },
      {
        name: 'weather',
        status: 'cant-reach',
        sentence: 'This server didn’t answer. It may be down.',
        managed: true,
      },
      { name: 'linear', status: 'connected', sentence: '12 tools available.', managed: true },
      {
        name: 'shadcn',
        status: 'not-checked',
        sentence: 'From this project’s config. Add it to manage it here.',
        managed: false,
      },
      {
        name: 'old-tool',
        status: 'off',
        sentence: 'Turned off — the agent doesn’t see this server.',
        managed: true,
      },
    ];

  return (
    <PlaygroundSection
      title="MCP cards: the panel when it opens"
      description="What needs you, then what is working, then what came from elsewhere, then what is off. The order is taken once at mount and held for as long as the panel stays open."
    >
      <ShowcaseDemo>
        <AtPanelWidth>
          {cards.map((card) => (
            <McpServerCard
              key={card.name}
              displayName={card.name}
              rawName={card.name}
              scope={card.managed ? 'agent' : 'project'}
              pluginName={null}
              status={card.status}
              sentence={card.sentence}
              managed={card.managed}
              toggle={
                card.managed ? (
                  <EnableSwitch name={card.name} on={card.status !== 'off'} />
                ) : undefined
              }
            />
          ))}
        </AtPanelWidth>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/**
 * Every state an MCP server card can reach, at the 340px the docked profile's right
 * panel actually gives it (spec `mcp-server-cards-redesign`).
 *
 * The cards here are the presentational shell driven by explicit props rather
 * than the live `ManagedMcpServerCard`, because half of these states are
 * reachable only through a server that is failing, a token that has expired, or
 * a sign-in mid-flight — conditions a playground cannot produce and a reviewer
 * still has to be able to look at.
 */
export function McpServerCardShowcases() {
  return (
    <>
      <AttentionStatesSection />
      <WorkingStatesSection />
      <ElsewhereStatesSection />
      <OpeningOrderSection />
    </>
  );
}
