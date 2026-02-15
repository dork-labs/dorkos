import { useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useTransport } from '@/layers/shared/lib';

const DEFAULT_MESSAGE = 'Permissions bypassed - all tool calls auto-approved';

const WITTY_MESSAGES = [
  'Permissions bypassed - you like living dangerously',
  "Permissions bypassed - you're running with scissors",
  'Permissions bypassed - YOLO mode engaged',
  'Permissions bypassed - no safety net',
  'Permissions bypassed - what could go wrong?',
  'Permissions bypassed - hold onto your files',
  "Permissions bypassed - I hope you trust me",
  'Permissions bypassed - send it',
] as const;

/** How long a witty message shows before reverting (ms). */
const WITTY_DISPLAY_MS = 4000;
/** How long the default message shows before swapping to a witty one (ms). */
const DEFAULT_DISPLAY_MS = 12000;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function PermissionBanner({ sessionId }: { sessionId: string | null }) {
  // Hidden for now — may re-enable in the future
  return null;
}
