# DorkOS Relay Adapter Template

A minimal working template for a custom DorkOS relay adapter.

## Quick Start

1. **Copy this template** into a new directory:

   ```bash
   cp -r templates/relay-adapter my-org/dorkos-relay-my-adapter
   cd my-org/dorkos-relay-my-adapter
   ```

2. **Rename** `MyAdapter` to your adapter name everywhere:
   - `src/my-adapter.ts` → `src/my-adapter.ts` (rename file if desired)
   - Update the class name, `subjectPrefix`, and manifest `type` / `displayName`

3. **Update `subjectPrefix`** to your channel's subject hierarchy:

   ```typescript
   // In my-adapter.ts
   super(id, 'relay.custom.your-service', displayName);
   ```

4. **Implement the three methods:**

   ```typescript
   protected async _start(relay: RelayPublisher): Promise<void> {
     // Connect to your external service
     // Use this.relay to publish inbound messages
   }

   protected async _stop(): Promise<void> {
     // Disconnect and drain in-flight messages
   }

   async deliver(subject: string, envelope: RelayEnvelope): Promise<DeliveryResult> {
     // Forward envelope.payload to your external channel
     this.trackOutbound(); // call after successful delivery
     return { success: true };
   }
   ```

5. **Run the compliance suite** to validate your implementation:

   ```bash
   pnpm test
   ```

   All compliance tests should pass before publishing.

6. **Configure in DorkOS** by adding an entry to `~/.dork/adapters.json`:

   ```json
   {
     "adapters": [
       {
         "id": "my-adapter-1",
         "type": "plugin",
         "plugin": { "package": "dorkos-relay-my-adapter" },
         "config": { "apiKey": "your-api-key" }
       }
     ]
   }
   ```

   Never commit `adapters.json` — it contains secrets.

## Publishing

```bash
pnpm build
pnpm publish --access public
```

## API Versioning

The `apiVersion` field in your manifest (`src/index.ts`) declares which relay
adapter API your adapter targets. The DorkOS plugin loader emits a warning if
your adapter was built against an incompatible host version. Update this field
when you rebuild against a new `@dorkos/relay` release.
