export function inspectOriginalSemanticObservation(
  token: unknown,
  session: unknown,
  tabId: string,
  action: string
): unknown;
export function createOriginalSemanticProtocol(
  options: Readonly<{
    guard(): void;
    request(body: Record<string, unknown>): Promise<unknown>;
    originalSession(): unknown;
  }>
): Readonly<{
  request(action: string, tabId: string, fields?: Record<string, unknown>): Promise<unknown>;
  frame(pending: Record<string, unknown>, bytes: Uint8Array): boolean;
  consume(
    pending: Record<string, unknown>,
    value: Record<string, unknown>
  ): Readonly<{ handled: boolean; settled?: boolean; value?: object }>;
  refuse(
    pending: Record<string, unknown>,
    value: Record<string, unknown>,
    mint: (reason: string) => unknown
  ): boolean;
  clear(pending: Record<string, unknown>): void;
}>;
