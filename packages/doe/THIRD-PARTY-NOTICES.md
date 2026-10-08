# Third-party notices

Doe depends on the following pinned MIT packages; the extraction listed below includes its upstream permission notice.

- `@earendil-works/pi-agent-core` 1.0.4, upstream `packages/agent/src/agent.ts`, `types.ts`, `agent-loop.ts`: copyright Earendil Works. The installed package exports `Agent`, loop contracts and queues. `AgentOptions.streamFn` is required; `prepareRequest`, `finishTurn`, and awaited subscription listeners are available.
- `@earendil-works/pi-ai` 1.0.4, upstream `packages/ai/src/types.ts`, `api/anthropic-messages.ts`, `api/openai-completions.ts`, `api/openai-responses.ts`, `utils/retry.ts`: copyright Earendil Works. Export maps expose `api/*`, `providers/*`, and `utils/*`; `isRetryableAssistantError` and `retryDelayMs` are audited exports.
- `typebox` 1.3.27: MIT, copyright sinclair. Public schemas use JSON, keeping its runtime-specific schema type inside the engine bridge.

The core dependency's compatible AI range resolves to exactly 1.0.4 in the workspace lockfile and packed production consumer. Pi model protocols stay behind the internal engine bridge. The full Pi coding product is not a dependency.

MIT permission notice for Earendil Works dependencies:

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Tool discovery and MCP (task 2.2)

- `src/registry/bm25.ts` extracts `STOP_WORDS`, singular stemming, `tokenize`, and `Bm25Ranker` from `@earendil-works/pi-coding-agent` **1.0.4**, upstream `packages/coding-agent/src/extensions/tool-search/tool.ts`, as published in the package's source map. Copyright Earendil Works. MIT; the full permission and warranty notice above applies. Local document types replace full-product interfaces; the algorithm is unchanged. Description/searchHint composition and activation are Doe-owned.
- `@earendil-works/pi-mcp` **1.0.4** is a pinned MIT runtime dependency, copyright Earendil Works. Audited published paths: `src/client.ts`, `src/transports/stdio.ts`, `src/transports/streamable-http.ts`, and `src/protocol/content.ts`. Root exports provide `McpClient`, `StdioTransport`, and `StreamableHttpTransport`; no full-product lifecycle is imported. Its packaged `LICENSES/modelcontextprotocol-typescript-sdk.txt` supplies the MIT notice for upstream SDK-derived material.

The local stdio and HTTP fixtures prove the pinned methods rather than relying on 1.1.0 signatures. `connect(transport)` requires an external abort/deadline wrapper; `request`/`callTool` accept signal, timeout and progress. Discovery uses bounded single-page `request('tools/list', ...)`, never aggregate `listTools`. Stdio environment inheritance is disabled. HTTP fetch bounds JSON/error/SSE bodies and rejects redirects, with explicit headers and zero stream reconnect retries. The pinned client cancels RPCs logically. Doe closes its whole connection after a call abort or deadline, aborting outstanding HTTP work and shutting down only its owned stdio process group. The host must create a new connection afterward. Tool results retain raw text/image/structured payloads; errors disclose no transport credentials.

## Context compaction (task 3.2)

The published `@earendil-works/pi-coding-agent` **1.0.4** `dist/core/compaction/compaction.js` was audited for its chars-per-token estimation and complete-group cut-point ideas. Doe's `context-estimation.ts` and `compaction.ts` are owned implementations, using complete JSON size estimates and durable sequence anchors rather than Pi session projections. No implementation was copied from the coding product; it is not a runtime dependency. Counts from this heuristic are labeled estimated, including any growth added to a measured provider baseline.
