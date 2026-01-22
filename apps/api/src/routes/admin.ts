/**
 * Admin API Routes
 * Password-protected routes for managing pre-saved ranges
 */

import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  ValidationError,
  NotFoundError,
  ServiceError,
  getConfig,
  createLogger,
  type DownloadProgressUpdate,
} from '@chromium-search/shared';
import { parseRangeFromGitilesUrl } from '@chromium-search/tools';
import { getDownloadService } from '../services/download.js';

const logger = createLogger('AdminRoutes');

// ============================================================================
// Validation Schemas
// ============================================================================

const createRangeSchema = z.object({
  name: z.string().min(1).max(200),
  gitilesUrl: z.string().url(),
});

// ============================================================================
// Admin Authentication Middleware
// ============================================================================

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const config = getConfig();
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Authorization header required' },
    });
    return;
  }

  // Support both "Bearer <password>" and "Basic <base64>" formats
  let password: string | null = null;

  if (authHeader.startsWith('Bearer ')) {
    password = authHeader.slice(7);
  } else if (authHeader.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
      // Basic auth format is "username:password", we only care about password
      password = decoded.includes(':') ? decoded.split(':')[1] : decoded;
    } catch {
      // Invalid base64
    }
  }

  if (!password || password !== config.admin.password) {
    res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Invalid admin password' },
    });
    return;
  }

  next();
}

// ============================================================================
// Route Factory
// ============================================================================

export function createAdminRouter(prisma: PrismaClient): Router {
  const router = Router();
  const downloadService = getDownloadService(prisma);

  // Apply admin auth to all routes
  router.use(adminAuth);

  /**
   * GET /v1/admin/ranges
   * List all pre-saved ranges
   */
  router.get('/ranges', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const ranges = await prisma.preSavedRange.findMany({
        orderBy: { createdAt: 'desc' },
      });

      res.json({ ranges });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /v1/admin/ranges
   * Create a new pre-saved range
   */
  router.post('/ranges', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parseResult = createRangeSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new ValidationError('Invalid request body', {
          errors: parseResult.error.errors,
        });
      }

      const { name, gitilesUrl } = parseResult.data;

      // Parse the Gitiles URL
      let parsed;
      try {
        parsed = parseRangeFromGitilesUrl(gitilesUrl);
      } catch (error) {
        throw new ValidationError(
          `Invalid Gitiles URL: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Check if URL already exists
      const existing = await prisma.preSavedRange.findUnique({
        where: { gitilesUrl },
      });

      if (existing) {
        throw new ValidationError('This Gitiles URL is already saved');
      }

      // Create the range
      const range = await prisma.preSavedRange.create({
        data: {
          name,
          gitilesUrl,
          repoBaseUrl: parsed.repoBaseUrl,
          startSha: parsed.startSha,
          endSha: parsed.endSha,
        },
      });

      logger.info({ rangeId: range.id, name }, 'Created pre-saved range');

      res.status(201).json({ range });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /v1/admin/ranges/:rangeId
   * Get a single pre-saved range
   */
  router.get('/ranges/:rangeId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rangeId } = req.params;

      const range = await prisma.preSavedRange.findUnique({
        where: { id: rangeId },
      });

      if (!range) {
        throw new NotFoundError(`Range not found: ${rangeId}`);
      }

      res.json({ range });
    } catch (error) {
      next(error);
    }
  });

  /**
   * DELETE /v1/admin/ranges/:rangeId
   * Delete a pre-saved range
   */
  router.delete('/ranges/:rangeId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rangeId } = req.params;

      // Cancel any active download
      downloadService.cancelDownload(rangeId);

      // Delete the range
      try {
        await prisma.preSavedRange.delete({
          where: { id: rangeId },
        });
      } catch {
        throw new NotFoundError(`Range not found: ${rangeId}`);
      }

      logger.info({ rangeId }, 'Deleted pre-saved range');

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /v1/admin/ranges/:rangeId/download
   * Start or resume downloading commits for a range
   */
  router.post('/ranges/:rangeId/download', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rangeId } = req.params;

      const range = await prisma.preSavedRange.findUnique({
        where: { id: rangeId },
      });

      if (!range) {
        throw new NotFoundError(`Range not found: ${rangeId}`);
      }

      // Check if already downloading
      if (downloadService.isDownloading(rangeId)) {
        throw new ServiceError('Download already in progress', 'DOWNLOAD_IN_PROGRESS', 409);
      }

      // Start the download
      await downloadService.startDownload(rangeId);

      logger.info({ rangeId }, 'Started download');

      res.json({
        message: 'Download started',
        rangeId,
        status: 'downloading',
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * DELETE /v1/admin/ranges/:rangeId/download
   * Cancel an ongoing download
   */
  router.delete('/ranges/:rangeId/download', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rangeId } = req.params;

      const cancelled = downloadService.cancelDownload(rangeId);

      if (!cancelled) {
        throw new NotFoundError('No active download found');
      }

      // Update status to pending so it can be restarted
      await prisma.preSavedRange.update({
        where: { id: rangeId },
        data: {
          downloadStatus: 'pending',
        },
      });

      logger.info({ rangeId }, 'Cancelled download');

      res.json({ message: 'Download cancelled' });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /v1/admin/ranges/:rangeId/progress
   * Get download progress for a range
   */
  router.get('/ranges/:rangeId/progress', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rangeId } = req.params;

      const progress = await downloadService.getProgress(rangeId);

      if (!progress) {
        throw new NotFoundError(`Range not found: ${rangeId}`);
      }

      res.json({ progress });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /v1/admin/ranges/:rangeId/progress/stream
   * Server-Sent Events stream for download progress
   */
  router.get('/ranges/:rangeId/progress/stream', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rangeId } = req.params;

      const range = await prisma.preSavedRange.findUnique({
        where: { id: rangeId },
      });

      if (!range) {
        throw new NotFoundError(`Range not found: ${rangeId}`);
      }

      // Set up SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Send initial state
      const initialProgress: DownloadProgressUpdate = {
        rangeId: range.id,
        status: range.downloadStatus as 'pending' | 'downloading' | 'completed' | 'error',
        progress: range.downloadProgress,
        total: range.totalCommits,
        error: range.errorMessage,
      };
      res.write(`data: ${JSON.stringify(initialProgress)}\n\n`);

      // Subscribe to progress updates
      const unsubscribe = downloadService.subscribeToProgress(rangeId, (update) => {
        res.write(`data: ${JSON.stringify(update)}\n\n`);
      });

      // Clean up on connection close
      req.on('close', () => {
        unsubscribe();
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

// ============================================================================
// Public Routes (no auth required)
// ============================================================================

export function createPublicRangesRouter(prisma: PrismaClient): Router {
  const router = Router();

  /**
   * GET /v1/ranges
   * List all pre-saved ranges (public, for user selection)
   */
  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const ranges = await prisma.preSavedRange.findMany({
        where: {
          // Only show ranges that are at least partially downloaded
          OR: [
            { downloadStatus: 'completed' },
            { downloadStatus: 'downloading', downloadProgress: { gt: 0 } },
          ],
        },
        select: {
          id: true,
          name: true,
          startSha: true,
          endSha: true,
          gitilesUrl: true,
          downloadStatus: true,
          downloadProgress: true,
          totalCommits: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      res.json({ ranges });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
