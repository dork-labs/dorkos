---
title: 'AI Coding Agent Runtime Landscape: Integration Survey for DorkOS'
date: 2026-04-05
type: external-best-practices
status: active
tags:
  [
    agent-runtime,
    coding-agents,
    sdk-integration,
    cli-tools,
    openai-codex,
    aider,
    opencode,
    cline,
    continue,
    goose,
    swe-agent,
    devin,
    amazon-q,
    gemini-cli,
    mcp,
    acp,
  ]
searches_performed: 22
sources_count: 45
---

# AI Coding Agent Runtime Landscape: Integration Survey for DorkOS

## Research Summary

This report surveys 10 AI coding agents that could be integrated as runtimes in DorkOS. The landscape has shifted dramatically in early 2026: the Agent Client Protocol (ACP) has emerged as a de-facto standard for subprocess-based agent communication (used by OpenCode, Cline, and Goose), while MCP has become ubiquitous for tool extension. Amazon Q Developer CLI has been rebranded and closed-sourced as Kiro. OpenCode is the fastest-growing open-source agent with 137K GitHub stars. Most agents support local models via LiteLLM, Ollama, or OpenAI-compatible APIs. TypeScript SDKs are now available for OpenAI Codex, OpenCode, and Cline — making them the most accessible for DorkOS integration.

---

## Key Findings

1. **TypeScript SDKs exist for three agents**: OpenAI Codex SDK (`@openai/codex-sdk`), OpenCode SDK (`@opencode-ai/sdk`), and Cline SDK — all are installable npm packages. These are the best candidates for first-class DorkOS runtime adapters.

2. **ACP (Agent Client Protocol) is the emerging standard**: OpenCode, Cline, and Goose all support ACP — a JSON-RPC-over-stdio protocol for editor/IDE integration. DorkOS could implement an ACP adapter that works with all three simultaneously.

3. **Python scripting APIs exist but are unstable**: Aider and SWE-agent have Python APIs but explicitly disclaim stability. They are better accessed via their CLIs.

4. **Devin is cloud-only with a REST API**: No local execution, no open source. API starts at $2.00/ACU. Not a good fit for DorkOS's local-first ethos.

5. **Kiro (formerly Amazon Q Developer CLI) is now proprietary**: The open-source repository is archived and no longer maintained. Kiro CLI is closed-source under an AWS proprietary license.

6. **Streaming is broadly available**: All CLI-based agents stream responses. TypeScript SDK-wrapped agents (Codex, OpenCode, Cline) expose structured streaming event APIs.

7. **Local model support is near-universal for open-source agents**: Aider, OpenCode, Cline, Continue, Goose, and SWE-agent all support Ollama/LM Studio/LiteLLM for local inference.

---

## Detailed Agent Profiles

### 1. OpenAI Codex CLI

**What it is:** A terminal coding agent by OpenAI, described as a "lightweight coding agent that runs in your terminal." Built primarily in Rust (94.7%), with a TypeScript SDK that spawns the CLI via subprocess and communicates over JSONL on stdin/stdout.

| Attribute      | Detail                                                                |
| -------------- | --------------------------------------------------------------------- |
| GitHub Stars   | 73,300+                                                               |
| License        | Apache-2.0                                                            |
| Open Source    | Yes                                                                   |
| TypeScript SDK | Yes — `@openai/codex-sdk` (npm, Node 18+)                             |
| Python SDK     | No                                                                    |
| CLI Interface  | Yes — `@openai/codex` (npm), also available via Homebrew              |
| Streaming      | Yes — `runStreamed()` returns an async generator of structured events |
| Tool Use       | Yes — file ops, code execution, shell commands                        |
| Local Models   | No — requires OpenAI API key / ChatGPT account                        |
| Protocols      | Proprietary JSONL over stdio (TypeScript SDK wraps this)              |

**SDK details:** The TypeScript SDK (`@openai/codex-sdk`) exposes `startThread()`, `resumeThread()`, `run()` (buffered), and `runStreamed()` (async generator of events). Supports structured output via JSON Schema or Zod. Configuration overrides for working directory and env vars. MIT-compatible license.

