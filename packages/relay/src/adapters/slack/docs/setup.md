# Slack Adapter Setup

Connect your DorkOS agents to Slack channels and DMs using Socket Mode.

## Quick Start

The fastest way to get started is with the **one-click app creation** flow:

1. Click the **Create Slack App** button in the adapter wizard. This opens Slack with a pre-filled manifest that auto-configures Socket Mode, bot events, and OAuth scopes.
2. Select the workspace you want to install the app to and click **Create**.
3. On the **Basic Information** page, scroll to **Install your app** and click **Install to Workspace**. Approve the requested permissions.
4. Copy the three credentials into the DorkOS wizard:
   - **Bot Token** (`xoxb-...`) from **OAuth & Permissions**
   - **App-Level Token** (`xapp-...`) from **Basic Information > App-Level Tokens** (generate one with the `connections:write` scope)
   - **Signing Secret** from **Basic Information > App Credentials**

That's it. The adapter connects via Socket Mode, so no public URL is required.

## Manual Setup

If you prefer to configure each setting yourself, or need a custom scope set:

### Step 1: Create the App

Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App > From Scratch**. Choose a name and workspace.

### Step 2: Enable Socket Mode

Navigate to **Settings > Socket Mode** in the left sidebar and toggle it on. Socket Mode lets DorkOS receive events over a WebSocket connection without exposing a public endpoint.

### Step 3: Subscribe to Bot Events

Go to **Features > Event Subscriptions** and toggle **Enable Events** on. Under **Subscribe to bot events**, add the following:

- `message.channels` -- messages in public channels the bot is in
- `message.groups` -- messages in private channels the bot is in
- `message.im` -- direct messages to the bot
- `app_mention` -- when someone @mentions the bot

Click **Save Changes**.

### Step 4: Add Bot Token Scopes

Navigate to **Features > OAuth & Permissions** and scroll to **Scopes > Bot Token Scopes**. Add all of the following:

| Scope | Purpose |
|---|---|
| `channels:history` | Read messages in public channels |
| `channels:read` | List and get info about public channels |
| `chat:write` | Send messages as the bot |
| `groups:history` | Read messages in private channels |
| `groups:read` | List and get info about private channels |
| `im:history` | Read direct message history |
| `im:read` | List and get info about DM conversations |
| `im:write` | Open and manage DM conversations |
| `mpim:history` | Read group DM history |
| `app_mentions:read` | Read @mention events |
| `users:read` | Resolve user display names |

### Step 5: Install the App

Go back to **Features > OAuth & Permissions** and click **Install to Workspace**. Authorize the app when prompted.

### Step 6: Copy the Bot Token

After installation, the **Bot User OAuth Token** appears on the OAuth & Permissions page. It starts with `xoxb-`. Copy it into the DorkOS wizard.

### Step 7: Generate an App-Level Token

Go to **Settings > Basic Information**, scroll to **App-Level Tokens**, and click **Generate Token and Scopes**. Give it a name (e.g., "dorkos-socket"), add the `connections:write` scope, and click **Generate**. Copy the token (starts with `xapp-`).

### Step 8: Copy the Signing Secret

Still on the **Basic Information** page, scroll to **App Credentials** and click **Show** next to **Signing Secret**. Copy it into the DorkOS wizard.

## Critical Warning

> **Do NOT enable "Agents & AI Apps"** in your Slack app settings.
>
> The "Agents & AI Apps" feature silently adds user-level OAuth scopes to your app. Most workspace plans do not support user scopes on bot apps, which causes `invalid_scope` errors during installation. If you have already enabled it, go to **Features > OAuth & Permissions**, remove any scopes listed under **User Token Scopes**, and reinstall the app.

## Troubleshooting

### `invalid_scope` Error

User scopes are present on the app. This usually happens when "Agents & AI Apps" has been enabled.

**Fix:** Go to **Features > OAuth & Permissions**, remove all scopes under **User Token Scopes**, and reinstall the app to your workspace.

### `not_authed` Error

The wrong token type is being used. DorkOS requires the **Bot User OAuth Token** (starts with `xoxb-`), not a user token (`xoxp-`).

**Fix:** Go to **Features > OAuth & Permissions** and copy the token listed under **Bot User OAuth Token**.

### `missing_scope` Error

A required bot scope is missing.

**Fix:** Go to **Features > OAuth & Permissions > Bot Token Scopes** and verify all 11 scopes from Step 4 above are listed. After adding any missing scopes, reinstall the app.

### Socket Mode Connection Failures

The App-Level Token is missing the required scope.

**Fix:** Go to **Settings > Basic Information > App-Level Tokens**, click on the token, and verify it has the `connections:write` scope. If not, delete it and generate a new one with the correct scope.

### Bot Not Responding in a Channel

The bot must be explicitly invited to channels it should monitor.

**Fix:** In Slack, type `/invite @YourBotName` in the channel where you want the bot to listen.
