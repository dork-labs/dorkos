export function copyBrowserVMRelease(
  root: string,
  output: string
): Promise<Readonly<{ available: boolean; manifestSHA256?: string }>>;

export const browserVMAssetNames: readonly string[];
export function verifyBrowserVMRelease(
  root: string,
  directory: string
): Promise<Readonly<{ available: boolean; manifestSHA256?: string }>>;
export function originalOutputPath(output: string, relativePath: string): Promise<boolean>;
export function clearBrowserVMModules(output: string): Promise<void>;

export function copyBrowserVMModules(
  root: string,
  output: string
): Promise<Readonly<{ modules: number }>>;
