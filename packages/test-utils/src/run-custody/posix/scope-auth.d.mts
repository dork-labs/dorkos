import type { Readable } from 'node:stream';

type Role = 'control' | 'stdin' | 'stdout' | 'stderr';
type Step = 'claim' | 'accepted';
type Connection = Readonly<{ endpointId: string; token: string }>;
export const SCOPE_ROLES: readonly Role[];
export function socketPath(directory: string, endpointId: string): string;
export function requirePrivateSocketDirectory(directory: string): Promise<void>;
export function authLine(connection: Connection, role: Role, step: Step): string;
export function verifyLine(connection: Connection, line: string, step: Step): Role | undefined;
export function readAuthLine(socket: Readable, signal: AbortSignal): Promise<string>;
