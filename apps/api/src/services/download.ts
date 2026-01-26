/**
 * Download Service
 * Handles downloading and caching commits from pre-saved ranges
 */

import { PrismaClient } from '@prisma/client';
import {
  createLogger,
  getConfig,
  mapWithConcurrency,
  sleep,
  type Logger,
  type DownloadStatus,
  type DownloadProgressUpdate,
  type CommitDetails,
} from '@chromium-search/shared';

import { getGitilesClient, CacheManager, UNLIMITED_COMMITS, type GitilesClient, type Cache } from '@chromium-search/tools';

// ============================================================================
// Rate Limit Retry Configuration
// ============================================================================

const RATE_LIMIT_CONFIG = {
  initialDelayMs: 1000,      // Start with 1 second
  maxDelayMs: 60000,         // Cap at 60 seconds (1 minute)
  backoffMultiplier: 2,      // Double the delay each time
  maxTotalRetries: 15,       // Safety limit to prevent infinite loops
};

// ============================================================================
// Types
// ============================================================================

interface DownloadJob {
  rangeId: string;
  repoBaseUrl: string;
  startSha: string;
  endSha: string;
  lastDownloadedSha: string | null;
}

interface ProgressCallback {
  (update: DownloadProgressUpdate): void;
}

// ============================================================================
// Download Service
// ============================================================================

