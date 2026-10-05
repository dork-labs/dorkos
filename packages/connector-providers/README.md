# @dork-labs/connector-providers

The connector contract DorkOS speaks, plus the adapter that talks to Composio.

DorkOS lets an agent act in your other apps (Gmail, Slack, Notion and more) through a
connection you approve. This package holds the parts of that which more than one program needs:
the DorkOS app uses it on your computer, and DorkOS Cloud uses the same code for hosted
connections. Publishing it means both sides read one definition instead of two copies that drift.

```bash
npm install @dork-labs/connector-providers zod
```

## Entry points

```ts
// The Composio adapter: catalog reads, managed accounts, events and webhook checks.
// This entry point and the root one load the Composio SDK.
import {
  ComposioSdkClient,
  ComposioWebhookVerifier,
} from '@dork-labs/connector-providers/composio';

// Zod schemas and types for connections, operations, events and the provider port.
// Zod only, so a browser can use them.
import { ConnectionIdSchema } from '@dork-labs/connector-providers/connector-schemas';
import { ConnectorEventDefinitionSchema } from '@dork-labs/connector-providers/connector-event-schemas';
import type { ConnectorProvider } from '@dork-labs/connector-providers/connector-provider';
import type { ConnectorEventCapability } from '@dork-labs/connector-providers/connector-events';
import { ConnectorAuthenticationSetupSchema } from '@dork-labs/connector-providers/connector-authentication-setup';

// Key-sorted JSON, the form DorkOS hashes connector material over.
import { stableStringify } from '@dork-labs/connector-providers/stable-stringify';

// Check an agent's arguments against an operation's JSON Schema, without filling defaults.
import { checkConnectorArguments } from '@dork-labs/connector-providers/connector-arguments';

// The wire schemas between a linked DorkOS app and DorkOS Cloud for hosted connections.
import { ManagedConnectorExecutionRequestSchema } from '@dork-labs/connector-providers/connector-managed-schemas';
import { ManagedConnectorCatalogPageSchema } from '@dork-labs/connector-providers/connector-managed-discovery-schemas';
import { ManagedConnectorUsageResponseSchema } from '@dork-labs/connector-providers/connector-managed-usage-schemas';
```

The root entry (`@dork-labs/connector-providers`) re-exports the Composio adapter and the event
payload protector. Prefer the narrow subpaths when you only need the schemas: they never load the
Composio SDK.

## Versions

This package carries the same version as each DorkOS release and is published with it, together
with `@dork-labs/cloud-api`. The two always share a version number.

While the version starts with `0.`, a caret range such as `^0.97.0` holds you on one release.
Pin an exact version and bump it when you take a new DorkOS release.

## Dependencies

- `zod` is a **peer dependency** (`^4.6.2`), so your app and this package share one copy and
  their schemas recognise each other.
- `@composio/core` is a regular dependency at an **exact** version. The adapter is written
  against that version's exact shapes.
- This is a Node.js package. If you use TypeScript, install `@types/node` too: the Composio
  SDK's own type files refer to Node's built-in modules.
- `@dork-labs/cloud-api` is a regular dependency at the **same exact version** as this package.
  The hosted-connection schemas use its connection grant shape. npm installs it for you.
- Nothing else. No other package from the DorkOS monorepo is a dependency.
  `src/__tests__/packaging.test.ts` checks this from the manifest, the imports and the lockfile.

## Development

```bash
pnpm --filter @dork-labs/connector-providers build       # ESM + .d.ts into dist/
pnpm --filter @dork-labs/connector-providers typecheck
pnpm --filter @dork-labs/connector-providers lint
pnpm vitest run packages/connector-providers             # from the repo root
```

Inside the monorepo, `@dorkos/shared` re-exports the schema modules under its old subpaths
(`@dorkos/shared/connector-schemas` and the rest), so app code keeps one import. The modules
themselves live here; edit them here.

## License

MIT
