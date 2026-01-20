/**
 * Utility functions for the Chromium Agentic Search Service
 */

import { pino, Logger as PinoLogger, LoggerOptions } from 'pino';
import { randomUUID } from 'crypto';
import { getConfig } from '../config/index.js';

// ============================================================================
// Logger
// ============================================================================

let loggerInstance: PinoLogger | null = null;

export function createLogger(name?: string): PinoLogger {
  if (!loggerInstance) {
    const config = getConfig();
    const pinoOptions: LoggerOptions = {
      level: config.logging.level,
    };
    
    if (config.logging.pretty) {
      pinoOptions.transport = {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
        },
      };
    }
    
    loggerInstance = pino(pinoOptions);
  }
  return name ? loggerInstance.child({ component: name }) : loggerInstance;
}

export type Logger = PinoLogger;

// ============================================================================
// ID Generation
// ============================================================================

export function generateId(): string {
  return randomUUID();
}

export function generateRunId(): string {
  return `run_${randomUUID()}`;
}

export function generateSessionId(): string {
  return `sess_${randomUUID()}`;
}

// ============================================================================
// String Utilities
// ============================================================================

export function truncateString(str: string, maxLength: number, suffix = '...'): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - suffix.length) + suffix;
}

export function truncateLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) {
    return { text, truncated: false };
  }
  return {
    text: lines.slice(0, maxLines).join('\n') + '\n...(truncated)',
    truncated: true,
  };
}

export function truncateBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.length <= maxBytes) {
    return { text, truncated: false };
  }
  // Find a safe cut point (avoid cutting in the middle of multi-byte chars)
  const cutPoint = maxBytes;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const decoded = decoder.decode(encoded.slice(0, cutPoint));
  return {
    text: decoded + '\n...(truncated)',
    truncated: true,
  };
}

// ============================================================================
// Hash Utilities
// ============================================================================

export async function hashString(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ============================================================================
// SHA Validation
// ============================================================================

const SHA_REGEX = /^[a-fA-F0-9]{7,40}$/;

export function isValidSha(sha: string): boolean {
  return SHA_REGEX.test(sha);
}

export function normalizeSha(sha: string): string {
  return sha.toLowerCase().trim();
}

// ============================================================================
// Git Ref Validation (SHA or Version Tag)
// ============================================================================

// Pattern to match version tags (e.g., 144.0.7559.1)
const VERSION_TAG_PATTERN = /^\d+(\.\d+)+$/;

/**
 * Check if a string is a valid version tag (e.g., 144.0.7559.1)
 */
export function isVersionTag(ref: string): boolean {
  return VERSION_TAG_PATTERN.test(ref);
}

/**
 * Check if a string is a valid Git ref (SHA or version tag)
 */
export function isValidGitRef(ref: string): boolean {
  return isValidSha(ref) || isVersionTag(ref);
}

/**
 * Normalize a Git ref (lowercase for SHAs, unchanged for version tags)
 */
export function normalizeGitRef(ref: string): string {
  return isVersionTag(ref) ? ref : normalizeSha(ref);
}

// ============================================================================
// URL Utilities
// ============================================================================

export function isAllowedGitilesHost(url: string, allowedHosts: string[]): boolean {
  try {
    const parsed = new URL(url);
    return allowedHosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

// ============================================================================
// Timing Utilities
// ============================================================================

export function createTimer(): { elapsed: () => number } {
  const start = performance.now();
  return {
    elapsed: () => Math.round(performance.now() - start),
  };
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage = 'Operation timed out'
): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Retry Utilities
// ============================================================================

export interface RetryOptions {
  maxAttempts: number;
  delayMs: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: unknown) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  logger?: Logger
): Promise<T> {
  const { maxAttempts, delayMs, backoffMultiplier = 2, shouldRetry = () => true } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !shouldRetry(error)) {
        throw error;
      }
      const waitTime = delayMs * Math.pow(backoffMultiplier, attempt - 1);
      logger?.warn({ attempt, maxAttempts, waitTime, error: String(error) }, 'Retrying after error');
      await sleep(waitTime);
    }
  }

  throw lastError;
}

// ============================================================================
// Concurrency Utilities
// ============================================================================

export async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const executing: Promise<void>[] = [];

  for (let i = 0; i < items.length; i++) {
    const promise = fn(items[i], i).then((result) => {
      results[i] = result;
    });

    executing.push(promise);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
      // Remove completed promises
      for (let j = executing.length - 1; j >= 0; j--) {
        // Check if promise is settled by racing with immediate resolve
        const settled = await Promise.race([
          executing[j].then(() => true).catch(() => true),
          Promise.resolve(false),
        ]);
        if (settled) {
          executing.splice(j, 1);
        }
      }
    }
  }

  await Promise.all(executing);
  return results;
}

// ============================================================================
// Tokenization Utilities (Simple)
// ============================================================================

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

export function calculateJaccardSimilarity(set1: Set<string>, set2: Set<string>): number {
  const intersection = new Set([...set1].filter((x) => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// ============================================================================
// Path Utilities
// ============================================================================

export function matchesPathScope(filePath: string, pathScope: string[]): boolean {
  if (pathScope.length === 0) return true;
  return pathScope.some((scope) => {
    const normalizedScope = scope.endsWith('/') ? scope : scope + '/';
    const normalizedPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
    return normalizedPath.startsWith(normalizedScope) || normalizedPath === scope.replace(/\/$/, '');
  });
}
