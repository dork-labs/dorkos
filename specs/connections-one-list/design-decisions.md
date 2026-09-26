# Connections, one list — design decisions

Visual companion session, 2026-09-26. The mockups are copied into [`mockups/`](./mockups/); they are HTML fragments written for the visual companion frame, readable in any browser.

**Why this exists.** The `/connections` page is six stacked sections (Communities, live chat bots, "Add a way to reach them", message-delivery settings, Accounts, agent requests, then Composio/Nango keys at the very bottom). It asks a person to learn Messaging vs Accounts vs Communities, managed vs your-own-key, and Composio vs Nango before they can connect anything. Its search promises "Search Gmail, Slack, Notion…" and answers "No matching services" whenever Composio isn't set up, without saying so (observed live, 2026-09-26: `/api/connectors/catalog?q=gmail` → `{"services":[]}` with both providers `configured: false`).

**The direction.** Lean all the way toward simple: one plain list of apps, like Composio's own toolkit page, Notion's AI connectors and Perplexity's connectors. The prior critique (`research/20260729_connections-ux-critique.md`) and the competitor survey done for this session agree on the shape: a flat catalog, state shown in the row, advanced setup behind a fold, and chat as the real way in.

## 1. One list, or two?

**Screen:** `mockups/01-shape.html`
**Options:** A) one list for everything — chat apps are rows with a small "Chat" tag. B) two tabs, "Apps" and "Chat".
**Chosen:** A. Every connection answers the same question — which agents get this — so they can share one list. Nothing new to learn.

This reverses ADR `260804-021140`'s "two permanently visible regions, Messaging and Accounts". A superseding ADR is owed.

**Moves off the page:** Composio/Nango keys and message-delivery settings → Settings › Connections (§7). Communities → its own home (§10). Agent requests → the chat card (§3). The internal Claude Code relay row disappears (§9).

## 2. Every state a row can be in

**Screen:** `mockups/02-states-and-flow.html`
The row itself shows its state; the right side is always the one thing you can do next.

| State                               | Row                                                            | Action                       |
| ----------------------------------- | -------------------------------------------------------------- | ---------------------------- |
| Connected                           | quiet green dot; subtitle names the account and who can use it | none (click opens the panel) |
| Broken (signed out / needs sign-in) | amber background, floats to the top of "Yours", plain reason   | **Sign in again**            |
| Connecting                          | "Waiting for you to finish signing in on GitHub…"              | **Cancel**                   |
| Paused                              | greyed out                                                     | **Resume**                   |
| Not connected                       | in "All apps", one-line description of what agents can do      | **Connect**                  |
| Chat app with a new person waiting  | "1 waiting"                                                    | opens the panel              |

- A second account of the same app is a second row.
- First visit: no "Yours" section at all. Search plus "All apps" is the empty state.
- "All apps" has category chips (Popular, Email, Chat, Docs, Code, …) and a small "For developers" group at the bottom (§9).

## 3. Two ways in, one shared card

**Screen:** `mockups/03-two-doors.html`
The operator's point: "connected, but no agent can use it" is a dead end, and the real journey starts in a chat.

**Path 1 — from a chat (the main one).** You ask an agent something that needs an app. A card appears in the transcript: "Connect Gmail — so DorkBot can read your email" [Connect Gmail] [Not now]. Sign-in opens the provider's page (the only moment you leave). The same card then asks "Let DorkBot use Gmail?" — Read email / Read and send — [Allow] [Allow once]. It collapses to "✓ Gmail connected · DorkBot can read" and the agent resumes the original request by itself.

- Already connected but not granted: only the "Let DorkBot use Gmail?" step.
- Two accounts of the same app: the card asks which one.
- In a room, only the owner sees and answers the card.
- Over Telegram/Slack the card can't render; the agent sends a link that opens it in the app.
- The chat card is always about **one** agent. It never offers "every agent".
- Tracked as **DOR-2415**; `meta/chat-capabilities.md` §13 row CN-12. The server half exists (CN-02, CN-03, CN-04, CN-06); the missing half is the transcript card, and an eval that the model raises the request from an ordinary message.

**Path 2 — from the page (planning ahead).** Connect → sign in → **Who can use it?** → **Try it**.

- "Try it" shows two or three one-click prompts ("Summarise today's inbox", "What needs a reply?") that open a chat with that agent, message already typed. Not a prompt to copy: a copied prompt is homework. v1 source: a small hand-picked prompt map per app (critique §f.6).
- If no agent was picked, Try it still works: you pick an agent and it goes through Path 1.

**Build once.** The chat card's access step and the page's "Who can use it?" step are the same component. The chat passes a fixed agent; the page lets you pick.

