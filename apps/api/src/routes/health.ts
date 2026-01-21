/**
 * Health Check Routes
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { getConfig, createLogger } from '@chromium-search/shared';

const logger = createLogger('HealthRoute');

// ============================================================================
// Route Factory
// ============================================================================

export function createHealthRouter(prisma: PrismaClient): Router {
  const router = Router();
  const config = getConfig();

  /**
   * GET /health
   * Basic health check
   */
  router.get('/', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * GET /health/ready
   * Readiness check (includes database connectivity)
   */
  router.get('/ready', async (_req: Request, res: Response) => {
    try {
      // Check database connection
      await prisma.$queryRaw`SELECT 1`;

      res.json({
        status: 'ready',
        timestamp: new Date().toISOString(),
        checks: {
          database: 'ok',
        },
      });
    } catch (error) {
      logger.error({ error: String(error) }, 'Readiness check failed');
      res.status(503).json({
        status: 'not_ready',
        timestamp: new Date().toISOString(),
        checks: {
          database: 'failed',
        },
      });
    }
  });

  /**
   * GET /health/live
   * Liveness check
   */
  router.get('/live', (_req: Request, res: Response) => {
    res.json({
      status: 'live',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      env: config.server.nodeEnv,
    });
  });

  return router;
}
