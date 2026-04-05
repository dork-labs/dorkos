---
title: 'Pi Coding Agent and Frameworks for Building Custom Coding Agents with Local Model Support'
date: 2026-04-05
type: external-best-practices
status: active
tags:
  [
    pi-coding-agent,
    local-models,
    ollama,
    coding-agents,
    agent-frameworks,
    typescript,
    mastra,
    langgraph,
    openhands,
    autogen,
  ]
searches_performed: 16
sources_count: 42
---

## Research Summary

"Pi" (pi-mono) is a real, well-regarded MIT-licensed TypeScript toolkit authored by Mario Zechner for building coding agents, with 31.8k GitHub stars and official Ollama integration. It has a layered SDK architecture (`pi-ai` → `pi-agent-core` → `pi-coding-agent`) that can be embedded directly in a Node.js/TypeScript application, supports local models via any OpenAI-compatible endpoint (including Ollama), and is the stack that powers OpenClaw. The hypothesis that building a custom runtime using one of these frameworks unlocks local model support is **valid** — pi-mono and Mastra are the two strongest TypeScript-native paths, with LangGraph.js as a well-established fallback.

---

## Key Findings

1. **Pi (pi-mono) is the exact thing described**: A TypeScript agent toolkit with a CLI (pi-coding-agent), SDK layer (pi-agent-core), unified LLM API (pi-ai), and official Ollama support. It is actively maintained, MIT-licensed, and already powers OpenClaw. Local models work via OpenAI-compatible endpoints.

2. **Mastra is the most production-ready TypeScript agent framework**: 22.7k stars, Y Combinator-backed, 3,300+ model integrations including native Ollama support via the Vercel AI SDK provider. It can be embedded in existing Node.js/Express apps and is the cleaner "full platform" option if you want memory, workflows, and observability bundled.

3. **LangGraph.js is a mature, stable option**: JavaScript/TypeScript port of the Python LangGraph, supports Ollama natively, well-documented, and suitable for complex stateful workflows. More overhead than pi-mono for simple agent loops.

4. **OpenHands (formerly OpenDevin) is Python-only**: Not embeddable in a Node.js app without running it as a separate process. Supports local models including Ollama but practical results with smaller local models are mixed due to context-length constraints.

5. **Google ADK for TypeScript is newly available**: Open-source, TypeScript-first, supports Ollama via LiteLLM connector. Less mature than Mastra or LangGraph.js but backed by Google with strong trajectory.

6. **Plandex is winding down**: As of October 2025, Plandex is no longer accepting new users. Not a viable option.

7. **The local model hypothesis is strongly validated**: All major TypeScript frameworks now support Ollama (or any OpenAI-compatible endpoint). The blocker is not framework capability — it is model capability. Smaller local models struggle with reliable tool-calling, which is the core operation in any coding agent loop.

---

## Detailed Analysis

### Pi (pi-mono) — Primary Recommendation for DorkOS

