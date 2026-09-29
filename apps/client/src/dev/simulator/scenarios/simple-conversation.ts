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

**HttpTransport** connects the web, desktop and phone app to the server. Components call the same methods regardless of where the app runs.

Tests use a mock Transport to return known responses without making network requests. The interface keeps the UI independent of the server's implementation.
`;

const USER_FOLLOWUP = createUserMessage({
  id: 'sim-user-2',
  content: 'That makes sense. How does error handling work in HttpTransport?',
});

const FOLLOWUP_MSG = createAssistantMessage({
  id: 'sim-asst-2',
  content: '',
  parts: [{ type: 'text', text: '' }],
});

const FOLLOWUP_TEXT = `This example groups request failures into a \`TransportError\` shape:

\`\`\`typescript
interface TransportError {
  code: 'network' | 'timeout' | 'auth' | 'server';
  message: string;
  retryable: boolean;
}
\`\`\`

**HttpTransport** catches fetch errors and HTTP status codes, mapping them to the appropriate error code. Network failures and 5xx responses are marked \`retryable: true\`, while 4xx errors are not.


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