**DorkOS fit:** Good for TypeScript-native integration. The SDK abstraction is clean, but it's locked to OpenAI models only — no local model support. Stars and OpenAI backing make it high-credibility.

---

### 2. Aider

**What it is:** "AI pair programming in your terminal." Python-based, git-integrated, supports virtually all LLMs including local models. One of the most mature and battle-tested open-source coding agents.

| Attribute      | Detail                                                          |
| -------------- | --------------------------------------------------------------- |
| GitHub Stars   | 42,900+                                                         |
| License        | Apache-2.0                                                      |
| Open Source    | Yes                                                             |
| TypeScript SDK | No                                                              |
| Python SDK     | Unofficial — internal `Coder` class API, explicitly not stable  |
| CLI Interface  | Yes — `aider` command, pip-installable                          |
| Streaming      | Yes — streams LLM responses, shows spinner during generation    |
| Tool Use       | Yes — file editing, git commits, linting, test execution        |
| Local Models   | Yes — Ollama, LM Studio, any OpenAI-compatible endpoint         |
| Protocols      | None — CLI-first, subprocess via `--message` flag for scripting |

**Python scripting:** `from aider.coders import Coder; coder.run("instruction")`. Officially unsupported, no backwards-compat guarantee. CLI subprocess is the recommended integration path.

**DorkOS fit:** Best integrated via subprocess with `--message` and `--yes` flags. No TypeScript SDK means a DorkOS adapter must shell-exec the CLI and parse stdout. High popularity and local model support make it attractive for Kai-type users.

---

### 3. OpenCode

**What it is:** An open-source terminal AI coding agent built by the SST team (`github.com/sst/opencode`). Go-based core with a TUI, supports 75+ LLM providers. The fastest-growing agent in the space — 137K GitHub stars as of April 2026.

| Attribute      | Detail                                                             |
| -------------- | ------------------------------------------------------------------ |
| GitHub Stars   | 137,000+                                                           |
| License        | MIT                                                                |
| Open Source    | Yes                                                                |
| TypeScript SDK | Yes — `@opencode-ai/sdk` (auto-generated from OpenAPI spec)        |
| Go SDK         | Yes — `github.com/sst/opencode-sdk-go`                             |
| Python SDK     | No                                                                 |
| CLI Interface  | Yes — `opencode` binary                                            |
| Streaming      | Yes — HTTP server exposes SSE event stream                         |
| Tool Use       | Yes — file ops, shell commands, LSP integration, custom tools, MCP |
| Local Models   | Yes — Ollama, LM Studio, any OpenAI-compatible API                 |
| Protocols      | ACP (JSON-RPC over stdio), REST/SSE HTTP server, MCP               |

**Architecture:** OpenCode runs as either a TUI or a headless server (`opencode serve`). The server exposes a REST API and SSE event stream. The ACP mode (`opencode acp`) runs as a subprocess communicating via newline-delimited JSON over stdin/stdout — compatible with Zed, Neovim, JetBrains, and others.

**DorkOS fit:** Excellent — MIT license, TypeScript SDK, ACP support, SSE streaming, and local model support check every box. The `opencode serve` model is particularly interesting for DorkOS: spawn an OpenCode server, connect to its REST/SSE API, and proxy sessions through the DorkOS session model.

---

### 4. Cline

**What it is:** An autonomous coding agent originally built as a VS Code extension, now expanding to a standalone CLI and SDK. "Autonomous coding agent right in your IDE."

| Attribute      | Detail                                                             |
| -------------- | ------------------------------------------------------------------ |
| GitHub Stars   | 30,000+ (as of early 2025; significantly higher by 2026)           |
| License        | Apache-2.0                                                         |
| Open Source    | Yes                                                                |
| TypeScript SDK | Yes — npm package, ACP-compliant, Node 20+                         |
| Python SDK     | No                                                                 |
| CLI Interface  | Yes — `cline` npm package, macOS/Linux (Windows coming)            |
| Streaming      | Yes — real-time event emitter for messages, thoughts, tool calls   |
| Tool Use       | Yes — file ops, terminal commands, browser automation, MCP servers |
| Local Models   | Yes — Ollama, LM Studio, any OpenAI-compatible API                 |
| Protocols      | ACP (Agent Client Protocol), MCP                                   |

