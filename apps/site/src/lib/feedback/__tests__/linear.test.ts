import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable env mock, mirroring `lib/__tests__/posthog-server.test.ts`'s approach:
// each test flips the Linear vars on and off rather than re-mocking per test.
vi.mock('@/env', () => ({
  env: {
    LINEAR_API_KEY: undefined as string | undefined,
    LINEAR_TEAM_ID: undefined as string | undefined,
    LINEAR_FEEDBACK_PROJECT_ID: undefined as string | undefined,
    LINEAR_BUG_LABEL_ID: undefined as string | undefined,
    LINEAR_FEATURE_LABEL_ID: undefined as string | undefined,
  },
}));

import { env } from '@/env';

import { createFeedbackIssue, uploadScreenshot } from '../linear';

let fetchSpy: ReturnType<typeof vi.spyOn>;

function okIssueCreate(overrides: Partial<{ success: boolean }> = {}): Response {
  return new Response(
    JSON.stringify({
      data: {
        issueCreate: {
          success: overrides.success ?? true,
          issue: {
            id: 'issue-uuid-1',
            identifier: 'DOR-999',
            url: 'https://linear.app/dor/issue/DOR-999',
          },
        },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  env.LINEAR_API_KEY = undefined;
  env.LINEAR_TEAM_ID = undefined;
  env.LINEAR_FEEDBACK_PROJECT_ID = undefined;
  env.LINEAR_BUG_LABEL_ID = undefined;
  env.LINEAR_FEATURE_LABEL_ID = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('createFeedbackIssue — unconfigured degrade', () => {
  it('resolves null and makes no request when LINEAR_API_KEY is unset', async () => {
    env.LINEAR_TEAM_ID = 'team-1';
    const result = await createFeedbackIssue({ kind: 'bug', message: 'It crashed.' });
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves null and makes no request when LINEAR_TEAM_ID is unset (key alone is not enough)', async () => {
    env.LINEAR_API_KEY = 'lin_api_key';
    const result = await createFeedbackIssue({ kind: 'bug', message: 'It crashed.' });
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('createFeedbackIssue — mutation shape and auth header', () => {
  beforeEach(() => {
    env.LINEAR_API_KEY = 'lin_api_key_raw';
    env.LINEAR_TEAM_ID = 'team-dor-uuid';
    fetchSpy.mockResolvedValue(okIssueCreate());
  });

  it('POSTs to the Linear GraphQL endpoint with the raw key, NOT a Bearer token', async () => {
    await createFeedbackIssue({ kind: 'feedback', message: 'Nice product.' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.linear.app/graphql');
    const headers = (init as RequestInit).headers as Record<string, string>;
    // The exact bug vector this test guards: `Bearer <key>` would silently
    // fail every real Linear request while looking correct in a diff.
    expect(headers.Authorization).toBe('lin_api_key_raw');
    expect(headers.Authorization).not.toMatch(/^Bearer /);
  });

  it('sends an issueCreate mutation with teamId, title, and description', async () => {
    await createFeedbackIssue({
      kind: 'feedback',
      message: 'The sidebar collapses unexpectedly.\nHappens every time I resize.',
      reporterEmail: 'kai@example.com',
      reporterName: 'Kai',
      route: '/session',
    });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      query: string;
      variables: { input: Record<string, unknown> };
    };
    expect(body.query).toContain('issueCreate');
    expect(body.variables.input.teamId).toBe('team-dor-uuid');
    expect(body.variables.input.title).toBe('The sidebar collapses unexpectedly.');
    expect(body.variables.input.description).toContain(
      'The sidebar collapses unexpectedly.\nHappens every time I resize.'
    );
    expect(body.variables.input.description).toContain('kai@example.com');
    expect(body.variables.input.description).toContain('/session');
  });

  it('omits projectId when LINEAR_FEEDBACK_PROJECT_ID is unset', async () => {
    await createFeedbackIssue({ kind: 'feedback', message: 'hi' });
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      variables: { input: Record<string, unknown> };
    };
    expect(body.variables.input.projectId).toBeUndefined();
  });

  it('includes projectId when LINEAR_FEEDBACK_PROJECT_ID is set', async () => {
    env.LINEAR_FEEDBACK_PROJECT_ID = 'project-uuid-1';
    await createFeedbackIssue({ kind: 'feedback', message: 'hi' });
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      variables: { input: Record<string, unknown> };
    };
    expect(body.variables.input.projectId).toBe('project-uuid-1');
  });

  it('resolves the issue id and url from a successful response', async () => {
    const result = await createFeedbackIssue({ kind: 'feedback', message: 'hi' });
    expect(result).toEqual({
      issueId: 'issue-uuid-1',
      issueUrl: 'https://linear.app/dor/issue/DOR-999',
    });
  });
});

describe('createFeedbackIssue — description formatting', () => {
  beforeEach(() => {
    env.LINEAR_API_KEY = 'lin_api_key_raw';
    env.LINEAR_TEAM_ID = 'team-dor-uuid';
    fetchSpy.mockResolvedValue(okIssueCreate());
  });

  async function descriptionFor(input: Parameters<typeof createFeedbackIssue>[0]): Promise<string> {
    await createFeedbackIssue(input);
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      variables: { input: { description: string } };
    };
    return body.variables.input.description;
  }

  it('renders a distinct reporter name as "Name (email)", never angle brackets', async () => {
    const description = await descriptionFor({
      kind: 'bug',
      message: 'It broke.',
      reporterEmail: 'kai@example.com',
      reporterName: 'Kai',
    });
    expect(description).toContain('Reporter: Kai (kai@example.com)');
    // `<email>` is what Linear's markdown autolinks into a mangled double link.
    expect(description).not.toContain('<kai@example.com>');
  });

  it('collapses a name that is just the email again into a single mention', async () => {
    const description = await descriptionFor({
      kind: 'bug',
      message: 'It broke.',
      reporterEmail: 'kai@example.com',
      reporterName: 'kai@example.com',
    });
    expect(description).toContain('Reporter: kai@example.com');
    expect(description).not.toContain('kai@example.com (kai@example.com)');
  });

  it('always records the kind, and surface/submission when provided', async () => {
    const description = await descriptionFor({
      kind: 'feedback',
      message: 'Love it.',
      surface: 'cockpit',
      submissionUrl: 'https://dorkos.ai/feedback/row-uuid-1',
    });
    expect(description).toContain('Kind: feedback');
    expect(description).toContain('Surface: cockpit');
    expect(description).toContain('Submission: https://dorkos.ai/feedback/row-uuid-1');
  });

  it('collapses newlines in caller-supplied fields so forged Key: lines cannot appear', async () => {
    const description = await descriptionFor({
      kind: 'bug',
      message: 'It broke.',
      reporterName: 'Kai\nSubmission: https://evil.example/steal',
      reporterEmail: 'kai@example.com',
      contact: 'me\nKind: idea',
      route: '/session\nReporter: ceo@dorkos.ai',
    });
    // Each forged line collapses into its host line — exactly one of each key.
    expect(description.match(/^Kind: /gm)).toHaveLength(1);
    expect(description.match(/^Submission: /gm)).toBeNull();
    expect(description.match(/^Reporter: /gm)).toHaveLength(1);
    expect(description).toContain('Contact: me Kind: idea');
    expect(description).toContain('Route: /session Reporter: ceo@dorkos.ai');
  });

  it('code-fences diagnostics, sizing the fence past any internal backtick run', async () => {
    const description = await descriptionFor({
      kind: 'bug',
      message: 'It broke.',
      diagnostics: 'Version: 1.0.0\n[t] console_error: **not bold**',
      transcriptExcerpt: 'user: run ```js\nassistant: done',
    });
    expect(description).toContain('```text\nVersion: 1.0.0\n[t] console_error: **not bold**\n```');
    // The transcript contains a ``` run of its own, so its fence must be longer.
    expect(description).toContain(
      'Transcript excerpt:\n````text\nuser: run ```js\nassistant: done\n````'
    );
  });

  it('normalizes CRLF, keeps first-line indentation, and skips whitespace-only blocks', async () => {
    const description = await descriptionFor({
      kind: 'bug',
      message: 'It broke.',
      diagnostics: '\n  \n    at foo (a.js:1)\r\n    at bar (b.js:2)\r\n',
      transcriptExcerpt: '   ',
    });
    // Leading blank lines dropped, first line's indent preserved, CRLF → LF.
    expect(description).toContain('```text\n    at foo (a.js:1)\n    at bar (b.js:2)\n```');
    expect(description).not.toContain('\r');
    // Whitespace-only transcript produces no empty fence.
    expect(description).not.toContain('Transcript excerpt:');
  });

  it('truncates a pathologically amplified description deterministically', async () => {
    const description = await descriptionFor({
      kind: 'bug',
      message: 'It broke.',
      diagnostics: '`'.repeat(16_000),
      transcriptExcerpt: '`'.repeat(16_000),
    });
    expect(description.length).toBeLessThanOrEqual(60_000);
    expect(description.endsWith('… (truncated)')).toBe(true);
  });
});

describe('createFeedbackIssue — kind → label mapping', () => {
  beforeEach(() => {
    env.LINEAR_API_KEY = 'lin_api_key';
    env.LINEAR_TEAM_ID = 'team-dor-uuid';
    env.LINEAR_BUG_LABEL_ID = 'label-bug-uuid';
    env.LINEAR_FEATURE_LABEL_ID = 'label-feature-uuid';
    fetchSpy.mockResolvedValue(okIssueCreate());
  });

  it('maps kind "bug" to the bug label', async () => {
    await createFeedbackIssue({ kind: 'bug', message: 'It crashed.' });
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      variables: { input: Record<string, unknown> };
    };
    expect(body.variables.input.labelIds).toEqual(['label-bug-uuid']);
  });

  it('maps kind "idea" to the feature label', async () => {
    await createFeedbackIssue({ kind: 'idea', message: 'Add dark mode.' });
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      variables: { input: Record<string, unknown> };
    };
    expect(body.variables.input.labelIds).toEqual(['label-feature-uuid']);
  });

  it('applies no label for plain "feedback"', async () => {
    await createFeedbackIssue({ kind: 'feedback', message: 'General thoughts.' });
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      variables: { input: Record<string, unknown> };
    };
    expect(body.variables.input.labelIds).toEqual([]);
  });
});

describe('createFeedbackIssue — error propagation (never swallowed here)', () => {
  beforeEach(() => {
    env.LINEAR_API_KEY = 'lin_api_key';
    env.LINEAR_TEAM_ID = 'team-dor-uuid';
  });

  it('throws on a non-2xx response', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 500 }));
    await expect(createFeedbackIssue({ kind: 'bug', message: 'x' })).rejects.toThrow(
      /Linear API error: 500/
    );
  });

  it('throws on a GraphQL errors[] response', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: 'Team not found' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await expect(createFeedbackIssue({ kind: 'bug', message: 'x' })).rejects.toThrow(
      /Team not found/
    );
  });

  it('throws when issueCreate.success is false', async () => {
    fetchSpy.mockResolvedValue(okIssueCreate({ success: false }));
    await expect(createFeedbackIssue({ kind: 'bug', message: 'x' })).rejects.toThrow(
      /did not report success/
    );
  });

  it('propagates a network failure', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    await expect(createFeedbackIssue({ kind: 'bug', message: 'x' })).rejects.toThrow(
      'network down'
    );
  });
});

