/**
 * Local Git Client
 * Accesses git repository data from a local checkout using git commands
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

import {
  CommitSummary,
  CommitDetails,
  DiffExcerpt,
  FileExcerpt,
  ServiceError,
  getConfig,
  createLogger,
  truncateLines,
  truncateBytes,
  mapWithConcurrency,
  type Logger,
} from '@chromium-search/shared';

import { InMemoryCache, type Cache } from './cache.js';
import type { IRepositoryClient, ListCommitsOptions, GetDiffOptions, ReadFileOptions } from './repository.js';

const execAsync = promisify(exec);

// ============================================================================
// Local Git Client
// ============================================================================

export class LocalGitClient implements IRepositoryClient {
  private logger: Logger;
  private cache: Cache;
  private config = getConfig();
  private checkoutPath: string;
  private batchSize: number;

  constructor(cache?: Cache) {
    this.logger = createLogger('LocalGitClient');
    this.cache = cache ?? new InMemoryCache();
    this.checkoutPath = this.config.repositorySource.localCheckoutPath;
    this.batchSize = this.config.repositorySource.localGitBatchSize;
  }

  /**
   * Get the local path for a repository based on repoBaseUrl
   * Maps URLs like https://chromium.googlesource.com/chromium/src to local paths
   */
  private getRepoPath(repoBaseUrl: string): string {
    // Extract the repo name from the URL
    // e.g., https://chromium.googlesource.com/chromium/src -> chromium/src
    try {
      const url = new URL(repoBaseUrl);
      // Remove leading slash from pathname
      const repoPath = url.pathname.replace(/^\//, '').replace(/\/$/, '');
      return path.join(this.checkoutPath, repoPath);
    } catch {
      // If it's not a valid URL, use it as-is
      return path.join(this.checkoutPath, repoBaseUrl);
    }
  }

  /**
   * Execute a git command in the repository directory
   */
  private async execGit(repoPath: string, args: string[], maxBuffer?: number): Promise<string> {
    const fullCommand = `git ${args.join(' ')}`;
    this.logger.trace({ repoPath, command: fullCommand }, 'Executing git command');

    try {
      const { stdout, stderr } = await execAsync(fullCommand, {
        cwd: repoPath,
        maxBuffer: maxBuffer ?? 50 * 1024 * 1024, // 50MB default buffer
      });

      if (stderr && !stderr.includes('warning:')) {
        this.logger.trace({ stderr }, 'Git command stderr');
      }

      return stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ repoPath, command: fullCommand, error: message }, 'Git command failed');
      throw new ServiceError(`Git command failed: ${message}`, 'GIT_ERROR', 500);
    }
  }

  /**
   * List commits in a range using git log
   */
  async listCommits(options: ListCommitsOptions): Promise<CommitSummary[]> {
    const { repoBaseUrl, startSha, endSha, maxCommits } = options;
    const max = maxCommits ?? this.config.defaults.maxCommits;
    const repoPath = this.getRepoPath(repoBaseUrl);

    // Check for full cache first
    const fullCacheKey = `commits:full:${startSha}..${endSha}`;
    if (options.preferFullCache !== false) {
      const fullCached = await this.cache.get<CommitSummary[]>(fullCacheKey);
      if (fullCached) {
        this.logger.debug({ fullCacheKey, count: fullCached.length }, 'Full cache hit for commit list');
        return fullCached;
      }
    }

    // Check regular cache
    const cacheKey = `commits:${startSha}..${endSha}`;
    const cached = await this.cache.get<CommitSummary[]>(cacheKey);
    if (cached) {
      this.logger.debug({ cacheKey }, 'Cache hit for commit list');
      return cached.slice(0, max);
    }

    this.logger.info({ max, repoPath }, 'Fetching commits from local git');

    // Use git log to get commits in range
    // Format: SHA|%|Author Name|%|Committer Name|%|Committer Date|%|Subject|%|Body
    const formatString = '%H|%|%an|%|%cn|%|%ci|%|%s|%|%b|%|END_COMMIT';
    const limitArg = max === Infinity ? '' : `-n ${max}`;
    
    // Note: git log A..B shows commits reachable from B but not from A
    // This is what we want: commits from endSha back to (but not including) startSha
    const gitArgs = [
      'log',
      '--format=' + formatString,
      `${startSha}..${endSha}`,
      limitArg,
    ].filter(Boolean);

    const output = await this.execGit(repoPath, gitArgs);
    const commits = this.parseGitLogOutput(output, repoBaseUrl);

    this.logger.info({ count: commits.length }, 'Fetched commits from local git');

    // Cache the results
    await this.cache.set(cacheKey, commits, this.config.cache.ttlCommitList);

    return commits.slice(0, max);
  }

  /**
   * Parse git log output into CommitSummary array
   */
  private parseGitLogOutput(output: string, repoBaseUrl: string): CommitSummary[] {
    const commits: CommitSummary[] = [];
    const commitBlocks = output.split('|%|END_COMMIT').filter(block => block.trim());

    for (const block of commitBlocks) {
      const parts = block.trim().split('|%|');
      if (parts.length >= 5) {
        const [sha, author, committer, date, title, ...bodyParts] = parts;
        const body = bodyParts.join('|%|').trim();
        const fullMessage = body ? `${title}\n\n${body}` : title;
        
        commits.push({
          sha: sha.trim(),
          title: title.trim(),
          author: author.trim() || undefined,
          committer: committer.trim() || undefined,
          date: date.trim() || undefined,
          messageSnippet: fullMessage.length > 500 ? fullMessage.slice(0, 500) + '...' : fullMessage,
          url: this.buildCommitUrl(repoBaseUrl, sha.trim()),
        });
      }
    }

    return commits;
  }

  /**
   * Build a URL for a commit (for compatibility with gitiles URLs)
   */
  private buildCommitUrl(repoBaseUrl: string, sha: string): string {
    // Generate a gitiles-style URL for display purposes
    return `${repoBaseUrl}/+/${sha}`;
  }

  /**
   * Build a URL for a file (for compatibility with gitiles URLs)
   */
  private buildFileUrl(repoBaseUrl: string, revision: string, filePath: string): string {
    return `${repoBaseUrl}/+/${revision}/${filePath}`;
  }

  /**
   * Cache a full commit list
   */
  async cacheFullCommitList(startSha: string, endSha: string, commits: CommitSummary[]): Promise<void> {
    const fullCacheKey = `commits:full:${startSha}..${endSha}`;
    await this.cache.set(fullCacheKey, commits, this.config.cache.ttlCommitDetails);
    this.logger.info({ fullCacheKey, count: commits.length }, 'Cached full commit list');
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

    const repoPath = this.getRepoPath(repoBaseUrl);

    // Get commit metadata
    const formatString = '%H|%|%s|%|%B|%|%an|%|%cn|%|%ai|%|%ci';
    const metadataOutput = await this.execGit(repoPath, ['show', '--format=' + formatString, '-s', sha]);
    
    const parts = metadataOutput.trim().split('|%|');
    if (parts.length < 7) {
      throw new ServiceError(`Invalid commit data for ${sha}`, 'GIT_ERROR', 500);
    }

    const [commitSha, title, message, author, committer, authorDate, committerDate] = parts;

    // Get list of changed files
    const filesOutput = await this.execGit(repoPath, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]);
    const filesChanged = filesOutput.trim().split('\n').filter(Boolean);

    const details: CommitDetails = {
      sha: commitSha.trim(),
      title: title.trim(),
      message: message.trim(),
      author: author.trim() || undefined,
      committer: committer.trim() || undefined,
      authorDate: authorDate.trim() || undefined,
      committerDate: committerDate.trim() || undefined,
      filesChanged,
      url: this.buildCommitUrl(repoBaseUrl, sha),
    };

    // Cache the commit details
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
    const repoPath = this.getRepoPath(repoBaseUrl);

    try {
      // Get the diff using git show
      const diffOutput = await this.execGit(repoPath, [
        'show',
        '--format=',
        '--patch',
        sha,
      ]);

      // Parse diff into file sections
      const diffs = this.parseDiffText(diffOutput, maxLines, options.fileGlobs);

      return { sha, diffs };
    } catch (error) {
      this.logger.warn({ sha, error: String(error) }, 'Failed to fetch diff, trying fallback');

      // Fallback: try to get file list
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
    filePath: string,
    revision: string,
    options: ReadFileOptions = {}
  ): Promise<FileExcerpt> {
    const { maxBytes = this.config.budgets.maxFileBytes } = options;
    const repoPath = this.getRepoPath(repoBaseUrl);

    const cacheKey = `file:${revision}:${filePath}`;
    const cached = await this.cache.get<FileExcerpt>(cacheKey);
    if (cached) {
      this.logger.debug({ filePath, revision }, 'Cache hit for file content');
      return cached;
    }

    try {
      // Use git show to get file content at revision
      const content = await this.execGit(repoPath, ['show', `${revision}:${filePath}`]);
      const { text: excerpt, truncated } = truncateBytes(content, maxBytes);

      const result: FileExcerpt = {
        path: filePath,
        revision,
        excerpt,
        truncated,
        url: this.buildFileUrl(repoBaseUrl, revision, filePath),
      };

      // Cache the file content
      await this.cache.set(cacheKey, result, this.config.cache.ttlFileContent);

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('does not exist') || message.includes('not in')) {
        throw new ServiceError(`File not found: ${filePath} at revision ${revision}`, 'NOT_FOUND', 404, {
          path: filePath,
          revision,
        });
      }
      throw error;
    }
  }

  /**
   * Batch fetch commit details with concurrency control and batching
   */
  async batchGetCommitDetails(repoBaseUrl: string, shas: string[]): Promise<CommitDetails[]> {
    const results: CommitDetails[] = [];
    
    // Process in batches
    for (let i = 0; i < shas.length; i += this.batchSize) {
      const batch = shas.slice(i, Math.min(i + this.batchSize, shas.length));
      
      const batchResults = await mapWithConcurrency(
        batch,
        (sha) => this.getCommitDetails(repoBaseUrl, sha),
        this.config.gitiles.concurrency
      );
      
      results.push(...batchResults);
      
      this.logger.debug({ 
        processed: Math.min(i + this.batchSize, shas.length), 
        total: shas.length 
      }, 'Batch progress');
    }
    
    return results;
  }

  /**
   * Batch fetch diffs with concurrency control and batching
   */
  async batchGetDiffExcerpts(
    repoBaseUrl: string,
    shas: string[],
    options: GetDiffOptions = {}
  ): Promise<DiffExcerpt[]> {
    const results: DiffExcerpt[] = [];
    
    // Process in batches
    for (let i = 0; i < shas.length; i += this.batchSize) {
      const batch = shas.slice(i, Math.min(i + this.batchSize, shas.length));
      
      const batchResults = await mapWithConcurrency(
        batch,
        (sha) => this.getDiffExcerpt(repoBaseUrl, sha, options),
        this.config.gitiles.concurrency
      );
      
      results.push(...batchResults);
      
      this.logger.debug({ 
        processed: Math.min(i + this.batchSize, shas.length), 
        total: shas.length 
      }, 'Batch progress');
    }
    
    return results;
  }
}

// ============================================================================
// Factory
// ============================================================================

let clientInstance: LocalGitClient | null = null;

export function getLocalGitClient(cache?: Cache): LocalGitClient {
  if (!clientInstance) {
    clientInstance = new LocalGitClient(cache);
  }
  return clientInstance;
}

export function resetLocalGitClient(): void {
  clientInstance = null;
}
