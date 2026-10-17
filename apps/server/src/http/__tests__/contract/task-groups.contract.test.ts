/**
 * Contract for the scheduled-task and runtime route groups, which move to Hono
 * together in DOR-2802: scheduled tasks (`/api/tasks`), the runtime connect
 * and provisioning routes (`/api/runtimes`), the Claude account rules mounted
 * inside them (`/api/runtimes/claude-code/{account-eligibility,
 * project-accounts,accounts/:id/only-projects}`), and the DorkOS model setup
 * (`/api/runtimes/doe`). That PR must pass this file unchanged.
 *
 * Four servers:
 *
 * 1. Login off, nothing seeded: shapes, validation answers, 404s, HEAD,
 *    trailing slashes, and the refusals a caller earns with headers alone (an
 *    agent header it never minted, an approval token).
 * 2. Login off, driven by hand: a schedule created, proposed by an agent,
 *    clamped, approved, run, cancelled and deleted; the account rules written
 *    and read back; the DorkOS model setup saved and read back; the Ollama
 *    pull stream's status, headers and frames.
 * 3. Login off, reached at a trusted host name that is not this computer: the
 *    loopback-only routes refuse it.
 * 4. Login on: an API key is not a person, so it may not arm a schedule, change
 *    the DorkOS model setup or an account rule; the owner's cookie may.
 *
 * Everything this file writes goes under the server's throwaway data
 * directory, except one empty git repository under the git-ignored `.temp/`
 * at the repository root, which the account rules name as a project.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TaskRunSchema, TaskSchema, TaskTemplateSchema } from '@dorkos/shared/schemas';
import { AccountEligibilityResponseSchema } from '@dorkos/shared/project-schemas';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  checkContractCase,
  contractSuite,
  SERVER_ORIGIN,
  type ComposedServer,
  type ContractCase,
  signInAt,
} from './harness.js';

/** The repository root: the composed server's directory boundary. */
const REPO_ROOT = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..')
);
/**
 * A git repository of its own under the git-ignored `.temp/`, so it is a
 * project inside the boundary even when this checkout is a worktree whose
 * repository lives outside it.
 */
const PROJECT = path.join(REPO_ROOT, '.temp', `contract-tasks-${randomUUID().slice(0, 8)}`);
mkdirSync(PROJECT, { recursive: true });
execFileSync('git', ['init', '--quiet'], { cwd: PROJECT });
afterAll(() => rmSync(PROJECT, { recursive: true, force: true }));

/**
 * Where the servers here look for Ollama when no case needs one: a loopback
 * port nothing listens on, so no answer depends on whether this machine runs
 * Ollama.
 */
const NO_OLLAMA = { DORKOS_OLLAMA_URL: 'http://127.0.0.1:9' };

/**
 * A stand-in for Ollama's pull endpoint: two progress lines, then the error
 * Ollama gives for a model it cannot find.
 */
async function startOllamaStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const stub: Server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/pull') {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write('{"status":"pulling manifest"}\n');
    res.write('{"status":"downloading","completed":1,"total":2}\n');
    res.end('{"error":"pull model manifest: file does not exist"}\n');
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => stub.close(() => resolve())),
  };
}

const JSON_TYPE = { 'content-type': /^application\/json\b/ };
const NOT_FOUND = { error: 'Not found', code: 'API_NOT_FOUND' };
const TASK_NOT_FOUND = { error: 'Scheduled task not found' };
const RUN_NOT_FOUND = { error: 'Run not found' };
/** An agent header this machine never minted: the caller is a machine, unverified. */
const AGENT = { 'X-DorkOS-Agent': 'not-a-real-token' };
/** A caller holding an approval token is the requester, never the person. */
const REQUESTER = { 'X-DorkOS-Approval': 'not-a-real-approval' };
const UNKNOWN_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const VALIDATION_FAILED = z.object({ error: z.literal('Validation failed') }).loose();
const MALFORMED_JSON = z.object({ code: z.literal('INTERNAL_ERROR') }).loose();
const TASK = TaskSchema.loose();
const TASK_LIST = z.array(TASK);
const OPERATOR_ONLY_TASK = (fields: string[]) =>
  z
    .object({
      error: z.literal('Only a person can decide how a scheduled task runs'),
      code: z.literal('operator_only_task_field'),
      fields: z.array(z.string()).refine((have) => have.join() === fields.join()),
      message: z.string(),
    })
    .strict();
const ACCOUNT_RULES_AGENT = {
  error: 'Only a person can change where an account may be used.',
  code: 'operator_only_config',
  message:
    'DorkOS changed nothing. Which projects a Claude account may work in is a decision ' +
    'only a person makes. Ask them to change it in Settings → Runtimes.',
};
const CONNECT_LOCAL_ONLY = { error: 'Runtime connect actions are only available locally' };
const PROVISION_LOCAL_ONLY = { error: 'Runtime provisioning is only available locally' };
const DOE_LOCAL_ONLY = { error: 'Model setup is only available on this computer.' };
const DOE_NOT_A_PERSON = {
  error: 'Only the owner can change model settings.',
  code: 'not-a-person',
};
const EVENT_STREAM = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  'x-accel-buffering': 'no',
};
/** A local model setup the schema accepts, naming no key. */
const LOCAL_INFERENCE = {
  source: 'local',
  provider: 'ollama',
  protocol: 'openai-chat-completions',
  endpoint: 'http://127.0.0.1:11434/v1',
  model: 'contract-model',
  contextWindow: 8192,
  maxOutputTokens: 1024,
};
/** A schedule a person may create, under a fresh name. */
function scheduleBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `contract-${randomUUID().slice(0, 8)}`,
    description: 'Made by the contract',
    prompt: 'Say hello.',
    cron: '0 3 * * *',
    target: 'global',
    ...extra,
  };
}