## 4. "Who can use it?" and "Every agent"

**Screen:** `mockups/04-who-can-use-it.html`
**Options:** A) two choices — "Only agents I pick" / "Every agent (including agents you add later)" — with guardrails. B) three choices — some / all today / all forever.
**Chosen:** A.

- Access level is a two-way switch: **Read** / **Read and send** (per app wording: "Read and write", etc.). Exact per-action picks live under More (§5).
- **Guardrail 1:** "Every agent" + a write level shows one plain warning: "Every agent — including ones you add later — could send email as you." Read-only shows no warning.
- **Guardrail 2:** when a new agent is created or installed, it says what it inherits: "Research Bot will get: Gmail (read), Calendar (read). Change." Future agents never get access silently.
- The row reads "Every agent" instead of a count.
- "Every agent" is page-only (§3).

**New server work.** Today grants are keyed per named agent (`specs/white-label-connections/02-specification.md`, authorization key `(owner, agentId, connectionId, operationRevisionId)`), deliberately. An owner-wide grant that applies to future agents is a new kind of grant and needs its own ADR. It must still respect revision pinning (new or reclassified operations default off) and revocation.

## 5. The side panel

**Screen:** `mockups/05-detail-panel.html`
**Options:** A) side panel over the list (bottom sheet on phone), with its own URL. B) its own page, `/connections/<app>`.
**Chosen:** A. The chat card's "Change" link deep-links into it.

Top of the panel is only what you came for:

- **Who can use it** — the "Every agent" switch, then each agent with a level menu (Read · Read and send · Remove), and "+ Add".
- **Recently** — three plain lines ("DorkBot read 12 emails · 2h ago"), "See all".
- **Try it** — the prompts from §3.
- **More** (folded): Name · "When a new email arrives…" (event notifications) · Exact actions per agent · Pause · How it's connected (the custody note, e.g. "Through Composio") · **Disconnect…** last, confirming who loses access.

A chat app's panel asks **Who answers** (one agent), shows people waiting to reach the bot (Let DorkBot answer · Ignore · Block — today's claim feed), and keeps allow-lists, groups and notices under More.

A broken app's panel puts the one fix on top ("Signed out. Agents can't use Notion." [Sign in again]); nothing else changes.

**Removed from today's panel:** "dorkos-managed", "Managed", "Authentication: Signed in", "Agent access: Ready" (one green dot replaces all four); "0 sessions may be affected by changes" (say it only when a change affects someone); "12 actions" (becomes Read / Read and send); "Delivery is managed by DorkOS…" (a sentence about us, not the person).

## 6. The first connect, ever

**Screen:** `mockups/06-first-connect.html`
**Options:** A) ask at the first Connect. B) a setup banner that greys out the list.
**Chosen:** A. The list always shows. Clicking Connect on an app that needs a connection service, when none is set up, shows one step, once ever: "First, pick how DorkOS reaches your apps." One big button, **Use my DorkOS account**; **Other ways** (folded) offers your own Composio key or your own Nango server. Then the provider's sign-in, as normal.

**Skip it when you're already set up** (operator, agreed):

- One way set up (DorkOS account linked with app connections available, or your own key)? Use it without asking.
- Two ways? Use the one marked "Used for new apps" in Settings. It starts as the DorkOS account unless the person added their own key — adding a key is a deliberate choice.
- Linked, but that link doesn't cover app connections, or the service is unreachable? Fall back to the one-time step with one plain line saying why. Never a dead end. (No plan names or prices in UI copy — see the root `CLAUDE.md` rule.)
- Until DorkOS Cloud app connections are live (gated by DOR-1798), the big button is "Use my Composio key".

**Always say whose sign-in page it is.** One line before the provider's page opens: "Google will ask you to allow Composio — that's the service DorkOS uses to connect." Not a question. Someone who linked a DorkOS account only for remote access didn't agree to "my Gmail login goes through Composio"; this line is how they find out before, not after.

**Needs a built-in list.** "Always show the list" means the catalog can't come only from Composio. Ship a small hand-picked list of popular apps (logo, name, one line) so the list is never empty; merge the live catalog in once a connection service is set up. Chat apps are always in it (§9).

## 7. Changing it later: Settings › Connections

**Screen:** `mockups/07-settings.html`
**Chosen:** a new Settings tab, **Connections**, under "Agents & sessions". Rule of thumb: the page is for apps; Settings is for the plumbing.