**SDK details:** The Cline SDK (`docs.cline.bot/cline-sdk`) implements the ACP `Agent` interface with an event-emitter pattern for streaming. You can subscribe to session events for real-time tool call and message updates. Supports plan/act modes, permission flows, and model switching. The SDK diverges from standard ACP stdio by using an in-process event emitter rather than a separate subprocess.

**DorkOS fit:** Strong — TypeScript SDK with ACP compliance is a clean integration point. In-process embedding (rather than subprocess) could be cleaner for DorkOS. Very strong community and roadmap (JetBrains, Neovim on the way).

---

### 5. Continue

**What it is:** An open-source AI coding assistant for VS Code and JetBrains IDEs, with a standalone CLI (`@continuedev/cli`). More focused on IDE-embedded assistance than autonomous task execution, but supports agent mode with MCP tools.

| Attribute      | Detail                                                               |
| -------------- | -------------------------------------------------------------------- |
| GitHub Stars   | 32,300+                                                              |
| License        | Apache-2.0                                                           |
| Open Source    | Yes                                                                  |
| TypeScript SDK | Partial — CLI is TypeScript, no embeddable SDK                       |
| Python SDK     | No                                                                   |
| CLI Interface  | Yes — `cn` command, `npm i -g @continuedev/cli`, Node 20+            |
| Streaming      | Yes — IDE extensions stream; CLI streaming not explicitly documented |
| Tool Use       | Yes — MCP servers, tool use in agent mode, function calling          |
| Local Models   | Yes — Ollama, Llama.cpp, LM Studio                                   |
| Protocols      | MCP (Model Context Protocol), SSE and Streamable HTTP MCP transports |

**Architecture:** Continue is primarily an IDE extension with a config-file-driven approach. The CLI supports source-controlled AI checks (`continue checks`) rather than interactive sessions. Not designed for subprocess-level programmatic integration in the same way as Cline or OpenCode.

**DorkOS fit:** Weaker than Cline/OpenCode for runtime integration — no embeddable SDK, and the CLI is oriented around CI checks rather than interactive agent sessions. Better positioned as a user-facing tool than a DorkOS runtime backend.

---

### 6. Goose by Block

**What it is:** An open-source, extensible AI agent from Block's Open Source Program Office. Available as both a desktop app and CLI. Built in Rust with TypeScript UI layer. One of the early adopters of MCP.

| Attribute      | Detail                                                               |
| -------------- | -------------------------------------------------------------------- |
| GitHub Stars   | 36,700+                                                              |
| License        | Apache-2.0                                                           |
| Open Source    | Yes                                                                  |
| TypeScript SDK | Yes — wraps the goose-acp server; ACP TypeScript SDK                 |
| Python SDK     | Planned (mentioned in roadmap)                                       |
| CLI Interface  | Yes — `goose` CLI                                                    |
| Streaming      | Yes — SSE-based streaming via goose-acp server                       |
| Tool Use       | Yes — MCP integration (3,000+ MCP servers), shell commands, file ops |
| Local Models   | Yes — supports any LLM, multi-model configuration                    |
| Protocols      | ACP (Agent Client Protocol), MCP                                     |

**Architecture:** Goose runs a local `goose-acp` server that wraps the Goose agent behind the Agent Client Protocol. A TypeScript SDK wraps this server and provides ACP extension methods. The 2026 roadmap includes a TypeScript TUI and migration of the Electron desktop app to ACP. Early and influential adopter of MCP — Goose's team collaborated on MCP's development with Anthropic.

