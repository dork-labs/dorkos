# Builder

The builder handles coding work in a separate conversation. Register it explicitly in the business tool registry. The business model receives a short final result; child text, tool activity and usage events carry a `child:` scope. The store keeps child history apart from the main conversation and includes child requests in `allUsage()`.

```ts
registry.register(
  createBuilderTool({
    workingDirectory: approvedDirectory,
    pathPolicy: { readRoots: [approvedDirectory], writeRoots: [approvedDirectory] },
    resources: childResources,
    guidance: miniAppInstructions,
    tools: hostCodingTools,
    maxResultCharacters: 2000,
    maxDurationMs: 60_000,
    maxOutputBytes: 16_384,
    executionPolicy: { kind: 'unrestricted', environment: {} },
  })
);
```

Use a resource instance owned by the child, separate from the parent's resources. Child discovery has its own registry. Host tools can start loaded or remain available through child tool search. The child cannot discover another builder or reuse the parent's tool search. The model defaults to the parent's explicit configuration. An optional child model must keep the same payer, protocol and history compatibility. Host approval decisions apply inside the child.

Shell requires an explicit execution policy. `unrestricted` allows full OS shell access on POSIX systems. File path grants restrict the file tools; they do not isolate shell commands. The shell receives only the supplied environment, never the host's ambient environment. Commands have a shared concurrency limit, a duration limit and a combined stdout/stderr byte limit. Cancellation stops the process group created for that command, using its held process identity. Command completion also stops any background processes left in that group.

Native shell is refused on Windows. Supply an `isolated` executor there, or wherever OS isolation is required. The executor receives an empty environment, canonical working directory, limits and an abort signal. It must enforce those limits and stop its own work when cancelled. Doe bounds the result returned to the model and stops waiting when cancelled; it cannot enforce an external executor's OS isolation.

The child also has a duration limit. Parent cancellation reaches child requests, pending approval and tools. Abort, failed or length-stopped children, and denied tool approval return an error rather than a successful builder summary. Ordinary tool errors can be corrected: a write refused until nested instructions reach the model can be retried after the next resource refresh.

Original messages and model usage remain in the durable child scope. The builder does not add another usage record for its summary. Unknown model cost remains unknown.
