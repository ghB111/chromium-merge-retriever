/**
 * Gitiles HTTP Client
 * Handles HTTP requests to Gitiles with retries, caching, and rate limiting
 */

import {
  GitilesError,
  GitilesLogResponse,
  GitilesLogEntry,
  CommitSummary,
  CommitDetails,
  DiffExcerpt,
  FileExcerpt,
  getConfig,
  createLogger,
  withRetry,
  createTimer,
  truncateLines,
  truncateBytes,
  mapWithConcurrency,
  type Logger,
} from '@chromium-search/shared';

import {
  buildJsonLogUrl,
  buildJsonCommitUrl,
  buildCommitUrl,
  buildTextDiffUrl,
  buildRawFileUrl,
  buildFileUrl,
} from './url-parser.js';

import { InMemoryCache, type Cache } from './cache.js';

// ============================================================================
// Types
// ============================================================================

export interface ListCommitsOptions {
  repoBaseUrl: string;
  startSha: string;
  endSha: string;
  pathScope?: string[];
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
// Gitiles Client
// ============================================================================

export class GitilesClient {
  private logger: Logger;
  private cache: Cache;
  private config = getConfig();

  constructor(cache?: Cache) {
    this.logger = createLogger('GitilesClient');
    this.cache = cache ?? new InMemoryCache();
  }

