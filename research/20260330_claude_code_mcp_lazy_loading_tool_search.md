---
title: 'Claude Code MCP Lazy Loading / Tool Search — Comprehensive Research'
date: 2026-03-30
type: external-best-practices
status: active
tags: [claude-code, mcp, tool-search, lazy-loading, defer-loading, token-optimization, agent-sdk]
searches_performed: 11
sources_count: 14
---

## Research Summary

Anthropic shipped "Tool Search" — their official term for MCP lazy loading / deferred tool loading — as a beta in November 2025 and enabled it by default in Claude Code in January 2026. The feature operates at two distinct levels: (1) the raw **Messages API** (available to anyone via `defer_loading: true` + a `tool_search_tool_*` tool), and (2) the **Claude Code CLI** (automatic, threshold-based). The **Claude Agent SDK** (TypeScript and Python) does **not** yet surface this natively — it is an open feature request as of March 2026.

## Key Findings

1. **Tool Search is Anthropic's canonical name for MCP lazy loading.** It was announced via the engineering blog on November 24, 2025 and became a stable-ish API feature requiring the beta header `advanced-tool-use-2025-11-20`.

2. **The token savings are enormous.** A typical multi-server MCP setup (GitHub, Slack, Sentry, Grafana, Splunk) consumes ~77K tokens in tool definitions before any work begins. Tool Search brings this to ~8.7K tokens — an 85%+ reduction. Only the 3–5 tools Claude actually invokes enter context.

3. **The Messages API implementation is production-ready and fully documented.** You mark tools with `defer_loading: true` and include a `tool_search_tool_regex_20251119` or `tool_search_tool_bm25_20251119` sentinel tool. Claude performs a search, gets back `tool_reference` blocks, which auto-expand server-side — prompt caching is preserved.

4. **Claude Code CLI enabled this by default in January 2026.** It activates automatically when MCP tool descriptions exceed 10K tokens. The env var `ENABLE_TOOL_SEARCH=auto` switches to a threshold-only mode (load upfront if within 10% of context window, defer the overflow).

5. **The Claude Agent SDK (TypeScript) does not natively support `defer_loading` yet.** Issue #124 in `anthropics/claude-agent-sdk-typescript` was opened January 10, 2026 and remains open as of March 12, 2026. The Python SDK has a parallel open issue (#525). There is no workaround short of reducing configured tools.

6. **Model support is restricted.** Tool Search only works with Sonnet 4.0+ and Opus 4.0+. Haiku models are excluded. On Bedrock, it only works via the Invoke API (not Converse API). On Vertex and Foundry it is not available for the MCP Connector.

7. **There is a known bug with `defer_loading + cache_control` interaction.** Claude Code 2.1.69 breaks all MCP tool calls when both flags are set on the same tool definition. Workaround: downgrade to 2.1.68 or set `ENABLE_TOOL_SEARCH=false`. This was partially fixed in 2.1.85 (deferred tools losing input schemas after compaction also fixed there).

---

## Detailed Analysis

### How Tool Search Works (Messages API)

When you include a `tool_search_tool_regex_20251119` or `tool_search_tool_bm25_20251119` tool in your `tools` array:

1. All tools you mark `defer_loading: true` are **not** included in the system-prompt prefix sent to the model.
2. Claude sees only the search tool and any non-deferred tools.
3. When Claude needs a tool, it calls the search tool with a regex or natural-language query.
4. The Anthropic API executes the search server-side and returns 3–5 `tool_reference` blocks.
5. Those references auto-expand inline (as `tool_reference` blocks in the conversation, not in the prefix), so **prompt caching is preserved** — the prefix never changes.
6. Because the grammar for strict mode is built from the full toolset, `defer_loading` and strict mode compose without grammar recompilation.

**Two search variants:**

- `tool_search_tool_regex_20251119` — Claude constructs Python `re.search()` patterns (max 200 chars). Case-sensitive by default; use `(?i)` prefix for case-insensitive.
- `tool_search_tool_bm25_20251119` — Claude uses natural language queries. Generally better for semantically varied tool libraries.

**MCP Connector integration:** When using `mcp_toolset`, you configure `defer_loading` at the toolset level:

```json
{
  "type": "mcp_toolset",
  "mcp_server_name": "my-server",
  "default_config": {
    "defer_loading": true
  },
  "configs": {
    "frequently_used_tool": { "defer_loading": false }
  }
}
```

**Constraint:** At least one tool must not be deferred. You cannot defer the search tool itself. You can defer the entire MCP server by default and explicitly opt specific tools back in as non-deferred.

**Usage tracking:**

```json
{
  "usage": {
    "input_tokens": 1024,
    "output_tokens": 256,
    "server_tool_use": { "tool_search_requests": 2 }
  }
}
```

