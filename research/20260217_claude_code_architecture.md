# Claude Code Architecture — Technical Truth

**Date**: 2026-02-17
**Purpose**: Understand Claude Code's real architecture so DorkOS marketing copy is accurate
**Research depth**: Focused Investigation

---

## Research Summary

Claude Code is a CLI tool (and associated IDE extensions/desktop/web surfaces) where the
**agent loop and all tool execution happen locally on the user's machine**, but **inference
(the LLM itself) runs in Anthropic's cloud** via API calls. Claiming "no cloud" or "runs
entirely on your machine" is false. The honest framing is: "your code and file system are
controlled locally; AI inference calls Anthropic's API (or a compatible provider)."

---

## Key Findings

### 1. Inference is always remote by default (cloud API)

The primary, default mode of Claude Code sends every prompt to Anthropic's API for
inference. The Claude model (claude-sonnet-*, claude-opus-*, etc.) runs on Anthropic's
servers, not on the user's machine. From The Pragmatic Engineer's deep dive:

> "Commands run locally, with the only network calls being to Claude's API for model
> inference, and you control exactly what context gets sent."

This is the single clearest architectural statement available from primary sources.

### 2. What actually runs locally

On the user's machine:
- The CLI process itself (TypeScript, Bun runtime)
- The agent loop: reading files, executing bash commands, writing files, managing state
- Tool execution: git operations, file reads/writes, shell commands, test runners
- Context assembly: gathering file contents, directory trees, terminal output before sending to the API
- Permission enforcement and approval UI (via React/Ink terminal UI)
- JSONL transcript files (session history stored locally at `~/.claude/projects/`)

Anthropic's cloud:
- The Claude model itself (inference)
- Processing the prompt and generating the response
- (For web/cloud mode only): An isolated VM runs the entire agent including tool execution

### 3. Local inference is possible but non-default and third-party

Since Claude Code v0.14.0 (January 2026), it supports alternative providers via the
Anthropic-compatible Messages API format. You can point Claude Code at:
- Ollama (local open-source models, e.g. on localhost:11434)
- LM Studio
- llama.cpp
- OpenRouter
- Amazon Bedrock
- Google Vertex AI
- Microsoft Foundry

This is done via env vars like `ANTHROPIC_BASE_URL`. This is not "Claude running locally" —
it's Claude Code (the agent framework) using a different model. The Claude model itself
cannot be run locally; only open-source alternatives can be substituted.

### 4. The "web" and "cloud session" modes run EVERYTHING in Anthropic's cloud

The desktop app and web interface offer "cloud sessions" where even the agent loop (file
operations, bash execution) runs inside Anthropic-managed isolated VMs:

> "When using Claude Code on the web, additional security controls are in place: Isolated
> virtual machines — Each cloud session runs in an isolated, Anthropic-managed VM."

So there is actually a spectrum:
- **Terminal/CLI mode**: agent runs locally, inference calls Anthropic API
- **Cloud session mode** (web/desktop): both agent and inference run in Anthropic's cloud

### 5. Tech stack of the local component

