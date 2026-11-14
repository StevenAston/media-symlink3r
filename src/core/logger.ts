import fs from 'node:fs';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';

export interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  source: string;
  message: string;
}

type LogListener = (entry: LogEntry) => void;

let nextLogId = 1;
let currentLogFilePath: string | null = null;
const recentLogs: LogEntry[] = [];
const MAX_RECENT_LOGS = 500;
const listeners = new Set<LogListener>();

export function configureLogger(logFilePath: string): void {
  currentLogFilePath = logFilePath;
}

export function onLogEntry(listener: LogListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRecentLogs(): LogEntry[] {
  return [...recentLogs];
}

export function emitLogEntry(entry: LogEntry): void {
  recentLogs.push(entry);
  if (recentLogs.length > MAX_RECENT_LOGS) {
    recentLogs.shift();
  }

  const formatted = `[${entry.timestamp}] [${entry.level}] [${entry.source}] ${entry.message}`;
  // Always print to terminal stdout so the user can see live progress in the console too
  console.log(formatted);

  if (currentLogFilePath) {
    try {
      fs.appendFileSync(currentLogFilePath, `${formatted}\n`, 'utf8');
    } catch {
      // Ignore file log write errors
    }
  }

  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      // Ignore listener errors
    }
  }
}

export function logMessage(
  level: LogLevel,
  source: string,
  message: string,
): LogEntry {
  const now = new Date();
  const timestamp = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
  const cleanMessage = message.replace(/\\PoolPart\.[^\\\s)'",]+(?=\\|\s|$|[)'",])/gi, '\\...');
  const entry: LogEntry = {
    id: nextLogId++,
    timestamp,
    level,
    source,
    message: cleanMessage,
  };
  emitLogEntry(entry);
  return entry;
}

export const logger = {
  info: (source: string, message: string) => logMessage('INFO', source, message),
  warn: (source: string, message: string) => logMessage('WARN', source, message),
  error: (source: string, message: string) => logMessage('ERROR', source, message),
  success: (source: string, message: string) => logMessage('SUCCESS', source, message),
};
