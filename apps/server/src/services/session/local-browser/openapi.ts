/** Human browser controls, using the same request and response schemas as the app. */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  LocalBrowserCapabilitiesSchema,
  LocalBrowserHandoffAnswerSchema,
  LocalBrowserOpenSchema,
  LocalBrowserPersonStateSchema,
  LocalBrowserProfileBindSchema,
  LocalBrowserProfileCreateSchema,
  LocalBrowserProfileSchema,
  LocalBrowserSignInRequestSchema,
  LocalBrowserStateSchema,
} from '@dorkos/shared/local-browser';
import { StepUpRequiredBodySchema } from '@dorkos/shared/step-up';

const errorSchema = z.object({ error: z.string(), code: z.string() });
const authority = 'Only the owner on this computer can call this route. ';

/** Describe the shared browser refusal payload. */
function refusal(description: string) {
  return { description, content: { 'application/json': { schema: errorSchema } } };
}

const stateResponses = {
  200: {
    description: 'Current browser state',
    content: { 'application/json': { schema: LocalBrowserStateSchema } },
  },
  403: refusal('The caller is not the owner on this computer'),
  409: refusal('The browser cannot complete this request in its current state'),
  500: refusal('The browser operation failed'),
};

const personStateResponses = {
  ...stateResponses,
  200: {
    description: 'Current browser state, with its handoff and sign-in',
    content: { 'application/json': { schema: LocalBrowserPersonStateSchema } },
  },
};
const inPerson =
  'Only the owner, in person, can call this route: no agent, API key or approval token. ';

/** Register the plain sign-in window and the handoff answers. */
function registerHandoverOpenApi(registry: OpenAPIRegistry): void {
  const answer = {
    body: {
      required: true,
      content: { 'application/json': { schema: LocalBrowserHandoffAnswerSchema } },
    },
  };
  registry.registerPath({
    method: 'post',
    path: '/api/local-browser/sign-in',
    tags: ['Local browser'],
    summary: 'Open the plain sign-in window',
    description:
      authority +
      inPerson +
      'Opens DorkOS’s Chromium on a profile with no debugging channel, so no agent can see or use it. ' +
      'Takes a page the person typed, or a handoff, which opens the agent page’s own origin. ' +
      'Accepts https, or http on this computer only. Password saving is off in that window.',
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: LocalBrowserSignInRequestSchema } },
      },
    },
    responses: { ...personStateResponses, 400: refusal('The request is invalid') },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/local-browser/handoff/hand-back',
    tags: ['Local browser'],
    summary: 'Hand the browser back to the agent',
    description:
      authority +
      inPerson +
      'Ends the handoff and resumes the agent’s browser, reopening its window if a sign-in closed it.',
    request: answer,
    responses: { ...personStateResponses, 400: refusal('The request is invalid') },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/local-browser/handoff/stop',
    tags: ['Local browser'],
    summary: 'Stop the task that asked for a person',
    description:
      authority +
      inPerson +
      'Ends the handoff and keeps the browser paused. The app stops the chat itself.',
    request: answer,
    responses: { ...personStateResponses, 400: refusal('The request is invalid') },
  });
}

