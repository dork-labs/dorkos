type Artifact = {
  readonly path: string;
  readonly sha256: string;
  readonly device: string;
  readonly inode: string;
  readonly mtimeNs: string;
  readonly size: string;
};
export function buildDarwinObserver(options: {
  parent: string;
  signal?: AbortSignal;
  run?(executable: string, args: readonly string[], signal?: AbortSignal): Promise<string>;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}): Promise<{
  readonly directory: string;
  readonly manifestSha256: string;
  readonly artifactSha256: string;
}>;
export function validateDarwinObserver(options: {
  directory: string;
  manifestSha256: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}): Promise<Artifact>;
