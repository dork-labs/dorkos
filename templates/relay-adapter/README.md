# DorkOS Relay Adapter Template

A minimal working template for a custom DorkOS relay adapter.

`@dorkos/relay` is private and not published to npm, and the adapter imports
it when it runs (`BaseRelayAdapter`). So an adapter built from this template
lives in your own DorkOS checkout, and DorkOS loads it from there by file path.
It cannot be published to npm as a standalone package.

The copy goes under `packages/`, so pnpm links `@dorkos/relay` for it, and that
makes it a workspace project. Add its folder to the `projects` list in the root
`vitest.config.ts`: `scripts/__tests__/vitest-projects.test.ts` fails until you
do. Keep it on your own branch rather than proposing it upstream.

## Quick Start

1. **Copy this template** into a new directory:

   ```bash
   cp -r templates/relay-adapter packages/dorkos-relay-my-adapter
   pnpm install
   pnpm --filter @dorkos/relay build
   cd packages/dorkos-relay-my-adapter
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

   All compliance tests should pass before you load it.

6. **Build it** with `pnpm build`, which writes `dist/index.js`.

7. **Configure in DorkOS** by adding an entry to `~/.dork/relay/adapters.json`:

   ```json
   {
     "adapters": [
       {
         "id": "my-adapter-1",
         "type": "plugin",
         "plugin": {
           "path": "/path/to/dorkos/packages/dorkos-relay-my-adapter/dist/index.js"
         },
         "config": { "apiKey": "your-api-key" }
       }
     ]
   }
   ```

   `path` is absolute or relative to `~/.dork/relay/`. Point it at the built
   file inside your checkout, so the adapter's own `@dorkos/relay` import
   resolves. Never commit `adapters.json`: it can hold secrets.

## API Versioning

The `apiVersion` field in your manifest (`src/index.ts`) declares which relay
adapter API your adapter targets. The DorkOS plugin loader emits a warning if
your adapter was built against an incompatible host version. The template sets
it from `RELAY_ADAPTER_API_VERSION`, so pulling a newer DorkOS and rebuilding
(`pnpm --filter @dorkos/relay build`, then `pnpm build` here) keeps it current.
