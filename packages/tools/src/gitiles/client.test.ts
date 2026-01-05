/**
 * Gitiles Client Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitilesClient } from './client.js';
import { InMemoryCache } from './cache.js';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Set up environment
beforeEach(() => {
  process.env.GITILES_BASE_URL = 'https://chromium.googlesource.com';
  process.env.GITILES_REPO_PATH = '/chromium/src';
  process.env.GITILES_CONCURRENCY = '4';
  process.env.GITILES_RETRY_COUNT = '1';
  process.env.GITILES_RETRY_DELAY_MS = '10';
  process.env.CACHE_TTL_COMMIT_LIST = '60';
  process.env.CACHE_TTL_COMMIT_DETAILS = '60';
  process.env.CACHE_TTL_FILE_CONTENT = '60';
  process.env.MAX_COMMITS_DEFAULT = '100';
  process.env.MAX_DIFF_LINES_PER_COMMIT = '100';
  process.env.MAX_FILE_BYTES = '1000';
  mockFetch.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GitilesClient', () => {
  describe('stripJsonPrefix', () => {
    it('should strip standard Gitiles JSON prefix', async () => {
      const cache = new InMemoryCache();
      const client = new GitilesClient(cache);

      const jsonWithPrefix = `)]}'\n{"log": [{"commit": "abc123"}]}`;
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(jsonWithPrefix),
      });

      const result = await client.listCommits({
        repoBaseUrl: 'https://chromium.googlesource.com/chromium/src',
        startSha: 'abc1234',
        endSha: 'def5678',
        maxCommits: 10,
      });

      expect(result).toHaveLength(1);
      expect(result[0].sha).toBe('abc123');
    });

    it('should handle JSON without prefix', async () => {
      const cache = new InMemoryCache();
      const client = new GitilesClient(cache);

      const jsonWithoutPrefix = `{"log": [{"commit": "abc123", "message": "Test commit"}]}`;
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(jsonWithoutPrefix),
      });

      const result = await client.listCommits({
        repoBaseUrl: 'https://chromium.googlesource.com/chromium/src',
        startSha: 'abc1234',
        endSha: 'def5678',
        maxCommits: 10,
      });

      expect(result).toHaveLength(1);
    });
  });

  describe('listCommits', () => {
    it('should parse commit list correctly', async () => {
      const cache = new InMemoryCache();
      const client = new GitilesClient(cache);

      const response = `)]}'\n{
        "log": [
          {
            "commit": "abc123456789",
            "message": "Fix bug in net module\\n\\nDetailed description here",
            "author": {"name": "John Doe", "email": "john@example.com", "time": "2024-01-15 10:00:00"},
            "committer": {"name": "Jane Doe", "email": "jane@example.com", "time": "2024-01-15 11:00:00"}
          },
          {
            "commit": "def987654321",
            "message": "Add feature X",
            "author": {"name": "Alice", "email": "alice@example.com"}
          }
        ]
      }`;
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(response),
      });

      const result = await client.listCommits({
        repoBaseUrl: 'https://chromium.googlesource.com/chromium/src',
        startSha: 'start123',
        endSha: 'end456',
        maxCommits: 10,
      });

      expect(result).toHaveLength(2);
      
      expect(result[0].sha).toBe('abc123456789');
      expect(result[0].title).toBe('Fix bug in net module');
      expect(result[0].author).toBe('John Doe');
      expect(result[0].committer).toBe('Jane Doe');
      expect(result[0].messageSnippet).toContain('Detailed description');
      
      expect(result[1].sha).toBe('def987654321');
      expect(result[1].title).toBe('Add feature X');
    });

    it('should handle pagination', async () => {
      const cache = new InMemoryCache();
      const client = new GitilesClient(cache);

      // First page
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(`)]}'\n{
          "log": [{"commit": "abc123", "message": "Commit 1"}],
          "next": "page2token"
        }`),
      });

      // Second page
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(`)]}'\n{
          "log": [{"commit": "def456", "message": "Commit 2"}]
        }`),
      });

      const result = await client.listCommits({
        repoBaseUrl: 'https://chromium.googlesource.com/chromium/src',
        startSha: 'start123',
        endSha: 'end456',
        maxCommits: 10,
      });

      expect(result).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should respect maxCommits limit', async () => {
      const cache = new InMemoryCache();
      const client = new GitilesClient(cache);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(`)]}'\n{
          "log": [
            {"commit": "abc1", "message": "1"},
            {"commit": "abc2", "message": "2"},
            {"commit": "abc3", "message": "3"},
            {"commit": "abc4", "message": "4"},
            {"commit": "abc5", "message": "5"}
          ]
        }`),
      });

      const result = await client.listCommits({
        repoBaseUrl: 'https://chromium.googlesource.com/chromium/src',
        startSha: 'start123',
        endSha: 'end456',
        maxCommits: 3,
      });

      expect(result).toHaveLength(3);
    });

    it('should use cache for subsequent calls', async () => {
      const cache = new InMemoryCache();
      const client = new GitilesClient(cache);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(`)]}'\n{"log": [{"commit": "abc123"}]}`),
      });

      // First call
      await client.listCommits({
        repoBaseUrl: 'https://chromium.googlesource.com/chromium/src',
        startSha: 'start123',
        endSha: 'end456',
        maxCommits: 10,
      });

      // Second call (should use cache)
      await client.listCommits({
        repoBaseUrl: 'https://chromium.googlesource.com/chromium/src',
        startSha: 'start123',
        endSha: 'end456',
        maxCommits: 10,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('getCommitDetails', () => {
    it('should parse commit details correctly', async () => {
      const cache = new InMemoryCache();
      const client = new GitilesClient(cache);

      const response = `)]}'\n{
        "commit": "abc123456789",
        "message": "Fix bug in net module\\n\\nDetailed description",
        "author": {"name": "John Doe", "time": "2024-01-15 10:00:00"},
        "committer": {"name": "Jane Doe", "time": "2024-01-15 11:00:00"},
        "tree_diff": [
          {"type": "modify", "old_path": "net/http/http.cc", "new_path": "net/http/http.cc"},
          {"type": "add", "new_path": "net/http/new_file.cc"}
        ]
      }`;
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(response),
      });

      const result = await client.getCommitDetails(
        'https://chromium.googlesource.com/chromium/src',
        'abc123456789'
      );

      expect(result.sha).toBe('abc123456789');
      expect(result.title).toBe('Fix bug in net module');
      expect(result.message).toContain('Detailed description');
      expect(result.author).toBe('John Doe');
      expect(result.filesChanged).toContain('net/http/http.cc');
      expect(result.filesChanged).toContain('net/http/new_file.cc');
    });
  });

  describe('error handling', () => {
    it('should handle 404 errors', async () => {
      const cache = new InMemoryCache();
      const client = new GitilesClient(cache);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(
        client.getCommitDetails(
          'https://chromium.googlesource.com/chromium/src',
          'nonexistent'
        )
      ).rejects.toThrow('Resource not found');
    });

    it('should handle rate limiting', async () => {
      const cache = new InMemoryCache();
      const client = new GitilesClient(cache);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });

      await expect(
        client.listCommits({
          repoBaseUrl: 'https://chromium.googlesource.com/chromium/src',
          startSha: 'start123',
          endSha: 'end456',
          maxCommits: 10,
        })
      ).rejects.toThrow('Rate limited');
    });

    it('should handle malformed JSON', async () => {
      const cache = new InMemoryCache();
      const client = new GitilesClient(cache);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('not valid json'),
      });

      await expect(
        client.listCommits({
          repoBaseUrl: 'https://chromium.googlesource.com/chromium/src',
          startSha: 'start123',
          endSha: 'end456',
          maxCommits: 10,
        })
      ).rejects.toThrow('Failed to parse');
    });
  });
});

describe('InMemoryCache', () => {
  it('should store and retrieve values', async () => {
    const cache = new InMemoryCache();
    
    await cache.set('key1', { data: 'test' }, 60);
    const result = await cache.get<{ data: string }>('key1');
    
    expect(result).toEqual({ data: 'test' });
  });

  it('should return null for missing keys', async () => {
    const cache = new InMemoryCache();
    const result = await cache.get('nonexistent');
    
    expect(result).toBeNull();
  });

  it('should expire entries', async () => {
    const cache = new InMemoryCache();
    
    await cache.set('key1', { data: 'test' }, 0); // 0 second TTL
    
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 10));
    
    const result = await cache.get('key1');
    expect(result).toBeNull();
  });

  it('should delete entries', async () => {
    const cache = new InMemoryCache();
    
    await cache.set('key1', { data: 'test' }, 60);
    await cache.delete('key1');
    
    const result = await cache.get('key1');
    expect(result).toBeNull();
  });

  it('should clear all entries', async () => {
    const cache = new InMemoryCache();
    
    await cache.set('key1', 'value1', 60);
    await cache.set('key2', 'value2', 60);
    await cache.clear();
    
    expect(await cache.get('key1')).toBeNull();
    expect(await cache.get('key2')).toBeNull();
  });
});
