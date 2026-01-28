/**
 * Repository Client Interface
 * Abstract interface for accessing git repository data
 * Can be implemented by Gitiles HTTP client or local git checkout
 */

import type {
  CommitSummary,
  CommitDetails,
  DiffExcerpt,
  FileExcerpt,
} from '@chromium-search/shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Use this constant with maxCommits to fetch all commits without any limit.
 * @example
 * client.listCommits({ ..., maxCommits: UNLIMITED_COMMITS })
 */
export const UNLIMITED_COMMITS = Infinity;

export interface ListCommitsOptions {
  repoBaseUrl: string;
  startSha: string;
  endSha: string;
  pathScope?: string[];
  /**
   * Maximum number of commits to return.
   * - If undefined, uses the default from config
   * - Use `UNLIMITED_COMMITS` (Infinity) to fetch all commits without limit
   */
  maxCommits?: number;
  /** If true, check for full/pre-cached commit list first (no limit) */
  preferFullCache?: boolean;
}

export interface GetDiffOptions {
  fileGlobs?: string[];
  contextLines?: number;
  maxLines?: number;
}

export interface ReadFileOptions {
  maxBytes?: number;
}

// ============================================================================
// Repository Client Interface
// ============================================================================

/**
 * Interface for accessing git repository data.
 * This abstraction allows switching between different implementations:
 * - GitilesClient: HTTP-based access to Gitiles server
 * - LocalGitClient: Local git checkout access
 */
export interface IRepositoryClient {
  /**
   * List commits in a range
   */
  listCommits(options: ListCommitsOptions): Promise<CommitSummary[]>;

  /**
   * Cache a full commit list (used by download service for pre-saved ranges)
   * This cache bypasses the maxCommits limit when retrieved
   */
  cacheFullCommitList(startSha: string, endSha: string, commits: CommitSummary[]): Promise<void>;

  /**
   * Get detailed commit information
   */
  getCommitDetails(repoBaseUrl: string, sha: string): Promise<CommitDetails>;

  /**
   * Get diff excerpt for a commit
   */
  getDiffExcerpt(repoBaseUrl: string, sha: string, options?: GetDiffOptions): Promise<DiffExcerpt>;

  /**
   * Read file content at a specific revision
   */
  readFileAtRevision(
    repoBaseUrl: string,
    path: string,
    revision: string,
    options?: ReadFileOptions
  ): Promise<FileExcerpt>;

  /**
   * Batch fetch commit details with concurrency control
   */
  batchGetCommitDetails(repoBaseUrl: string, shas: string[]): Promise<CommitDetails[]>;

  /**
   * Batch fetch diffs with concurrency control
   */
  batchGetDiffExcerpts(
    repoBaseUrl: string,
    shas: string[],
    options?: GetDiffOptions
  ): Promise<DiffExcerpt[]>;
}

// ============================================================================
// Repository Source Type
// ============================================================================

export type RepositorySourceType = 'gitiles' | 'local';
