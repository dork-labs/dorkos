/**
 * Runtime capabilities for images attached to messages or returned by tools.
 *
 * @module test-utils/runtime-capability-media
 */
import type { MatrixCell, RuntimeCapability } from './runtime-capability-types.js';

const IMAGE_INPUT_UNVERIFIED: MatrixCell = {
  status: 'unverified',
  reason: 'The composer sends the saved file path. How the agent receives the image needs a test.',
};

/** Image input and the tool images stored by the configured server. */
export const MEDIA_CAPABILITIES: readonly RuntimeCapability[] = [
  {
    id: 'RT-MEDIA-01',
    group: 'MEDIA',
    title: 'Attach images to a message',
    expected: 'Images the person attaches reach the agent with the message.',
    cells: {
      'claude-code': IMAGE_INPUT_UNVERIFIED,
      codex: IMAGE_INPUT_UNVERIFIED,
      opencode: IMAGE_INPUT_UNVERIFIED,
      doe: { status: 'not-supported', reason: 'Images cannot be attached to Doe messages yet.' },
      'test-mode': { status: 'n/a', reason: 'Test mode has no backend to receive images.' },
    },
  },
  {
    id: 'RT-MEDIA-02',
    group: 'MEDIA',
    title: 'Show pictures returned by tools',
    expected:
      'A picture returned by an agent’s tool reaches the chat as a stored attachment announced by URL.',
    flag: { label: "mediaOutput !== 'none'", read: (caps) => caps.mediaOutput !== 'none' },
    cells: {
      'claude-code': {
        status: 'supported',
        evidence: ['U'],
        references: [
          {
            tier: 'U',
            file: 'apps/server/src/services/runtimes/claude-code/sessions/__tests__/pump-turn-stream-media.test.ts',
            title: 'announces the image by URL, with the bytes already on disk',
          },
        ],
      },
      codex: {
        status: 'supported',
        evidence: ['U'],
        references: [
          {
            tier: 'U',
            file: 'apps/server/src/services/runtimes/codex/app-server/__tests__/notification-mapper.test.ts',
            title: 'records an MCP image for the runtime to store',
          },
          {
            tier: 'U',
            file: 'apps/server/src/services/runtimes/codex/__tests__/media-capture.test.ts',
            title: 'announces the image by URL, with the bytes already on disk',
          },
        ],
      },
      opencode: {
        status: 'supported',
        evidence: ['U'],
        references: [
          {
            tier: 'U',
            file: 'apps/server/src/services/runtimes/opencode/__tests__/media-capture.test.ts',
            title: 'stores the bytes and announces them by URL',
          },
          {
            tier: 'U',
            file: 'apps/server/src/services/runtimes/opencode/__tests__/media-capture.test.ts',
            title: 'writes bytes that are actually the image, not a placeholder',
          },
        ],
      },
      doe: { status: 'not-supported', reason: 'DorkOS does not expose this feature.' },
      'test-mode': { status: 'n/a', reason: 'Test mode does not produce tool images.' },
    },
  },
];
