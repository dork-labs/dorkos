/** Owner-private Unix socket rendezvous. Each direction is claimed at most once. */
import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

export const SCOPE_ROLES = ['control', 'stdin', 'stdout', 'stderr'];
const ENDPOINT = /^[a-f0-9]{32}$/;
const TOKEN = /^[a-f0-9]{64}$/;

export function socketPath(directory, endpointId) {
  if (!isAbsolute(directory) || !ENDPOINT.test(endpointId))
    throw new Error('Invalid POSIX endpoint path');
  return join(directory, `${endpointId}.sock`);
}

export async function requirePrivateSocketDirectory(directory) {
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0)
    throw new Error('POSIX socket directory is not owner-private');
}

function sign(token, endpointId, role, step) {
  if (!TOKEN.test(token) || !ENDPOINT.test(endpointId) || !SCOPE_ROLES.includes(role))
    throw new Error('Invalid POSIX socket credential');
  return createHmac('sha256', Buffer.from(token, 'hex'))
    .update(JSON.stringify([endpointId, role, step]))
    .digest('hex');
}

export function authLine(connection, role, step) {
  return `${role}:${sign(connection.token, connection.endpointId, role, step)}\n`;
}

export function verifyLine(connection, line, step) {
  const match = /^(control|stdin|stdout|stderr):([a-f0-9]{64})$/.exec(line);
  if (!match) return;
  const [, role, proof] = match;
  const expected = sign(connection.token, connection.endpointId, role, step);
  return timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(expected, 'hex'))
    ? role
    : undefined;
}

/** Read one bounded line and return any following binary bytes to the same socket. */
export function readAuthLine(socket, signal) {
  return new Promise((resolve, reject) => {
    let line = Buffer.alloc(0);
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('end', ended);
      socket.off('close', ended);
      socket.off('error', ended);
      signal.removeEventListener('abort', ended);
    };
    const ended = () => {
      cleanup();
      reject(new Error('POSIX socket authentication did not finish'));
    };
    const onData = (bytes) => {
      const end = bytes.indexOf(10);
      const prefix = end < 0 ? bytes : bytes.subarray(0, end);
      if (line.length + prefix.length > 80) return ended();
      line = Buffer.concat([line, prefix]);
      if (end < 0) return;
      socket.pause();
      cleanup();
      if (bytes.length > end + 1) socket.unshift(bytes.subarray(end + 1));
      resolve(line.toString('latin1'));
    };
    socket.on('end', ended);
    socket.on('close', ended);
    socket.on('error', ended);
    signal.addEventListener('abort', ended, { once: true });
    if (signal.aborted || socket.destroyed) return ended();
    socket.on('data', onData);
  });
}