The locally running CLI is built with:
- TypeScript (primary language)
- React + Ink (terminal UI rendering)
- Yoga (Meta's constraint-based layout for terminal)
- Bun (build tooling and runtime)
- ~90% of the code is written by Claude Code itself

Anthropic deliberately kept it lean: "we want people to feel the model as raw as possible"
with "as little business logic as possible."

### 6. No virtualization in CLI mode (by default)

> "Claude Code runs batch commands locally, and reads and writes to the filesystem.
> There's no virtualization."

This means Claude Code in CLI mode has direct, non-sandboxed access to the local filesystem
and shell (subject to the permission/approval system). This is a deliberate design choice
for simplicity and directness.

### 7. Data privacy considerations for marketing

- Anthropic has limited retention periods for prompt data
- Consumer users can opt out of training data usage via privacy settings
- API/Teams/Enterprise users are covered by commercial terms (prompts not used for training)
- All code context sent in prompts travels to Anthropic's servers

---

## What This Means for DorkOS Marketing Copy

### Claims that are TRUE and safe to use:

- "Runs in your terminal" / "on your machine" — TRUE (the agent loop and tool execution)
- "Reads and writes directly to your filesystem" — TRUE
- "Executes commands in your shell" — TRUE
- "No virtualization" — TRUE (in CLI mode)
- "You control what context is sent" — TRUE
- "Works with your existing tools and workflow" — TRUE
- "Local file access, git integration, shell execution" — TRUE
- "Sessions stored locally" — TRUE (JSONL transcripts in `~/.claude/`)

### Claims that are FALSE and must NOT be used:

- "No cloud" — FALSE (inference is cloud-based by default)
- "Runs entirely on your machine" — FALSE (inference goes to Anthropic API)
- "Your code never leaves your machine" — FALSE (code context is sent in API calls)
- "Local AI" or "offline AI" — FALSE (by default; only true with Ollama/local models)
- "Private, no data sent to servers" — FALSE

### Honest framing options for DorkOS:

**Option A (emphasizing what IS local):**
"Claude Code's agent loop runs directly on your machine — reading files, executing commands,
and writing code without virtualization. Inference calls Anthropic's API."

**Option B (emphasizing control):**
"Your codebase stays in your hands. Claude Code runs natively in your terminal, with direct
filesystem and shell access. AI inference is powered by Anthropic's API — the same model,
directly accessible, without middleware."

**Option C (acknowledging the hybrid nature):**
"A local agent, cloud inference. Claude Code runs your tools locally — git, bash, file
editing — while Claude's intelligence comes from Anthropic's API. DorkOS adds a web UI
and REST API on top of that agent."

**DorkOS-specific truth:**
DorkOS wraps Claude Code (the local agent) with a web UI and REST/SSE API. It does not
change where inference happens. When describing DorkOS, be precise:
- DorkOS adds a web interface to Claude Code's local agent
- DorkOS does not make Claude Code "more local" or "more private"
- DorkOS sessions are stored locally (JSONL from Agent SDK)

---

## Detailed Analysis

### The Agent Loop (What "Local" Actually Means)

Claude Code implements a classic ReAct-style agent loop:
1. Receive user message
2. Assemble context (relevant files, terminal history, project structure)
3. Send assembled context + tools schema to Anthropic's API via HTTPS
4. Receive model response (text + tool_use blocks)
5. Execute approved tool calls locally (read_file, write_file, bash, etc.)
6. Append tool results to context
7. Repeat from step 3 until done
8. Return final response to user

Steps 3-4 are cloud. Steps 1-2, 5-8 are local. This is the fundamental architecture.

### Alternative Provider Support (True Local Inference)

For users who want zero cloud inference, the path is:
1. Run Ollama locally with a capable model (e.g., deepseek-r1, qwen2.5-coder)
2. Set `ANTHROPIC_BASE_URL=http://localhost:11434` (Ollama's Anthropic-compatible endpoint)
3. Claude Code agent loop still runs locally, but inference goes to local Ollama

This achieves true "no cloud" but uses open-source models, not Anthropic's Claude. The
quality/capability difference is significant. This is not the typical use case.

### Session Storage Architecture

All session data (JSONL transcripts) are stored locally at `~/.claude/projects/{slug}/`.
DorkOS's `TranscriptReader` reads these files directly — no separate session store.
This is genuinely local and private (the transcripts, not the inference calls).

---

## Sources & Evidence

- "Commands run locally, with the only network calls being to Claude's API for model inference" — [How Claude Code is Built, Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/how-claude-code-is-built)
- "Claude Code runs batch commands locally, and reads and writes to the filesystem. There's no virtualization." — [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/how-claude-code-is-built)
- "Each cloud session runs in an isolated, Anthropic-managed VM" — [Claude Code Security Docs](https://code.claude.com/docs/en/security)
- "Since v0.14.0 (January 2026), Ollama exposes an Anthropic-compatible Messages API on localhost:11434" — [Towards Data Science / search results](https://towardsdatascience.com/run-claude-code-for-free-with-local-and-cloud-models-from-ollama/)
- Full tech stack details — [Pragmatic Engineer deep dive](https://newsletter.pragmaticengineer.com/p/how-claude-code-is-built)
- Overview docs — [code.claude.com/docs/en/overview](https://code.claude.com/docs/en/overview)
- Security docs — [code.claude.com/docs/en/security](https://code.claude.com/docs/en/security)
- Enterprise/third-party integrations — [code.claude.com/docs/en/third-party-integrations](https://code.claude.com/docs/en/third-party-integrations)

---

## Research Gaps & Limitations

- Exact list of data fields sent in each API call is not documented publicly (beyond "context you choose to send")
- Anthropic's data retention specifics require reading the Privacy Policy directly
- Whether prompt caching (on by default) affects data handling is unspecified in the docs
- The Pragmatic Engineer article may have been written before v0.14.0; some details may be slightly outdated

---

## Contradictions & Disputes

None found. All sources are consistent: local agent loop, remote inference via API.
The only nuance is "cloud session" mode (web/desktop) where even the agent runs in Anthropic's cloud, which is an opt-in, not default, mode.

---

## Search Methodology

- Searches performed: 3 web searches + 5 URL fetches
- Most productive sources: Pragmatic Engineer deep dive, code.claude.com/docs/en/security
- Key terms: "Claude Code architecture", "inference local cloud", "CLI API", "no virtualization"
- Primary information sources: code.claude.com (official docs), newsletter.pragmaticengineer.com (technical deep dive)
