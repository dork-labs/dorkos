import { describe, expect, it, vi } from 'vitest';
import { CommunityLiveGateError } from '../../scripts/community-deploy-live-capture.js';
import {
  createLauncherPromptResponder,
  requireTigrisTermsAccepted,
} from '../../scripts/community-deploy-live-launcher.js';

const APP = 'dorkos-gate-0123456789ab';
const TERMS_PROMPT =
  'Fly requires separate Tigris terms acceptance. Accept them in Fly, then type accept: ';

describe('requireTigrisTermsAccepted', () => {
  it('refuses at step tigris-terms when the account has not accepted them', async () => {
    const refusal = requireTigrisTermsAccepted(() => Promise.resolve(false));
    await expect(refusal).rejects.toBeInstanceOf(CommunityLiveGateError);
    await expect(refusal).rejects.toMatchObject({ step: 'tigris-terms', recoveryCommand: null });
  });

  it('lets the run continue once they have', async () => {
    const read = vi.fn(() => Promise.resolve(true));
    await expect(requireTigrisTermsAccepted(read)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledOnce();
  });
});

describe('createLauncherPromptResponder', () => {
  it('refuses, and never answers, when the launcher asks for Tigris terms', () => {
    const respond = createLauncherPromptResponder(APP);
    const actions = respond(`creating bucket\n${TERMS_PROMPT}`);
    expect(actions).toEqual([{ type: 'refuse', step: 'tigris-terms' }]);
    expect(actions).not.toContainEqual(expect.objectContaining({ text: 'accept\r' }));
  });

  it('answers each prompt once, however long it stays in the rolling transcript', () => {
    const respond = createLauncherPromptResponder(APP);
    const consent = `Type ${APP} to create these resources: `;
    expect(respond(consent)).toEqual([{ type: 'write', text: `${APP}\r` }]);
    // The echo and later output arrive while the prompt is still inside the window. A second
    // answer would sit in the launcher's input and be read as the answer to its next question.
    expect(respond(`${consent}${APP}\r\nChecking providers`)).toEqual([]);
    const copyTest = `${consent}${APP}\r\nType COPY TEST to replace your current clipboard: `;
    expect(respond(copyTest)).toEqual([{ type: 'write', text: 'COPY TEST\r' }]);
    expect(respond(`${copyTest}COPY TEST\r\n`)).toEqual([]);
  });

  it('answers the owner handoff prompts in order', () => {
    const respond = createLauncherPromptResponder(APP);
    expect(respond('Type copy: ')).toEqual([{ type: 'write', text: 'copy\r' }]);
    expect(respond('Type copy: copy\r\nFinish owner setup at https://x')).toEqual([]);
    expect(
      respond('Type copy: copy\r\nFinish owner setup at https://x, then press Enter to verify it.')
    ).toEqual([{ type: 'owner-pending' }]);
    expect(respond('Type complete when both work: ')).toEqual([
      { type: 'write', text: 'complete\r' },
    ]);
  });

  it('keeps a separate record for each launcher process', () => {
    const first = createLauncherPromptResponder(APP);
    const resumed = createLauncherPromptResponder(APP);
    expect(first('Type copy: ')).toHaveLength(1);
    expect(resumed('Type copy: ')).toEqual([{ type: 'write', text: 'copy\r' }]);
  });
});