**DorkOS fit:** Good — ACP compliance and TypeScript SDK are promising. Apache-2.0 license is clean. The Rust core means lower-level integration is less accessible, but ACP wrapping provides a standard interface. MCP breadth (3,000+ servers) is impressive.

---

### 7. SWE-agent (Princeton)

**What it is:** A research-origin coding agent from Princeton and Stanford. Takes a GitHub issue and autonomously attempts to fix it using your LLM of choice. Also has `mini-swe-agent` — a 100-line agent that scores 74%+ on SWE-bench verified.

| Attribute      | Detail                                                                     |
| -------------- | -------------------------------------------------------------------------- |
| GitHub Stars   | 18,900+ (SWE-agent main)                                                   |
| License        | MIT                                                                        |
| Open Source    | Yes                                                                        |
| TypeScript SDK | No                                                                         |
| Python SDK     | Unofficial — Python-native, no stable public API                           |
| CLI Interface  | Yes — `swe-agent` CLI; mini-swe-agent installable via `uvx mini-swe-agent` |
| Streaming      | Partial — outputs to stdout/logs, no structured streaming API              |
| Tool Use       | Yes — file editing, shell, bash (mini-swe-agent uses only bash)            |
| Local Models   | Yes — LiteLLM integration, OpenRouter, Portkey, any local model            |
| Protocols      | None standard — CLI-only integration                                       |

**Notable variants:**

- `SWE-agent`: Full agent with Docker/Podman sandboxing, config-file-driven, used by Meta, NVIDIA, IBM
- `mini-SWE-agent`: 100-line agent, MIT licensed, `uvx mini-swe-agent` installable, no tools beyond bash

**DorkOS fit:** Research-grade tool, not designed for embedding. Better as a reference implementation than a runtime. CLI subprocess integration is possible but brittle. Strong for benchmark-driven evaluation scenarios.

---

### 8. Devin by Cognition

**What it is:** A cloud-hosted autonomous AI software engineer from Cognition AI. Not open source. Accessible via REST API, web UI, Slack, Linear, and CLI.

| Attribute      | Detail                                                                    |
| -------------- | ------------------------------------------------------------------------- |
| GitHub Stars   | N/A — closed source                                                       |
| License        | Proprietary                                                               |
| Open Source    | No                                                                        |
| TypeScript SDK | No official SDK                                                           |
| Python SDK     | Unofficial — `devin_sdk` referenced in examples                           |
| CLI Interface  | Yes — Devin CLI                                                           |
| Streaming      | Unknown — REST API does not document streaming                            |
| Tool Use       | Yes — integrated with GitHub, GitLab, Linear, Jira, Slack, AWS, GCP, etc. |
| Local Models   | No — cloud-only, proprietary models                                       |
| Protocols      | REST API (`api.devin.ai/v3`), Slack, Linear webhooks                      |

**API structure:** Devin API v3 has Organization API and Enterprise API scopes. Key operations: spin up sessions programmatically, attach to PRs and issues, create sessions on behalf of users. Pricing: Core (pay-as-you-go, $2.25/ACU), Team ($500/month with 250 ACUs), Enterprise (custom). Devin 2.0 launched with a $20 entry tier.

**DorkOS fit:** Poor — closed source, cloud-only, no TypeScript SDK, opaque pricing. Philosophically misaligned with DorkOS's local-first, developer-controlled ethos. If desired, a DorkOS REST adapter against the Devin API is technically possible but not recommended as a core integration.

---

### 9. Amazon Q Developer CLI / Kiro

**What it is:** Amazon's AI CLI agent for developers. Originally open source as `amazon-q-developer-cli`, rebranded and closed-sourced as **Kiro CLI** in November 2025. The open-source repository is now archived and receives only critical security patches.