export class DownloadService {
  private prisma: PrismaClient;
  private logger: Logger;
  private config = getConfig();
  private gitilesClient: GitilesClient;
  private cache: Cache;
  private activeDownloads: Map<string, AbortController> = new Map();
  private progressCallbacks: Map<string, Set<ProgressCallback>> = new Map();

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.logger = createLogger('DownloadService');
    this.gitilesClient = getGitilesClient();
    this.cache = CacheManager.getInstance().getCache();
  }

  /**
   * Start downloading commits for a range
   */
  async startDownload(rangeId: string): Promise<void> {
    // Atomic check-and-set to prevent TOCTOU race conditions.
    // We must reserve the slot BEFORE any async operations.
    if (this.activeDownloads.has(rangeId)) {
      this.logger.warn({ rangeId }, 'Download already in progress');
      return;
    }

    // Create abort controller and reserve the slot immediately (before any await)
    const abortController = new AbortController();
    this.activeDownloads.set(rangeId, abortController);

    try {
      // Get range from database
      const range = await this.prisma.preSavedRange.findUnique({
        where: { id: rangeId },
      });

      if (!range) {
        throw new Error(`Range not found: ${rangeId}`);
      }

      // Update status to downloading
      await this.updateRangeStatus(rangeId, 'downloading', {
        downloadStartedAt: new Date(),
        errorMessage: null,
      });

      // Start download in background
      this.executeDownload({
        rangeId,
        repoBaseUrl: range.repoBaseUrl,
        startSha: range.startSha,
        endSha: range.endSha,
        lastDownloadedSha: range.lastDownloadedSha,
      }, abortController.signal).catch((error) => {
        this.logger.error({ rangeId, error: String(error) }, 'Download failed');
      });
    } catch (error) {
      // Clean up the reserved slot if setup fails before the download starts
      this.activeDownloads.delete(rangeId);
      throw error;
    }
  }

  /**
   * Execute the download process
   */
  private async executeDownload(job: DownloadJob, signal: AbortSignal): Promise<void> {
    const { rangeId, repoBaseUrl, startSha, endSha, lastDownloadedSha } = job;

    // Track progress outside try block so values are available in catch
    let totalCommits: number | null = null;
    let downloadedCount = 0;

    try {
      // First, get the list of commits in the range
      this.logger.info({ rangeId, startSha, endSha }, 'Fetching commit list');
      
      const commits = await this.gitilesClient.listCommits({
        repoBaseUrl,
        startSha,
        endSha,
        maxCommits: UNLIMITED_COMMITS, // No practical limit for admin downloads
      });

      totalCommits = commits.length;
      this.logger.info({ rangeId, totalCommits }, 'Found commits in range');

      // Update total commits in database
      await this.prisma.preSavedRange.update({
        where: { id: rangeId },
        data: { totalCommits },
      });

      // Find where to resume from if we have a lastDownloadedSha
      let startIndex = 0;
      if (lastDownloadedSha) {
        const resumeIndex = commits.findIndex((c) => c.sha === lastDownloadedSha);
        if (resumeIndex !== -1) {
          startIndex = resumeIndex + 1;
          this.logger.info({ rangeId, startIndex }, 'Resuming download from index');
        }
      }

      // Download commits in batches
      const batchSize = 10;
      downloadedCount = startIndex;

      for (let i = startIndex; i < commits.length; i += batchSize) {
        // Check for abort
        if (signal.aborted) {
          this.logger.info({ rangeId }, 'Download aborted');
          return;
        }

        const batch = commits.slice(i, Math.min(i + batchSize, commits.length));
        const shas = batch.map((c) => c.sha);

        // Download commit details with retries
        await this.downloadBatchWithRetry(rangeId, repoBaseUrl, shas);

        downloadedCount += batch.length;
        const lastSha = batch[batch.length - 1]?.sha;

        // Update progress
        await this.updateProgress(rangeId, downloadedCount, totalCommits, lastSha);

        // Notify progress callbacks
        this.notifyProgress({
          rangeId,
          status: 'downloading',
          progress: downloadedCount,
          total: totalCommits,
          error: null,
        });

        // Small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Cache the full commit list for this range (bypasses normal limits)
      await this.gitilesClient.cacheFullCommitList(startSha, endSha, commits);
      this.logger.info({ rangeId, totalCommits }, 'Cached full commit list');

      // Mark as completed
      await this.updateRangeStatus(rangeId, 'completed', {
        downloadCompletedAt: new Date(),
        downloadProgress: totalCommits,
      });

      this.notifyProgress({
        rangeId,
        status: 'completed',
        progress: totalCommits,
        total: totalCommits,
        error: null,
      });

      this.logger.info({ rangeId, totalCommits }, 'Download completed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error({ rangeId, error: errorMessage }, 'Download error');

      // Update status to error
      await this.updateRangeStatus(rangeId, 'error', {
        errorMessage,
      });

      this.notifyProgress({
        rangeId,
        status: 'error',
        progress: downloadedCount,
        total: totalCommits,
        error: errorMessage,
      });
    } finally {
      this.activeDownloads.delete(rangeId);
    }
  }

  /**
   * Check if an error is a rate limit error
   */
  private isRateLimitError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('429') || message.toLowerCase().includes('rate limit');
  }

  /**
   * Check if an error is retryable (network errors, server errors)
   */
  private isRetryableError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return this.isRateLimitError(error) ||
           message.includes('500') ||
           message.includes('502') ||
           message.includes('503') ||
           message.includes('504') ||
           message.includes('timeout') ||
           message.includes('ECONNRESET') ||
           message.includes('ENOTFOUND') ||
           message.includes('ETIMEDOUT') ||
           message.includes('EAI_AGAIN');
  }

  /**
   * Retry with aggressive exponential backoff for rate limiting
   * Keeps retrying until we've waited 60 seconds and still get rate limited
   */
  private async withRateLimitRetry<T>(
    fn: () => Promise<T>,
    context: string
  ): Promise<T> {
    let currentDelay = RATE_LIMIT_CONFIG.initialDelayMs;
    let totalRetries = 0;
    let lastError: unknown;

    while (totalRetries < RATE_LIMIT_CONFIG.maxTotalRetries) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        totalRetries++;

        const isRateLimit = this.isRateLimitError(error);
        const isRetryable = this.isRetryableError(error);

        // If not retryable at all, throw immediately
        if (!isRetryable) {
          this.logger.error({ context, error: String(error) }, 'Non-retryable error');
          throw error;
        }

        // For rate limits: keep retrying with exponential backoff up to 60s
        // For other errors: retry a few times with shorter delays
        if (isRateLimit) {
          // If we've already waited 60 seconds and still rate limited, give up
          if (currentDelay >= RATE_LIMIT_CONFIG.maxDelayMs) {
            this.logger.error(
              { context, delay: currentDelay, totalRetries },
              'Rate limit persists after maximum delay, giving up'
            );
            throw new Error(`Rate limit exceeded after waiting ${currentDelay / 1000}s. Original error: ${error instanceof Error ? error.message : String(error)}`);
          }

          this.logger.warn(
            { context, delay: currentDelay, totalRetries, error: String(error) },
            'Rate limited, waiting before retry'
          );
        } else {
          // For non-rate-limit errors, use smaller delays and fewer retries
          if (totalRetries >= 5) {
            this.logger.error(
              { context, totalRetries, error: String(error) },
              'Max retries reached for non-rate-limit error'
            );
            throw error;
          }

          // Use a smaller delay for non-rate-limit errors
          const nonRateLimitDelay = Math.min(currentDelay, 5000);
          this.logger.warn(
            { context, delay: nonRateLimitDelay, totalRetries, error: String(error) },
            'Retryable error, waiting before retry'
          );
          await sleep(nonRateLimitDelay);
          continue;
        }

        // Wait before retrying
        await sleep(currentDelay);

        // Exponential backoff, capped at max delay
        currentDelay = Math.min(
          currentDelay * RATE_LIMIT_CONFIG.backoffMultiplier,
          RATE_LIMIT_CONFIG.maxDelayMs
        );
      }
    }

    // Safety: should not reach here, but throw if we do
    throw lastError || new Error('Max retries exceeded');
  }

  /**
   * Download a batch of commits with rate-limit-aware retries
   */
  private async downloadBatchWithRetry(
    _rangeId: string,
    repoBaseUrl: string,
    shas: string[]
  ): Promise<void> {
    await mapWithConcurrency(
      shas,
      async (sha) => {
        // Check if already cached
        const cacheKey = `commit:${sha}`;
        const cached = await this.cache.get<CommitDetails>(cacheKey);
        if (cached) {
          this.logger.debug({ sha }, 'Commit already cached');
          return;
        }

        // Download with rate-limit-aware retry
        await this.withRateLimitRetry(
          async () => {
            const details = await this.gitilesClient.getCommitDetails(repoBaseUrl, sha);
            
            // Cache the commit details with long TTL (30 days)
            await this.cache.set(cacheKey, details, this.config.cache.ttlCommitDetails);
            
            this.logger.debug({ sha }, 'Cached commit details');
          },
          `getCommitDetails:${sha.slice(0, 8)}`
        );
      },
      this.config.gitiles.concurrency
    );
  }

  /**
   * Update range status in database
   */
  private async updateRangeStatus(
    rangeId: string,
    status: DownloadStatus,
    extra: Partial<{
      downloadStartedAt: Date;
      downloadCompletedAt: Date;
      errorMessage: string | null;
      downloadProgress: number;
    }> = {}
  ): Promise<void> {
    await this.prisma.preSavedRange.update({
      where: { id: rangeId },
      data: {
        downloadStatus: status,
        ...extra,
      },
    });
  }

  /**
   * Update download progress
   */
  private async updateProgress(
    rangeId: string,
    progress: number,
    total: number,
    lastSha: string | undefined
  ): Promise<void> {
    await this.prisma.preSavedRange.update({
      where: { id: rangeId },
      data: {
        downloadProgress: progress,
        totalCommits: total,
        lastDownloadedSha: lastSha,
      },
    });
  }

  /**
   * Cancel a download in progress
   */
  cancelDownload(rangeId: string): boolean {
    const controller = this.activeDownloads.get(rangeId);
    if (controller) {
      controller.abort();
      this.activeDownloads.delete(rangeId);
      return true;
    }
    return false;
  }

  /**
   * Check if a download is in progress
   */
  isDownloading(rangeId: string): boolean {
    return this.activeDownloads.has(rangeId);
  }

  /**
   * Subscribe to progress updates for a range
   */
  subscribeToProgress(rangeId: string, callback: ProgressCallback): () => void {
    if (!this.progressCallbacks.has(rangeId)) {
      this.progressCallbacks.set(rangeId, new Set());
    }
    this.progressCallbacks.get(rangeId)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.progressCallbacks.get(rangeId)?.delete(callback);
    };
  }

  /**
   * Notify all subscribers of progress update
   */
  private notifyProgress(update: DownloadProgressUpdate): void {
    const callbacks = this.progressCallbacks.get(update.rangeId);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback(update);
        } catch (error) {
          this.logger.warn({ error: String(error) }, 'Progress callback error');
        }
      }
    }
  }

  /**
   * Get current progress for a range
   */
  async getProgress(rangeId: string): Promise<DownloadProgressUpdate | null> {
    const range = await this.prisma.preSavedRange.findUnique({
      where: { id: rangeId },
    });

    if (!range) {
      return null;
    }

    return {
      rangeId: range.id,
      status: range.downloadStatus as DownloadStatus,
      progress: range.downloadProgress,
      total: range.totalCommits,
      error: range.errorMessage,
    };
  }
}

// ============================================================================
// Factory
// ============================================================================

let serviceInstance: DownloadService | null = null;

export function getDownloadService(prisma: PrismaClient): DownloadService {
  if (!serviceInstance) {
    serviceInstance = new DownloadService(prisma);
  }
  return serviceInstance;
}