/** Register the local browser setup and human controls. */
export function registerLocalBrowserOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/local-browser/capabilities',
    tags: ['Local browser'],
    summary: 'Read available browser modes',
    description: authority + 'Reports the two owned browser modes, managed versions and defaults.',
    responses: {
      200: {
        description: 'Browser modes available on this computer',
        content: { 'application/json': { schema: LocalBrowserCapabilitiesSchema } },
      },
      403: stateResponses[403],
      500: stateResponses[500],
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/local-browser/state',
    tags: ['Local browser'],
    summary: 'Read the browser connection',
    description:
      authority +
      'Includes preparation, selected tab, sharing chat, Pause state, any handoff and the latest sign-in.',
    responses: personStateResponses,
  });
  registry.registerPath({
    method: 'post',
    path: '/api/local-browser/open',
    tags: ['Local browser'],
    summary: 'Open a browser',
    description:
      authority +
      'Choose the embedded DorkOS browser or a separate visible browser window. ' +
      'A sessionId shares the chosen page with that chat; leaving it out keeps human controls only.',
    request: {
      body: { required: true, content: { 'application/json': { schema: LocalBrowserOpenSchema } } },
    },
    responses: { ...personStateResponses, 400: refusal('The browser choice is invalid') },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/local-browser/tabs/{id}/select',
    tags: ['Local browser'],
    summary: 'Choose the tab shared with the agent',
    description: authority + 'Invalidates earlier observations before sharing the selected tab.',
    request: { params: z.object({ id: z.string() }) },
    responses: stateResponses,
  });
  registry.registerPath({
    method: 'post',
    path: '/api/local-browser/navigate',
    tags: ['Local browser'],
    summary: 'Open a web address in the selected tab',
    description:
      authority + 'Accepts HTTP or HTTPS addresses and invalidates earlier observations.',
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: z.object({ url: z.string().url() }).strict() } },
      },
    },
    responses: { ...stateResponses, 400: refusal('The web address is invalid') },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/local-browser/pause',
    tags: ['Local browser'],
    summary: 'Pause agent browser actions',
    description:
      authority +
      'Immediately refuses new and queued agent actions. An action already sent may still finish. ' +
      'Human browser controls remain available.',
    responses: stateResponses,
  });
  registry.registerPath({
    method: 'post',
    path: '/api/local-browser/resume',
    tags: ['Local browser'],
    summary: 'Resume agent browser actions',
    description:
      authority +
      'The agent must read a fresh observation before its next action. During a handoff this hands the browser back.',
    responses: personStateResponses,
  });
  const profileResponse = {
    description: 'The browser profile',
    content: { 'application/json': { schema: LocalBrowserProfileSchema } },
  };
  const profileRefusals = {
    403: stateResponses[403],
    404: refusal('The browser profile or agent no longer exists'),
    500: stateResponses[500],
  };
  registry.registerPath({
    method: 'get',
    path: '/api/local-browser/profiles',
    tags: ['Local browser'],
    summary: 'List named browser profiles',
    description: authority + 'Lists each profile and the agents a person let use it.',
    responses: {
      200: {
        description: 'The named profiles',
        content: {
          'application/json': {
            schema: z.object({ profiles: z.array(LocalBrowserProfileSchema) }),
          },
        },
      },
      403: stateResponses[403],
      500: stateResponses[500],
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/local-browser/profiles',
    tags: ['Local browser'],
    summary: 'Create a named browser profile',
    description: authority + 'A new profile has no agents and no sign-ins.',
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: LocalBrowserProfileCreateSchema } },
      },
    },
    responses: {
      201: profileResponse,
      400: refusal('The name is invalid'),
      403: stateResponses[403],
      500: stateResponses[500],
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/local-browser/profiles/{id}/agents',
    tags: ['Local browser'],
    summary: 'Let an agent use a browser profile',
    description:
      authority + 'Nothing changes until the person confirms it’s them through the step-up routes.',
    request: {
      params: z.object({ id: z.string() }),
      body: {
        required: true,
        content: { 'application/json': { schema: LocalBrowserProfileBindSchema } },
      },
    },
    responses: {
      428: {
        description: 'Held until the person confirms it’s them',
        content: { 'application/json': { schema: StepUpRequiredBodySchema } },
      },
      400: refusal('The request is invalid'),
      ...profileRefusals,
    },
  });
  registry.registerPath({
    method: 'delete',
    path: '/api/local-browser/profiles/{id}/agents/{agentId}',
    tags: ['Local browser'],
    summary: 'Stop an agent using a browser profile',
    description: authority + 'The agent’s next browser call is refused.',
    request: { params: z.object({ id: z.string(), agentId: z.string() }) },
    responses: { 200: profileResponse, ...profileRefusals },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/local-browser/disconnect',
    tags: ['Local browser'],
    summary: 'Disconnect the browser',
    description:
      authority +
      'Stops sharing immediately. Closes DorkOS-owned pages and windows, keeping their saved sign-ins. ' +
      'A pending close blocks new opens.',
    responses: stateResponses,
  });
  registerHandoverOpenApi(registry);
}
