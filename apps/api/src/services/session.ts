/**
 * Session Service
 * Manages chat sessions and their state
 */

import { PrismaClient } from '@prisma/client';
import {
  Session,
  SessionScope,
  CommitRange,
  NotFoundError,
  ValidationError,
  createLogger,
  type Logger,
  type LlmLog,
} from '@chromium-search/shared';

import { parseRangeFromGitilesUrl } from '@chromium-search/tools';

// ============================================================================
// Types
// ============================================================================

export interface CreateSessionResult {
  sessionId: string;
  scope: SessionScope;
}

export interface UpdateScopeRequest {
  rangeEnabled?: boolean;
  rangeUrl?: string;
  range?: CommitRange;
  pathScope?: string[];
}

// ============================================================================
// Session Service
// ============================================================================

export class SessionService {
  private prisma: PrismaClient;
  private logger: Logger;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.logger = createLogger('SessionService');
  }

  /**
   * Create a new session
   */
  async createSession(): Promise<CreateSessionResult> {
    const session = await this.prisma.session.create({
      data: {
        rangeEnabled: true,
        pathScope: [],
      },
    });

    this.logger.info({ sessionId: session.id }, 'Created new session');

    return {
      sessionId: session.id,
      scope: {
        rangeEnabled: session.rangeEnabled,
        range: null,
        pathScope: session.pathScope,
      },
    };
  }

  /**
   * Get a session by ID
   */
  async getSession(sessionId: string): Promise<Session> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new NotFoundError(`Session not found: ${sessionId}`);
    }

    return {
      sessionId: session.id,
      scope: {
        rangeEnabled: session.rangeEnabled,
        range: session.startSha && session.endSha
          ? { startSha: session.startSha, endSha: session.endSha }
          : null,
        pathScope: session.pathScope,
      },
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  /**
   * Update session scope
   */
  async updateScope(sessionId: string, request: UpdateScopeRequest): Promise<SessionScope> {
    // Verify session exists
    const existing = await this.prisma.session.findUnique({
      where: { id: sessionId },
    });

    if (!existing) {
      throw new NotFoundError(`Session not found: ${sessionId}`);
    }

    // Parse range from URL if provided
    let range: CommitRange | null = null;
    if (request.rangeUrl) {
      try {
        const parsed = parseRangeFromGitilesUrl(request.rangeUrl);
        range = { startSha: parsed.startSha, endSha: parsed.endSha };
      } catch (error) {
        throw new ValidationError(
          `Invalid range URL: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else if (request.range) {
      range = request.range;
    }

    // Validate: if rangeEnabled is true and we don't have a range
    const rangeEnabled = request.rangeEnabled ?? existing.rangeEnabled;
    if (rangeEnabled && !range && !existing.startSha) {
      // Only error if explicitly enabling range without providing one
      if (request.rangeEnabled === true && !request.rangeUrl && !request.range) {
        throw new ValidationError('Range is required when enabling range mode');
      }
    }

    // Update session
    const updated = await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        rangeEnabled: request.rangeEnabled ?? existing.rangeEnabled,
        startSha: range?.startSha ?? (request.rangeEnabled === false ? null : existing.startSha),
        endSha: range?.endSha ?? (request.rangeEnabled === false ? null : existing.endSha),
        pathScope: request.pathScope ?? existing.pathScope,
      },
    });

    this.logger.info({ sessionId, range, pathScope: updated.pathScope }, 'Updated session scope');

    return {
      rangeEnabled: updated.rangeEnabled,
      range: updated.startSha && updated.endSha
        ? { startSha: updated.startSha, endSha: updated.endSha }
        : null,
      pathScope: updated.pathScope,
    };
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      await this.prisma.session.delete({
        where: { id: sessionId },
      });
      this.logger.info({ sessionId }, 'Deleted session');
    } catch (error) {
      // Prisma throws if not found
      throw new NotFoundError(`Session not found: ${sessionId}`);
    }
  }

  /**
   * Add a message to a session
   */
  async addMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    runId?: string
  ): Promise<string> {
    const message = await this.prisma.message.create({
      data: {
        sessionId,
        role,
        content,
        runId,
      },
    });

    return message.id;
  }

  /**
   * Get messages for a session
   */
  async getMessages(sessionId: string): Promise<Array<{ role: string; content: string; createdAt: Date }>> {
    const messages = await this.prisma.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        content: true,
        createdAt: true,
      },
    });

    return messages;
  }

  /**
   * Record an agent run
   */
  async recordRun(
    sessionId: string,
    runId: string,
    queryHash: string,
    status: 'running' | 'completed' | 'failed',
    durationMs?: number,
    toolCallCount?: number,
    bytesUsed?: number,
    errorMessage?: string,
    llmLogs?: LlmLog[]
  ): Promise<void> {
    await this.prisma.agentRun.upsert({
      where: { id: runId },
      create: {
        id: runId,
        sessionId,
        queryHash,
        status,
        durationMs,
        toolCallCount,
        bytesUsed,
        errorMessage,
        completedAt: status !== 'running' ? new Date() : undefined,
        llmLogs: llmLogs ? {
          create: llmLogs.map(log => ({
            model: log.model,
            systemPrompt: log.systemPrompt,
            userPrompt: log.userPrompt,
            temperature: log.temperature,
            maxTokens: log.maxTokens,
            response: log.response,
            inputTokens: log.inputTokens,
            outputTokens: log.outputTokens,
            latencyMs: log.latencyMs,
            finishReason: log.finishReason,
          }))
        } : undefined
      },
      update: {
        status,
        durationMs,
        toolCallCount,
        bytesUsed,
        errorMessage,
        completedAt: status !== 'running' ? new Date() : undefined,
        llmLogs: llmLogs ? {
          create: llmLogs.map(log => ({
            model: log.model,
            systemPrompt: log.systemPrompt,
            userPrompt: log.userPrompt,
            temperature: log.temperature,
            maxTokens: log.maxTokens,
            response: log.response,
            inputTokens: log.inputTokens,
            outputTokens: log.outputTokens,
            latencyMs: log.latencyMs,
            finishReason: log.finishReason,
          }))
        } : undefined
      },
    });
  }
}

// ============================================================================
// Factory
// ============================================================================

let serviceInstance: SessionService | null = null;

export function getSessionService(prisma: PrismaClient): SessionService {
  if (!serviceInstance) {
    serviceInstance = new SessionService(prisma);
  }
  return serviceInstance;
}
