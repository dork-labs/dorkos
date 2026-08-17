import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';
import { RightPanelPage } from './RightPanelPage';

/** The right panel's share of the window while the profile surface is exercised. */
const RIGHT_PANEL_PCT = 45;

/**
 * Page Object for the managed-MCP OAuth sign-in surface (DOR-943 client half,
 * DOR-952 e2e). The surface is the profile's **Tools & MCP** page — the
 * `AgentMcpServers` section that joins an agent's managed servers with their
 * live `getMcpStatus` by name.
 *
 * Reached by deep-linking the docked profile straight onto that page
 * (`?panel=profile&profilePage=tools`), the way a person would follow a link —
 * with no in-app opener priming any store first. It used to be the old agent panel's
 * Toolkit tab behind a "Tools & MCP" accordion; the hub is gone and the
 * accordion with it, so the page IS the surface now (spec `profile-unification`).
 */
export class McpOAuthSigninPage {
  readonly page: Page;
  readonly basePage: BasePage;

  /** The `AgentMcpServers` section (`<section aria-label="MCP servers">`). */
  readonly mcpSection: Locator;
  /** The profile page's own heading, which names where the deep link landed. */
  readonly pageTitle: Locator;

  constructor(page: Page) {
    this.page = page;
    this.basePage = new BasePage(page);
    this.mcpSection = page.getByRole('region', { name: 'MCP servers' });
    this.pageTitle = page.locator('[data-slot="profile-page-title"]');
  }

  /**
   * Open the seeded agent's managed-MCP surface: deep-link the profile onto its
   * Tools & MCP page.
   *
   * @param agentDir - The seeded agent's directory (from `seed-oauth-mcp-agent`).
   */
  async open(agentDir: string): Promise<void> {
    // Give the right panel a real width BEFORE mount (it reads the persisted
    // layout once), otherwise the panel is squished to zero width and the main
    // column intercepts every click.
    const rightPanel = new RightPanelPage(this.page);
    await rightPanel.seedSplit(RIGHT_PANEL_PCT);
    await this.page.goto(
      `/session?panel=profile&profilePage=tools&agentPath=${encodeURIComponent(agentDir)}&dir=${encodeURIComponent(agentDir)}`,
      { waitUntil: 'domcontentloaded' }
    );
    await this.basePage.waitForAppReady();
    await rightPanel.ensureTabStripOpen();
    await this.mcpSection.waitFor({ state: 'visible' });
  }

  /**
   * The card for a given server, anchored to the card's own root so an assertion
   * cannot match a sibling card. Every card carries `data-mcp-server` with the
   * RAW name the runtime uses, which is also the one name that survives the
   * card's plugin-name parsing (DOR-1005).
   *
   * @param name - The managed server's name.
   */
  row(name: string): Locator {
    return this.mcpSection.locator(`[data-mcp-server="${name}"]`);
  }

  /**
   * The Sign in button on the named server's card. Its accessible name is
   * `Sign in to <name>` (DOR-985), matching the card's other icon-plus-text
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
