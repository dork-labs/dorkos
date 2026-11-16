# Worked example: a hello card

Request: "Put a small card in Activity that says hello."

## 0. Interview

The request already answers where it shows, so one short round covers the rest:

> Before I build: (1) a small section at the top of Activity, nothing else. (2) You'll
> glance at it, so it stays one line. (3) It reads nothing and sends nothing. (4) Just
> for you. Change any of these, or say go.

The person says go. Nothing needs a network, a key, server code or agent tools, so the
smallest template does: `dashboard-card`.

## 1. Scaffold

```
create_extension(
  name: "hello-card",
  description: "An Activity section that says hello. Reads nothing, sends nothing.",
  template: "dashboard-card"
)
```

Reply (trimmed):

```json
{
  "id": "hello-card",
  "status": "compiled",
  "bundleReady": true,
  "files": ["extension.json", "index.ts"],
  "autoApproved": { "runtime": "in-process", "net": [], "run": [], "agents": false }
}
```

`compiled` is the build. `autoApproved` appears because this is a Trusted install and
the starter is untouched. It says what the template may run with: in-process, no hosts,
no commands, no agent access. This app is screen code only, so a change to it waits for
the person's yes before it shows; say that when you report it. If the reply says
`approval_required` instead, it's waiting for the person: tell them, and call again
with the token only after they approve.

## 2. The files

`extension.json`: one contribution, no `serverCapabilities`, no `tools`, no
`capabilities`. The one change from the starter: `minHostVersion` goes from the
placeholder `0.1.0` to the first release with API v2 (shown here as `<v2 release>`).

```json
{
  "id": "hello-card",
  "name": "Hello Card",
  "version": "0.1.0",
  "description": "An Activity section that says hello. Reads nothing, sends nothing.",
  "minHostVersion": "<v2 release>",
  "clientApiVersion": 2,
  "contributions": { "dashboard.sections": true }
}
```

`index.ts` registers one component. A plain `function`, no generic arrows:

```tsx
import type { ExtensionAPI } from '@dorkos/extension-api';

function HelloCard() {
  return (
    <div style={{ padding: '16px', border: '1px solid var(--border)', borderRadius: '12px' }}>
      <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>Hello</h3>
    </div>
  );
}

export function activate(api: ExtensionAPI): void {
  api.registerComponent('dashboard.sections', 'hello-card-section', HelloCard, { priority: 50 });
}
```

## 3. Test

```
test_extension(id: "hello-card")
```

```json
{
  "status": "ok",
  "contributions": { "dashboard.sections": 1, "right-panel": 0, "command-palette.items": 0 },
  "message": "Extension activated successfully. Registered 1 contribution(s)."
}
```

One Activity section (slot id `dashboard.sections`), as meant.

## 4. Check it started

`list_extensions`, your entry:

```json
{ "id": "hello-card", "status": "compiled", "bundleReady": true,
  "hasServerEntry": false, "serverStatus": "inactive" }
```

`serverStatus: inactive` is right here: there's no server code. For an app with
`server.ts`, anything but `active` means it didn't start; read `get_extension_errors`
and the server log.

## 5. Prove it

Four screenshots of the Activity section: 390 px and desktop, light and dark. It has no
data, so the empty state is the only state. Post them with the review.

## 6. Tell the person

> Built by {your name} from your request. **Hello Card** is one section at the top of
> Activity that says hello. It takes no other surface. It reaches nothing outside your
> screen: no files, no network, no keys, no agent tools. It never posts or sends. You
> can turn it off in Settings → Extensions.
