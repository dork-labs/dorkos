# Pitfalls: things that pass your tests and fail in DorkOS

## 1. Extension `.ts` files compile as TSX

DorkOS compiles `.ts` files, server files included, as TSX. A generic arrow function
parses as a JSX tag and breaks the build:

```ts
// Breaks in DorkOS
const first = <T>(items: T[]) => items[0];

// Works
function first<T>(items: T[]): T | undefined {
  return items[0];
}
```

`node --test` or `tsc` on the same file passes, so only DorkOS shows the error, often only
in the server log. Use plain `function` declarations for generics. If the app has its
own tests, add one that fails on a generic arrow (a grep for `= <` followed by an
identifier and `>(` is enough).

## 2. Untyped tool inputs are refused, after approval

Every agent tool's `inputSchema` must be closed: each object sets
`"additionalProperties": false`, and every field has a type. No `patternProperties`,
`propertyNames` or `$ref`. A field with no type, or an open map, is refused when the
server registers its handlers. That happens at start, after the person approved, so:

- the manifest loads and the app shows "compiled",
- `test_extension` can still pass,
- the server doesn't start, and one refused tool can stop the whole server.

For a value that may be a map or any shape, take it as a JSON string and parse it in the
handler. After install, check `serverStatus: active` and each tool's `status: active`.

`act` and `destructive` tools also need `approvalDisplayFields`, so the person sees what
they're approving.

## 3. "compiled" isn't "started"

`create_extension` and `list_extensions` say `compiled` when the bundle builds. A server
that fails at start still says `compiled`. Read `serverStatus`, each tool's status,
`get_extension_errors` and the server log. If `get_extension_errors` is empty but
`serverStatus` isn't `active`, trust `serverStatus`.

## 4. UI copy must point at something that exists

Text that sends the person somewhere ("approve it under Needs you", "open Settings →
Keys", "click Sync") must match the real state the app is in. An empty state that
points at a card or button that isn't there is a bug. Check each such line against the
app in that exact state (empty, loading, error, full) before you hand it over. If the
thing it points at can't be reached from the app, say what's missing and show no button.

## 5. The sandboxed frame (extension API v2)

On DorkOS with API v2, app screens run in an isolated frame. The manifest sets
`"clientApiVersion": 2`; without it no screen code runs.

- **No `fetch`.** Call your own server with `api.request(path, { method, body })`, which
  needs `capabilities.http`. Pictures and video come through `api.media(path)`.
- **Other apps only through declared exports.** To call another app, list it in
  `capabilities.http.apps`; that app must list the route and method in its
  `exports.http`. Export the fewest routes, name their callers, and keep person-only
  routes in `personOnly`.
- **`minHostVersion` is enforced.** Set it to the first release with every API the app
  uses, so an older DorkOS refuses it instead of breaking.

## 6. The fill view scrolls at `#root`

In a page or panel the frame's `#root` is the scroller; `html` and `body` don't
scroll. An inner `h-full` box that's meant to scroll grows instead, and content below the
fold is cut off. Test with content taller than the view, using a real mouse wheel and
the End key, not only a screenshot of the top.

## 7. Layout follows the app's width, not the window's

The same app runs in a narrow panel and a full window. Size with container queries on
the app's own root, not viewport media queries. Touch targets at least 44 px on coarse
pointers; nothing that only shows on hover. If your team has a shared UI kit (lists,
tabs, alerts, loading and error states, time formats), use it so apps look and behave
alike, and get your designer's OK on anything people see.

## 8. Data agents can't overwrite

Decisions, approvals, limits and anything else the person controls must not live in a
file an agent can edit (a plain JSON file in a folder the agent writes to). Keep them in
the app's own storage behind a person-only route or setting, and give agent tools only
the reads and writes the job needs. Never edit a data migration that already ran; add a
new one.

"Person-only" means checked on the server. Writes to those fields go through a route
behind `requirePerson`, and no agent tool may set them, including a generic "update
record" tool. Text that came from outside (web pages, messages, other agents) and is
stored in the app is shown as plain text, never as HTML or a clickable action.

## 9. Small things

- Client code can't import npm packages like `lucide-react`. Inline small SVGs.
- `registerComponent` options: `label` names a right-panel tab; the host draws the tab
  strip and header, so render only the body.
- Subscribing to events needs `capabilities.events` in the manifest; undeclared kinds are
  dropped.
- Agent tool names are lowercase words joined by single underscores, and agents see them
  as `ext_<id with - as _>__<name>`. Keep the whole thing within 64 characters.
- Bump `version` on every change, so the person and the extension list can tell builds
  apart.