| Attribute      | Detail                                                                       |
| -------------- | ---------------------------------------------------------------------------- |
| GitHub Stars   | 1,900 (archived Q Developer CLI repo)                                        |
| License        | Kiro: Proprietary (AWS Customer Agreement). Q CLI: Apache-2.0/MIT (archived) |
| Open Source    | No (Kiro). The predecessor Q CLI was open source but is discontinued         |
| TypeScript SDK | No                                                                           |
| Python SDK     | No                                                                           |
| CLI Interface  | Yes — `q` / `q chat` entry points (backwards-compatible with Q CLI)          |
| Streaming      | Unknown — not documented publicly                                            |
| Tool Use       | Yes — MCP integration, custom agents, AWS resource queries                   |
| Local Models   | No — AWS-hosted models (powered by Claude)                                   |
| Protocols      | MCP, ACP (referenced in docs)                                                |

**Transition status:** Auto-update pushed Kiro CLI to existing Q Developer CLI users on November 24, 2025. Kiro CLI uses Bun for its frontend. "Kiro CLI leverages the Auto agent" — powered by Claude models on AWS. Free tier available.

**DorkOS fit:** Poor — proprietary license, closed source, AWS-only backend. No SDK. The pivot from open source to closed source is a red flag for a runtime integration that should be stable and forkable.

---

### 10. Gemini CLI

**What it is:** Google's open-source AI agent for the terminal. Announced mid-2025, reached 100K GitHub stars rapidly. Built in TypeScript, powered by Gemini models.

| Attribute      | Detail                                                                     |
| -------------- | -------------------------------------------------------------------------- |
| GitHub Stars   | 100,000+                                                                   |
| License        | Apache-2.0                                                                 |
| Open Source    | Yes                                                                        |
| TypeScript SDK | Partial — written in TypeScript, but no separate embeddable SDK package    |
| Python SDK     | No                                                                         |
| CLI Interface  | Yes — `gemini` command                                                     |
| Streaming      | Yes — `--output-format stream-json` flag for newline-delimited JSON events |
| Tool Use       | Yes — Google Search grounding, file ops, shell commands, MCP servers       |
| Local Models   | No — requires Google authentication (OAuth, API key, Vertex AI)            |
| Protocols      | MCP, stream-JSON output for CI/scripting integration                       |

**Architecture:** TypeScript monorepo. Built-in tools include file system operations, shell commands, and web fetching. Supports MCP server extensions. Companion GitHub Actions integration for CI/CD pipelines. Free tier via Google account (Gemini Flash access), paid via API key or Vertex AI.

**DorkOS fit:** Moderate — Apache-2.0, TypeScript, good streaming support. But no local models and Google-cloud-only inference. The stream-JSON output flag is useful for subprocess integration without a formal SDK. Growing fast but very Google-ecosystem-centric.

---

## Comparison Matrix

| Agent        | Stars | License     | TS SDK         | Python SDK | CLI           | Streaming         | Local Models  | Tool Use   | Protocols               |
| ------------ | ----- | ----------- | -------------- | ---------- | ------------- | ----------------- | ------------- | ---------- | ----------------------- |
| OpenAI Codex | 73K   | Apache-2.0  | Yes (official) | No         | Yes           | Yes (async gen)   | No            | Yes        | Proprietary JSONL/stdio |
| Aider        | 43K   | Apache-2.0  | No             | Unofficial | Yes           | Yes (stdout)      | Yes           | Yes        | CLI subprocess          |
| OpenCode     | 137K  | MIT         | Yes (official) | No         | Yes           | Yes (SSE)         | Yes           | Yes        | ACP, REST/SSE, MCP      |
| Cline        | 30K+  | Apache-2.0  | Yes (official) | No         | Yes (preview) | Yes (events)      | Yes           | Yes        | ACP, MCP                |
| Continue     | 32K   | Apache-2.0  | Partial (CLI)  | No         | Yes           | Yes (IDE)         | Yes           | Yes        | MCP                     |
| Goose        | 37K   | Apache-2.0  | Yes (ACP wrap) | Planned    | Yes           | Yes (SSE)         | Yes           | Yes        | ACP, MCP                |
| SWE-agent    | 19K   | MIT         | No             | Unofficial | Yes           | Partial           | Yes (LiteLLM) | Yes (bash) | CLI subprocess          |
| Devin        | N/A   | Proprietary | No             | Unofficial | Yes           | Unknown           | No            | Yes        | REST API                |
| Kiro (Q CLI) | 1.9K  | Proprietary | No             | No         | Yes           | Unknown           | No            | Yes        | MCP, ACP                |
| Gemini CLI   | 100K  | Apache-2.0  | Partial        | No         | Yes           | Yes (stream-JSON) | No            | Yes        | MCP                     |