contractSuite(
  'task and runtime groups',
  [
    // tasks: reads
    {
      name: 'GET /api/tasks lists the schedules',
      path: '/api/tasks',
      expect: { status: 200, headers: JSON_TYPE, schema: TASK_LIST },
    },
    {
      name: 'GET /api/tasks/ answers with a trailing slash',
      path: '/api/tasks/',
      expect: { status: 200, headers: JSON_TYPE, schema: TASK_LIST },
    },
    {
      name: 'HEAD /api/tasks answers the GET’s status with no body',
      method: 'HEAD',
      path: '/api/tasks',
      expect: { status: 200, headers: JSON_TYPE, body: '' },
    },
    {
      name: 'GET /api/tasks/templates lists the templates',
      path: '/api/tasks/templates',
      expect: { status: 200, schema: z.array(TaskTemplateSchema.loose()) },
    },
    {
      name: 'GET /api/tasks/runs lists no runs',
      path: '/api/tasks/runs',
      expect: { status: 200, headers: JSON_TYPE, schema: z.array(TaskRunSchema.loose()) },
    },
    {
      name: 'GET /api/tasks/runs refuses a limit that is not a number',
      path: '/api/tasks/runs?limit=lots',
      expect: { status: 400, schema: VALIDATION_FAILED },
    },
    {
      name: 'GET /api/tasks/runs/:id answers 404 for an unknown run',
      path: `/api/tasks/runs/${UNKNOWN_ID}`,
      expect: { status: 404, headers: JSON_TYPE, body: RUN_NOT_FOUND },
    },
    {
      name: 'HEAD /api/tasks/runs/:id answers 404 with no body',
      method: 'HEAD',
      path: `/api/tasks/runs/${UNKNOWN_ID}`,
      expect: { status: 404, body: '' },
    },
    {
      name: 'GET /api/tasks/:id is the /api 404 (there is no single-task read)',
      path: `/api/tasks/${UNKNOWN_ID}`,
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'GET /api/tasks/runs/:id/cancel is the /api 404',
      path: `/api/tasks/runs/${UNKNOWN_ID}/cancel`,
      expect: { status: 404, body: NOT_FOUND },
    },

    // tasks: writes refused
    {
      name: 'POST /api/tasks refuses an empty body',
      method: 'POST',
      path: '/api/tasks',
      expect: { status: 400, schema: VALIDATION_FAILED },
    },
    {
      name: 'POST /api/tasks refuses a schedule croner cannot read',
      method: 'POST',
      path: '/api/tasks',
      body: scheduleBody({ cron: 'every so often' }),
      expect: { status: 400, schema: z.object({ error: z.string() }).strict() },
    },
    {
      name: 'POST /api/tasks refuses an agent naming its own permission level',
      method: 'POST',
      path: '/api/tasks',
      headers: AGENT,
      body: scheduleBody({ permissionMode: 'bypassPermissions', reason: 'Because' }),
      expect: { status: 403, schema: OPERATOR_ONLY_TASK(['permissionMode']) },
    },
    {
      name: 'POST /api/tasks refuses an agent proposal with no reason',
      method: 'POST',
      path: '/api/tasks',
      headers: AGENT,
      body: scheduleBody(),
      expect: { status: 400, schema: z.object({ error: z.string().includes('needs a reason') }) },
    },
    {
      name: 'POST /api/tasks refuses an approval-token holder naming the status',
      method: 'POST',
      path: '/api/tasks',
      headers: REQUESTER,
      body: scheduleBody({ status: 'active', reason: 'Because' }),
      expect: { status: 403, schema: OPERATOR_ONLY_TASK(['status']) },
    },
    {
      name: 'POST /api/tasks refuses an agent naming DorkOS credits',
      method: 'POST',
      path: '/api/tasks',
      headers: AGENT,
      body: scheduleBody({ account: 'dorkos-credits', reason: 'Because' }),
      expect: { status: 403, schema: z.object({ code: z.string() }).loose() },
    },
    {
      name: 'POST /api/tasks refuses malformed JSON as the chain does',
      method: 'POST',
      path: '/api/tasks',
      headers: { 'content-type': 'application/json' },
      body: '{"name":',
      expect: { status: 500, schema: MALFORMED_JSON },
    },
    {
      name: 'PATCH /api/tasks/:id answers 404 for an unknown schedule',
      method: 'PATCH',
      path: `/api/tasks/${UNKNOWN_ID}`,
      body: { prompt: 'Changed.' },
      expect: { status: 404, body: TASK_NOT_FOUND },
    },
    {
      name: 'PATCH /api/tasks/:id refuses a field it does not know before the 404',
      method: 'PATCH',
      path: `/api/tasks/${UNKNOWN_ID}`,
      body: { agentId: 'someone-else' },
      expect: { status: 400, schema: z.object({ fields: z.array(z.string()) }).loose() },
    },
    {
      name: 'PATCH /api/tasks/:id refuses an agent setting the status before the 404',
      method: 'PATCH',
      path: `/api/tasks/${UNKNOWN_ID}`,
      headers: AGENT,
      body: { status: 'active' },
      expect: { status: 403, schema: OPERATOR_ONLY_TASK(['status']) },
    },
    {
      name: 'DELETE /api/tasks/:id answers 404 for an unknown schedule',
      method: 'DELETE',
      path: `/api/tasks/${UNKNOWN_ID}`,
      expect: { status: 404, body: TASK_NOT_FOUND },
    },
    {
      name: 'POST /api/tasks/:id/trigger refuses an agent outright',
      method: 'POST',
      path: `/api/tasks/${UNKNOWN_ID}/trigger`,
      headers: AGENT,
      expect: { status: 403, schema: OPERATOR_ONLY_TASK([]) },
    },
    {
      name: 'POST /api/tasks/:id/trigger answers 404 for an unknown schedule',
      method: 'POST',
      path: `/api/tasks/${UNKNOWN_ID}/trigger`,
      expect: { status: 404, body: TASK_NOT_FOUND },
    },
    {
      name: 'POST /api/tasks/runs/:id/cancel answers 404 for an unknown run',
      method: 'POST',
      path: `/api/tasks/runs/${UNKNOWN_ID}/cancel`,
      expect: { status: 404, body: RUN_NOT_FOUND },
    },
    {
      name: 'GET /api/tasks refuses a foreign Host',
      path: '/api/tasks',
      headers: { host: 'evil.example.com' },
      expect: { status: 403, schema: z.object({ error: z.string() }).loose() },
    },
    {
      name: 'GET /api/tasks answers a same-origin browser with its CORS headers',
      path: '/api/tasks',
      headers: { origin: SERVER_ORIGIN },
      expect: {
        status: 200,
        headers: {
          'access-control-allow-origin': SERVER_ORIGIN,
          'access-control-allow-credentials': 'true',
          vary: /Origin/,
        },
      },
    },

    // runtimes: reads
    {
      name: 'GET /api/runtimes is the /api 404',
      path: '/api/runtimes',
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'GET /api/runtimes/nothing is the /api 404',
      path: '/api/runtimes/nothing',
      expect: { status: 404, body: NOT_FOUND },
    },
    {
      name: 'GET /api/runtimes/:runtime/accounts/usage refuses a runtime with no ledger',
      path: '/api/runtimes/not-a-runtime/accounts/usage',
      expect: { status: 400, body: { error: 'Unknown runtime "not-a-runtime".' } },
    },
    {
      name: 'GET /api/runtimes/claude-code/accounts/usage lists the accounts',
      path: '/api/runtimes/claude-code/accounts/usage',
      expect: {
        status: 200,
        headers: JSON_TYPE,
        schema: z.object({ accounts: z.array(z.object({}).loose()) }).strict(),
      },
    },
    {
      name: 'GET /api/runtimes/claude-code/accounts/usage/ answers with a trailing slash',
      path: '/api/runtimes/claude-code/accounts/usage/',
      expect: { status: 200, schema: z.object({ accounts: z.array(z.unknown()) }).strict() },
    },
    {
      name: 'HEAD /api/runtimes/claude-code/accounts/usage answers with no body',
      method: 'HEAD',
      path: '/api/runtimes/claude-code/accounts/usage',
      expect: { status: 200, headers: JSON_TYPE, body: '' },
    },
    {
      name: 'GET /api/runtimes/claude-code/accounts/found lists folders',
      path: '/api/runtimes/claude-code/accounts/found',
      expect: { status: 200, schema: z.object({ folders: z.array(z.unknown()) }).strict() },
    },
    {
      name: 'GET /api/runtimes/claude-code/credential says whether a key is saved',
      path: '/api/runtimes/claude-code/credential',
      expect: { status: 200, headers: JSON_TYPE, schema: z.object({}).loose() },
    },
    {
      name: 'GET /api/runtimes/opencode/provider says what is saved',
      path: '/api/runtimes/opencode/provider',
      expect: { status: 200, headers: JSON_TYPE, schema: z.object({}).loose() },
    },
    {
      name: 'GET /api/runtimes/opencode/ollama/models lists the curated models',
      path: '/api/runtimes/opencode/ollama/models',
      expect: { status: 200, headers: JSON_TYPE },
    },
    {
      name: 'GET /api/runtimes/opencode/openrouter/oauth/status answers for an unknown state',
      path: '/api/runtimes/opencode/openrouter/oauth/status?state=nobody',
      expect: { status: 200, headers: JSON_TYPE, schema: z.object({ status: z.string() }).loose() },
    },
    {
      name: 'GET /api/runtimes/opencode/openrouter/oauth/callback answers a page for an unknown state',
      path: '/api/runtimes/opencode/openrouter/oauth/callback?state=nobody&code=nothing',
      expect: {
        status: 400,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        schema: z.string().startsWith('<!doctype html>').includes('Sign-in failed'),
      },
    },

    // runtimes: writes refused
    {
      name: 'POST /api/runtimes/:type/login refuses a runtime with no sign-in',
      method: 'POST',
      path: '/api/runtimes/opencode/login',
      expect: { status: 400, body: { ok: false, error: 'OpenCode does not support sign-in.' } },
    },
    {
      name: 'POST /api/runtimes/:type/login refuses an empty account root',
      method: 'POST',
      path: '/api/runtimes/codex/login',
      body: { accountRoot: '' },
      expect: {
        status: 400,
        body: { ok: false, error: 'accountRoot and sessionId must be non-empty strings.' },
      },
    },
    {
      name: 'POST /api/runtimes/:type/credential refuses an empty key',
      method: 'POST',
      path: '/api/runtimes/claude-code/credential',
      body: { secret: '' },
      expect: { status: 400, body: { error: 'An API key is required.' } },
    },
    {
      name: 'POST /api/runtimes/:type/credential/check refuses a key that is not a string',
      method: 'POST',
      path: '/api/runtimes/claude-code/credential/check',
      body: { secret: 42 },
      expect: { status: 400, body: { error: 'An API key must be a string.' } },
    },
    {
      name: 'POST /api/runtimes/opencode/provider/credential refuses a missing provider',
      method: 'POST',
      path: '/api/runtimes/opencode/provider/credential',
      body: { secret: 'x' },
      expect: { status: 400, body: { error: 'A provider id and API key are required.' } },
    },
    {
      name: 'POST /api/runtimes/opencode/provider/credential/check refuses a missing provider',
      method: 'POST',
      path: '/api/runtimes/opencode/provider/credential/check',
      expect: { status: 400, body: { error: 'A provider id is required.' } },
    },
    {
      name: 'POST /api/runtimes/opencode/openrouter/key refuses an empty key',
      method: 'POST',
      path: '/api/runtimes/opencode/openrouter/key',
      body: {},
      expect: { status: 400, body: { ok: false, error: 'An OpenRouter key is required.' } },
    },
    {
      name: 'POST /api/runtimes/opencode/openrouter/oauth/start names the callback by the forwarded scheme',
      method: 'POST',
      path: '/api/runtimes/opencode/openrouter/oauth/start',
      headers: { 'x-forwarded-proto': 'https' },
      expect: {
        status: 200,
        schema: z
          .object({
            // The port varies; the scheme, the raw Host and the path are what is pinned.
            authorizeUrl: z
              .string()
              .refine((url) =>
                /https:\/\/127\.0\.0\.1:\d+\/api\/runtimes\/opencode\/openrouter\/oauth\/callback\?state=/.test(
                  decodeURIComponent(url)
                )
              ),
            state: z.string().min(1),
          })
          .strict(),
      },
    },
    {
      name: 'POST /api/runtimes/opencode/ollama/pull refuses a malformed model name',
      method: 'POST',
      path: '/api/runtimes/opencode/ollama/pull',
      body: { model: 'not a model!' },
      expect: { status: 400, body: { error: 'That is not a valid Ollama model name.' } },
    },
    {
      name: 'POST /api/runtimes/claude-code/accounts/:id/probe refuses an agent',
      method: 'POST',
      path: '/api/runtimes/claude-code/accounts/default/probe',
      headers: AGENT,
      expect: {
        status: 403,
        body: {
          error:
            'Only a person can start an account check here. Agents use the accounts_probe tool.',
          code: 'PERSON_ONLY',
        },
      },
    },
    {
      name: 'POST /api/runtimes/claude-code/accounts/:id/probe answers 404 for an unknown account',
      method: 'POST',
      path: '/api/runtimes/claude-code/accounts/no-such-account/probe',
      expect: { status: 404, schema: z.object({ error: z.string(), code: z.string() }).strict() },
    },
    {
      name: 'POST /api/runtimes/claude-code/accounts/found/dismiss refuses an agent',
      method: 'POST',
      path: '/api/runtimes/claude-code/accounts/found/dismiss',
      headers: AGENT,
      body: { path: '/nowhere' },
      expect: {
        status: 403,
        schema: z
          .object({
            code: z.string(),
            message: z.literal('Only a person can hide an account folder.'),
          })
          .loose(),
      },
    },
    {
      name: 'POST /api/runtimes/claude-code/accounts/found/dismiss refuses an empty body',
      method: 'POST',
      path: '/api/runtimes/claude-code/accounts/found/dismiss',
      expect: { status: 400, body: { error: 'Send the folder to hide as `path`.' } },
    },
    {
      name: 'POST /api/runtimes/claude-code/accounts/found/dismiss refuses a folder it did not offer',
      method: 'POST',
      path: '/api/runtimes/claude-code/accounts/found/dismiss',
      body: { path: '/nowhere/at/all' },
      expect: {
        status: 400,
        body: { error: 'That folder is not one of the account folders found on this computer.' },
      },
    },

    // account rules
    {
      name: 'GET /api/runtimes/claude-code/account-eligibility answers for no project',
      path: '/api/runtimes/claude-code/account-eligibility',
      expect: {
        status: 200,
        headers: JSON_TYPE,
        schema: AccountEligibilityResponseSchema.extend({ project: z.null(), allow: z.null() }),
      },
    },
    {
      name: 'GET /api/runtimes/claude-code/account-eligibility refuses a folder outside the boundary',
      path: '/api/runtimes/claude-code/account-eligibility?project=%2F',
      expect: {
        status: 403,
        body: {
          error: 'That folder is outside the folders DorkOS may open.',
          code: 'OUTSIDE_BOUNDARY',
        },
      },
    },
    {
      name: 'GET /api/runtimes/claude-code/account-eligibility refuses an empty project',
      path: '/api/runtimes/claude-code/account-eligibility?project=',
      expect: { status: 400, schema: z.object({ error: z.literal('Invalid query') }).loose() },
    },
    {
      name: 'PUT /api/runtimes/claude-code/project-accounts refuses an agent',
      method: 'PUT',
      path: '/api/runtimes/claude-code/project-accounts',
      headers: AGENT,
      body: { project: PROJECT, allow: null },
      expect: { status: 403, body: ACCOUNT_RULES_AGENT },
    },
    {
      name: 'PUT /api/runtimes/claude-code/project-accounts refuses a cross-site browser at the chain',
      method: 'PUT',
      path: '/api/runtimes/claude-code/project-accounts',
      headers: { origin: 'https://evil.example' },
      body: { project: PROJECT, allow: null },
      expect: {
        status: 500,
        body: { error: 'Origin https://evil.example not allowed by CORS', code: 'INTERNAL_ERROR' },
      },
    },
    {
      name: 'PUT /api/runtimes/claude-code/project-accounts refuses an empty body',
      method: 'PUT',
      path: '/api/runtimes/claude-code/project-accounts',
      expect: {
        status: 400,
        schema: z.object({ error: z.string(), details: z.unknown() }).strict(),
      },
    },
    {
      name: 'PUT /api/runtimes/claude-code/project-accounts refuses an account nobody has',
      method: 'PUT',
      path: '/api/runtimes/claude-code/project-accounts',
      body: { project: PROJECT, allow: ['nobody'] },
      expect: {
        status: 400,
        body: { error: 'There is no Claude account named "nobody".', code: 'unknown_account' },
      },
    },
    {
      name: 'PUT /api/runtimes/claude-code/project-accounts refuses a folder outside the boundary',
      method: 'PUT',
      path: '/api/runtimes/claude-code/project-accounts',
      body: { project: '/', allow: null },
      expect: {
        status: 403,
        body: {
          error: 'That folder is outside the folders DorkOS may open.',
          code: 'OUTSIDE_BOUNDARY',
        },
      },
    },
    {
      name: 'PUT /api/runtimes/claude-code/accounts/:id/only-projects answers 404 for an unknown account',
      method: 'PUT',
      path: '/api/runtimes/claude-code/accounts/nobody/only-projects',
      body: { projects: null },
      expect: {
        status: 404,
        body: { error: 'There is no Claude account named "nobody".', code: 'unknown_account' },
      },
    },
    {
      name: 'POST /api/runtimes/claude-code/project-accounts/without-credits refuses an agent',
      method: 'POST',
      path: '/api/runtimes/claude-code/project-accounts/without-credits',
      headers: AGENT,
      body: { sessionId: UNKNOWN_ID },
      expect: { status: 403, body: ACCOUNT_RULES_AGENT },
    },
    {
      name: 'POST /api/runtimes/claude-code/project-accounts/without-credits refuses an empty body',
      method: 'POST',
      path: '/api/runtimes/claude-code/project-accounts/without-credits',
      expect: {
        status: 400,
        schema: z.object({ error: z.literal('Send the session as `sessionId`.') }).loose(),
      },
    },

    // DorkOS model setup
    {
      name: 'GET /api/runtimes/doe/inference answers nothing saved',
      path: '/api/runtimes/doe/inference',
      expect: {
        status: 200,
        headers: JSON_TYPE,
        body: { inference: null, hasKey: false, autoProtocol: null },
      },
    },
    {
      name: 'GET /api/runtimes/doe/credits-models refuses a protocol it does not know',
      path: '/api/runtimes/doe/credits-models?protocol=carrier-pigeon',
      expect: { status: 400, body: { error: 'Choose a model protocol.' } },
    },
    {
      name: 'PUT /api/runtimes/doe/inference refuses an agent',
      method: 'PUT',
      path: '/api/runtimes/doe/inference',
      headers: AGENT,
      body: LOCAL_INFERENCE,
      expect: { status: 403, body: DOE_NOT_A_PERSON },
    },
    {
      name: 'PUT /api/runtimes/doe/inference refuses an approval-token holder',
      method: 'PUT',
      path: '/api/runtimes/doe/inference',
      headers: REQUESTER,
      body: LOCAL_INFERENCE,
      expect: { status: 403, body: DOE_NOT_A_PERSON },
    },
    {
      name: 'POST /api/runtimes/doe/credential refuses an agent',
      method: 'POST',
      path: '/api/runtimes/doe/credential',
      headers: AGENT,
      body: { inference: LOCAL_INFERENCE, secret: 'sk-contract' },
      expect: { status: 403, body: DOE_NOT_A_PERSON },
    },
    {
      name: 'PUT /api/runtimes/doe/inference refuses a body that names a key reference',
      method: 'PUT',
      path: '/api/runtimes/doe/inference',
      body: { ...LOCAL_INFERENCE, credentialRef: 'secret:nothing' },
      expect: { status: 400, body: { error: 'Check the model, endpoint, and token limits.' } },
    },
    {
      name: 'POST /api/runtimes/doe/credential refuses a body with no key',
      method: 'POST',
      path: '/api/runtimes/doe/credential',
      body: { inference: LOCAL_INFERENCE },
      expect: { status: 400, body: { error: 'Enter an API key and model settings.' } },
    },
    {
      name: 'GET /api/runtimes/doe is the /api 404',
      path: '/api/runtimes/doe',
      expect: { status: 404, body: NOT_FOUND },
    },
  ],
  { env: NO_OLLAMA }
);

