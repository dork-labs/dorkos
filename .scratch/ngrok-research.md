# @ngrok/ngrok Node.js SDK Research

**Note**: This research was compiled from training data (knowledge cutoff: January 2025) due to web search tool limitations. Please verify critical details against current official documentation at https://ngrok.com/docs/integrations/javascript/ and https://github.com/ngrok/ngrok-javascript

---

## 1. Installation

### Package Name
```bash
npm install @ngrok/ngrok
```

The official package is `@ngrok/ngrok` on npm (previously there was an unofficial `ngrok` package, but the official one uses the `@ngrok` scope).

---

## 2. Programmatic API

### Basic HTTP Tunnel

```typescript
import ngrok from '@ngrok/ngrok';

// Start a tunnel
const listener = await ngrok.forward({
  addr: 6942,  // Local port
  authtoken: 'your_auth_token_here',
});

// Get the public URL
console.log(`Tunnel established: ${listener.url()}`);

// The listener acts as a Node.js net.Server
// Keep it running while you need the tunnel
```

### With Basic Auth

```typescript
const listener = await ngrok.forward({
  addr: 6942,
  authtoken: process.env.NGROK_AUTHTOKEN,
  basic_auth: ['username:password'],  // Can be array of multiple credentials
});

console.log(`Tunnel with basic auth: ${listener.url()}`);
```

### Full Configuration Example

```typescript
import ngrok from '@ngrok/ngrok';

const listener = await ngrok.forward({
  // Required
  addr: 6942,  // or 'localhost:6942' or '0.0.0.0:6942'

  // Auth
  authtoken: process.env.NGROK_AUTHTOKEN,

  // HTTP options
  basic_auth: ['user:pass'],
  domain: 'my-custom-domain.ngrok.app',  // Requires paid plan

  // Security
  circuit_breaker: 0.5,  // Reject requests when 5XX responses exceed this ratio

  // Headers
  request_headers: {
    add: { 'X-Custom-Header': 'value' },
    remove: ['X-Unwanted-Header'],
  },
  response_headers: {
    add: { 'X-Response-Header': 'value' },
    remove: ['X-Remove-This'],
  },

  // Traffic policy (advanced)
  policy: '...', // JSON traffic policy
});

console.log('Tunnel URL:', listener.url());
```

### Stopping the Tunnel

```typescript
// Close the tunnel
await listener.close();

// Or with a timeout
await listener.close({ timeout: 5000 });  // Wait up to 5s for graceful shutdown
```

### Express Integration Example

```typescript
import express from 'express';
import ngrok from '@ngrok/ngrok';

const app = express();
const PORT = 6942;

app.get('/', (req, res) => {
  res.send('Hello from ngrok!');
});

// Start Express server
const server = app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  // Start ngrok tunnel
  try {
    const listener = await ngrok.forward({
      addr: PORT,
      authtoken: process.env.NGROK_AUTHTOKEN,
      basic_auth: process.env.NGROK_BASIC_AUTH
        ? [process.env.NGROK_BASIC_AUTH]  // Format: 'user:pass'
        : undefined,
    });

    console.log(`Public URL: ${listener.url()}`);

    // Store listener for cleanup
    process.on('SIGINT', async () => {
      console.log('Closing ngrok tunnel...');
      await listener.close();
      server.close();
      process.exit(0);
    });
  } catch (error) {
    console.error('Failed to start ngrok:', error);
  }
});
```

---

## 3. Configuration Options

### Common Options

| Option | Type | Description | Requires Paid? |
|--------|------|-------------|----------------|
| `addr` | `string \| number` | Local port or address to forward | No |
| `authtoken` | `string` | ngrok auth token | No |
| `basic_auth` | `string[]` | Basic auth credentials (format: `'user:pass'`) | **Yes** (paid plan) |
| `domain` | `string` | Custom/static domain | **Yes** (paid plan) |
| `circuit_breaker` | `number` | Reject when 5XX ratio exceeds this (0-1) | No |
| `compression` | `boolean` | Enable gzip compression | No |
| `mutual_tls_cas` | `Buffer[]` | Mutual TLS certificate authorities | **Yes** |
| `oauth` | `object` | OAuth configuration | **Yes** |
| `oidc` | `object` | OIDC configuration | **Yes** |
| `request_headers` | `object` | Modify request headers | No |
| `response_headers` | `object` | Modify response headers | No |
| `websocket_tcp_converter` | `boolean` | Convert WebSocket to TCP | No |
| `verify_webhook` | `object` | Webhook verification | **Yes** |
| `policy` | `string` | Traffic policy JSON | **Yes** |

### Advanced Tunnel Types

```typescript
// TCP tunnel
const tcpListener = await ngrok.forward({
  addr: 22,
  proto: 'tcp',
  authtoken: process.env.NGROK_AUTHTOKEN,
});

// TLS tunnel
const tlsListener = await ngrok.forward({
  addr: 443,
  proto: 'tls',
  authtoken: process.env.NGROK_AUTHTOKEN,
});
```

---

## 4. Auth Token

### Setting the Auth Token

**Three methods** (in order of precedence):

1. **Inline in code**:
   ```typescript
   await ngrok.forward({
     addr: 6942,
     authtoken: 'your_token_here',
   });
   ```

2. **Environment variable**:
   ```bash
   export NGROK_AUTHTOKEN=your_token_here
   ```
   Then omit from config:
   ```typescript
   await ngrok.forward({ addr: 6942 });  // Reads from env
   ```

3. **Default config file** (written by `ngrok config add-authtoken`):
   - Linux/macOS: `~/.config/ngrok/ngrok.yml`
   - Windows: `%USERPROFILE%\.ngrok2\ngrok.yml`

### Getting an Auth Token