---

## Integration Architecture Recommendations for DorkOS

### Tier 1: Best fit (TypeScript SDK + streaming + open source)

**OpenCode** is the strongest candidate for a first-class DorkOS runtime adapter:

- Official TypeScript SDK (`@opencode-ai/sdk`) generated from OpenAPI spec
- Headless server mode (`opencode serve`) with REST API and SSE event stream
- ACP support for editor ecosystem compatibility
- MIT license — maximally permissive
- Local model support covers Kai's use case
- 137K stars and fast growth signals strong community

**Cline** is the second-best candidate:

- Official TypeScript SDK with ACP compliance and event-emitter streaming
- In-process embedding (no subprocess overhead)
- Apache-2.0, strong community
- SDK is production-grade and documented

**OpenAI Codex** rounds out Tier 1:

- Official TypeScript SDK with `runStreamed()` async generator
- Clean subprocess abstraction
- Weakest on local model support (OpenAI only)

### Tier 2: CLI subprocess adapters (no SDK)

**Aider**: Shell-exec with `--message`, `--yes`, `--no-auto-commits`. Parse stdout. Best for users who already have Aider configured locally.

**Gemini CLI**: Shell-exec with `--output-format stream-json`. Parse newline-delimited JSON events. Good for Google Workspace users.

**SWE-agent / mini-SWE-agent**: `uvx mini-swe-agent` — subprocess, parse stdout. Research-grade; best as an optional power-user runtime.

### Tier 3: Not recommended

**Devin**: Cloud-only, proprietary, no TS SDK, no local models. Misaligned with DorkOS values.

**Kiro (Amazon Q CLI)**: Closed source since Nov 2025, AWS-only backend, proprietary license.

**Continue**: IDE-extension-first architecture; CLI is CI-check-oriented, not session-oriented.

---

## ACP: The Emerging Integration Protocol

The Agent Client Protocol (ACP) is emerging as the standard for subprocess-level agent communication. Key properties:

- Transport: Newline-delimited JSON (ndjson) over stdin/stdout
- Protocol: JSON-RPC
- Lifecycle: `initialize → authenticate → session → prompt`
- Adopted by: OpenCode, Cline, Goose, Kiro (partial)
- Editors with ACP support: Zed, JetBrains IDEs, Neovim, Emacs

A single DorkOS `AcpRuntime` adapter could potentially connect to any ACP-compliant agent (OpenCode, Cline, Goose) — similar to how DorkOS's `Transport` interface abstracts HTTP vs. DirectTransport. This would be a strong architectural win.

---

## Sources & Evidence