/** A request against a hand-driven server, with the case fields that vary. */
type Ask = Omit<ContractCase, 'name'>;

/** Send one case to the server this file booted itself. */
async function check(server: ComposedServer | undefined, ask: Ask): Promise<void> {
  await checkContractCase(server!.baseUrl, { name: ask.path, ...ask });
}

/**
 * Send one setup request and return its JSON body and headers, failing loudly
 * when the server refuses it.
 */
async function setup(
  server: ComposedServer | undefined,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ json: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(new URL(url, server!.baseUrl), {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} answered ${res.status}: ${text.slice(0, 300)}`);
  return { json: text ? (JSON.parse(text) as Record<string, unknown>) : {}, headers: res.headers };
}

describe('contract: tasks, account rules and model setup, driven by hand (login off)', () => {
  let server: ComposedServer | undefined;
  let ollama: Awaited<ReturnType<typeof startOllamaStub>> | undefined;
  beforeAll(async () => {
    ollama = await startOllamaStub();
    server = await bootComposedServer({ DORKOS_OLLAMA_URL: ollama.url });
    // The composed server runs on the test-mode runtime, whose never-ask mode
    // id a SKILL.md `schedule:` block cannot hold, so no stop of its own here:
    // schedules take the fallback mode, as they did before Trusted.
    await setup(server, 'PATCH', '/api/config', { runtimes: { defaultTrustStop: null } });
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
    await ollama?.close();
  }, 30_000);

  it('creates a schedule, lists it, edits it, pauses it and deletes it', async () => {
    const body = scheduleBody();
    const created = await setup(server, 'POST', '/api/tasks', body);
    const id = created.json.id as string;
    expect(created.json).toMatchObject({ name: body.name, status: 'active', enabled: true });
    await check(server, {
      method: 'POST',
      path: '/api/tasks',
      body: { ...body },
      expect: { status: 409, schema: z.object({ error: z.string() }).strict() },
    });
    await check(server, {
      path: '/api/tasks',
      expect: { status: 200, schema: TASK_LIST.refine((tasks) => tasks.some((t) => t.id === id)) },
    });
    await check(server, {
      method: 'PATCH',
      path: `/api/tasks/${id}`,
      body: { prompt: 'Say goodbye.' },
      expect: {
        status: 200,
        schema: TASK.extend({ id: z.literal(id), prompt: z.literal('Say goodbye.') }),
      },
    });
    await check(server, {
      method: 'PATCH',
      path: `/api/tasks/${id}`,
      body: { cron: 'whenever' },
      expect: { status: 400, schema: z.object({ error: z.string() }).strict() },
    });
    await check(server, {
      method: 'PATCH',
      path: `/api/tasks/${id}`,
      body: { cron: '0 4 * * *', defaultCron: true },
      expect: { status: 400, schema: z.object({ error: z.string() }).loose() },
    });
    await check(server, {
      method: 'PATCH',
      path: `/api/tasks/${id}`,
      headers: AGENT,
      body: { enabled: false },
      expect: { status: 200, schema: TASK.extend({ enabled: z.literal(false) }) },
    });
    await check(server, {
      method: 'DELETE',
      path: `/api/tasks/${id}`,
      expect: { status: 200, body: { success: true } },
    });
    await check(server, {
      method: 'DELETE',
      path: `/api/tasks/${id}`,
      expect: { status: 404, body: TASK_NOT_FOUND },
    });
  });

  it('parks and clamps an agent’s proposal, and arms it when a person approves', async () => {
    const proposed = await setup(
      server,
      'POST',
      '/api/tasks',
      scheduleBody({ reason: 'The contract asked' }),
      AGENT
    );
    const id = proposed.json.id as string;
    expect(proposed.json).toMatchObject({
      status: 'pending_approval',
      reason: 'The contract asked',
    });
    expect(proposed.json.nextRuns).toHaveLength(3);
    await check(server, {
      method: 'PATCH',
      path: `/api/tasks/${id}`,
      headers: AGENT,
      body: { status: 'active' },
      expect: { status: 403, schema: OPERATOR_ONLY_TASK(['status']) },
    });
    await check(server, {
      method: 'PATCH',
      path: `/api/tasks/${id}/`,
      body: { status: 'active', permissionMode: 'acceptEdits' },
      expect: {
        status: 200,
        schema: TASK.extend({
          status: z.literal('active'),
          permissionMode: z.literal('acceptEdits'),
          nextRuns: z.array(z.string()).length(0),
        }),
      },
    });

    // A person's full-power schedule keeps its level until an agent rewrites the work.
    const full = await setup(
      server,
      'POST',
      '/api/tasks',
      scheduleBody({ permissionMode: 'bypassPermissions' })
    );
    expect(full.json).toMatchObject({ status: 'active', permissionMode: 'bypassPermissions' });
    await check(server, {
      method: 'PATCH',
      path: `/api/tasks/${full.json.id as string}`,
      headers: AGENT,
      body: { prompt: 'Do something else entirely.' },
      expect: {
        status: 200,
        schema: TASK.extend({
          status: z.literal('pending_approval'),
          permissionMode: z.string().refine((mode) => mode !== 'bypassPermissions'),
        }),
      },
    });

    // Rejecting a proposal is deleting it.
    await check(server, {
      method: 'DELETE',
      path: `/api/tasks/${full.json.id as string}`,
      expect: { status: 200, body: { success: true } },
    });
  });

  it('runs a schedule now for a person, and cancels the run', async () => {
    const created = await setup(server, 'POST', '/api/tasks', scheduleBody());
    const id = created.json.id as string;
    await check(server, {
      method: 'POST',
      path: `/api/tasks/${id}/trigger`,
      headers: AGENT,
      expect: { status: 403, schema: OPERATOR_ONLY_TASK([]) },
    });
    const triggered = await setup(server, 'POST', `/api/tasks/${id}/trigger`);
    const runId = triggered.json.runId as string;
    expect(Object.keys(triggered.json)).toEqual(['runId']);
    await check(server, {
      path: `/api/tasks/runs/${runId}`,
      expect: { status: 200, schema: TaskRunSchema.loose().extend({ id: z.literal(runId) }) },
    });
    await check(server, {
      path: `/api/tasks/runs?scheduleId=${id}`,
      expect: {
        status: 200,
        schema: z.array(TaskRunSchema.loose()).refine((runs) => runs.some((r) => r.id === runId)),
      },
    });
    await check(server, {
      method: 'POST',
      path: `/api/tasks/runs/${runId}/cancel`,
      expect: {
        status: 200,
        schema: z
          .object({
            success: z.literal(true),
            state: z.enum(['stopping', 'already_finished']),
          })
          .strict(),
      },
    });
  });

  it('writes a project’s account list and reads it back', async () => {
    await check(server, {
      method: 'PUT',
      path: '/api/runtimes/claude-code/project-accounts',
      body: { project: PROJECT, allow: ['default'] },
      expect: {
        status: 200,
        schema: AccountEligibilityResponseSchema.extend({
          project: z.object({ root: z.string() }).loose(),
          allow: z.array(z.string()).refine((allow) => allow.join() === 'default'),
        }),
      },
    });
    await check(server, {
      path: `/api/runtimes/claude-code/account-eligibility?project=${encodeURIComponent(PROJECT)}`,
      expect: {
        status: 200,
        schema: AccountEligibilityResponseSchema.extend({
          allow: z.array(z.string()).refine((allow) => allow.join() === 'default'),
          launch: z.object({ ok: z.boolean() }).loose(),
        }),
      },
    });
    await check(server, {
      method: 'PUT',
      path: '/api/runtimes/claude-code/project-accounts',
      body: { project: PROJECT, allow: null },
      expect: { status: 200, schema: AccountEligibilityResponseSchema.extend({ allow: z.null() }) },
    });
    await check(server, {
      method: 'PUT',
      path: '/api/runtimes/claude-code/accounts/default/only-projects',
      body: { projects: null },
      expect: { status: 200, body: { onlyProjects: null } },
    });
  });

  it('saves the DorkOS model setup for a person, and never echoes a key', async () => {
    await check(server, {
      method: 'PUT',
      path: '/api/runtimes/doe/inference',
      body: LOCAL_INFERENCE,
      expect: { status: 200, body: { ok: true } },
    });
    await check(server, {
      path: '/api/runtimes/doe/inference',
      expect: {
        status: 200,
        body: { inference: LOCAL_INFERENCE, hasKey: false, autoProtocol: null },
      },
    });
  });

  it('streams an Ollama pull as progress frames and one result', async () => {
    await check(server, {
      method: 'POST',
      path: '/api/runtimes/opencode/ollama/pull',
      headers: { origin: SERVER_ORIGIN },
      body: { model: 'dorkos-contract/no-such-model:0' },
      expect: {
        status: 200,
        headers: {
          ...EVENT_STREAM,
          'access-control-allow-origin': SERVER_ORIGIN,
          'access-control-allow-credentials': 'true',
          'x-content-type-options': 'nosniff',
          'content-length': null,
        },
        schema: z
          .string()
          .startsWith('event: ')
          .refine((text) => /event: progress\ndata: \{.*"status":"downloading".*\}\n\n/.test(text))
          .refine((text) => /event: result\ndata: \{.*"ok":false.*\}\n\n$/.test(text)),
      },
    });
  });
});

/** A host name the server is told it answers to, which is not this computer. */
const PROXIED_HOST = 'dorkos.contract.example';

describe('contract: the loopback-only routes, reached by a name that is not this computer', () => {
  let server: ComposedServer | undefined;
  let cookie: Record<string, string>;
  const OWNER = {
    email: `owner-${randomUUID().slice(0, 8)}@dork.test`,
    password: 'a-long-password-1',
  };
  beforeAll(async () => {
    server = await bootComposedServer({ ...NO_OLLAMA, DORKOS_TRUSTED_HOSTS: PROXIED_HOST });
    // An owner exists and this computer still asks for no password. Another
    // device must sign in as that owner (ADR 261015-125850 rule 3); the routes'
    // own "only on this computer" answers are what a signed-in caller there hears.
    const origin = { origin: server.baseUrl };
    await setup(server, 'POST', '/api/auth/sign-up/email', { ...OWNER, name: 'Owner' }, origin);
    // Signed in there, since a sign-in works only where it was made (DOR-2969).
    cookie = await signInAt(server.baseUrl, PROXIED_HOST, OWNER);
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  /** The owner, signed in on another device that reaches this server by name. */
  const remote = () => ({ ...cookie, host: PROXIED_HOST, origin: `http://${PROXIED_HOST}` });
  const AUTH_REQUIRED = z.object({ code: z.literal('AUTH_REQUIRED') }).loose();

  it('asks another device with no session to sign in, with the this-computer password off', async () => {
    for (const [method, url] of [
      ['GET', '/api/runtimes/claude-code/credential'],
      ['POST', '/api/runtimes/codex/provision'],
      ['GET', '/api/runtimes/opencode/openrouter/oauth/callback?state=x'],
      ['GET', '/api/runtimes/claude-code/accounts/usage'],
      ['GET', '/api/tasks'],
    ] as const) {
      await check(server, {
        method,
        path: url,
        headers: { host: PROXIED_HOST },
        body: method === 'GET' ? undefined : {},
        expect: { status: 401, headers: JSON_TYPE, schema: AUTH_REQUIRED },
      });
    }
  });

  it('refuses the signed-in owner there every connect, provisioning and model-setup action', async () => {
    for (const [method, url, expected] of [
      ['GET', '/api/runtimes/claude-code/credential', CONNECT_LOCAL_ONLY],
      ['POST', '/api/runtimes/claude-code/credential', CONNECT_LOCAL_ONLY],
      ['POST', '/api/runtimes/claude-code/credential/check', CONNECT_LOCAL_ONLY],
      ['POST', '/api/runtimes/codex/login', CONNECT_LOCAL_ONLY],
      ['GET', '/api/runtimes/opencode/provider', CONNECT_LOCAL_ONLY],
      ['POST', '/api/runtimes/opencode/provider/credential', CONNECT_LOCAL_ONLY],
      ['POST', '/api/runtimes/opencode/provider/credential/check', CONNECT_LOCAL_ONLY],
      ['POST', '/api/runtimes/opencode/openrouter/key', CONNECT_LOCAL_ONLY],
      ['POST', '/api/runtimes/opencode/openrouter/oauth/start', CONNECT_LOCAL_ONLY],
      ['GET', '/api/runtimes/opencode/openrouter/oauth/status', CONNECT_LOCAL_ONLY],
      ['GET', '/api/runtimes/opencode/ollama', CONNECT_LOCAL_ONLY],
      ['GET', '/api/runtimes/opencode/ollama/models', CONNECT_LOCAL_ONLY],
      ['POST', '/api/runtimes/opencode/ollama/pull', CONNECT_LOCAL_ONLY],
      ['POST', '/api/runtimes/opencode/ollama/provision', PROVISION_LOCAL_ONLY],
      ['POST', '/api/runtimes/opencode/provision', PROVISION_LOCAL_ONLY],
      ['POST', '/api/runtimes/codex/provision', PROVISION_LOCAL_ONLY],
      ['POST', '/api/runtimes/claude-code/provision', PROVISION_LOCAL_ONLY],
      ['GET', '/api/runtimes/doe/inference', DOE_LOCAL_ONLY],
      ['GET', '/api/runtimes/doe/credits-models', DOE_LOCAL_ONLY],
      ['PUT', '/api/runtimes/doe/inference', DOE_LOCAL_ONLY],
      ['POST', '/api/runtimes/doe/credential', DOE_LOCAL_ONLY],
    ] as const) {
      await check(server, {
        method,
        path: url,
        headers: remote(),
        body: method === 'GET' ? undefined : {},
        expect: { status: 403, headers: JSON_TYPE, body: expected },
      });
    }
  });

  it('answers the signed-in owner there the OAuth landing with a plain refusal', async () => {
    await check(server, {
      path: '/api/runtimes/opencode/openrouter/oauth/callback?state=x',
      headers: remote(),
      expect: { status: 403, body: 'Not available.' },
    });
  });

  it('still answers the signed-in owner there the routes any person may read', async () => {
    await check(server, {
      path: '/api/runtimes/claude-code/accounts/usage',
      headers: remote(),
      expect: { status: 200, schema: z.object({ accounts: z.array(z.unknown()) }).strict() },
    });
    await check(server, {
      path: '/api/tasks',
      headers: remote(),
      expect: { status: 200, schema: TASK_LIST },
    });
  });
});

