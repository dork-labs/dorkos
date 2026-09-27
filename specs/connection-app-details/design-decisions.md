---
slug: connection-app-details
title: 'Connections: app logos, descriptions, actions and a kept app list'
status: ideation
created: 2026-09-27
linear: [DOR-2463, DOR-2464, DOR-2465]
builds-on: specs/connections-one-list
design-session: .dork/visual-companion/98488-1790523829
---

# Connections: app details — design decisions

Follows the shipped Connections one-list redesign (`specs/connections-one-list/`). That work made the page one plain list of apps. This round makes each app recognisable and understandable, and it makes the list cheap to load.

## 1. What we found (2026-09-27)

- **No logos anywhere.** `ServiceMark.tsx` draws a letter tile for every app except the chat apps. An older plan (`specs/connections-redesign` OQ5) held logos back until the owner cleared a trademark question. **The owner cleared it on 2026-09-27: we show other companies' logos.**
- **Logos and descriptions are thrown away.** Composio's and Nango's app lists both carry a logo link and a description. `composio-client.ts` and `nango.ts` keep only the slug, name and auth kind. Only the ~15 hand-picked apps in `built-in-apps.ts` have a description, and we wrote those ourselves.
- **Actions are fetched, but only for safety.** Before an agent uses an app, `packages/connector-providers/src/composio/sdk-client.ts` fetches the app's action list and marks each action `read` or `destructive` (`classify`, line ~127: read only on an explicit, uncontradicted `readOnlyHint`). Reviewed actions land in `connector_operation_revisions`. The person never sees any of it. Nango gives no trusted action list, and our code marks it unsupported on purpose.
- **The app list is fetched again on every request.** Each page (24 apps) and each search calls `collectCatalog`, which asks Composio for its whole list: about 850 apps at 100 per call, so ~9 upstream calls every time. The agent-facing lookup (`serviceDirectory`) does the same. The only memo is per request signal. The browser refetches too (`staleTime: 0`).

## 2. Logos

- **Show real logos.** Every logo sits on a white rounded tile, in light and dark mode, so black marks (GitHub, Notion) never vanish. We show logos as their owners publish them, without changing them. The letter tile stays as the fallback.
- **Popular apps ship in the repo.** The built-in apps and chat apps carry their marks in `packages/icons` (next to today's Telegram and Slack marks), with each file's source recorded. They show on a fresh install with nothing set up, and offline too.
- **Every other app uses the logo the connection service sends, fetched by our server, never by the browser.** The browser never loads a third-party URL, so Composio can't see which apps a person browses, and cached logos work offline.
  - The server fetches a logo only for an app in its own kept app list, and only from that service's logo address. It never fetches a URL a request names.
  - https only, image types only, size-capped. SVGs are served with headers that stop scripts running.
  - Kept at `~/.dork/cache/connectors/logos/` (resolved through `lib/dork-home.ts`). Precedent: `~/.dork/cache/runtimes/<runtime>/models.json` and `~/.dork/cache/extensions/`. Anything under `cache/` is safe to delete and is rebuilt.
- **New apps get logos for free.** The app list comes from the service, so a new Composio app arrives with its logo link.

## 3. Descriptions

- One plain line per app. Our hand-written line wins. Otherwise we use the service's description, cut to one short sentence.

## 4. The kept app list (efficiency)

- The server keeps each service's full app list in memory and on disk at `~/.dork/cache/connectors/catalog/`. The copy counts as fresh for 24 hours. After that it keeps serving while it refreshes in the background.
- The copy is dropped right away when that service's key or setup changes, or when the service is removed.
- Paging, search and the agent lookup all read the kept copy: at most one upstream listing per service while fresh.
- The file holds no secrets.
- The browser keeps catalog pages for a few minutes.

## 5. What an app lets agents do

**Screen:** `capabilities-panel.html`. **Options:**

- **A:** Look/Change buckets tied to the access choice.
- **B:** The full searchable list.
- **C:** Just a sentence and a count.

**Chosen: A** (owner, 2026-09-27).

- **In the side panel, right under "Who can use it":** the heading "With "Read & write", agents can" sits over two buckets:
  - **Look:** the main read actions.
  - **Change:** the main write actions.
- **Choosing "Read" leaves only Look.** So the level choice finally shows what it means.
- **"See all N actions"** opens the full list, each action tagged Look or Change.
- **Look/Change is the same classification the safety check enforces.** `read` means Look; anything else means Change. The screen can therefore never promise less than what an agent is allowed to do.
- **Fetched on demand when the panel opens,** and kept per service, app and version.
- **Works before an app is connected,** to help a person decide.
- **Services that can't list actions (Nango) say so plainly** and count everything as Change.
- **The list row keeps one plain line.** The chat card keeps its current wording.

## 6. Ranking (MoSCoW)

**Must**

- DOR-2463: keep the app list (§4). This is the efficiency fix, and it's the base for logos.
- DOR-2464: logos and descriptions (§2, §3).

**Should**

- DOR-2465: what an app lets agents do (§5).
- DOR-2444: warnings use an undefined color class.
- DOR-2436: a popular app shows twice through Nango. Nango's `provider` field is Nango's own fixed template id (not the person's key), so it can map to our app id.
- DOR-2450 + DOR-2451: two Connections browser-test flakes (one branch).

**Could (decide later)**

- DOR-2437: Allow once.
- DOR-2438: each app's own wording for access levels. §5 covers most of the need.
- DOR-2448: turn an app back on for one chat.
- DOR-2449: owner-only one-tap from Telegram/Slack.
- DOR-2440: gate wide-reach writes with login off.
- DOR-2439 + CLD-216: every agent for DorkOS-account apps.
- Logos and descriptions in the DorkOS account's app list. This needs a public contract field first; until then those apps reuse the kept logo by app id.
- The chat card naming the exact action an agent needs.

**Won't (this round)**

- Action lists for Nango apps. Nango gives no trusted action data.
