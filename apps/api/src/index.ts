/**
 * Chromium Agentic Search API Server
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { PrismaClient } from '@prisma/client';
import { getConfig, createLogger } from '@chromium-search/shared';

import { createSessionsRouter, createMessagesRouter, createHealthRouter } from './routes/index.js';
import { errorHandler, requestLogger } from './middleware/index.js';

// ============================================================================
// Initialize
// ============================================================================

const config = getConfig();
const logger = createLogger('API');
const prisma = new PrismaClient();

// ============================================================================
// Create Express App
// ============================================================================

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: config.server.isDev ? '*' : undefined,
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Include-Debug'],
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: config.server.isDev ? 1000 : 60, // requests per minute
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
});
app.use(limiter);

// Body parsing
app.use(express.json({ limit: '16kb' }));

// Request logging
app.use(requestLogger);

// ============================================================================
// Routes
// ============================================================================

// Health checks (no auth required)
app.use('/health', createHealthRouter(prisma));

// API v1 routes
app.use('/v1/sessions', createSessionsRouter(prisma));
app.use('/v1/sessions', createMessagesRouter(prisma));

// ============================================================================
// Error Handling
// ============================================================================

app.use(errorHandler);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Endpoint not found',
    },
  });
});

// ============================================================================
// Start Server
// ============================================================================

async function main() {
  try {
    // Connect to database
    await prisma.$connect();
    logger.info('Connected to database');

    // Start server
    const server = app.listen(config.server.port, config.server.host, () => {
      logger.info(
        { host: config.server.host, port: config.server.port, env: config.server.nodeEnv },
        'Server started'
      );
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutting down...');
      server.close(async () => {
        await prisma.$disconnect();
        logger.info('Server stopped');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error({ error: String(error) }, 'Failed to start server');
    process.exit(1);
  }
}

main();

export { app, prisma };