**Max catalog size:** 10,000 tools. The API returns 3–5 most relevant tools per search call. The search tool itself adds ~500 tokens overhead.

### Claude Code CLI Behavior

In Claude Code, Tool Search is **on by default** as of the January 2026 2.1.x series. The activation logic is threshold-based:

| Condition                         | Behavior                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------- |
| MCP tool definitions < 10K tokens | Normal eager loading                                                              |
| MCP tool definitions > 10K tokens | Tool Search activates, all MCP tools deferred                                     |
| `ENABLE_TOOL_SEARCH=auto`         | Load upfront if definitions fit in 10% of context window; defer only the overflow |
| `ENABLE_TOOL_SEARCH=false`        | Disable entirely, revert to eager loading                                         |

Configuration is placed in `~/.claude/settings.json`:

```json
{
  "env": {
    "ENABLE_TOOL_SEARCH": "auto"
  }
}
```

**Relevant Claude Code changelog entries:**

| Version          | Change                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1.x (Jan 2026) | Tool Search enabled by default; 10K token threshold                                                                                                              |
| 2.1.78           | Fixed `deny: ["mcp__servername"]` permission rules not blocking deferred tools before model sees them                                                            |
| 2.1.83           | Improved prompt cache hit rate for Bedrock/Vertex/Foundry users                                                                                                  |
| 2.1.84           | MCP tool descriptions + server instructions capped at 2KB to prevent OpenAPI-generated servers from bloating context                                             |
| 2.1.85           | Fixed deferred tools losing input schemas after conversation compaction; fixed global system-prompt caching when ToolSearch is enabled (including for MCP users) |
| 2.1.76           | General milestone; tool search operational in production                                                                                                         |

**March 6, 2026:** Fixed API 400 errors when using `ANTHROPIC_BASE_URL` with a third-party gateway — tool search now correctly detects proxy endpoints and disables `tool_reference` blocks.

**March 10, 2026:** Fixed tool search not activating with `ANTHROPIC_BASE_URL` when `ENABLE_TOOL_SEARCH` is explicitly set.

### Claude Agent SDK Status

| SDK                                           | Status                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| Messages API (Python/TypeScript/Go/Java/etc.) | **Fully supported** — `defer_loading: true` works in all SDK clients          |
| MCP Connector (`mcp-client-2025-11-20` beta)  | **Fully supported** — `mcp_toolset` with `default_config.defer_loading: true` |
| Claude Agent SDK TypeScript                   | **NOT supported** — issue #124, open since Jan 10 2026                        |
| Claude Agent SDK Python                       | **NOT supported** — issue #525, open as of March 2026                         |

The distinction is important: the _Messages API SDKs_ (`@anthropic-ai/sdk`, `anthropic` Python package) already support `defer_loading: true` because it is just a field on the tool definition. The _Agent SDK_ (`@anthropic-ai/claude-agent-sdk`) is a higher-level abstraction that manages its own tool lifecycle — it does not yet expose the plumbing to configure per-tool deferral or inject the search tool.

The feature request shows the planned API surface for the Agent SDK:

```typescript
// Desired (not yet implemented in Agent SDK)
{
  type: "mcp_toolset",
  mcp_server_name: "my-server",
  default_config: { defer_loading: true },
  configs: {
    "frequently_used_tool": { defer_loading: false }
  }
}
```

### Token Savings — Concrete Numbers

| Scenario                                               | Tokens (eager)      | Tokens (Tool Search) | Reduction |
| ------------------------------------------------------ | ------------------- | -------------------- | --------- |
| 50+ MCP tools (GitHub, Slack, Sentry, Grafana, Splunk) | ~77,000             | ~8,700               | ~89%      |
| Search tool overhead                                   | —                   | ~500                 | —         |
| Per-query tool load (3–5 tools @ ~600 tokens each)     | —                   | ~3,000               | —         |
| Context preserved (200K window example)                | 122,800 tokens free | 191,300 tokens free  | +68,500   |

The 46.9% figure (51K → 8.5K) referenced in some articles represents a specific real-world setup with ~30 MCP tools, not the maximum-case numbers.

### Model Accuracy Impact

Internal Anthropic benchmarks from the November 2025 launch:

| Model    | Without Tool Search | With Tool Search |
| -------- | ------------------- | ---------------- |
| Opus 4   | 49%                 | 74% (+25pp)      |
| Opus 4.5 | 79.5%               | 88.1% (+8.6pp)   |

The accuracy gains are primarily from reducing the decision surface — with 50+ tools, Claude's attention is diluted across low-relevance tool schemas. Loading 3–5 focused tools per turn keeps selection crisp.

