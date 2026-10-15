/** Human browser controls, using the same request and response schemas as the app. */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  LocalBrowserCapabilitiesSchema,
  LocalBrowserOpenSchema,
  LocalBrowserStateSchema,
} from '@dorkos/shared/local-browser';

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
    description: authority + 'Includes preparation, selected tab, sharing chat and Pause state.',
    responses: stateResponses,
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
    responses: { ...stateResponses, 400: refusal('The browser choice is invalid') },
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
    description: authority + 'The agent must read a fresh observation before its next action.',
    responses: stateResponses,
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
}
