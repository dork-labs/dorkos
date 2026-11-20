import type { Duplex, Readable, Writable } from 'node:stream';
import type { LaneReader, LaneWriter } from '../index.mjs';

type SocketLaneWriter = LaneWriter & { readonly finished: Promise<boolean> };
export function socketLaneWriter(socket: Duplex): SocketLaneWriter;
export function socketLaneReader(socket: Duplex): LaneReader;
export function forwardOutput(source: Readable, writer: SocketLaneWriter): Promise<boolean>;
export function forwardInput(reader: LaneReader, destination: Writable): Promise<void>;
