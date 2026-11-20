export function allocatePosixSocketDirectory(parent?: string): Promise<{
  readonly directory: string;
  readonly identity: Readonly<{ device: string; inode: string }>;
  remove(): Promise<'closed' | 'cleanup-uncertain'>;
}>;
