import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';
import { RightPanelPage } from './RightPanelPage';

/** The right panel's share of the window while the hub surface is exercised. */
const RIGHT_PANEL_PCT = 45;

/**
 * Page Object for the managed-MCP OAuth sign-in surface (DOR-943 client half,
 * DOR-952 e2e). The surface lives in the Agent Hub's Toolkit tab, under the
 * "Tools & MCP" accordion — the `AgentMcpServers` section that joins an agent's
 * managed servers with their live `getMcpStatus` by name.
 *
 * Reached by deep-linking the Agent Hub onto the seeded agent (`?panel=agent-hub`
 * on `/session`, where the panel's tab is registered unconditionally), then
 * opening the Toolkit tab and expanding the accordion — the way a person gets
 * there, with no in-app opener priming the store first.
 */
export class McpOAuthSigninPage {
  readonly page: Page;
  readonly basePage: BasePage;

  /** The `AgentMcpServers` section (`<section aria-label="MCP servers">`). */
  readonly mcpSection: Locator;
  /** The Toolkit tab in the Agent Hub tab bar. */
  readonly toolkitTab: Locator;
  /** The "Tools & MCP" accordion toggle inside the Toolkit tab. */
  readonly toolsAndMcpToggle: Locator;

  constructor(page: Page) {
    this.page = page;
    this.basePage = new BasePage(page);
    this.mcpSection = page.getByRole('region', { name: 'MCP servers' });
    this.toolkitTab = page.getByRole('tab', { name: 'Toolkit' });
    this.toolsAndMcpToggle = page.getByRole('button', { name: /Tools & MCP/i });
  }

  /**
   * Open the seeded agent's managed-MCP surface: deep-link the hub onto it, open
   * the Toolkit tab, and expand the "Tools & MCP" accordion.
   *
   * @param agentDir - The seeded agent's directory (from `seed-oauth-mcp-agent`).
   */
  async open(agentDir: string): Promise<void> {
    // Give the right panel a real width BEFORE mount (it reads the persisted
    // layout once), then open it — otherwise the hub's tab strip is squished to
    // zero width and the main column intercepts every click.
    const rightPanel = new RightPanelPage(this.page);
    await rightPanel.seedSplit(RIGHT_PANEL_PCT);
    await this.page.goto(
      `/session?panel=agent-hub&hubTab=config&dir=${encodeURIComponent(agentDir)}`,
      { waitUntil: 'domcontentloaded' }
    );
    await this.basePage.waitForAppReady();
    await rightPanel.ensureTabStripOpen();
    await this.toolkitTab.click();
    await this.toolsAndMcpToggle.click();
    await this.mcpSection.waitFor({ state: 'visible' });
  }

  /**
   * The managed-server row carrying a given name, anchored structurally to the
   * row's own container so an assertion cannot match a sibling row.
   *
   * @param name - The managed server's name.
   */
  row(name: string): Locator {
    return this.mcpSection
      .getByText(name, { exact: true })
      .locator('xpath=ancestor::div[.//*[@role="switch"]][1]');
  }

  /**
   * The Sign in button on the named server's row. Its accessible name is
   * `Sign in to <name>` (DOR-985), matching the row's other icon-plus-text
   * controls, so this anchors on the prefix rather than the visible label.
   */
  signInButton(name: string): Locator {
    return this.row(name).getByRole('button', { name: /^Sign in/ });
  }

  /** The Dismiss button on the sign-in panel's success state. */
  dismissSignInPanel(): Locator {
    return this.mcpSection.getByRole('button', { name: 'Dismiss' });
  }

  /** The link that opens the vendor sign-in page for the named server. */
  openSignInLink(name: string): Locator {
    return this.mcpSection.getByRole('link', {
      name: new RegExp(`Open the sign-in page for ${name}`, 'i'),
    });
  }
}
