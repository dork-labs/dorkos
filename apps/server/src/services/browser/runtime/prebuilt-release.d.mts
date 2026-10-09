export function openOriginalInstalledPrebuiltRelease(
  options: Readonly<{ dataHome: string; current(): boolean }>
): Promise<object>;
export function openOriginalPrivateInstalledPrebuiltRelease(
  options: Readonly<{
    dataHome: string;
    current(): boolean;
    authorization: 'I_AUTHORIZE_PRIVATE_INSTALLED_RELEASE';
  }>
): Promise<object>;
export function originalPrebuiltReleaseLifetimeCurrent(token: unknown): boolean;