- **How DorkOS reaches your apps:** each way set up, with status, how many apps use it, "Used for new apps" marker, and Disconnect… / Change key / Remove…; "+ Add another way". Nothing set up: "Set up when you connect your first app", linking to the page.
- **Chat apps:** today's "When messages arrive" card, in plainer words — Start working right away (toggle), Most chats at once, Give up after (minutes).
- Disconnecting a whole way lists every app that will stop working and the button carries the number ("Disconnect 4 apps"). Access settings don't come back on their own after a later reconnect.
- Switching ways never moves logins behind the person's back: add the new way, reconnect apps one by one; rows on the old way keep working until then.
- The DorkOS account link itself stays in Settings › Access; this tab only shows that it's used for apps.

## 8. All together

**Screen:** `mockups/08-final.html` — the page with Notion broken on top, Gmail selected with its side panel open, Calendar shared with every agent, Telegram with one person waiting, and "All apps" below.

## 9. Our own chat apps: Telegram, Slack, Webhook

**Screen:** `mockups/09-chat-apps.html`
They're built in (`packages/relay/src/adapters/`), so they work with nothing set up. Four rules, agreed:

1. **They're rows like everything else.** A "Chat" tag is the only difference. No separate Messaging section.
2. **They skip the one-time setup (§6).** Connect goes straight to the app's own steps. Telegram: paste the bot token (with a "How do I get one?" link), then **Who answers?** — two steps. Everything else under the panel's More.
3. **One row per app, even when it does two things.** Slack's Connect asks "Talk to my agents in Slack" (our bot; no setup needed) or "Let agents use my Slack" (through a connection service; §6 applies). Only apps with two uses ask.
4. **Plumbing stays hidden.** The internal Claude Code relay row ("internal · Serving 35 agents · Chat + Tasks") is not shown. Webhook sits in a "For developers" group at the bottom of All apps. Chat apps installed from the Marketplace appear as ordinary rows.

## 10. Communities

Communities leave this page. Their home is already designed and mostly built: the sidebar's community switcher (`specs/community-switcher-navigation/`, ADR `260920-205153`, DOR-2183, shipped in PR #2002/#2015). Its "Add" menu already holds **Connect** · **Join with an invitation** · **Create a community** · **Run your own community**, and Join already opens its own dialog in place.

The one loose end: two switcher actions still bounce to this page (`CommunityContextSwitcher.tsx`) — **Connect** (`onConnect: () => openConnections('messaging')`) and **clicking a community that is still waiting for approval** (`selectCommunity` → `openConnections('messaging')`). Both land on the form this redesign removes.

**Do it in the same work, so the ability is never lost:**

1. Add a `ConnectCommunityDialog` beside `JoinCommunityDialog` in `features/dashboard-sidebar/ui/context/CommunityActionDialogs.tsx`, porting the address + installation-name form and `transport.startCommunityConnection` from `features/community-connections/ui/CommunityConnections.tsx`.
2. Port the waiting-for-approval state from `CommunityConnectionRow.tsx` (the "Open … to approve" link, polling, Cancel) into that dialog, and open it for a pending community instead of navigating.
3. Remove `<CommunityConnections />` from the page and delete the `features/community-connections` slice once nothing imports it.

Order matters: steps 1–2 land before or with step 3, never after.

## Vocabulary

Follows ADR `260804-021140`'s ban on "integration", "connector", "adapter" and "provider" in user-facing copy. New user-facing words this design introduces: **app**, **Chat** (tag), **Every agent**, **Who can use it**, **Who answers**, **Try it**, **How DorkOS reaches your apps**, **For developers**. "Managed" / "Your account" custody badges are retired from rows; custody lives in the panel's More › How it's connected.

## Follow-ups this design creates

- ADR superseding `260804-021140` (one list, not two regions) — lands with DOR-2418.
- ADR for owner-wide "every agent" grants (§4) — lands with DOR-2420.

Work items, all in the **DorkOS Connections** project. Build order: the first four unblock the page.

| Issue    | What                                                | Blocks             |
| -------- | --------------------------------------------------- | ------------------ |
| DOR-2417 | Shared "who can use it" access card (§3, §4)        | DOR-2415, DOR-2418 |
| DOR-2421 | Built-in app list + the one-time setup step (§6)    | DOR-2418           |
| DOR-2422 | Connect a community from the sidebar switcher (§10) | DOR-2418           |
| DOR-2419 | Settings › Connections tab (§7)                     | DOR-2418           |
| DOR-2415 | Connect and allow from a card in the chat (§3)      | —                  |
| DOR-2418 | The page redesign itself (§1, §2, §5, §8, §9)       | —                  |
| DOR-2420 | "Every agent" grants + new-agent disclosure (§4)    | —                  |
