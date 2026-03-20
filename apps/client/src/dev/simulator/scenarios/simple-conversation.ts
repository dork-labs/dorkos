import { createUserMessage, createAssistantMessage } from '../../mock-chat-data';
import { buildStreamingTextSteps } from '../sim-helpers';
import type { SimScenario } from '../sim-types';

const USER_MSG = createUserMessage({
  id: 'sim-user-1',
  content: 'Can you explain how the Transport interface works in this codebase?',
});

const ASSISTANT_MSG = createAssistantMessage({
  id: 'sim-asst-1',
  content: '',
  parts: [{ type: 'text', text: '' }],
});

const ASSISTANT_TEXT = `The **Transport** interface is the key abstraction that decouples the React client from its backend. It lives in \`packages/shared/src/transport.ts\` and defines methods like:

\`\`\`typescript
interface Transport {
  sendMessage(sessionId: string, content: string, onEvent: (event: StreamEvent) => void): Promise<void>;
  listSessions(): Promise<SessionListResponse>;
  getSession(sessionId: string): Promise<SessionResponse>;
}
\`\`\`

There are two concrete adapters:

1. **HttpTransport** — Used by the standalone web client. Makes HTTP requests to the Express server. This adapter handles SSE streaming for real-time message delivery, manages authentication headers, and provides automatic reconnection when the connection drops.

2. **DirectTransport** — Used by the Obsidian plugin. Calls services in-process without HTTP. This is significantly faster since there's no serialization overhead, but it requires the agent runtime to be bundled alongside the plugin.

This hexagonal architecture means the UI components never know or care whether they're running in a browser or inside Obsidian. They just call Transport methods and receive the same shaped data.

### Why This Matters

The Transport pattern enables several important workflows:

- **Testing** — You can create a \`MockTransport\` that returns canned responses, making component tests fast and deterministic without any network calls.
- **Plugin development** — The Obsidian plugin reuses the exact same React components, just wired to a different Transport implementation.
- **Future adapters** — Adding a new deployment target (VS Code extension, Electron app, etc.) only requires implementing the Transport interface.

The interface is intentionally minimal — it defines the contract without prescribing implementation details. Each adapter can optimize for its specific environment.`;

const USER_FOLLOWUP = createUserMessage({
  id: 'sim-user-2',
  content: 'That makes sense. How does error handling work across the two transports?',
});

const FOLLOWUP_MSG = createAssistantMessage({
  id: 'sim-asst-2',
  content: '',
  parts: [{ type: 'text', text: '' }],
});

const FOLLOWUP_TEXT = `Error handling follows a consistent pattern across both transports. Each adapter normalizes errors into a standard \`TransportError\` shape:

\`\`\`typescript
interface TransportError {
  code: 'network' | 'timeout' | 'auth' | 'server';
  message: string;
  retryable: boolean;
}
\`\`\`

**HttpTransport** catches fetch errors and HTTP status codes, mapping them to the appropriate error code. Network failures and 5xx responses are marked \`retryable: true\`, while 4xx errors are not.

**DirectTransport** wraps service-layer exceptions in the same shape. Since there's no network involved, it never produces \`network\` or \`timeout\` errors — those codes are exclusive to HttpTransport.

The UI layer handles these errors uniformly via the \`ErrorMessageBlock\` component, which shows retry buttons only when \`retryable\` is true.`;

/** Demonstrates user message → assistant text streaming → follow-up exchange. */
export const simpleConversation: SimScenario = {
  id: 'simple-conversation',
  title: 'Simple Conversation',
  description: 'User message → streaming text response → follow-up exchange',
  steps: [
    { type: 'append_message', message: USER_MSG, delayMs: 300 },
    { type: 'set_status', status: 'streaming' },
    { type: 'append_message', message: ASSISTANT_MSG, delayMs: 400 },
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-asst-1', ASSISTANT_TEXT),
    { type: 'set_streaming', isTextStreaming: false, delayMs: 200 },
    { type: 'set_status', status: 'idle', delayMs: 600 },

    // Follow-up exchange
    { type: 'append_message', message: USER_FOLLOWUP, delayMs: 300 },
    { type: 'set_status', status: 'streaming' },
    { type: 'append_message', message: FOLLOWUP_MSG, delayMs: 400 },
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps('sim-asst-2', FOLLOWUP_TEXT),
    { type: 'set_streaming', isTextStreaming: false, delayMs: 200 },
    { type: 'set_status', status: 'idle' },
  ],
};
