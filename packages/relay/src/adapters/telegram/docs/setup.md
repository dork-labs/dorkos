# Telegram Adapter Setup

Connect your DorkOS agents to Telegram chats via the [Bot API](https://core.telegram.org/bots/api).

## Create a Bot

1. Open Telegram and search for **@BotFather** (or tap [this link](https://t.me/botfather)).
2. Send `/newbot` to start the creation flow.
3. Choose a **display name** for your bot (e.g., "My DorkOS Agent"). This is the name users see in chats.
4. Choose a **username** for your bot. It must end in `bot` (e.g., `my_dorkos_agent_bot`).
5. BotFather replies with your bot token. Copy it immediately.

## Get Your Token

The token BotFather sends looks like this:

```
123456789:ABCDefGHijklMNOpqrSTUvwxYZ
```

The format is `{bot_id}:{random_string}` where the bot ID is a numeric identifier and the random string is 35+ alphanumeric characters.

If you already have a bot and need to retrieve the token:

1. Send `/myBots` to **@BotFather**
2. Select your bot from the list
3. Tap **API Token** to view or regenerate it

> **Keep your token secret.** Anyone with the token can control your bot. If you suspect it has been compromised, send `/revoke` to BotFather and generate a new one.

## Connection Modes

DorkOS supports two ways to receive messages from Telegram:

### Long Polling (Default)

The adapter repeatedly asks the Telegram servers for new updates. This is the simplest mode and works in any environment.

- No public URL required
- Works behind firewalls and NATs
- Good for development and most production setups
- Slightly higher latency than webhooks (polling interval)

**Use this mode** unless you have a specific reason to use webhooks.

### Webhook

Telegram pushes updates to a URL you provide. This is more efficient at high message volumes but requires infrastructure.

- Requires a **public HTTPS URL** (Telegram enforces TLS)
- Lower latency for message delivery
- Better suited for high-traffic bots in production

**Use this mode** if you already have a publicly accessible HTTPS endpoint and need minimal latency.

## Webhook Setup

If you selected **Webhook** mode, you need to configure a few additional settings.

### HTTPS Requirement

Telegram requires all webhook URLs to use HTTPS with a valid TLS certificate. Self-signed certificates have [limited support](https://core.telegram.org/bots/webhooks#a-self-signed-certificate) and are not recommended for production.

### Webhook URL

Set the webhook URL to point to your DorkOS instance:

```
https://your-domain.com/relay/webhooks/telegram
```

Replace `your-domain.com` with your actual domain. The path must match the Relay webhook endpoint format.

### Local Development

For local development, use a tunnel service to expose your machine to the internet:

- **[ngrok](https://ngrok.com/):** `ngrok http 4242` then use the generated `https://...ngrok-free.app` URL
- **[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):** `cloudflared tunnel --url http://localhost:4242`

Set the tunnel's HTTPS URL as the **Webhook URL** in the adapter config.

### Webhook Port

The port for the local HTTP server that receives webhook requests. Defaults to `8443`, which is one of the [ports Telegram supports](https://core.telegram.org/bots/api#setwebhook) (`443`, `80`, `88`, `8443`).

### Webhook Secret

An optional secret token for additional request verification. When set, Telegram includes it in the `X-Telegram-Bot-Api-Secret-Token` header of every webhook request. DorkOS verifies the header matches before processing the update.

If left empty, DorkOS auto-generates a secure secret on first connection.

## Testing

After saving the adapter configuration:

1. Open Telegram and find your bot by its username.
2. Send a message (e.g., "Hello").
3. In the DorkOS Relay panel, verify the message appears in the adapter's activity log.
4. Check the adapter status shows **connected** in the Relay settings.

If the bot does not respond, check the DorkOS server logs for connection errors and verify the token is correct.
