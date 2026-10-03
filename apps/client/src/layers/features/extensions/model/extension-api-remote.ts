import type {
  DecisionAnswer,
  DecisionAnswerResult,
  ExtensionAPI,
  ExtensionDecisionView,
  StartWorkInput,
} from '@dorkos/extension-api';
import { StartWorkError } from '@dorkos/extension-api';
import {
  DecisionActionResponseSchema,
  ListExtensionDecisionsResponseSchema,
  ProjectSettingsResponseSchema,
  START_WORK_ERROR_CODES,
  StartWorkResponseSchema,
  type StartWorkErrorCode,
} from '@dorkos/shared/extension-decision-schemas';
import { extensionApiUrl } from './extension-api-url';
import type { HostEntry } from './extension-api-host';
type RemoteAPI = Pick<
  ExtensionAPI,
  'loadData' | 'saveData' | 'answerDecision' | 'listDecisions' | 'startWork' | 'projectSettings'
>;
/** Build remote calls with a final guard on every owned request. */
export function createRemoteAPI(context: RemoteContext): RemoteAPI {
  return {
    async loadData<T>(): Promise<T | null> {
      return remoteLoadData<T>(context);
    },
    async saveData<T>(data: T): Promise<void> {
      return remoteSaveData<T>(context, data);
    },
    async answerDecision(
      decisionId: string,
      answer: DecisionAnswer
    ): Promise<DecisionAnswerResult> {
      return remoteAnswerDecision(context, decisionId, answer);
    },
    async listDecisions(): Promise<ExtensionDecisionView[]> {
      return remoteListDecisions(context);
    },
    async startWork(input: StartWorkInput): Promise<{ sessionId: string }> {
      return remoteStartWork(context, input);
    },
    projectSettings: {
      async get<T = unknown>(projectRoot: string): Promise<T | null> {
        return settingsGet<T>(context, projectRoot);
      },
      async set(projectRoot: string, value: unknown): Promise<void> {
        return settingsSet(context, projectRoot, value);
      },
    },
  };
}
function isStartWorkCode(code: string | undefined): code is StartWorkErrorCode {
  return (START_WORK_ERROR_CODES as readonly string[]).includes(code ?? '');
}
async function requestError(
  res: Response,
  method: string
): Promise<Error & { code?: string; status: number }> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  const error = new Error(body.error ?? `${method} failed: ${res.status}`) as Error & {
    code?: string;
    status: number;
  };
  error.status = res.status;
  if (body.code) error.code = body.code;
  return error;
}

type RemoteContext = {
  extId: string;
  hostFetch: HostEntry['fetch'];
  requireCurrent: () => void;
  navigate: ExtensionAPI['navigate'];
};
async function remoteLoadData<T>(context: RemoteContext): Promise<T | null> {
  const { extId, hostFetch } = context;

  const res = await hostFetch(extensionApiUrl(`/extensions/${extId}/data`));
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`loadData failed: ${res.status}`);
  return res.json() as Promise<T>;
}
async function remoteSaveData<T>(context: RemoteContext, data: T): Promise<void> {
  const { extId, hostFetch } = context;

  const res = await hostFetch(extensionApiUrl(`/extensions/${extId}/data`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`saveData failed: ${res.status}`);
}
async function remoteAnswerDecision(
  context: RemoteContext,
  decisionId: string,
  answer: DecisionAnswer
): Promise<DecisionAnswerResult> {
  const { extId, hostFetch, requireCurrent, navigate } = context;

  const res = await hostFetch(
    extensionApiUrl(`/extensions/${extId}/decisions/${encodeURIComponent(decisionId)}/action`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(answer),
    }
  );
  if (!res.ok) throw await requestError(res, 'answerDecision');
  const body = DecisionActionResponseSchema.parse(await res.json());
  // The server checked it is an in-app path. Follow it the way the
  // extension's own `navigate` would: core routes, and this extension's
  // own `/x/<id>/…` pages.
  requireCurrent();
  if (body.navigate) navigate(body.navigate);
  requireCurrent();
  return {
    resolved: body.resolved,
    message: body.message,
    navigate: body.navigate,
    watch: body.watch,
  };
}
async function remoteListDecisions(context: RemoteContext): Promise<ExtensionDecisionView[]> {
  const { extId, hostFetch } = context;

  const res = await hostFetch(extensionApiUrl(`/extensions/${extId}/decisions`));
  if (!res.ok) throw await requestError(res, 'listDecisions');
  return ListExtensionDecisionsResponseSchema.parse(await res.json()).decisions.map((decision) => ({
    id: decision.id,
    key: decision.key,
    title: decision.title,
    why: decision.why,
    detail: decision.detail,
    project: decision.project,
    projectLabel: decision.projectLabel,
    since: decision.since,
    actions: decision.actions,
    link: decision.link,
    raisedAt: decision.raisedAt,
  }));
}
async function remoteStartWork(
  context: RemoteContext,
  input: StartWorkInput
): Promise<{ sessionId: string }> {
  const { extId, hostFetch } = context;

  const res = await hostFetch(extensionApiUrl(`/extensions/${extId}/start-work`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await requestError(res, 'startWork');
    throw isStartWorkCode(err.code) ? new StartWorkError(err.code, err.message) : err;
  }
  return { sessionId: StartWorkResponseSchema.parse(await res.json()).sessionId };
}
async function settingsGet<T = unknown>(
  context: RemoteContext,
  projectRoot: string
): Promise<T | null> {
  const { extId, hostFetch } = context;

  const query = new URLSearchParams({ project: projectRoot });
  const res = await hostFetch(
    extensionApiUrl(`/extensions/${extId}/project-settings?${query.toString()}`)
  );
  if (!res.ok) throw await requestError(res, 'projectSettings.get');
  const body = ProjectSettingsResponseSchema.parse(await res.json());
  return (body.value as T | null) ?? null;
}
async function settingsSet(
  context: RemoteContext,
  projectRoot: string,
  value: unknown
): Promise<void> {
  const { extId, hostFetch } = context;

  const res = await hostFetch(extensionApiUrl(`/extensions/${extId}/project-settings`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: projectRoot, value }),
  });
  if (!res.ok) throw await requestError(res, 'projectSettings.set');
}