describe('contract: the same groups with login on', () => {
  let server: ComposedServer | undefined;
  let cookie: Record<string, string>;
  let apiKey: Record<string, string>;
  const OWNER = {
    email: `owner-${randomUUID().slice(0, 8)}@dork.test`,
    password: 'a-long-password-1',
  };

  beforeAll(async () => {
    server = await bootComposedServer(NO_OLLAMA);
    const origin = { origin: server.baseUrl };
    await setup(server, 'POST', '/api/auth/sign-up/email', { ...OWNER, name: 'Owner' }, origin);
    // No stop of its own, for the test-mode reason the login-off block gives.
    await setup(server, 'PATCH', '/api/config', { runtimes: { defaultTrustStop: null } });
    await setup(server, 'PATCH', '/api/config', { auth: { enabled: true } });
    const signedIn = await setup(server, 'POST', '/api/auth/sign-in/email', OWNER, origin);
    cookie = {
      cookie: signedIn.headers
        .getSetCookie()
        .map((value) => value.split(';')[0]!)
        .join('; '),
    };
    const created = await setup(
      server,
      'POST',
      '/api/auth/api-key/create',
      { name: 'c' },
      { ...cookie, ...origin }
    );
    apiKey = { authorization: `Bearer ${created.json.key as string}` };
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  const AUTH_REQUIRED = z.object({ code: z.literal('AUTH_REQUIRED') }).loose();
  const COOKIE_REQUIRED = z.object({ code: z.literal('operator_cookie_required') }).loose();

  it('refuses a caller with no credential at the session gate', async () => {
    for (const [method, url] of [
      ['GET', '/api/tasks'],
      ['POST', '/api/tasks'],
      ['GET', '/api/runtimes/claude-code/accounts/usage'],
      ['GET', '/api/runtimes/doe/inference'],
      ['PUT', '/api/runtimes/doe/inference'],
    ] as const) {
      await check(server, { method, path: url, expect: { status: 401, schema: AUTH_REQUIRED } });
    }
  });

  it('lets an API key propose a schedule but not arm one; the owner’s cookie arms it', async () => {
    const proposed = await setup(
      server,
      'POST',
      '/api/tasks',
      scheduleBody({ reason: 'An API key asked' }),
      apiKey
    );
    expect(proposed.json.status).toBe('pending_approval');
    const id = proposed.json.id as string;
    await check(server, {
      method: 'PATCH',
      path: `/api/tasks/${id}`,
      headers: apiKey,
      body: { status: 'active' },
      expect: { status: 403, schema: OPERATOR_ONLY_TASK(['status']) },
    });
    await check(server, {
      method: 'POST',
      path: `/api/tasks/${id}/trigger`,
      headers: apiKey,
      expect: { status: 403, schema: OPERATOR_ONLY_TASK([]) },
    });
    await check(server, {
      method: 'DELETE',
      path: `/api/tasks/${id}`,
      headers: apiKey,
      expect: {
        status: 403,
        body: {
          error: 'Only a person signed in to DorkOS can delete a scheduled task',
          code: 'operator_cookie_required',
        },
      },
    });
    await check(server, {
      method: 'POST',
      path: `/api/tasks/runs/${UNKNOWN_ID}/cancel`,
      headers: apiKey,
      expect: {
        status: 403,
        body: {
          error: 'Only a person signed in to DorkOS can cancel a scheduled run',
          code: 'operator_cookie_required',
        },
      },
    });
    await check(server, {
      method: 'PATCH',
      path: `/api/tasks/${id}`,
      headers: cookie,
      body: { status: 'active' },
      expect: { status: 200, schema: TASK.extend({ status: z.literal('active') }) },
    });
    await check(server, {
      method: 'DELETE',
      path: `/api/tasks/${id}`,
      headers: cookie,
      expect: { status: 200, body: { success: true } },
    });
  });

  it('refuses an API key the model setup and account rules; the owner’s cookie may', async () => {
    await check(server, {
      method: 'PUT',
      path: '/api/runtimes/doe/inference',
      headers: apiKey,
      body: LOCAL_INFERENCE,
      expect: { status: 403, body: DOE_NOT_A_PERSON },
    });
    await check(server, {
      method: 'POST',
      path: '/api/runtimes/doe/credential',
      headers: apiKey,
      body: { inference: LOCAL_INFERENCE, secret: 'sk-contract' },
      expect: { status: 403, body: DOE_NOT_A_PERSON },
    });
    await check(server, {
      path: '/api/runtimes/doe/inference',
      headers: apiKey,
      expect: { status: 200, body: { inference: null, hasKey: false, autoProtocol: null } },
    });
    await check(server, {
      method: 'PUT',
      path: '/api/runtimes/doe/inference',
      headers: cookie,
      body: LOCAL_INFERENCE,
      expect: { status: 200, body: { ok: true } },
    });
    await check(server, {
      method: 'PUT',
      path: '/api/runtimes/claude-code/project-accounts',
      headers: apiKey,
      body: { project: PROJECT, allow: null },
      expect: { status: 403, schema: COOKIE_REQUIRED },
    });
    await check(server, {
      method: 'POST',
      path: '/api/runtimes/claude-code/accounts/found/dismiss',
      headers: apiKey,
      body: { path: '/nowhere' },
      expect: { status: 403, schema: COOKIE_REQUIRED },
    });
    await check(server, {
      method: 'POST',
      path: '/api/runtimes/claude-code/accounts/default/probe',
      headers: apiKey,
      expect: { status: 403, schema: COOKIE_REQUIRED },
    });
  });
});
