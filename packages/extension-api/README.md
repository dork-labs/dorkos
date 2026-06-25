# @dorkos/extension-api

## Purpose

The public contract for DorkOS extensions. Extension authors type against this package; the host (the DorkOS server) provides the implementation. It defines the extension manifest schema, the settings/secrets declaration shapes, and the typed API surface an extension is handed at runtime.

Types and schemas only — no host logic. The runtime that loads, compiles, and sandboxes extensions lives in `apps/server/src/services/extensions/`.

## Exports

| Export                                                                                                | Purpose                                                     |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `.` → `ExtensionManifestSchema`, `SettingDeclarationSchema`, `SettingOptionSchema`                    | Zod schemas for `extension.json` manifests and settings     |
| `.` → `ExtensionManifest`, `ExtensionAPI`, `ExtensionRecord`, `ExtensionStatus`, `ExtensionModule`, … | The types an extension author writes against                |
| `./server` → `SecretStore`, `SettingsStore`, `DataProviderContext`, `ServerExtensionRegister`         | Server-side extension contracts (the host implements these) |

## Usage

```ts
import type { ExtensionModule, ExtensionAPI } from '@dorkos/extension-api';

const extension: ExtensionModule = {
  activate(api: ExtensionAPI) {
    // register contributions against the host-provided API
  },
};
export default extension;
```

Import server-side contracts from the `./server` subpath when building host-facing capabilities (secrets, settings, data providers).
