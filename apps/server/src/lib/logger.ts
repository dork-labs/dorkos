import { createConsola, type LogObject } from 'consola';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Central logger module for DorkOS server.
 *
 * Provides a singleton logger backed by consola. Before `initLogger()` is called,
 * the logger outputs to console only at info level. After `initLogger()`, it also
 * appends structured NDJSON entries to `~/.dork/logs/dorkos.log` with automatic
 * log rotation when the file exceeds 10MB.
 *
 * @module lib/logger
 */

const LOG_DIR = path.join(os.homedir(), '.dork', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'dorkos.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_FILES = 7;

/**
 * Create an NDJSON file reporter that appends structured log entries to disk.
 */
function createFileReporter() {
  return {
    log(logObj: LogObject) {
      const entry = JSON.stringify({
        level: logObj.type,
        time: logObj.date.toISOString(),
        msg: logObj.args.map(String).join(' '),
        tag: logObj.tag || undefined,
      });
      fs.appendFileSync(LOG_FILE, entry + '\n');
    },
  };
}

/**
 * Rotate log file if >10MB. Keep last MAX_LOG_FILES rotated files.
 * Errors during rotation are silently ignored to avoid crashing on startup.
 */
function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_SIZE) {
      const date = new Date().toISOString().slice(0, 10);
      const rotatedName = `dorkos-${date}-${Date.now()}.log`;
      fs.renameSync(LOG_FILE, path.join(LOG_DIR, rotatedName));

      // Clean old rotated files beyond MAX_LOG_FILES
      const files = fs
        .readdirSync(LOG_DIR)
        .filter((f) => f.startsWith('dorkos-') && f.endsWith('.log'))
        .sort()
        .reverse();
      for (const old of files.slice(MAX_LOG_FILES)) {
        fs.unlinkSync(path.join(LOG_DIR, old));
      }
    }
  } catch {
    // File doesn't exist yet or rotation failed — continue
  }
}

/** Default logger instance (console-only until initLogger is called). */
export let logger = createConsola({
  level: 3, // info
});

/**
 * Initialize the logger with file persistence and configured log level.
 * Call once at server startup after config is loaded.
 *
 * @param options - Optional configuration
 * @param options.level - Numeric log level (0=fatal … 5=trace). Defaults to 4 (debug) in dev, 3 (info) in production.
 */
export function initLogger(options?: { level?: number }): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  rotateIfNeeded();

  const level = options?.level ?? (process.env.NODE_ENV === 'production' ? 3 : 4);

  logger = createConsola({
    level,
    reporters: [],
  });

  logger.addReporter(createFileReporter());
}