### Effect on User-Scoped vs Project-Scoped MCP Servers

Tool Search does not differentiate between user-scoped and project-scoped MCP servers at the deferral mechanism level — all MCP tools above the 10K threshold are deferred regardless of scope.

However, the implication for scope decisions changes:

**Before Tool Search:** Project-scoped MCP servers were strongly preferred because user-scoped servers (applied globally) inflated context for every session, even when their tools were irrelevant. The token cost was paid upfront regardless of whether tools were used.

**After Tool Search:** The penalty for user-scoped servers with large tool catalogs is greatly reduced. Since deferred tools contribute minimal context overhead (just name + description for the search index, not full schemas), having a large global tool catalog is far less costly.

**Practical guidance:**

- If your MCP server has well-described tools and you're below the 10K threshold, user-scope vs. project-scope is still a stylistic choice.
- For large MCP servers (OpenAPI-generated, 100+ tools): project-scope is still preferable for explicitness, but the token cost concern is now secondary to discoverability and security (least-privilege).
- The 2.1.84 hard cap of 2KB per tool description mitigates the worst case (OpenAPI-generated servers with verbose descriptions).

---

## Sources & Evidence

- Official Tool Search documentation (Anthropic platform docs): [Tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- Official MCP Connector documentation: [MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)
- Engineering blog announcing the feature: [Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) — published November 24, 2025
- Claude Code official MCP docs: [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp)
- Claude Code CHANGELOG: [claude-code/CHANGELOG.md](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- GitHub issue — original feature request (CLOSED/COMPLETED): [#7336 Lazy-load MCP tool definitions](https://github.com/anthropics/claude-code/issues/7336) — closed March 19, 2026
- GitHub issue — Agent SDK TypeScript, OPEN: [#124 Support for Tool Search Tool (defer_loading)](https://github.com/anthropics/claude-agent-sdk-typescript/issues/124)
- GitHub issue — defer_loading + cache_control bug: [#30989 Claude Code 2.1.69 breaks MCP tool calls](https://github.com/anthropics/claude-code/issues/30989)
- Community analysis of token savings: [Claude Code Just Cut MCP Context Bloat by 46.9%](https://medium.com/@joe.njenga/claude-code-just-cut-mcp-context-bloat-by-46-9-51k-tokens-down-to-8-5k-with-new-tool-search-ddf9e905f734) (Medium, Joe Njenga)
- Explainer article: [Claude Code Finally Gets Lazy Loading for MCP Tools](https://jpcaparas.medium.com/claude-code-finally-gets-lazy-loading-for-mcp-tools-explained-39b613d1d5cc) (Medium, JP Caparas, January 2026)
- Context window analysis: [Claude Code's Hidden MCP Flag: 32k Tokens Back](https://paddo.dev/blog/claude-code-hidden-mcp-flag/) (paddo.dev)
- Original community feature request repo: [claude-lazy-loading proof of concept](https://github.com/machjesusmoto/claude-lazy-loading)

---

## Research Gaps & Limitations

- The exact version of Claude Code when Tool Search first shipped is ambiguous. Sources reference "January 14, 2026" and "January 2026" but the specific version number (e.g., 2.1.x where x=?) is not pinned in public changelogs.
- The Claude Agent SDK Python issue number (#525) is cited in the TypeScript issue's cross-references but was not directly verified.
- "Tool Search" uses server-side tool indexing (ZDR note: tool names, descriptions, and argument metadata are retained beyond the API response per standard Anthropic retention policy — not ZDR-eligible). Custom client-side search using `tool_reference` blocks is fully ZDR-eligible.
- The Deferred Loading for Task Agents and Skills feature request (#19445) is a separate, still-open request to apply similar deferral to Claude Code's internal Skills/Agents constructs — not just MCP tools.

## Contradictions & Disputes

- Some community articles claim "95% token reduction"; the official Anthropic figure is "over 85% reduction." The discrepancy arises because 95% is the max-case (very large tool library), while 85% is the stated general case.
- The `ENABLE_EXPERIMENTAL_MCP_CLI=true` flag documented on paddo.dev is an older workaround from before Tool Search shipped; it is now superseded by the `ENABLE_TOOL_SEARCH` setting.

## Search Methodology

- Searches performed: 11
- Most productive search terms: "Claude Code MCP lazy loading tools deferred 2025 2026", "claude code ENABLE_TOOL_SEARCH version release", "claude agent SDK MCP lazy loading"
- Primary sources: platform.claude.com (official docs), code.claude.com (Claude Code docs), anthropic.com/engineering (blog), github.com/anthropics/claude-code, github.com/anthropics/claude-agent-sdk-typescript
- Research depth: Deep
