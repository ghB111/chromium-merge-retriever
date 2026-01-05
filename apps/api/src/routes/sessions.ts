/**
 * Sessions API Routes
 */

import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { getSessionService } from '../services/session.js';
import { ValidationError } from '@chromium-search/shared';

// ============================================================================
// Validation Schemas
// ============================================================================

const updateScopeSchema = z.object({
  rangeEnabled: z.boolean().optional(),
  rangeUrl: z.string().url().optional(),
  range: z.object({
    startSha: z.string().min(7).max(40),
    endSha: z.string().min(7).max(40),
  }).optional(),
  pathScope: z.array(z.string()).optional(),
});

// ============================================================================
// Route Factory
// ============================================================================

export function createSessionsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const sessionService = getSessionService(prisma);

  /**
   * POST /v1/sessions
   * Create a new session
   */
  router.post('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await sessionService.createSession();
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /v1/sessions/:sessionId
   * Get session details
   */
  router.get('/:sessionId', async (req, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const session = await sessionService.getSession(sessionId);
      res.json(session);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /v1/sessions/:sessionId/scope
   * Update session scope (range and paths)
   */
  router.post('/:sessionId/scope', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      
      // Validate request body
      const parseResult = updateScopeSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new ValidationError('Invalid request body', {
          errors: parseResult.error.errors,
        });
      }

      const scope = await sessionService.updateScope(sessionId, parseResult.data);
      res.json({ scope });
    } catch (error) {
      next(error);
    }
  });

  /**
   * DELETE /v1/sessions/:sessionId
   * Delete a session
   */
  router.delete('/:sessionId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      await sessionService.deleteSession(sessionId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /v1/sessions/:sessionId/messages
   * Get chat history for a session
   */
  router.get('/:sessionId/messages', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const messages = await sessionService.getMessages(sessionId);
      res.json({ messages });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
