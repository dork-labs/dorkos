/**
 * The runtime connect routes a caller away from this computer is refused, with
 * the request each sends and the service it must never reach
 * (`runtimes-connect.test.ts`).
 */

/** One route: its request, the service it must never reach, and whether it carries a key. */
export interface LocalOnlyRoute {
  name: string;
  method: 'get' | 'post';
  path: string;
  body?: Record<string, unknown>;
  /** The mocked service that must never run, by name. */
  action?: string;
  /** Whether the request body carries a secret that must not be echoed. */
  carriesSecret?: boolean;
}

/**
 * Every local-only runtime connect route.
 *
 * @param secret - The key the requests carry.
 */
export function localOnlyRoutes(secret: string): LocalOnlyRoute[] {
  return [
    {
      name: 'POST /:type/credential',
      method: 'post',
      path: '/api/runtimes/claude-code/credential',
      body: { secret: secret },
      action: 'storeRuntimeCredential',
      carriesSecret: true,
    },
    {
      name: 'POST /opencode/provider/credential',
      method: 'post',
      path: '/api/runtimes/opencode/provider/credential',
      body: { providerId: 'anthropic', secret: secret },
      action: 'storeProviderCredential',
      carriesSecret: true,
    },
    {
      name: 'GET /opencode/provider',
      method: 'get',
      path: '/api/runtimes/opencode/provider',
      action: 'readOpenCodeDirectSetup',
    },
    {
      name: 'POST /opencode/provider/credential/check',
      method: 'post',
      path: '/api/runtimes/opencode/provider/credential/check',
      body: { providerId: 'openai', secret: secret },
      action: 'checkProviderCredential',
      carriesSecret: true,
    },
    {
      name: 'GET /:type/credential',
      method: 'get',
      path: '/api/runtimes/claude-code/credential',
      action: 'readRuntimeKeyStatus',
    },
    {
      name: 'POST /:type/credential/check',
      method: 'post',
      path: '/api/runtimes/claude-code/credential/check',
      body: { secret: secret },
      action: 'checkRuntimeCredential',
      carriesSecret: true,
    },
    {
      name: 'POST /codex/login',
      method: 'post',
      path: '/api/runtimes/codex/login',
      body: {},
      action: 'delegateRuntimeLogin',
    },
    {
      name: 'POST /opencode/openrouter/key',
      method: 'post',
      path: '/api/runtimes/opencode/openrouter/key',
      body: { key: secret },
      action: 'storeOpenRouterKeyReference',
      carriesSecret: true,
    },
    {
      name: 'POST /opencode/openrouter/oauth/start',
      method: 'post',
      path: '/api/runtimes/opencode/openrouter/oauth/start',
      body: {},
    },
    {
      name: 'GET /opencode/ollama',
      method: 'get',
      path: '/api/runtimes/opencode/ollama',
      action: 'detectOllama',
    },
    {
      name: 'GET /opencode/ollama/models',
      method: 'get',
      path: '/api/runtimes/opencode/ollama/models',
    },
    {
      name: 'POST /opencode/ollama/pull',
      method: 'post',
      path: '/api/runtimes/opencode/ollama/pull',
      body: { model: 'qwen2.5-coder:7b' },
      action: 'pullOllamaModel',
    },
  ];
}