1. Sign up at https://dashboard.ngrok.com/signup
2. Find your authtoken at https://dashboard.ngrok.com/get-started/your-authtoken
3. Free tier includes basic tunneling

---

## 5. Free vs Paid Features

### Free Tier (No Credit Card Required)
- ✅ HTTP/HTTPS tunnels
- ✅ Random public URLs (e.g., `https://abc123.ngrok.app`)
- ✅ 1 online tunnel at a time
- ✅ 40 connections per minute
- ✅ Basic request inspection
- ✅ Request/response header modification
- ✅ Circuit breaker
- ✅ Compression

### Paid Features (Requires Subscription)
- ❌ **Basic Authentication** (requires Personal plan or higher)
- ❌ **Custom/Static Domains** (e.g., `my-app.ngrok.app`)
- ❌ **OAuth/OIDC Authentication**
- ❌ **Mutual TLS**
- ❌ **IP Restrictions**
- ❌ **Webhook Verification**
- ❌ **Traffic Policies**
- ❌ Multiple simultaneous tunnels
- ❌ Reserved TCP addresses
- ❌ Custom TLS certificates

**Critical for your use case**: Basic auth (`basic_auth` option) **requires a paid plan**. On the free tier, attempting to use `basic_auth` will result in an error.

### Plan Tiers (as of 2024)
- **Free**: $0/month - 1 tunnel, random URLs only
- **Personal**: ~$8-10/month - Custom domains, basic auth, OAuth
- **Pro**: ~$20-30/month - More tunnels, IP restrictions
- **Enterprise**: Custom pricing

Check current pricing at https://ngrok.com/pricing

---

## 6. Error Handling

### Missing Auth Token

```typescript
try {
  const listener = await ngrok.forward({ addr: 6942 });
} catch (error) {
  if (error.message.includes('authtoken')) {
    console.error('Auth token missing. Set NGROK_AUTHTOKEN or provide authtoken option.');
    console.error('Get your token at: https://dashboard.ngrok.com/get-started/your-authtoken');
  }
}
```

**Error message**: `"Your authtoken is missing. ..."` or similar.

### Using Paid Features on Free Plan

```typescript
try {
  const listener = await ngrok.forward({
    addr: 6942,
    basic_auth: ['user:pass'],  // This will fail on free plan
  });
} catch (error) {
  console.error('Failed to start tunnel:', error.message);
  // Error will mention account limitations
}
```

**Error message**: `"HTTP Basic Authentication is not available on your plan..."` or similar.

### Network/Connection Errors

```typescript
try {
  const listener = await ngrok.forward({ addr: 6942, authtoken: 'token' });
} catch (error) {
  if (error.message.includes('ECONNREFUSED')) {
    console.error('Cannot connect to ngrok service');
  } else if (error.message.includes('ENOTFOUND')) {
    console.error('DNS resolution failed - check internet connection');
  } else {
    console.error('Tunnel error:', error);
  }
}
```

### Common Error Scenarios

| Error | Cause | Solution |
|-------|-------|----------|
| "authtoken required" | No token provided | Set `NGROK_AUTHTOKEN` or pass `authtoken` option |
| "account limit exceeded" | Using paid feature on free plan | Upgrade plan or remove feature |
| "tunnel not found" | Invalid domain | Check domain spelling or use random URL |
| "port already in use" | Port conflict | Change local port or kill existing process |
| "connection refused" | Local server not running | Start your Express server before ngrok |

### Robust Startup Pattern

```typescript
import ngrok from '@ngrok/ngrok';
import express from 'express';

const app = express();
const PORT = process.env.PORT || 6942;

async function startServer() {
  // First, start the Express server
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
      resolve(s);
    });
  });

  // Then start ngrok tunnel
  try {
    const listener = await ngrok.forward({
      addr: PORT,
      authtoken: process.env.NGROK_AUTHTOKEN,
    });

    console.log(`✓ Public URL: ${listener.url()}`);

    return { server, listener };
  } catch (error) {
    console.error('Failed to create ngrok tunnel:', error.message);
    console.error('Server still accessible locally at http://localhost:' + PORT);

    // Decide: continue without tunnel or exit
    return { server, listener: null };
  }
}

startServer().then(({ server, listener }) => {
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    if (listener) await listener.close();
    server.close(() => process.exit(0));
  });
});
```

---

## Additional Resources

- **Official Docs**: https://ngrok.com/docs/integrations/javascript/
- **GitHub**: https://github.com/ngrok/ngrok-javascript
- **npm Package**: https://www.npmjs.com/package/@ngrok/ngrok
- **API Reference**: https://ngrok.github.io/ngrok-javascript/
- **Dashboard**: https://dashboard.ngrok.com/

---

## Quick Reference Card

```typescript
// Minimal setup
import ngrok from '@ngrok/ngrok';

const listener = await ngrok.forward({
  addr: 6942,
  authtoken: process.env.NGROK_AUTHTOKEN,
});

console.log(listener.url());  // https://abc123.ngrok.app
await listener.close();

// With all common options
const listener = await ngrok.forward({
  addr: 6942,
  authtoken: process.env.NGROK_AUTHTOKEN,
  domain: 'my-app.ngrok.app',  // Paid only
  basic_auth: ['user:pass'],    // Paid only
  circuit_breaker: 0.5,
  request_headers: { add: { 'X-Custom': 'value' } },
});
```

**Environment Variables**:
- `NGROK_AUTHTOKEN` - Auth token (auto-detected)

**Critical Notes**:
- Basic auth requires paid plan ($8-10/month minimum)
- Free tier allows 1 tunnel with random URLs
- Auth token is required (get from dashboard)
- SDK bundles the ngrok agent (no separate installation needed)
