export function issueOriginalVMRuntimeSubject(
  release: unknown,
  policyRevision: number
): Promise<object>;
export function inspectOriginalVMRuntimeSubject(
  token: unknown,
  release: unknown
): Readonly<{
  binding: Readonly<{ runtimeIdentity: string; policyRevision: number }>;
  descriptor: unknown;
  current(): boolean;
}>;
