# Doe

Doe is a Node library for agents that do business work. Your application supplies the model, tools, instructions and permissions. Doe runs the conversation and keeps its complete model history in SQLite, a local database.

Coding work goes to a separate builder with its own instructions and tools. The business agent gets a short result. Your application can also show the builder's progress.

This package does not install an agent runtime in the DorkOS app. App support and the service that schedules agent beats are separate work.

## What your application owns

You choose the model endpoint, model name, credential callback and payer. Doe does not discover vendor logins or read environment keys on its own. It refuses Anthropic subscription tokens before sending requests.

You also supply these:

- The database location and session ID.
- The working directory and explicit file grants.
- Instruction, skill and memory sources.
- Tool descriptions, schemas and execution callbacks.
- Approval decisions, retry choices and progress handling.
- Any builder guidance, tools and process execution policy.
- Any beat inputs, scheduling and notification tools.

Constructing the library sends no model requests. Loading resources makes local file reads within the supplied grants. Requests begin only when your application asks Doe to run.

## Start with a local model

The runnable example uses a local server with an OpenAI-compatible Chat Completions API. From the repository root, build the package and supply the URL and model ID explicitly:

```sh
pnpm --filter @dorkos/doe build
node packages/doe/examples/local.mjs http://127.0.0.1:8080/v1 your-local-model
```

Importing the example does nothing. Running it creates a temporary workspace and database, streams main text, and prints request usage. It needs no API key. It deletes only its own temporary workspace after the run settles.

Tools are denied by default. Add `--allow-tools` to approve the example's read, write and tool-search tools. File grants cover only the temporary workspace. Press Control-C to abort; cleanup waits for owned work before closing SQLite.

Use a lasting database path in your application. Follow the example's configuration shape, then choose your own resources, tools and approval callback.

## Choose a model explicitly

Set the protocol, endpoint, model ID, context window and output limit. The supported protocol names are `anthropic-messages`, `openai-completions` and `openai-responses`. Compatible local servers use the same explicit settings. Doe does not guess a protocol from the URL.

The credential callback supplies the request credential. A missing required credential fails before a request. Set `requiresCredentials:false` only for an endpoint that accepts requests without credentials.

Retries follow host choices. Authentication, quota and cancellation errors are refused. A request that already produced text or executed a tool cannot silently replay. Fallback models must keep the same payer and compatible protocol/history family. Retry and model substitution events let the host show what happened.

## Keep the complete conversation

The store keeps full model messages, including tool exchanges, images and opaque reasoning fields. It does not rebuild model context from a shortened display log.

`archive(sessionId)` returns original messages. `restore(sessionId)` returns the latest saved summary plus retained messages. A checkpoint adds a summary boundary without deleting the original archive.

Completed messages and request usage are appended as separate durable records. Failed writes are reported. A failed checkpoint keeps the previous restored context. History survives close and reopen; only an explicit session deletion removes it.

Builder and beat messages use separate scopes. They do not replace the main conversation. Each model request has a unique usage record across that session's scopes. Use `allUsage(sessionId)` for totals; do not add child totals to a total that already includes them.

Reported token counts come from the model provider when available. Context estimates are labeled as estimates. Missing cost is unknown, not zero.

## Compact business context

Attach the compaction module when constructing Doe:

```ts
extensions: createCompaction({ reserveTokens: 2048, retainTurns: 2 });
```

Call `await doe.compact()` for manual compaction. The same operation runs automatically before a main request would exceed the model's context window minus the reserve. It keeps recent complete turns, unfinished work, tool exchanges and current instructions.

A summary records business outcomes, decisions, promises, open work and relevant artifacts. Error, abort, length and oversized summaries cannot replace the current context. Real summary usage remains recorded even when checkpoint persistence fails. Compaction never deletes the original archive.

Local token estimates are heuristics, not guaranteed bounds. Counts combine a usable reported baseline with estimated growth where available. Mixed counts stay labeled estimated.

## Instructions and skills

Pass the resource roots yourself. Doe loads ancestor `AGENTS.md` files from outer to inner, followed by agent instructions and `SOUL.md`. It preserves supplied memory and context.

Nested instructions load only when a file operation reaches their directory. Reads include those instructions in the result. A first write or edit returns a retry-required error before changing the file. The next model request includes the instructions, and the agent can retry.