  /**
   * Strip Gitiles JSON prefix from response
   * Gitiles prepends ")]}\n" to JSON responses for security
   */
  private stripJsonPrefix(text: string): string {
    // Common Gitiles prefix patterns
    const prefixes = [")]}'", ')]}\'', ")]}'\n"];
    for (const prefix of prefixes) {
      if (text.startsWith(prefix)) {
        return text.slice(prefix.length).trim();
      }
    }
    // Also handle the case with just the prefix followed by newline
    const newlineMatch = text.match(/^\)\]\}'\s*\n/);
    if (newlineMatch) {
      return text.slice(newlineMatch[0].length);
    }
    return text;
  }

  /**
   * Make an HTTP request to Gitiles with retries
   */
  private async fetch(url: string): Promise<Response> {
    const timer = createTimer();
    
    const result = await withRetry(
      async () => {
        this.logger.trace({ url }, 'Gitiles request starting');
        
        const response = await fetch(url, {
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'User-Agent': 'ChromiumAgenticSearch/1.0',
          },
        });

        // Log all responses at trace level with HTTP status
        this.logger.trace(
          { 
            url, 
            status: response.status, 
            statusText: response.statusText,
            ok: response.ok,
            headers: {
              contentType: response.headers.get('content-type'),
              contentLength: response.headers.get('content-length'),
            }
          }, 
          `Gitiles response: HTTP ${response.status}`
        );

        if (!response.ok) {
          if (response.status === 404) {
            throw new GitilesError(`Resource not found: ${url}`, { status: 404 });
          }
          if (response.status === 429) {
            throw new GitilesError('Rate limited by Gitiles', { status: 429 });
          }
          throw new GitilesError(`HTTP ${response.status}: ${response.statusText}`, {
            status: response.status,
          });
        }

        return response;
      },
      {
        maxAttempts: this.config.gitiles.retryCount,
        delayMs: this.config.gitiles.retryDelayMs,
        shouldRetry: (error) => {
          if (error instanceof GitilesError) {
            const status = error.details?.status as number;
            // Retry on 429 (rate limit) and 5xx errors
            return status === 429 || (status >= 500 && status < 600);
          }
          return true;
        },
      },
      this.logger
    );

    this.logger.debug({ url, elapsed: timer.elapsed() }, 'Gitiles fetch completed');
    return result;
  }

  /**
   * Fetch and parse JSON from Gitiles
   */
  private async fetchJson<T>(url: string): Promise<T> {
    const response = await this.fetch(url);
    const text = await response.text();
    const cleanJson = this.stripJsonPrefix(text);
    
    try {
      return JSON.parse(cleanJson) as T;
    } catch (error) {
      this.logger.error({ url, text: cleanJson.slice(0, 200) }, 'Failed to parse JSON');
      throw new GitilesError('Failed to parse Gitiles JSON response', {
        url,
        parseError: String(error),
      });
    }
  }

  /**
   * Fetch text content from Gitiles (may be base64 encoded)
   */
  private async fetchText(url: string, isBase64 = false): Promise<string> {
    const response = await this.fetch(url);
    const text = await response.text();
    
    if (isBase64) {
      try {
        // Gitiles returns base64-encoded content for ?format=TEXT
        return Buffer.from(text, 'base64').toString('utf-8');
      } catch (error) {
        this.logger.warn({ url }, 'Failed to decode base64, returning raw text');
        return text;
      }
    }
    
    return text;
  }

  /**
   * List commits in a range
   */
  async listCommits(options: ListCommitsOptions): Promise<CommitSummary[]> {
    const { repoBaseUrl, startSha, endSha, maxCommits, preferFullCache } = options;
    const max = maxCommits ?? this.config.defaults.maxCommits;
    
    // First, check for full cache (from pre-saved/downloaded ranges)
    // This cache contains ALL commits and should return without limit
    const fullCacheKey = `commits:full:${startSha}..${endSha}`;
    if (preferFullCache !== false) {
      const fullCached = await this.cache.get<CommitSummary[]>(fullCacheKey);
      if (fullCached) {
        this.logger.debug({ fullCacheKey, count: fullCached.length }, 'Full cache hit for commit list (no limit applied)');
        return fullCached;
      }
    }
    
    // Check regular cache (may be partial due to previous limit)
    const cacheKey = `commits:${startSha}..${endSha}`;
    const cached = await this.cache.get<CommitSummary[]>(cacheKey);
    if (cached) {
      this.logger.debug({ cacheKey }, 'Cache hit for commit list');
      return cached.slice(0, max);
    }

    const commits: CommitSummary[] = [];
    let nextToken: string | undefined;
    let pageCount = 0;
    const maxPages = 100; // Safety limit

    do {
      const url = nextToken
        ? `${repoBaseUrl}/+log/${nextToken}?format=JSON`
        : buildJsonLogUrl(repoBaseUrl, startSha, endSha);

      this.logger.debug({ url, pageCount }, 'Fetching commit list page');

      const response = await this.fetchJson<GitilesLogResponse>(url);
      
      for (const entry of response.log || []) {
        commits.push(this.mapLogEntryToSummary(entry, repoBaseUrl));
        if (commits.length >= max) {
          break;
        }
      }

      nextToken = response.next;
      pageCount++;
    } while (nextToken && commits.length < max && pageCount < maxPages);

    this.logger.info({ count: commits.length, pages: pageCount }, 'Fetched commit list');

    // Cache the results
    await this.cache.set(cacheKey, commits, this.config.cache.ttlCommitList);

    return commits;
  }

  /**
   * Cache a full commit list (used by download service for pre-saved ranges)
   * This cache bypasses the maxCommits limit when retrieved
   */
  async cacheFullCommitList(startSha: string, endSha: string, commits: CommitSummary[]): Promise<void> {
    const fullCacheKey = `commits:full:${startSha}..${endSha}`;
    await this.cache.set(fullCacheKey, commits, this.config.cache.ttlCommitDetails); // Long TTL like commit details
    this.logger.info({ fullCacheKey, count: commits.length }, 'Cached full commit list');
  }

  /**
   * Map a Gitiles log entry to a CommitSummary
   */
  private mapLogEntryToSummary(entry: GitilesLogEntry, repoBaseUrl: string): CommitSummary {
    const message = entry.message || '';
    const firstLine = message.split('\n')[0] || '';
    
    return {
      sha: entry.commit,
      title: firstLine,
      author: entry.author?.name,
      committer: entry.committer?.name,
      date: entry.committer?.time || entry.author?.time,
      messageSnippet: message.length > 500 ? message.slice(0, 500) + '...' : message,
      url: buildCommitUrl(repoBaseUrl, entry.commit),
    };
  }

  /**
   * Get detailed commit information
   */
  async getCommitDetails(repoBaseUrl: string, sha: string): Promise<CommitDetails> {
    const cacheKey = `commit:${sha}`;
    const cached = await this.cache.get<CommitDetails>(cacheKey);
    if (cached) {
      this.logger.debug({ sha }, 'Cache hit for commit details');
      return cached;
    }

    const url = buildJsonCommitUrl(repoBaseUrl, sha);
    
    interface CommitResponse {
      commit: string;
      tree?: string;
      parents?: string[];
      author?: { name?: string; email?: string; time?: string };
      committer?: { name?: string; email?: string; time?: string };
      message?: string;
      tree_diff?: Array<{ type: string; old_path?: string; new_path?: string }>;
    }

    const response = await this.fetchJson<CommitResponse>(url);
    
    const filesChanged = response.tree_diff?.map((d) => d.new_path || d.old_path || '').filter(Boolean);
    
    const details: CommitDetails = {
      sha: response.commit,
      title: (response.message || '').split('\n')[0] || '',
      message: response.message || '',
      author: response.author?.name,
      committer: response.committer?.name,
      authorDate: response.author?.time,
      committerDate: response.committer?.time,
      filesChanged,
      url: buildCommitUrl(repoBaseUrl, sha),
    };

    // Cache immutable commit details for longer
    await this.cache.set(cacheKey, details, this.config.cache.ttlCommitDetails);

    return details;
  }

  /**
   * Get diff excerpt for a commit
   */
  async getDiffExcerpt(
    repoBaseUrl: string,
    sha: string,
    options: GetDiffOptions = {}
  ): Promise<DiffExcerpt> {
    const { maxLines = this.config.budgets.maxDiffLinesPerCommit } = options;
    
    const url = buildTextDiffUrl(repoBaseUrl, sha);
    
    try {
      const diffText = await this.fetchText(url, true);
      
      // Parse diff into file sections
      const diffs = this.parseDiffText(diffText, maxLines, options.fileGlobs);
      
      return { sha, diffs };
    } catch (error) {
      this.logger.warn({ sha, error: String(error) }, 'Failed to fetch diff, trying fallback');
      
      // Fallback: try to get file list and construct minimal diff info
      const details = await this.getCommitDetails(repoBaseUrl, sha);
      return {
        sha,
        diffs: (details.filesChanged || []).map((file) => ({
          file,
          excerpt: '(diff not available)',
          truncated: false,
        })),
      };
    }
  }

  /**
   * Parse unified diff text into file sections
   */
  private parseDiffText(
    diffText: string,
    maxLines: number,
    fileGlobs?: string[]
  ): Array<{ file: string; excerpt: string; truncated: boolean }> {
    const results: Array<{ file: string; excerpt: string; truncated: boolean }> = [];
    
    // Split by file diff headers
    const fileDiffs = diffText.split(/(?=^diff --git)/m);
    
    for (const fileDiff of fileDiffs) {
      if (!fileDiff.trim()) continue;
      
      // Extract file path from diff header
      const headerMatch = fileDiff.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
      if (!headerMatch) continue;
      
      const filePath = headerMatch[2];
      
      // Filter by file globs if specified
      if (fileGlobs && fileGlobs.length > 0) {
        const matches = fileGlobs.some((glob) => {
          if (glob.includes('*')) {
            const regex = new RegExp(glob.replace(/\*/g, '.*'));
            return regex.test(filePath);
          }
          return filePath.includes(glob);
        });
        if (!matches) continue;
      }
      
      // Truncate diff content
      const { text: excerpt, truncated } = truncateLines(fileDiff, maxLines);
      
      results.push({ file: filePath, excerpt, truncated });
    }
    
    return results;
  }

  /**
   * Read file content at a specific revision
   */
  async readFileAtRevision(
    repoBaseUrl: string,
    path: string,
    revision: string,
    options: ReadFileOptions = {}
  ): Promise<FileExcerpt> {
    const { maxBytes = this.config.budgets.maxFileBytes } = options;
    
    const cacheKey = `file:${revision}:${path}`;
    const cached = await this.cache.get<FileExcerpt>(cacheKey);
    if (cached) {
      this.logger.debug({ path, revision }, 'Cache hit for file content');
      return cached;
    }

    const url = buildRawFileUrl(repoBaseUrl, revision, path);
    
    try {
      const content = await this.fetchText(url, true);
      const { text: excerpt, truncated } = truncateBytes(content, maxBytes);
      
      const result: FileExcerpt = {
        path,
        revision,
        excerpt,
        truncated,
        url: buildFileUrl(repoBaseUrl, revision, path),
      };

      // Cache immutable file content for longer
      await this.cache.set(cacheKey, result, this.config.cache.ttlFileContent);

      return result;
    } catch (error) {
      if (error instanceof GitilesError && error.details?.status === 404) {
        throw new GitilesError(`File not found: ${path} at revision ${revision}`, {
          path,
          revision,
        });
      }
      throw error;
    }
  }

  /**
   * Batch fetch commit details with concurrency control
   */
  async batchGetCommitDetails(
    repoBaseUrl: string,
    shas: string[]
  ): Promise<CommitDetails[]> {
    return mapWithConcurrency(
      shas,
      (sha) => this.getCommitDetails(repoBaseUrl, sha),
      this.config.gitiles.concurrency
    );
  }

  /**
   * Batch fetch diffs with concurrency control
   */
  async batchGetDiffExcerpts(
    repoBaseUrl: string,
    shas: string[],
    options: GetDiffOptions = {}
  ): Promise<DiffExcerpt[]> {
    return mapWithConcurrency(
      shas,
      (sha) => this.getDiffExcerpt(repoBaseUrl, sha, options),
      this.config.gitiles.concurrency
    );
  }
}

// ============================================================================
// Factory
// ============================================================================

let clientInstance: GitilesClient | null = null;

export function getGitilesClient(cache?: Cache): GitilesClient {
  if (!clientInstance) {
    clientInstance = new GitilesClient(cache);
  }
  return clientInstance;
}

export function resetGitilesClient(): void {
  clientInstance = null;
}
