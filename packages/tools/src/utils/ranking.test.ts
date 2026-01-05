/**
 * Ranking Utilities Tests
 */

import { describe, it, expect } from 'vitest';
import {
  scoreCommit,
  rankCommits,
  selectTopCandidates,
  filterCommitsByPaths,
  analyzeQuery,
} from './ranking.js';
import type { CommitSummary } from '@chromium-search/shared';

describe('scoreCommit', () => {
  it('should score title matches', () => {
    const commit: CommitSummary = {
      sha: 'abc123',
      title: 'Fix network timeout bug',
      url: 'https://example.com/abc123',
    };

    const result = scoreCommit(commit, { query: 'network timeout' });

    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons.some(r => r.includes('title match'))).toBe(true);
  });

  it('should score message matches', () => {
    const commit: CommitSummary = {
      sha: 'abc123',
      title: 'Minor fix',
      messageSnippet: 'This fixes the network timeout issue in HTTP client',
      url: 'https://example.com/abc123',
    };

    const result = scoreCommit(commit, { query: 'HTTP client' });

    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons.some(r => r.includes('message match'))).toBe(true);
  });

  it('should boost for path scope hints', () => {
    const commit: CommitSummary = {
      sha: 'abc123',
      title: 'Update net module code',
      url: 'https://example.com/abc123',
    };

    const resultWithScope = scoreCommit(commit, {
      query: 'update code',
      pathScope: ['net/'],
    });

    const resultWithoutScope = scoreCommit(commit, {
      query: 'update code',
    });

    expect(resultWithScope.score).toBeGreaterThan(resultWithoutScope.score);
  });

  it('should return empty reasons for no matches', () => {
    const commit: CommitSummary = {
      sha: 'abc123',
      title: 'Unrelated change',
      url: 'https://example.com/abc123',
    };

    const result = scoreCommit(commit, { query: 'network timeout bug' });

    expect(result.reasons.filter(r => r.includes('match'))).toHaveLength(0);
  });
});

describe('rankCommits', () => {
  it('should rank commits by relevance', () => {
    const commits: CommitSummary[] = [
      { sha: 'aaa', title: 'Unrelated change', url: '' },
      { sha: 'bbb', title: 'Fix network timeout', url: '' },
      { sha: 'ccc', title: 'Network refactor', url: '' },
    ];

    const ranked = rankCommits(commits, { query: 'network timeout' });

    expect(ranked[0].sha).toBe('bbb'); // Most relevant
    expect(ranked.length).toBe(3);
  });

  it('should include scores and reasons', () => {
    const commits: CommitSummary[] = [
      { sha: 'abc', title: 'Fix bug', url: '' },
    ];

    const ranked = rankCommits(commits, { query: 'bug fix' });

    expect(ranked[0]).toHaveProperty('sha');
    expect(ranked[0]).toHaveProperty('score');
    expect(ranked[0]).toHaveProperty('reason');
  });
});

describe('selectTopCandidates', () => {
  it('should select top N candidates', () => {
    const ranked = [
      { sha: 'a', score: 0.9, reason: '' },
      { sha: 'b', score: 0.8, reason: '' },
      { sha: 'c', score: 0.7, reason: '' },
      { sha: 'd', score: 0.6, reason: '' },
    ];

    const top = selectTopCandidates(ranked, 2);

    expect(top).toHaveLength(2);
    expect(top[0].sha).toBe('a');
    expect(top[1].sha).toBe('b');
  });

  it('should filter by minimum score', () => {
    const ranked = [
      { sha: 'a', score: 0.9, reason: '' },
      { sha: 'b', score: 0.5, reason: '' },
      { sha: 'c', score: 0.3, reason: '' },
    ];

    const top = selectTopCandidates(ranked, 10, 0.5);

    expect(top).toHaveLength(2);
    expect(top.every(c => c.score >= 0.5)).toBe(true);
  });
});

describe('filterCommitsByPaths', () => {
  it('should filter commits by path scope', () => {
    const commits = [
      { sha: 'a', filesChanged: ['net/http/client.cc', 'net/http/server.cc'] },
      { sha: 'b', filesChanged: ['base/memory.cc'] },
      { sha: 'c', filesChanged: ['net/dns/resolver.cc'] },
    ];

    const filtered = filterCommitsByPaths(commits, ['net/http/']);

    expect(filtered).toEqual(['a']);
  });

  it('should return all commits if no path scope', () => {
    const commits = [
      { sha: 'a', filesChanged: ['net/http/client.cc'] },
      { sha: 'b', filesChanged: ['base/memory.cc'] },
    ];

    const filtered = filterCommitsByPaths(commits, []);

    expect(filtered).toEqual(['a', 'b']);
  });

  it('should handle commits without file info', () => {
    const commits = [
      { sha: 'a' },
      { sha: 'b', filesChanged: ['net/http/client.cc'] },
    ];

    const filtered = filterCommitsByPaths(commits, ['net/']);

    expect(filtered).toEqual(['b']);
  });
});

describe('analyzeQuery', () => {
  it('should detect regression queries', () => {
    const analysis = analyzeQuery('Why did the test start failing?');

    expect(analysis.isRegressionQuery).toBe(true);
  });

  it('should detect summary queries', () => {
    const analysis = analyzeQuery('What changed in this range?');

    expect(analysis.isSummaryQuery).toBe(true);
  });

  it('should detect file queries', () => {
    const analysis = analyzeQuery('What changed in the .cc files?');

    expect(analysis.isFileQuery).toBe(true);
  });

  it('should extract potential paths', () => {
    const analysis = analyzeQuery('Changes in net/http/client.cc');

    expect(analysis.potentialPaths).toContain('net/http/client.cc');
  });

  it('should extract potential symbols', () => {
    const analysis = analyzeQuery('What happened to HttpClient class?');

    expect(analysis.potentialSymbols).toContain('HttpClient');
  });

  it('should extract snake_case symbols', () => {
    const analysis = analyzeQuery('Changes to http_client_impl');

    expect(analysis.potentialSymbols).toContain('http_client_impl');
  });

  it('should tokenize query', () => {
    const analysis = analyzeQuery('Fix the network bug');

    expect(analysis.keywords).toContain('fix');
    expect(analysis.keywords).toContain('network');
    expect(analysis.keywords).toContain('bug');
  });
});