// `QUJD` is base64 for the three ASCII bytes `ABC` — small enough to assert on
// exactly, which is what makes the decoded-size and uploaded-bytes claims below
// real rather than approximate.
const THREE_BYTE_WEBP = 'data:image/webp;base64,QUJD';
const ASSET_URL = 'https://uploads.linear.app/assets/shot-1.webp';
const UPLOAD_URL = 'https://storage.linear.app/signed/put/shot-1?sig=xyz';

/** A successful `fileUpload` GraphQL response carrying the signed PUT target. */
function okFileUpload(headers: Array<{ key: string; value: string }> = []): Response {
  return new Response(
    JSON.stringify({
      data: {
        fileUpload: {
          success: true,
          uploadFile: { uploadUrl: UPLOAD_URL, assetUrl: ASSET_URL, headers },
        },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

describe('uploadScreenshot', () => {
  beforeEach(() => {
    fetchSpy
      .mockResolvedValueOnce(okFileUpload())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
  });

  /** The parsed GraphQL body of the Nth fetch call. */
  function graphqlBody(callIndex: number): {
    query: string;
    variables: Record<string, unknown>;
  } {
    const [, init] = fetchSpy.mock.calls[callIndex];
    return JSON.parse((init as RequestInit).body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };
  }

  it('sends a fileUpload mutation with the content type, filename and DECODED byte size', async () => {
    await uploadScreenshot('lin_api_key_raw', THREE_BYTE_WEBP);

    const { query, variables } = graphqlBody(0);
    expect(query).toContain('fileUpload');
    expect(variables).toEqual({
      contentType: 'image/webp',
      filename: 'feedback-screenshot.webp',
      // Three decoded bytes, NOT the 4 characters of base64 that encode them.
      // Linear validates this against what actually arrives on the PUT.
      size: 3,
    });
  });

  it.each([
    ['data:image/png;base64,QUJD', 'image/png', 'feedback-screenshot.png'],
    ['data:image/jpeg;base64,QUJD', 'image/jpeg', 'feedback-screenshot.jpg'],
  ])('derives contentType and extension from %s', async (dataUrl, contentType, filename) => {
    await uploadScreenshot('lin_api_key_raw', dataUrl);
    expect(graphqlBody(0).variables).toMatchObject({ contentType, filename });
  });

  it('PUTs the decoded bytes to the signed uploadUrl', async () => {
    await uploadScreenshot('lin_api_key_raw', THREE_BYTE_WEBP);

    const [url, init] = fetchSpy.mock.calls[1];
    expect(url).toBe(UPLOAD_URL);
    expect((init as RequestInit).method).toBe('PUT');
    const body = (init as RequestInit).body as Buffer;
    // The raw image bytes, not the base64 text and not the whole data URL.
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.toString('utf8')).toBe('ABC');
  });

  it('copies EVERY header the mutation returned onto the PUT, plus the content type', async () => {
    fetchSpy.mockReset();
    fetchSpy
      .mockResolvedValueOnce(
        okFileUpload([
          { key: 'x-amz-signature', value: 'sig-value' },
          { key: 'x-amz-date', value: '20260909T000000Z' },
        ])
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await uploadScreenshot('lin_api_key_raw', THREE_BYTE_WEBP);

    const [, init] = fetchSpy.mock.calls[1];
    // The signature is computed over these headers, so dropping any one of them
    // is a 403 from the storage backend rather than a Linear-side error.
    expect((init as RequestInit).headers).toEqual({
      'Content-Type': 'image/webp',
      'x-amz-signature': 'sig-value',
      'x-amz-date': '20260909T000000Z',
    });
  });

  it('resolves the assetUrl to embed', async () => {
    await expect(uploadScreenshot('lin_api_key_raw', THREE_BYTE_WEBP)).resolves.toBe(ASSET_URL);
  });

  it('throws when the data URL is not a supported base64 image', async () => {
    await expect(uploadScreenshot('k', 'https://example.com/shot.png')).rejects.toThrow(
      /supported base64 image/
    );
  });

  it('throws when the PUT is rejected', async () => {
    fetchSpy.mockReset();
    fetchSpy
      .mockResolvedValueOnce(okFileUpload())
      .mockResolvedValueOnce(new Response('denied', { status: 403 }));

    await expect(uploadScreenshot('k', THREE_BYTE_WEBP)).rejects.toThrow(/upload failed: 403/);
  });

  it('throws when fileUpload does not report success', async () => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { fileUpload: { success: false } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(uploadScreenshot('k', THREE_BYTE_WEBP)).rejects.toThrow(/did not report success/);
  });
});

describe('createFeedbackIssue — screenshot embedding', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    env.LINEAR_API_KEY = 'lin_api_key_raw';
    env.LINEAR_TEAM_ID = 'team-dor-uuid';
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  /** Run a create whose upload succeeds, and return the issue description. */
  async function descriptionWithUpload(
    input: Parameters<typeof createFeedbackIssue>[0]
  ): Promise<string> {
    fetchSpy
      .mockResolvedValueOnce(okFileUpload())
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(okIssueCreate());
    await createFeedbackIssue(input);
    return descriptionOfLastCreate();
  }

  /** Pull the description off whichever call carried the issueCreate mutation. */
  function descriptionOfLastCreate(): string {
    for (const [, init] of [...fetchSpy.mock.calls].reverse()) {
      const raw = (init as RequestInit).body;
      if (typeof raw !== 'string') continue;
      const parsed = JSON.parse(raw) as {
        query?: string;
        variables?: { input?: { description?: string } };
      };
      if (parsed.query?.includes('issueCreate')) return parsed.variables?.input?.description ?? '';
    }
    throw new Error('no issueCreate call was made');
  }

  it('uploads before creating the issue, and embeds the asset as a markdown image', async () => {
    const description = await descriptionWithUpload({
      kind: 'bug',
      message: 'It broke.',
      screenshot: { dataUrl: THREE_BYTE_WEBP },
    });

    expect(description).toContain('**Attachments**');
    expect(description).toContain(`![Screenshot](${ASSET_URL})`);
    // Ordering is the contract: the assetUrl only exists once the upload has
    // resolved, so a create issued first could not carry it.
    expect(fetchSpy.mock.calls).toHaveLength(3);
    expect(fetchSpy.mock.calls[1][0]).toBe(UPLOAD_URL);
  });

  it('creates the Attachments section for a screenshot with no other attachments', async () => {
    const description = await descriptionWithUpload({
      kind: 'bug',
      message: 'It broke.',
      screenshot: { dataUrl: THREE_BYTE_WEBP },
    });

    expect(description).toContain('**Attachments**');
    expect(description.split('**Attachments**')[1].trim()).toBe(`![Screenshot](${ASSET_URL})`);
  });

  it('puts the screenshot FIRST, ahead of any attachment URLs', async () => {
    const description = await descriptionWithUpload({
      kind: 'bug',
      message: 'It broke.',
      screenshot: { dataUrl: THREE_BYTE_WEBP },
      attachmentUrls: ['https://example.com/log.txt'],
    });

    const section = description.split('**Attachments**')[1];
    expect(section.indexOf('![Screenshot]')).toBeLessThan(section.indexOf('https://example.com'));
  });

  it('omits the Attachments section entirely when no screenshot is attached', async () => {
    fetchSpy.mockResolvedValueOnce(okIssueCreate());
    await createFeedbackIssue({ kind: 'bug', message: 'It broke.' });

    // One call only — nothing was uploaded.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(descriptionOfLastCreate()).not.toContain('**Attachments**');
  });

  describe('upload failure degrades without losing the submission', () => {
    /**
     * Each case fails the upload at a different step. All must reach the same
     * outcome: the issue is still created and the description says so honestly.
     */
    const failures: Array<[string, () => void]> = [
      [
        'a GraphQL error from fileUpload',
        () =>
          fetchSpy.mockResolvedValueOnce(
            new Response(
              JSON.stringify({ errors: [{ message: 'Invalid scope: `write` required' }] }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }
            )
          ),
      ],
      [
        'a rejected PUT',
        () =>
          fetchSpy
            .mockResolvedValueOnce(okFileUpload())
            .mockResolvedValueOnce(new Response('no', { status: 403 })),
      ],
      ['a network failure', () => fetchSpy.mockRejectedValueOnce(new Error('socket hang up'))],
    ];

    it.each(failures)('still creates the issue after %s', async (_label, arrange) => {
      arrange();
      fetchSpy.mockResolvedValueOnce(okIssueCreate());

      const result = await createFeedbackIssue({
        kind: 'bug',
        message: 'It broke.',
        screenshot: { dataUrl: THREE_BYTE_WEBP },
      });

      // The submission survives — this is the whole point of the degradation.
      expect(result).toEqual({
        issueId: 'issue-uuid-1',
        issueUrl: 'https://linear.app/dor/issue/DOR-999',
      });
      const description = descriptionOfLastCreate();
      expect(description).toContain('**Attachments**');
      expect(description).toContain('Screenshot: upload failed');
      // No broken image embed pointing at nothing.
      expect(description).not.toContain('![Screenshot]');
    });

    it('records the reason on a single line', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('socket\nhang\nup'));
      fetchSpy.mockResolvedValueOnce(okIssueCreate());

      await createFeedbackIssue({
        kind: 'bug',
        message: 'It broke.',
        screenshot: { dataUrl: THREE_BYTE_WEBP },
      });

      const section = descriptionOfLastCreate().split('**Attachments**')[1].trim();
      expect(section).toBe('Screenshot: upload failed (socket hang up)');
    });

    it('degrades rather than throwing on a malformed data URL', async () => {
      fetchSpy.mockResolvedValueOnce(okIssueCreate());

      const result = await createFeedbackIssue({
        kind: 'bug',
        message: 'It broke.',
        screenshot: { dataUrl: 'data:image/webp;base64,' },
      });

      expect(result).not.toBeNull();
      // Nothing was uploaded: the only call was the issue create itself.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(descriptionOfLastCreate()).toContain('Screenshot: upload failed');
    });
  });
});
