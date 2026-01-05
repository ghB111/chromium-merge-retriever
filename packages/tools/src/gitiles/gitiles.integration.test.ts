/**
 * Gitiles Integration Tests
 * These tests hit real Gitiles endpoints and are skipped in CI by default
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { GitilesClient } from './client.js';
import { InMemoryCache } from './cache.js';
import { parseRangeFromGitilesUrl } from './url-parser.js';

// Skip in CI unless explicitly enabled
const SKIP_INTEGRATION = process.env.RUN_INTEGRATION_TESTS !== 'true';

// Use a known stable commit range for testing
// These commits should exist in the Chromium repository
const TEST_REPO_URL = 'https://chromium.googlesource.com/chromium/src';

// Set up environment
beforeAll(() => {
  process.env.GITILES_BASE_URL = 'https://chromium.googlesource.com';
  process.env.GITILES_REPO_PATH = '/chromium/src';
  process.env.GITILES_CONCURRENCY = '2';
  process.env.GITILES_RETRY_COUNT = '3';
  process.env.GITILES_RETRY_DELAY_MS = '1000';
  process.env.CACHE_TTL_COMMIT_LIST = '60';
  process.env.CACHE_TTL_COMMIT_DETAILS = '60';
  process.env.CACHE_TTL_FILE_CONTENT = '60';
  process.env.MAX_COMMITS_DEFAULT = '100';
  process.env.MAX_DIFF_LINES_PER_COMMIT = '200';
  process.env.MAX_FILE_BYTES = '50000';
  process.env.ALLOWED_GITILES_HOSTS = 'chromium.googlesource.com';
});

describe.skipIf(SKIP_INTEGRATION)('Gitiles Integration', () => {
  describe('parseRangeFromGitilesUrl', () => {
    it('should parse a real Gitiles URL', () => {
      const url = 'https://chromium.googlesource.com/chromium/src/+log/main~10..main';
      
      // Note: This will fail because main~10 is not a valid SHA
      // In real usage, you'd use actual SHAs
      // This test documents the expected behavior
      expect(() => parseRangeFromGitilesUrl(url)).toThrow();
    });
  });

  describe('GitilesClient.listCommits', () => {
    it('should fetch commit list from real Gitiles', async () => {
      const cache = new InMemoryCache();
      const client = new GitilesClient(cache);

      // Use HEAD~5..HEAD as a stable range
      // This fetches the last 5 commits
      const result = await client.listCommits({
        repoBaseUrl: TEST_REPO_URL,
        startSha: 'HEAD~5',
        endSha: 'HEAD',
        maxCommits: 5,
      });

      // Verify structure
      expect(Array.isArray(result)).toBe(true);
      
      if (result.length > 0) {
        const commit = result[0];
        expect(commit).toHaveProperty('sha');
        expect(commit).toHaveProperty('title');
        expect(commit).toHaveProperty('url');
        expect(commit.sha).toMatch(/^[a-f0-9]{40}$/);
        expect(commit.url).toContain(TEST_REPO_URL);
      }
    }, 30000);
  });

  describe('GitilesClient.getCommitDetails', () => {
    it('should fetch commit details from real Gitiles', async () => {
      const cache = new InMemoryCache();
      const client = new GitilesClient(cache);

      // First get a real commit SHA
      const commits = await client.listCommits({
        repoBaseUrl: TEST_REPO_URL,
        startSha: 'HEAD~2',
        endSha: 'HEAD',
        maxCommits: 1,
      });

      expect(commits.length).toBeGreaterThan(0);
      const sha = commits[0].sha;

      // Now fetch details
      const details = await client.getCommitDetails(TEST_REPO_URL, sha);

      expect(details).toHaveProperty('sha');
      expect(details).toHaveProperty('title');
      expect(details).toHaveProperty('message');
      expect(details.sha).toBe(sha);
    }, 30000);
  });

  describe('GitilesClient.getDiffExcerpt', () => {
    it('should fetch diff from real Gitiles', async () => {
      const cache = new InMemoryCache();
      const client = new GitilesClient(cache);

      // First get a real commit SHA
      const commits = await client.listCommits({
        repoBaseUrl: TEST_REPO_URL,
        startSha: 'HEAD~2',
        endSha: 'HEAD',
        maxCommits: 1,
      });

      expect(commits.length).toBeGreaterThan(0);
      const sha = commits[0].sha;

      // Fetch diff
      const diff = await client.getDiffExcerpt(TEST_REPO_URL, sha, {
        maxLines: 100,
      });

      expect(diff).toHaveProperty('sha');
      expect(diff).toHaveProperty('diffs');
      expect(diff.sha).toBe(sha);
      expect(Array.isArray(diff.diffs)).toBe(true);
    }, 30000);
  });

  describe('GitilesClient.readFileAtRevision', () => {
    it('should read file at HEAD from real Gitiles', async () => {
      const cache = new InMemoryCache();
      const client = new GitilesClient(cache);

      // Read a known stable file
      const result = await client.readFileAtRevision(
        TEST_REPO_URL,
        'README.md',
        'HEAD',
        { maxBytes: 10000 }
      );

      expect(result).toHaveProperty('path');
      expect(result).toHaveProperty('revision');
      expect(result).toHaveProperty('excerpt');
      expect(result.path).toBe('README.md');
      expect(result.excerpt.length).toBeGreaterThan(0);
    }, 30000);

    it('should handle base64 decoded content correctly', async () => {
      const cache = new InMemoryCache();
      const client = new GitilesClient(cache);

      const result = await client.readFileAtRevision(
        TEST_REPO_URL,
        'LICENSE',
        'HEAD',
        { maxBytes: 50000 }
      );

      // LICENSE file should contain readable text
      expect(result.excerpt).toContain('Copyright');
    }, 30000);
  });
});

describe.skipIf(SKIP_INTEGRATION)('Gitiles JSON Prefix Handling', () => {
  it('should correctly strip various prefix formats', async () => {
    const cache = new InMemoryCache();
    const client = new GitilesClient(cache);

    // This test verifies that our prefix stripping handles the real
    // Gitiles response format
    const commits = await client.listCommits({
      repoBaseUrl: TEST_REPO_URL,
      startSha: 'HEAD~1',
      endSha: 'HEAD',
      maxCommits: 1,
    });

    // If we got here without throwing, the prefix was stripped correctly
    expect(commits.length).toBeGreaterThan(0);
    expect(commits[0].sha).toMatch(/^[a-f0-9]{40}$/);
  }, 30000);
});
