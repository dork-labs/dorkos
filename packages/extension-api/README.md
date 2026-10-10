# @dorkos/extension-api

## Purpose

The public contract for DorkOS extensions. Extension authors type against this package; the host (the DorkOS server) provides the implementation. It defines the extension manifest schema, the settings/secrets declaration shapes, and the typed API surface an extension is handed at runtime.

Types and schemas only — no host logic. The runtime that loads, compiles, and sandboxes extensions lives in `apps/server/src/services/extensions/`.

## Exports

| Export                                                                                                | Purpose                                                     |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `.` → `ExtensionManifestSchema`, `SettingDeclarationSchema`, `SettingOptionSchema`                    | Zod schemas for `extension.json` manifests and settings     |
| `.` → `ExtensionManifest`, `ExtensionAPI`, `ExtensionRecord`, `ExtensionStatus`, `ExtensionModule`, … | The types an extension author writes against                |
| `.` → `pageBadgeProblem`, `copyPageBadge`, `PAGE_BADGE_STATUSES`, `ExtensionPageBadge`                | The check and shape behind `api.setPageBadge`               |
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

### A tab badge for your page

`api.setPageBadge(path, badge)` puts a status, a count or one short sentence on every tab showing a page you registered with `registerPage`; pass `null` to clear it. The host checks it with `pageBadgeProblem` (status in `PAGE_BADGE_STATUSES`, count a whole number 0 or more, sentence at most 80 characters), ignores a badge that fails with a console warning, and clears your badges when the extension deactivates.

```ts
api.registerPage('', FlowHome, { title: 'Flow' });
api.setPageBadge('', { status: 'needs-you', count: 2, sentence: '2 ideas wait for you' });
api.setPageBadge('', null); // clear
```

Import server-side contracts from the `./server` subpath when building host-facing capabilities (secrets, settings, data providers).
