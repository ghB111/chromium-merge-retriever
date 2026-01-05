/**
 * Ranking utilities for commit candidate selection
 */

import {
  CommitSummary,
  RankedCandidate,
  tokenize,
  calculateJaccardSimilarity,
  matchesPathScope,
} from '@chromium-search/shared';

// ============================================================================
// Scoring Configuration
// ============================================================================

export interface ScoringWeights {
  titleMatch: number;
  messageMatch: number;
  pathBoost: number;
  recencyBoost: number;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  titleMatch: 0.4,
  messageMatch: 0.3,
  pathBoost: 0.2,
  recencyBoost: 0.1,
};

// ============================================================================
// Heuristic Scorer
// ============================================================================

export interface RankingOptions {
  query: string;
  pathScope?: string[];
  weights?: Partial<ScoringWeights>;
}

/**
 * Score a single commit against a query
 */
export function scoreCommit(
  commit: CommitSummary,
  options: RankingOptions
): { score: number; reasons: string[] } {
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const queryTokens = new Set(tokenize(options.query));
  const reasons: string[] = [];
  let score = 0;

  // Title matching
  const titleTokens = new Set(tokenize(commit.title));
  const titleSimilarity = calculateJaccardSimilarity(queryTokens, titleTokens);
  if (titleSimilarity > 0) {
    score += titleSimilarity * weights.titleMatch;
    reasons.push(`title match (${(titleSimilarity * 100).toFixed(0)}%)`);
  }

  // Message snippet matching
  if (commit.messageSnippet) {
    const messageTokens = new Set(tokenize(commit.messageSnippet));
    const messageSimilarity = calculateJaccardSimilarity(queryTokens, messageTokens);
    if (messageSimilarity > 0) {
      score += messageSimilarity * weights.messageMatch;
      reasons.push(`message match (${(messageSimilarity * 100).toFixed(0)}%)`);
    }
  }

  // Path scope boosting (if we had file info, which we don't at summary level)
  // This will be more useful after getting commit details
  if (options.pathScope && options.pathScope.length > 0) {
    // Check if any path scope keywords appear in title or message
    const pathKeywords = options.pathScope.flatMap((p) => 
      p.replace(/\/$/, '').split('/').filter((s) => s.length > 2)
    );
    const combinedText = `${commit.title} ${commit.messageSnippet || ''}`.toLowerCase();
    const pathMatches = pathKeywords.filter((kw) => combinedText.includes(kw.toLowerCase()));
    if (pathMatches.length > 0) {
      score += weights.pathBoost * (pathMatches.length / pathKeywords.length);
      reasons.push(`path hint: ${pathMatches.join(', ')}`);
    }
  }

  // Recency boost (newer commits get slight boost)
  // This is a placeholder - could be enhanced with actual date parsing
  score += weights.recencyBoost * 0.5; // Base recency

  return { score, reasons };
}

/**
 * Rank commits by relevance to a query
 */
export function rankCommits(
  commits: CommitSummary[],
  options: RankingOptions
): RankedCandidate[] {
  const scored = commits.map((commit) => {
    const { score, reasons } = scoreCommit(commit, options);
    return {
      sha: commit.sha,
      score,
      reason: reasons.join('; ') || 'no strong matches',
    };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored;
}

/**
 * Select top candidates from ranked list
 */
export function selectTopCandidates(
  ranked: RankedCandidate[],
  topN: number,
  minScore = 0
): RankedCandidate[] {
  return ranked
    .filter((c) => c.score >= minScore)
    .slice(0, topN);
}

// ============================================================================
// Path-based Filtering
// ============================================================================

/**
 * Filter commits by file paths (requires commit details)
 */
export function filterCommitsByPaths(
  commits: Array<{ sha: string; filesChanged?: string[] }>,
  pathScope: string[]
): string[] {
  if (pathScope.length === 0) {
    return commits.map((c) => c.sha);
  }

  return commits
    .filter((commit) => {
      if (!commit.filesChanged) return false;
      return commit.filesChanged.some((file) => matchesPathScope(file, pathScope));
    })
    .map((c) => c.sha);
}

// ============================================================================
// Query Analysis
// ============================================================================

export interface QueryAnalysis {
  keywords: string[];
  potentialPaths: string[];
  potentialSymbols: string[];
  isRegressionQuery: boolean;
  isSummaryQuery: boolean;
  isFileQuery: boolean;
}

const REGRESSION_INDICATORS = [
  'regression', 'broke', 'broken', 'fail', 'failing', 'crash', 'error',
  'bug', 'issue', 'problem', 'wrong', 'incorrect', 'caused', 'introduced',
];

const SUMMARY_INDICATORS = [
  'what changed', 'changes', 'summary', 'overview', 'list', 'all changes',
  'modifications', 'updates', 'commits',
];

const FILE_INDICATORS = [
  'file', 'path', 'directory', 'folder', '.cc', '.h', '.cpp', '.py', '.js',
  '.ts', '.java', '.gn', '.gni',
];

/**
 * Analyze a query to understand intent and extract useful information
 */
export function analyzeQuery(query: string): QueryAnalysis {
  const lowerQuery = query.toLowerCase();
  const tokens = tokenize(query);

  // Extract potential file paths (things that look like paths)
  const pathPattern = /(?:^|\s)([a-zA-Z_][a-zA-Z0-9_/.-]*\/[a-zA-Z0-9_/.-]+)/g;
  const potentialPaths: string[] = [];
  let match;
  while ((match = pathPattern.exec(query)) !== null) {
    potentialPaths.push(match[1]);
  }

  // Extract potential symbols (CamelCase or snake_case identifiers)
  const symbolPattern = /\b([A-Z][a-zA-Z0-9]+|[a-z]+_[a-z_]+)\b/g;
  const potentialSymbols: string[] = [];
  while ((match = symbolPattern.exec(query)) !== null) {
    if (match[1].length > 3) {
      potentialSymbols.push(match[1]);
    }
  }

  // Determine query type
  const isRegressionQuery = REGRESSION_INDICATORS.some((ind) => lowerQuery.includes(ind));
  const isSummaryQuery = SUMMARY_INDICATORS.some((ind) => lowerQuery.includes(ind));
  const isFileQuery = FILE_INDICATORS.some((ind) => lowerQuery.includes(ind)) || 
                     potentialPaths.length > 0;

  return {
    keywords: tokens,
    potentialPaths,
    potentialSymbols,
    isRegressionQuery,
    isSummaryQuery,
    isFileQuery,
  };
}