- [OpenAI Codex GitHub](https://github.com/openai/codex) — 73.3K stars, Apache-2.0, Rust primary
- [Codex TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) — `runStreamed()` async generator, JSONL stdio
- [Codex SDK on npm](https://www.npmjs.com/package/@openai/codex) — `@openai/codex-sdk`, Node 18+
- [Aider GitHub](https://github.com/Aider-AI/aider) — 42.9K stars, Apache-2.0
- [Aider scripting docs](https://aider.chat/docs/scripting.html) — Python `Coder` API, explicitly unstable
- [OpenCode GitHub (sst)](https://github.com/sst/opencode) — 137K stars (April 2026), MIT
- [OpenCode docs](https://opencode.ai/docs/) — ACP, MCP, server mode, 75+ providers
- [OpenCode ACP docs](https://opencode.ai/docs/acp/) — JSON-RPC over stdio, SSE HTTP server
- [OpenCode Go SDK](https://pkg.go.dev/github.com/sst/opencode-sdk-go) — Stainless-generated
- [Cline GitHub](https://github.com/cline/cline) — 30K+ stars, Apache-2.0
- [Cline SDK docs](https://docs.cline.bot/cline-sdk/overview) — TypeScript, ACP, event emitter streaming
- [Cline CLI announcement](https://cline.ghost.io/cline-cli-return-to-the-primitives/) — macOS/Linux preview
- [Continue GitHub](https://github.com/continuedev/continue) — 32.3K stars, Apache-2.0
- [Continue MCP docs](https://docs.continue.dev/customize/deep-dives/mcp) — SSE and Streamable HTTP MCP
- [Goose GitHub](https://github.com/block/goose) — 36.7K stars, Apache-2.0, Rust+TypeScript
- [Goose ACP discussion](https://github.com/block/goose/discussions/7309) — ACP TypeScript SDK, goose-acp-server
- [SWE-agent GitHub](https://github.com/SWE-agent/SWE-agent) — 18.9K stars, MIT
- [mini-SWE-agent GitHub](https://github.com/SWE-agent/mini-swe-agent) — 100-line agent, MIT, `uvx` installable
- [Devin API docs](https://docs.devin.ai/api-reference/overview) — REST API v3, no official SDK
- [Cognition Devin 2.0](https://cognition.ai/blog/devin-2) — $20 entry tier, proprietary
- [Amazon Q Developer CLI GitHub](https://github.com/aws/amazon-q-developer-cli) — 1.9K stars, archived
- [Kiro CLI docs](https://kiro.dev/cli/) — proprietary, MCP, ACP referenced
- [Kiro migration guide](https://kiro.dev/docs/cli/migrating-from-q/) — Q CLI → Kiro transition Nov 2025
- [Gemini CLI GitHub](https://github.com/google-gemini/gemini-cli) — 100K stars, Apache-2.0, TypeScript
- [Gemini CLI blog](https://blog.google/innovation-and-ai/technology/developers-tools/introducing-gemini-cli-open-source-ai-agent/) — stream-json flag, MCP support
- [ACP welcome docs](https://agentcommunicationprotocol.dev/introduction/welcome) — protocol specification

---

## Research Gaps & Limitations

- **Goose streaming latency**: Streaming is confirmed via SSE but specific latency characteristics against different LLM providers are not documented.
- **Cline GitHub stars (2026)**: The 30K figure is from early 2025. Current 2026 figure is likely significantly higher but not confirmed via direct repo fetch.
- **OpenCode TypeScript SDK maturity**: Auto-generated from OpenAPI spec via Stainless — quality depends on spec completeness. No user reports found on SDK production stability.
- **Aider subprocess robustness**: Integration via `--message` flag is documented but error handling and exit code behavior across model providers is not fully characterized.
- **SWE-agent tool calling**: The main SWE-agent uses a custom `ACI` (Agent-Computer Interface) rather than standard tool-calling APIs — this may complicate integration.
- **Devin streaming**: Not documented in public API reference. May be available in enterprise tier.

---

## Contradictions & Disputes

- **OpenCode star count**: Sources vary between 95K and 137K. The 137K figure appears in April 2026 sources; 95K was accurate in late 2025. Both reflect extraordinary growth trajectory.
- **Cline SDK vs. ACP spec**: The Cline SDK implements the ACP `Agent` interface but uses an event emitter rather than standard ACP stdio transport. This is a deliberate design choice for in-process embedding, not a spec violation, but it means the Cline SDK is not a drop-in for standard ACP tooling.
- **Goose Python SDK**: The July 2025 roadmap mentioned publishing a Python SDK equivalent. As of April 2026, this appears to still be planned rather than shipped.

---

## Search Methodology

- Searches performed: 22
- Most productive search terms: agent name + "github stars" + "typescript sdk" + year, agent name + "streaming" + "ACP", "OpenCode SST", "Kiro CLI AWS"
- Primary sources: GitHub repositories (direct fetch), official documentation sites, npm registry, Google/OpenAI/AWS blog posts
