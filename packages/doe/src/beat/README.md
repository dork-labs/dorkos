# Beat execution

Pass `createBeatExtension()` as `config.extensions.runBeat`. The host schedules calls to `doe.runBeat`; the package creates no timer and sends no notifications. A host may supply a cheap `decide` callback to skip work before creating an engine. Skips persist their reason.

Each invocation needs a new nonempty ID. Its durable scope is `beat:<id>`; an ID with prior messages, usage or outcomes is refused. Supply changes, instructions and commitments explicitly. Main dialogue is excluded, while the business profile remains available. Commitments should describe prior raises so the agent can avoid repeating unchanged issues across beats.

The temporary `end_beat` tool records either quiet completion or one to eight raises. Each raise contains a message of at most 2,000 characters and a reporting rung: `record`, `report`, `room`, `dm` or `notification`. These are reporting intentions for the host to interpret. Free text is activity, and only explicit host posting tools deliver messages.

Completion waits for every tool in the current batch. A failed sibling, cancellation, model failure or persistence failure prevents a successful outcome. Earlier failed batches may be corrected. Tool events remain paired; usage and messages retain the beat scope. Concurrent operations on the same Doe session are refused by its existing guard.

Deferred discovery refreshes the host selection before the next request. The scoped registry adds `end_beat` without registering it in the host registry, and rejects a selected host tool with that reserved name. `BeatOptions` caps the complete selected set including this tool: 64 tools and 262,144 serialized schema bytes by default. Smaller explicit bounds are supported. Inputs are limited to 32,768 characters per field. The host owns scheduling, prior-raise state, retries with new IDs and delivery policy.