**Repository**: [badlogic/pi-mono](https://github.com/badlogic/pi-mono)
**Author**: Mario Zechner (creator of LibGDX)
**License**: MIT
**Stars**: 31.8k
**Language**: TypeScript (95.9%)
**Published packages**: `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@mariozechner/pi-web-ui`, `@mariozechner/pi-mom` (Slack), `@mariozechner/pi-pods` (vLLM management)

#### Architecture (Layer-by-Layer)

```
pi-ai           — unified multi-provider LLM API (OpenAI, Anthropic, Google, Ollama, etc.)
pi-agent-core   — agent loop with tool calling, event subscriptions, type-safe tools
pi-coding-agent — full interactive CLI with 4 built-in tools (read, write, edit, bash),
                  session management, extensions, skills, themes
```

The architecture is intentionally layered. You can use `pi-ai` alone for LLM calls, `pi-agent-core` to add the agent loop, or the full `pi-coding-agent` as a CLI. Each level is an npm package you can import.

#### Local Model Support

Pi routes through `openai-completions` API type, which accepts any OpenAI-compatible endpoint. This means Ollama, vLLM, LM Studio, and similar local servers work out of the box. Configuration via `~/.pi/agent/models.json`:

```json
{
  "providers": [
    {
      "type": "openai-completions",
      "baseUrl": "http://localhost:11434/v1",
      "models": ["llama3.1:8b", "qwen3-coder"]
    }
  ]
}
```

As of January 2026, `ollama launch pi` is a one-command setup that installs pi, configures Ollama as a provider, and drops into an interactive session. Pi is now a first-class integration in the Ollama ecosystem.

#### Embedding in a Node.js Application (SDK Mode)

The `pi-coding-agent` exposes an explicit SDK mode. The core `Agent` class from `pi-agent-core` is the key surface:

```typescript
import { Agent } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

const localModel = {
  id: 'llama-3.1-8b',
  api: 'openai-completions' as const,
  baseUrl: 'http://localhost:11434/v1',
};

const myTool = {
  name: 'run_bash',
  label: 'Run Bash Command',
  description: 'Execute a shell command and return output',
  parameters: Type.Object({ command: Type.String() }),
  execute: async (id, params, signal, onUpdate) => {
    // your implementation
    return { content: [{ type: 'text', text: '...' }] };
  },
};

const agent = new Agent({
  initialState: {
    systemPrompt: 'You are a coding assistant.',
    model: localModel,
    tools: [myTool],
  },
  streamFn: streamSimple,
});

agent.subscribe((event) => {
  if (event.type === 'message_update') {
    /* stream to UI */
  }
});

await agent.prompt('Fix the TypeScript errors in src/index.ts');
```

Events emitted: `agent_start`, `message_update`, `tool_execution_start`, `tool_execution_end`, `agent_end`.

#### How OpenClaw Uses Pi

Nader Dabit published a guide ("How to Build a Custom Agent Framework with PI: The Agent Stack Powering OpenClaw") confirming that OpenClaw is built on pi-agent-core. The pattern is: instantiate `Agent` with custom tools and a custom model config, subscribe to events, and pipe output to the UI layer. This is the exact integration pattern DorkOS would use to add a new `AgentRuntime` implementation.

#### Extensions and Skills

Pi has an extension system where npm packages can register tools, commands, shortcuts, and flags. The pi-skills repo (`badlogic/pi-skills`) is a curated collection compatible with Claude Code, Codex CLI, Amp, and Droid — and presumably any pi-based runtime.

#### Maturity Assessment

- 31.8k stars, 184 releases, v0.65.0
- Active weekly development (OSS weekends noted April 2026)
- "Deep in refactoring internals" note in the README means internal churn but the public API surface is stable
- Ollama's first-class integration (`ollama launch pi`) signals ecosystem endorsement
- Risk: solo maintainer (Mario Zechner), though Rust port and oh-my-pi fork reduce bus-factor concern

---

### Mastra — Best "Full Platform" Option

**Website**: [mastra.ai](https://mastra.ai/)
**License**: Open-source (Mastra Enterprise License for advanced features)
**Stars**: 22.7k
**Backed by**: Y Combinator (S24)
**Language**: TypeScript

#### What It Is

Mastra is an all-in-one TypeScript framework for building AI agents and applications. It provides agents, workflows (DAG + cyclic), long-term memory, tool integrations, observability, and evaluation in a single package. It bundles agents and workflows into existing React, Next.js, and Node.js apps, or ships them as standalone endpoints.

#### Local Model Support

Native Ollama support through the Vercel AI SDK Ollama provider. 3,300+ models from 94 providers as of March 2026. Configuration is straightforward:

```typescript
import { ollama } from '@ai-sdk/ollama';
import { Agent } from '@mastra/core';

const agent = new Agent({
  name: 'coding-agent',
  instructions: 'You are a coding assistant.',
  model: ollama('qwen3-coder'),
});
```

#### Embedding in Node.js/Express

Mastra is designed to bundle into existing Node.js apps. It supports Express, Hono, and Next.js as deployment targets. The `@mastra/core` package is framework-agnostic.

#### What It Provides Beyond Pi

- Persistent memory (vector stores, semantic search)
- Workflow orchestration (multi-step, conditional, parallel)
- Built-in observability and tracing
- Tool registry and MCP integration
- A hosted "Mastra Code" CLI agent for building Mastra-based apps

#### Maturity Assessment

- Production-ready; Y Combinator backed; 1.0 launched January 2026
- npm downloads grew from 60k/month (March 2025) to 1.8M/month (February 2026)
- 22.7k stars with rapid growth trajectory
- Issue: `cant connect to ollama local models` GitHub issue (#2619) was filed and being tracked — Ollama integration has rough edges but is officially supported

#### Comparison to Pi for DorkOS

Mastra is heavier than pi-mono. Pi is "4,000 lines of TypeScript" — intentionally minimal. Mastra is a full platform. For DorkOS, which already has its own session management, relay, mesh, and UI, Mastra's additional abstractions would likely conflict. Pi's `pi-agent-core` fits more cleanly into DorkOS's `AgentRuntime` interface.

---

### LangGraph.js — Mature Stateful Agent Graphs

**Docs**: [LangGraph.js](https://langchain-ai.github.io/langgraphjs/)
**Language**: TypeScript/JavaScript
**Current version**: 1.0.6 (as of early 2026)
**Stars**: ~6k for the JS repo

#### What It Is

LangGraph.js is the JavaScript port of LangGraph, a framework for building stateful, graph-based agent orchestration. It excels at complex control flow: loops, conditional branching, parallel execution, human-in-the-loop, and state persistence across interactions.

#### Local Model Support

Full Ollama support via `@langchain/ollama` or `@langchain/community`. LLM class is instantiated with the Ollama base URL:

```typescript
import { ChatOllama } from '@langchain/ollama';

const llm = new ChatOllama({ model: 'llama3.1', baseUrl: 'http://localhost:11434' });
```

#### When to Use LangGraph.js vs Pi-mono

| Scenario                                    | Prefer        |
| ------------------------------------------- | ------------- |
| Simple agent loop, minimal dependencies     | pi-agent-core |
| Complex multi-step workflows with branching | LangGraph.js  |
| Multi-agent coordination with shared state  | LangGraph.js  |
| Embedding in existing Express app           | Both work     |
| Lowest conceptual surface area              | pi-agent-core |

#### Maturity

Stable, actively maintained, LangGraph.js v1.0.6 is the current stable release. LangChain.js has been around since 2023 and has strong community adoption. LangGraph.js is newer but benefits from the broader LangChain ecosystem.

---

### OpenHands (formerly OpenDevin) — Not Embeddable in Node.js

**Repository**: [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands)
**Language**: Python
**Stars**: ~40k+

#### Summary

OpenHands is a substantial Python-based agent platform for software engineering tasks. It has a Docker-first architecture, browser-based IDE integration, and REST/WebSocket server for remote access. The SDK was refactored in late 2025 into a modular Python library.

#### Local Model Support

Yes — supports Ollama via OpenAI-compatible API. Official docs at `docs.openhands.dev/openhands/usage/llms/local-llms`. Requires `OLLAMA_CONTEXT_LENGTH` set to at least 22,000. Recommended local models include Qwen3-Coder-30B and Devstral Small (24B) — both require significant GPU. OpenHands LM (32B) achieves 37.2% on SWE-Bench Verified and runs on a single 3090 GPU.

#### Node.js Embeddability

**Not embeddable in a Node.js application.** OpenHands is Python-only (requires Python 3.12–3.13). Integration from Node.js would require spawning it as a subprocess or calling its REST API. This makes it unsuitable as a DorkOS `AgentRuntime` implementation without significant wrapper overhead.

#### Practical Performance with Local Models

User reports indicate smaller models (those that fit comfortably on consumer hardware) struggle with OpenHands' tool-calling patterns. The context window issue causes models to "forget" tools and instructions as files are fed in. You essentially need a 30B+ model to get reliable results.

---

### Google Agent Development Kit (ADK) for TypeScript — New Entrant

**Docs**: [google.github.io/adk-docs](https://google.github.io/adk-docs/get-started/typescript/)
**Language**: TypeScript/Python (parallel implementations)
**Backed by**: Google

#### What It Is

ADK is Google's open-source framework for building AI agents with a code-first, TypeScript-native approach. It supports multi-agent systems, complex orchestration, and is deployment-agnostic (local, containers, Cloud Run).

#### Local Model Support

Ollama support via LiteLLM model connector. Configuration uses the `ollama_chat/` prefix:

```typescript
const agent = new LlmAgent({
  model: 'ollama_chat/gemma3:latest',
  // ...
});
```

Requires `OLLAMA_API_BASE` environment variable pointing to the Ollama server.

#### Maturity

Newer than Mastra or LangGraph.js. Google-backed means strong trajectory and docs, but community adoption is not yet comparable. Optimized for Google's Vertex AI / Gemini ecosystem, though designed as model-agnostic. Not a first-line recommendation for a DorkOS integration today — worth watching.

---

### AutoGen (Microsoft) — Python-Dominant, TypeScript Port Exists

**Repository**: [microsoft/autogen](https://github.com/microsoft/autogen)
**Language**: Python (primary); TypeScript port community-driven

#### Summary

AutoGen is Microsoft's Python framework for multi-agent conversational AI. A TypeScript port ("Abitat") exists but is a community effort by Mintplex Labs, not Microsoft-official. Microsoft is now promoting a new "Microsoft Agent Framework" (evolution of AutoGen + Semantic Kernel) as the successor.

#### Local Model Support

Python AutoGen supports local models via OpenAI-compatible endpoints. The TypeScript port has limited documentation on local model support.

#### Embeddability in Node.js

Not practical. AutoGen is Python-first. The TypeScript port (Abitat) is low-activity. **AutoGen is not a viable path for DorkOS.**

---

### Vercel AI SDK — Lowest-Level Option

The Vercel AI SDK (`ai` package) is not a framework per se — it is the primitive layer that Mastra and others build on. It has:

- Official Ollama provider (`@ai-sdk/ollama`)
- `generateText`, `streamText`, `generateObject`, `streamObject` primitives
- `maxSteps` parameter for building simple agent loops without full framework overhead

For DorkOS, this is the lowest-friction path if you want to write the agent loop yourself without adopting a full framework. The trade-off is that you implement retry logic, tool execution, event emission, and state management yourself. Pi-agent-core is essentially this pattern, already implemented well in TypeScript.

---

### Devon, Mentat, bolt.diy — Not Recommended

- **Devon** (~200 stars): Python-based, early stage, limited documentation, no TypeScript.
- **Mentat** (archived/stale): Development appears to have stopped.
- **bolt.diy**: A web-based coding environment (fork of bolt.new), not an embeddable agent framework. Not relevant for DorkOS runtime integration.

---

## Hypothesis Evaluation: Can Building a Custom Agent Unlock Local Model Support?

**The hypothesis is valid, with an important caveat.**

### What is True

Every major TypeScript agent framework (pi-mono, Mastra, LangGraph.js, Vercel AI SDK) supports Ollama and any OpenAI-compatible local model endpoint. There is no technical barrier to building a DorkOS `AgentRuntime` implementation that routes to a local model instead of Claude. The implementation pattern is well-understood: point the `baseUrl` at `http://localhost:11434/v1`, configure the model ID, and the agent loop runs identically.

### The Real Constraint

**Model capability, not framework support, is the bottleneck.** Local models at consumer-hardware scale (7B–13B parameters, 4-bit quantized) have unreliable tool-calling behavior. Coding agents depend on accurate, structured tool invocations (read file, write file, run bash). The frameworks all work — but whether the local model can reliably drive the tool loop is model-dependent.

Models that work well for coding agents locally as of early 2026:

- Qwen3-Coder-30B (requires ~20GB VRAM, runs on 3090/4090)
- Devstral Small 24B (requires ~16GB VRAM)
- Llama 3.3 70B (requires dual 3090 or 4xA6000 setup)
- Qwen2.5-Coder-32B (reliable tool-calling, runs on single 3090)

Models that struggle with coding agent loops:

- Anything under ~14B parameters at 4-bit quantization
- Models not fine-tuned for tool use

### Recommended Implementation Path for DorkOS

1. **Implement a `PiRuntime`** using `@mariozechner/pi-agent-core` as the engine. It fits cleanly into the `AgentRuntime` interface (send messages, stream responses, execute tools, emit events).
2. **Model config passed through the runtime** — user specifies `baseUrl` pointing at Ollama or any OpenAI-compatible endpoint, plus model ID.
3. **Session management** stays in DorkOS's existing layer; pi-agent-core handles only the LLM loop.
4. **Alternative**: Implement a `MastraRuntime` using `@mastra/core` if you also want workflow orchestration, persistent memory across sessions, or multi-agent coordination — capabilities DorkOS doesn't currently expose.
5. **Lowest-effort path**: Skip the frameworks entirely and call the Ollama API directly using the Vercel AI SDK's Ollama provider, implementing a minimal agent loop in the DorkOS server. This avoids a new dependency and works if the loop is simple (no custom tools beyond what the SDK provides).

---

## Source Matrix

| Framework         | Language   | Local Models             | Embeddable in Node.js | Maturity                  | DorkOS Fit      |
| ----------------- | ---------- | ------------------------ | --------------------- | ------------------------- | --------------- |
| **pi-mono**       | TypeScript | Yes (Ollama native)      | Yes (SDK mode)        | High (31.8k stars, v0.65) | Excellent       |
| **Mastra**        | TypeScript | Yes (Ollama via AI SDK)  | Yes (Express/Hono)    | High (22.7k stars, v1.0)  | Good (heavier)  |
| **LangGraph.js**  | TypeScript | Yes (Ollama)             | Yes                   | High (v1.0.6)             | Good (complex)  |
| **Vercel AI SDK** | TypeScript | Yes (Ollama provider)    | Yes                   | High (production)         | Good (DIY loop) |
| **Google ADK TS** | TypeScript | Yes (Ollama via LiteLLM) | Yes                   | Medium (new)              | Fair            |
| **OpenHands**     | Python     | Yes (Ollama)             | No (Python only)      | High (40k+ stars)         | Poor            |
| **AutoGen**       | Python     | Yes                      | No (Python only)      | High                      | Poor            |
| **Devon**         | Python     | Unknown                  | No                    | Low                       | Poor            |
| **Plandex**       | Go         | Cloud-only               | No                    | Winding down              | None            |
| **Mentat**        | Python     | Unknown                  | No                    | Archived                  | None            |

---

## Sources & Evidence

- [badlogic/pi-mono GitHub](https://github.com/badlogic/pi-mono) — Repository overview, package listing, 31.8k stars
- [pi-coding-agent README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md) — SDK modes, 18+ providers, extension system
- [pi-mono coding-agent sdk.ts](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/sdk.ts) — SDK entry point
- [Pi Coding Agent website](https://shittycodingagent.ai/) — Official site
- ["How to Build a Custom Agent Framework with PI"](https://nader.substack.com/p/how-to-build-a-custom-agent-framework) (Nader Dabit) — OpenClaw's use of pi-agent-core, Agent class API, custom tools example
- [Pi + Ollama integration](https://docs.ollama.com/integrations/pi) — Ollama Docs on `ollama launch pi`
- [Run pi-agent on local models with Ollama](https://insiderllm.com/guides/pi-agent-local-models-ollama/) — InsiderLLM guide
- [Ollama auto-detect pi issue #1321](https://github.com/badlogic/pi-mono/issues/1321) — Evidence of active local model integration work
- [badlogic/pi-skills](https://github.com/badlogic/pi-skills) — Skills compatible with pi, Claude Code, Codex CLI, Amp, Droid
- [What I learned building an opinionated coding agent](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) — Author's design rationale
- [Mastra.ai](https://mastra.ai/) — Official site, 22.7k stars, YC-backed
- [Mastra Ollama docs](https://mastra.ai/models/providers/ollama) — Native Ollama provider support
- [Mastra complete guide 2026](https://www.generative.inc/mastra-ai-the-complete-guide-to-the-typescript-agent-framework-2026) — Adoption metrics, architecture overview
- [Building Mastra + Ollama + Next.js app](https://danielkliewer.com/blog/2025-03-09-mastra-ollama-nextjs) — Integration tutorial
- [OpenHands local LLMs docs](https://docs.openhands.dev/openhands/usage/llms/local-llms) — Context length requirement (22k), recommended models
- [OpenHands + Ollama GitHub issue #6918](https://github.com/OpenHands/OpenHands/issues/6918) — Practical user struggles with local models
- [LangGraph + Ollama multi-agent](https://medium.com/@diwakarkumar_18755/building-multi-agent-systems-with-langgraph-and-ollama-architectures-concepts-and-code-383d4c01e00c) — Architecture patterns
- [LangGraph.js SDK agent guide](https://dev.to/buildandcodewithraman/using-langgraphjs-sdk-to-create-agents-494n) — TypeScript usage
- [LangGraph + MCP + Ollama integration](https://dasroot.net/posts/2026/01/integrating-langgraph-mcp-ollama-agentic-ai/) — 2026 stack integration
- [Google ADK TypeScript announcement](https://developers.googleblog.com/introducing-agent-development-kit-for-typescript-build-ai-agents-with-the-power-of-a-code-first-approach/) — Launch post
- [Google ADK Ollama integration](https://google.github.io/adk-docs/agents/models/ollama/) — LiteLLM connector docs
- [Top 5 TypeScript Agent Frameworks 2026](https://techwithibrahim.medium.com/top-5-typescript-ai-agent-frameworks-you-should-know-in-2026-5a2a0710f4a0) — Landscape overview
- [Vercel AI SDK Ollama community provider](https://ai-sdk.dev/providers/community-providers/ollama) — Official docs
- [Building AI agents with Vercel and AI SDK](https://vercel.com/kb/guide/how-to-build-ai-agents-with-vercel-and-the-ai-sdk) — Agent loop pattern
- [Plandex winding down](https://plandex.ai/) — No longer accepting new users (October 2025)
- [Devon GitHub](https://github.com/vunderkind/devon) — ~200 stars, Python-based
- [e2b open-source Devin alternatives](https://e2b.dev/blog/open-source-alternatives-to-devin) — Landscape comparison

---

## Research Gaps & Limitations

- Pi-mono's internal API stability: the README notes "deep in refactoring internals" — the exact SDK surface in `sdk.ts` should be verified against the current commit before building against it.
- Mastra's Ollama issue #2619 ("cant connect to ollama local models") was open at time of research — unclear if resolved.
- No hands-on benchmark data comparing pi-agent-core vs Mastra for a coding-agent use case at the DorkOS integration level.
- LangGraph.js 1.0.6 is the stated version but detailed changelog for breaking changes vs 0.x was not reviewed.
- Google ADK TypeScript is too new (announced early 2026) to have meaningful production case studies.

---

## Search Methodology

- Searches performed: 16
- Most productive search terms: `pi-mono pi-agent-core local model Ollama`, `pi coding agent framework GitHub 2025`, `Mastra TypeScript agent framework Ollama local model`, `building custom coding agent TypeScript Node.js local model framework embed`
- Primary sources: GitHub repositories, official framework documentation, Nader Dabit's OpenClaw guide, Ollama integrations documentation, Mastra docs
- Pages fetched: pi-mono GitHub, pi-coding-agent README, OpenClaw agent framework guide, Ollama pi integration docs, Mastra homepage
