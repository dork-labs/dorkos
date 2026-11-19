/** Human browser controls, using the same request and response schemas as the app. */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  LocalBrowserCapabilitiesSchema,
  LocalBrowserHandoffAnswerSchema,
  LocalBrowserHistoryDirectionSchema,
  LocalBrowserOpenSchema,
  LocalBrowserPersonStateSchema,
  LocalBrowserProfileBindSchema,
  LocalBrowserProfileSchema,
  LocalBrowserSignInDoneSchema,
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
      'Opens installed Chrome, or managed Chromium, without a debugging channel on the chosen profile. ' +
      'An embedded handoff keeps its native view detached; a separate window uses the handoff’s saved page. ' +
      'Otherwise takes a page the person typed. ' +
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
    path: '/api/local-browser/sign-in/done',
    tags: ['Local browser'],
    summary: 'Finish the open sign-in window',
    description:
      authority +
      inPerson +
      'Quits the sign-in window DorkOS opened, so its sign-in saves. Names the handoff it ' +
      'answers, or none for a window no handoff waits on. Answers at once; the state says when ' +
      'it saved or failed, and a saved one is handed back to the handoff named.',
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: LocalBrowserSignInDoneSchema } },
      },
    },
    responses: {
      202: {
        description: 'The window was asked to quit',
        content: { 'application/json': { schema: z.object({ accepted: z.literal(true) }) } },
      },
      400: refusal('The request is invalid'),
      403: refusal('The caller is not the owner on this computer'),
      409: refusal('No sign-in window of this handoff can be finished'),
      500: refusal('The browser operation failed'),
    },
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
      'Ends the handoff and keeps the browser paused. That chat can’t read or use the browser ' +
      'until a person opens or resumes it again. The app stops the chat itself.',
    request: answer,
    responses: { ...personStateResponses, 400: refusal('The request is invalid') },
  });
}

/** Register the local browser setup and human controls. */
export function registerLocalBrowserOpenApi(registry: OpenAPIRegistry): void {
  for (const operation of ['forget-sign-ins', 'delete'] as const) {
    const deleting = operation === 'delete';
    registry.registerPath({
      method: deleting ? 'delete' : 'post',
      path: `/api/local-browser/profiles/{id}${deleting ? '' : '/forget-sign-ins'}`,
      tags: ['Local browser'],
      summary: deleting ? 'Delete a browser profile' : 'Forget every site in a browser profile',
      description:
        inPerson +
        'Refused while a window, sign-in, handoff or unfinished close holds the profile. ' +
        (deleting
          ? 'Removes the whole profile folder and all its agent bindings before dropping its record.'
          : 'Removes all cookies and site storage. The profile and its agent bindings remain. ' +
            'The default profile also clears the embedded browser and older CLI state and source profile.') +
        ' This can’t be undone.',
      request: {
        params: z.object({
          id: deleting ? z.string().uuid() : z.union([z.literal('default'), z.string().uuid()]),
        }),
      },
      responses: {
        200: {
          description: 'Removed and recorded in Activity',
          content: { 'application/json': { schema: z.object({ success: z.literal(true) }) } },
        },
        400: refusal('The profile id is invalid'),
        403: refusal('The caller is not the owner in person on this computer'),
        404: refusal('The browser profile no longer exists'),
        409: refusal('A writer still holds the profile, or removal was incomplete'),
        500: refusal('The profile data could not be removed'),
      },
    });
  }
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
    description:
      authority +
      inPerson +
      'Invalidates earlier observations before sharing the selected tab. ' +
      'During a handoff, only the tab already selected can be chosen.',
    request: { params: z.object({ id: z.string() }) },
    responses: stateResponses,
  });
  registry.registerPath({
    method: 'post',
    path: '/api/local-browser/navigate',
    tags: ['Local browser'],
    summary: 'Open a web address in the selected tab',
    description:
      authority +
      inPerson +
      'Accepts HTTP or HTTPS addresses and invalidates earlier observations. Refused during a handoff. ' +
      'Takes the page from a chat sharing it first, as take-over does. ' +
      'A bare host may ask for one HTTP fallback when the HTTPS page cannot connect; a timeout never falls back.',
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z
              .object({
                url: z.string().url(),
                httpFallback: z
                  .boolean()
                  .optional()
                  .describe('Ask for one HTTP fallback for a bare host.'),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      ...personStateResponses,
      400: refusal('The web address or HTTP fallback choice is invalid'),
      409: refusal(
        'The browser cannot complete the navigation (`navigation_timed_out`, `navigation_unreachable`, or `navigation_uncertain`)'
      ),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/local-browser/take-over',
    tags: ['Local browser'],
    summary: 'Take the page from the agent',
    description:
      authority +
      inPerson +
      'Pauses the chat sharing the page and refuses its every browser call, reads included, ' +
      'until a person resumes, opens or disconnects the browser. Does nothing when no chat shares it ' +
      'or during a handoff.',
    responses: personStateResponses,
  });
  registry.registerPath({
    method: 'post',
    path: '/api/local-browser/history',
    tags: ['Local browser'],
    summary: 'Move the selected tab back or forward through its own history',
    description:
      authority +
      inPerson +
      'Goes to the nearest page that way the address rules still allow, skipping refused ones. ' +
      'Every load on the way, a redirect included, runs the same rules; a refused one leaves the ' +
      'person on the page they were on (`history_refused`). Takes the page from a chat sharing it ' +
      'first, as take-over does, so that agent stays shut out even when the step is refused. ' +
      'Refused during a handoff.',
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({ direction: LocalBrowserHistoryDirectionSchema }).strict(),
          },
        },
      },
    },
    responses: { ...personStateResponses, 400: refusal('The direction is not back or forward') },
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
      'The agent must read a fresh observation before its next action. During a handoff this hands the browser back, ' +
      'and after a take-over it gives the page back to the agent.',
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
    summary: 'Create a named browser profile (refused)',
    description:
      'Named profiles are cut for launch: the app can’t show one, so this always refuses with `profiles_closed`. Listing and deleting existing profiles still work.',
    responses: {
      403: refusal('New browser profiles aren’t available'),
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
      inPerson +
      'Stops sharing immediately. Closes DorkOS-owned pages and windows, keeping their saved sign-ins. ' +
      'A pending close blocks new opens. During a handoff it ends the agent’s task, as Stop task does.',
    responses: personStateResponses,
  });
  registerHandoverOpenApi(registry);
}
