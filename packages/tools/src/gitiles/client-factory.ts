/**
 * Repository Client Factory
 * Provides the appropriate repository client based on configuration
 */

import { getConfig, createLogger } from '@chromium-search/shared';

import type { IRepositoryClient } from './repository.js';
import type { Cache } from './cache.js';
import { GitilesClient } from './client.js';
import { LocalGitClient } from './local-git-client.js';

// ============================================================================
// Factory
// ============================================================================

let repositoryClientInstance: IRepositoryClient | null = null;
const logger = createLogger('RepositoryClientFactory');

/**
 * Get the repository client based on configuration.
 * Returns either a GitilesClient or LocalGitClient depending on REPO_SOURCE env var.
 * 
 * @param cache Optional cache instance to use
 * @returns The appropriate repository client implementation
 */
export function getRepositoryClient(cache?: Cache): IRepositoryClient {
  if (!repositoryClientInstance) {
    const config = getConfig();
    const sourceType = config.repositorySource.type;

    logger.info({ sourceType }, 'Initializing repository client');

    if (sourceType === 'local') {
      repositoryClientInstance = new LocalGitClient(cache);
      logger.info({ 
        checkoutPath: config.repositorySource.localCheckoutPath,
        batchSize: config.repositorySource.localGitBatchSize
      }, 'Using local git client');
    } else {
      repositoryClientInstance = new GitilesClient(cache);
      logger.info({ 
        baseUrl: config.gitiles.baseUrl,
        repoPath: config.gitiles.repoPath
      }, 'Using Gitiles client');
    }
  }

  return repositoryClientInstance;
}

/**
 * Reset the repository client instance.
 * Useful for testing or when configuration changes.
 */
export function resetRepositoryClient(): void {
  repositoryClientInstance = null;
}

/**
 * Check if the current repository source is local.
 */
export function isLocalRepositorySource(): boolean {
  return getConfig().repositorySource.isLocal;
}

/**
 * Check if the current repository source is gitiles.
 */
export function isGitilesRepositorySource(): boolean {
  return getConfig().repositorySource.isGitiles;
}