The facade refreshes `resources.load()` before every model request. Share one Resources instance with that conversation's file tools. A builder uses a separate Resources instance so its prompt refresh cannot acknowledge the parent's pending instructions.

Skill roots have explicit priority: the first root wins. Namespaces qualify names as `namespace:name`. Canonical file paths prevent duplicates; canonical directory paths prevent symlink cycles. A physical skill file is consumed at its first root appearance, even when its name loses a collision.

The initial catalogue contains names, descriptions and locations, not skill bodies. `load_skill` loads a body when needed. Skills marked `disable-model-invocation` are excluded from automatic selection and refused by that tool.

Relative scripts and resources resolve beside the canonical skill file and remain grant-checked. The business agent sends script execution to builder.

## Tools load when needed

Register your own capabilities through normal tool descriptors. Each descriptor supplies its name, description, JSON schema and execution callback. A `searchHint` adds terms the agent can find.

Keep a small set of tools initially loaded. `tool_search` finds a bounded set of deferred tools and loads their schemas for the next request. It does not execute them. A successful search replaces the deferred selection while keeping initially loaded tools. Previous request snapshots remain unchanged.

Registry limits cap initial schema bytes, total selected schema bytes, selected tool count and discovery page size. Adding deferred tools does not enlarge the initial schemas. A tool that has not been loaded cannot run.

## Connect MCP tools explicitly

MCP is a standard for exposing tools to agents. Doe's MCP client accepts an explicit process command or HTTP endpoint. It does not discover vendor settings.

A stdio server receives only the supplied environment. Model keys and cloud secrets are not inherited. HTTP requests stay on the configured endpoint and refuse redirects. Discovery pages, message sizes and request duration have explicit bounds.

Tool aliases include the server identity and a stable hash. Discovery and execution use the same aliases. Results preserve text, images and structured fields. Protocol failures become tool errors.

An aborted or timed-out call closes that MCP connection to stop its outstanding work. The host must create a new connection afterward. Rebuild the affected tool registrations with the new callbacks; a closed connection's descriptors cannot run again. Close connections when your application stops.

## Give builder an explicit execution policy

Builder gets its own coding prompt, approved working directory and curated tool list. It inherits the approved model and payer. Host guidance can explain how to build tools for your application. It cannot spawn another builder through its tools or discovery.

Read, write, exact edit and text search enforce canonical file grants. Shell execution requires a separate policy. Choose an explicitly authorized unrestricted shell or provide an isolated executor. File grants do not create an operating-system shell sandbox.

Native shell execution is POSIX-only. On Windows, supply a host isolated executor.

Shell work has duration and output limits. It receives an explicit environment and follows cancellation. Cleanup targets only processes owned by that builder. An isolated executor must honor the supplied cancellation signal and bounds.

The parent receives a bounded final result. Child progress stays tagged as child activity. Denial, cancellation and failure must not become a successful builder summary.

## Run one beat when your host asks

A beat is one short run with fresh changes, instructions and commitments. A host decision callback can skip it without making a full model request. A run returns a quiet result or bounded raises with their reporting level.

Free text is activity, not a notification. Only explicit host posting tools can notify people. The package does not start timers, gather changes, schedule future runs or batch notifications.

## Limits and cleanup

File tools cap input and output. They refuse special files, symlink escapes and ambiguous exact edits. Web fetch checks host URL policy before the first request and each redirect. It caps response size, output and duration.

Filesystem grants cannot defend against an adversarial process continuously replacing parent directories. Treat shell isolation and process execution as separate host responsibilities.

Call `doe.abort()` and await the active run before closing its store or deleting temporary files. The facade drains its owned child executions before returning and releasing its session lock. Close any host-owned MCP connections separately. Do not place credentials in messages, tool output, memory or session metadata.

## Development

From the repository root:

```sh
pnpm vitest run packages/doe/src
pnpm --filter @dorkos/doe build
pnpm --filter @dorkos/doe typecheck
pnpm --filter @dorkos/doe lint
pnpm --filter @dorkos/doe test:pack
```

Tests use temporary files, scripted model responses, local HTTP servers and local MCP fixtures. Ordinary tests do not use paid model credentials.

Doe uses MIT-licensed Pi core libraries behind its engine interface. Runtime exports do not import DorkOS product packages. See `LICENSE` and `THIRD-PARTY-NOTICES.md` for licenses and source attribution.
