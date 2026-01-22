/**
 * Download Service
 * Handles downloading and caching commits from pre-saved ranges
 */

import { PrismaClient } from '@prisma/client';
import {
  createLogger,
  getConfig,
  withRetry,
  mapWithConcurrency,
  type Logger,
  type DownloadStatus,
  type DownloadProgressUpdate,
  type CommitDetails,
} from '@chromium-search/shared';

import { getGitilesClient, CacheManager, type GitilesClient, type Cache } from '@chromium-search/tools';

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
    // Check if already downloading
    if (this.activeDownloads.has(rangeId)) {
      this.logger.warn({ rangeId }, 'Download already in progress');
      return;
    }

    // Get range from database
    const range = await this.prisma.preSavedRange.findUnique({
      where: { id: rangeId },
    });

    if (!range) {
      throw new Error(`Range not found: ${rangeId}`);
    }

    // Create abort controller for this download
    const abortController = new AbortController();
    this.activeDownloads.set(rangeId, abortController);

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
  }

  /**
   * Execute the download process
   */
  private async executeDownload(job: DownloadJob, signal: AbortSignal): Promise<void> {
    const { rangeId, repoBaseUrl, startSha, endSha, lastDownloadedSha } = job;

    try {
      // First, get the list of commits in the range
      this.logger.info({ rangeId, startSha, endSha }, 'Fetching commit list');
      
      const commits = await this.gitilesClient.listCommits({
        repoBaseUrl,
        startSha,
        endSha,
        maxCommits: 100000, // No practical limit for admin downloads
      });

      const totalCommits = commits.length;
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
      let downloadedCount = startIndex;

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
        progress: 0,
        total: null,
        error: errorMessage,
      });
    } finally {
      this.activeDownloads.delete(rangeId);
    }
  }

  /**
   * Download a batch of commits with retries
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

        // Download with retry
        await withRetry(
          async () => {
            const details = await this.gitilesClient.getCommitDetails(repoBaseUrl, sha);
            
            // Cache the commit details with long TTL (30 days)
            await this.cache.set(cacheKey, details, this.config.cache.ttlCommitDetails);
            
            this.logger.debug({ sha }, 'Cached commit details');
          },
          {
            maxAttempts: 5,
            delayMs: 2000,
            shouldRetry: (error) => {
              // Retry on network errors and rate limits
              const message = error instanceof Error ? error.message : String(error);
              return message.includes('429') || 
                     message.includes('500') || 
                     message.includes('timeout') ||
                     message.includes('ECONNRESET');
            },
          },
          this.logger
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
