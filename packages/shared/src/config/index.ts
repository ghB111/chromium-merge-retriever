/**
 * Configuration management for the Chromium Agentic Search Service
 */

import { z } from 'zod';
import type { RunBudget } from '../types/index.js';

// ============================================================================
// Environment Schema
// ============================================================================

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000').transform(Number),
  HOST: z.string().default('0.0.0.0'),

  // Database
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/chromium_search'),

  // Redis (optional)
  REDIS_URL: z.string().optional(),
  REDIS_ENABLED: z.string().default('false').transform((v) => v === 'true'),

  // OpenAI
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_FAST_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_STRONG_MODEL: z.string().default('gpt-4o'),

  // Repository Source Configuration
  // Options: 'gitiles' (default) or 'local' (uses local git checkout)
  REPO_SOURCE: z.enum(['gitiles', 'local']).default('gitiles'),
  // Path to local git checkouts directory (used when REPO_SOURCE=local)
  LOCAL_CHECKOUT_PATH: z.string().default('./data/checkouts'),
  // Batch size for fetching commit details/diffs (used when REPO_SOURCE=local)
  LOCAL_GIT_BATCH_SIZE: z.string().default('100').transform(Number),

  // Gitiles
  GITILES_BASE_URL: z.string().default('https://chromium.googlesource.com'),
  GITILES_REPO_PATH: z.string().default('/chromium/src'),
  GITILES_CONCURRENCY: z.string().default('4').transform(Number),
  GITILES_RETRY_COUNT: z.string().default('3').transform(Number),
  GITILES_RETRY_DELAY_MS: z.string().default('1000').transform(Number),
  GITILES_PAGE_SIZE: z.string().default('1000').transform(Number), // Commits per page when listing (Google's Go client uses 1000)

  // Budgets
  MAX_TOOL_CALLS_PER_RUN: z.string().default('12').transform(Number),
  MAX_TOTAL_BYTES_PER_RUN: z.string().default('20000000').transform(Number), // 20MB
  MAX_DIFF_LINES_PER_COMMIT: z.string().default('800').transform(Number),
  MAX_FILE_BYTES: z.string().default('204800').transform(Number), // 200KB
  RUN_TIMEOUT_MS: z.string().default('110000').transform(Number), // 110s
  MAX_COMMITS_DEFAULT: z.string().default('7000').transform(Number),

  // Cache TTLs (seconds)
  CACHE_TTL_COMMIT_LIST: z.string().default('1800').transform(Number), // 30 min
  CACHE_TTL_COMMIT_DETAILS: z.string().default('604800').transform(Number), // 7 days
  CACHE_TTL_FILE_CONTENT: z.string().default('2592000').transform(Number), // 30 days

  // Ranking
  TOP_N_HEURISTIC: z.string().default('100').transform(Number),
  TOP_K_DEEP_DIVE: z.string().default('10').transform(Number),

  // Security
  MAX_INPUT_SIZE_BYTES: z.string().default('16384').transform(Number), // 16KB
  ALLOWED_GITILES_HOSTS: z.string().default('chromium.googlesource.com'),

  // Logging
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: z.string().default('false').transform((v) => v === 'true'),

  // Debug
  DEBUG_ENABLED: z.string().default('true').transform((v) => v === 'true'),

  // Admin
  ADMIN_PASSWORD: z.string().default('chromium-admin'),
});

export type EnvConfig = z.infer<typeof envSchema>;

// ============================================================================
// Configuration Class
// ============================================================================

class Config {
  private static instance: Config;
  private env: EnvConfig;

  private constructor() {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      console.error('Invalid environment configuration:', result.error.format());
      throw new Error('Invalid environment configuration');
    }
    this.env = result.data;
  }

  static getInstance(): Config {
    if (!Config.instance) {
      Config.instance = new Config();
    }
    return Config.instance;
  }

  get server() {
    return {
      nodeEnv: this.env.NODE_ENV,
      port: this.env.PORT,
      host: this.env.HOST,
      isDev: this.env.NODE_ENV === 'development',
      isProd: this.env.NODE_ENV === 'production',
      isTest: this.env.NODE_ENV === 'test',
    };
  }

  get database() {
    return {
      url: this.env.DATABASE_URL,
    };
  }

  get redis() {
    return {
      url: this.env.REDIS_URL,
      enabled: this.env.REDIS_ENABLED,
    };
  }

  get openai() {
    return {
      apiKey: this.env.OPENAI_API_KEY,
      baseUrl: this.env.OPENAI_BASE_URL,
      fastModel: this.env.OPENAI_FAST_MODEL,
      strongModel: this.env.OPENAI_STRONG_MODEL,
    };
  }

  get repositorySource() {
    return {
      type: this.env.REPO_SOURCE,
      isLocal: this.env.REPO_SOURCE === 'local',
      isGitiles: this.env.REPO_SOURCE === 'gitiles',
      localCheckoutPath: this.env.LOCAL_CHECKOUT_PATH,
      localGitBatchSize: this.env.LOCAL_GIT_BATCH_SIZE,
    };
  }

  get gitiles() {
    return {
      baseUrl: this.env.GITILES_BASE_URL,
      repoPath: this.env.GITILES_REPO_PATH,
      fullRepoUrl: `${this.env.GITILES_BASE_URL}${this.env.GITILES_REPO_PATH}`,
      concurrency: this.env.GITILES_CONCURRENCY,
      retryCount: this.env.GITILES_RETRY_COUNT,
      retryDelayMs: this.env.GITILES_RETRY_DELAY_MS,
      pageSize: this.env.GITILES_PAGE_SIZE,
    };
  }

  get budgets(): RunBudget {
    return {
      maxToolCalls: this.env.MAX_TOOL_CALLS_PER_RUN,
      maxTotalBytes: this.env.MAX_TOTAL_BYTES_PER_RUN,
      maxDiffLinesPerCommit: this.env.MAX_DIFF_LINES_PER_COMMIT,
      maxFileBytes: this.env.MAX_FILE_BYTES,
      timeoutMs: this.env.RUN_TIMEOUT_MS,
    };
  }

  get cache() {
    return {
      ttlCommitList: this.env.CACHE_TTL_COMMIT_LIST,
      ttlCommitDetails: this.env.CACHE_TTL_COMMIT_DETAILS,
      ttlFileContent: this.env.CACHE_TTL_FILE_CONTENT,
    };
  }

  get ranking() {
    return {
      topNHeuristic: this.env.TOP_N_HEURISTIC,
      topKDeepDive: this.env.TOP_K_DEEP_DIVE,
    };
  }

  get security() {
    return {
      maxInputSizeBytes: this.env.MAX_INPUT_SIZE_BYTES,
      allowedGitilesHosts: this.env.ALLOWED_GITILES_HOSTS.split(',').map((h) => h.trim()),
    };
  }

  get logging() {
    return {
      level: this.env.LOG_LEVEL,
      pretty: this.env.LOG_PRETTY,
    };
  }

  get debug() {
    return {
      enabled: this.env.DEBUG_ENABLED,
    };
  }

  get defaults() {
    return {
      maxCommits: this.env.MAX_COMMITS_DEFAULT,
    };
  }

  get admin() {
    return {
      password: this.env.ADMIN_PASSWORD,
    };
  }
}

export function getConfig(): Config {
  return Config.getInstance();
}

export { Config };
