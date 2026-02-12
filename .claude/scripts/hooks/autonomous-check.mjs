#!/usr/bin/env node

/**
 * Stop Hook for Autonomous Roadmap Execution
 *
 * This hook implements the Ralph Wiggum loop pattern by preventing
 * Claude from stopping when there's active work in progress.
 *
 * Exit codes:
 * - 0: Allow stop (phase complete, abort signal, or no active work)
 * - 2: Block stop (work in progress, not yet complete)
 *
 * Completion signals:
 * - <promise>PHASE_COMPLETE:<phase></promise> - Phase finished successfully
 * - <promise>ABORT</promise> - User requested abort
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ROADMAP_PATH = join(process.cwd(), 'roadmap/roadmap.json');

/**
 * Read Claude's output from stdin
 */
async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (chunk) => {
      data += chunk;
    });

    process.stdin.on('end', () => {
      resolve(data);
    });

    // Handle case where stdin is empty or closed immediately
    setTimeout(() => {
      if (data === '') {
        resolve('');
      }
    }, 100);
  });
}

/**
 * Check if roadmap has any item with active workflow
 */
function getActiveWorkItem(roadmap) {
  const activePhases = [
    'ideating',
    'specifying',
    'decomposing',
    'implementing',
    'testing',
    'committing',
    'releasing'
  ];

  return roadmap.items.find(item =>
    item.workflowState?.phase &&
    activePhases.includes(item.workflowState.phase)
  );
}

/**
 * Format the blocking message box
 */
function formatBlockingMessage(item) {
  const title = item.title.length > 48
    ? item.title.substring(0, 45) + '...'
    : item.title;
  const phase = item.workflowState.phase;

  console.error('');
  console.error('┌─────────────────────────────────────────────────────────────┐');
  console.error('│  AUTONOMOUS WORK IN PROGRESS                                │');
  console.error('├─────────────────────────────────────────────────────────────┤');
  console.error(`│  Item: ${title.padEnd(50)} │`);
  console.error(`│  Phase: ${phase.padEnd(49)} │`);
  console.error('├─────────────────────────────────────────────────────────────┤');
  console.error('│  To stop: Output <promise>ABORT</promise>                   │');
  console.error('│  Or complete the current phase                              │');
  console.error('└─────────────────────────────────────────────────────────────┘');
  console.error('');
}

async function main() {
  const output = await readStdin();

  // Check for explicit completion signal
  if (output.includes('<promise>PHASE_COMPLETE:')) {
    const match = output.match(/<promise>PHASE_COMPLETE:(\w+)<\/promise>/);
    if (match) {
      console.error(`[autonomous-check] Phase complete: ${match[1]}`);
    }
    process.exit(0); // Allow stop
  }

  // Check for explicit abort signal
  if (output.includes('<promise>ABORT</promise>')) {
    console.error('[autonomous-check] Abort signal received');
    process.exit(0); // Allow stop
  }

  // Check roadmap for active work
  try {
    const roadmapContent = readFileSync(ROADMAP_PATH, 'utf8');
    const roadmap = JSON.parse(roadmapContent);

    const activeItem = getActiveWorkItem(roadmap);

    if (activeItem) {
      formatBlockingMessage(activeItem);
      process.exit(2); // Block stop
    }
  } catch (e) {
    // If roadmap unreadable, allow stop (fail open)
    console.error(`[autonomous-check] Warning: Could not read roadmap: ${e.message}`);
    process.exit(0);
  }

  // No active work, allow stop
  process.exit(0);
}

main();
