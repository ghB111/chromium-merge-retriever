/**
 * Evaluation Dataset
 * Sample questions and expected evidence patterns
 */

export interface EvalCase {
  id: string;
  name: string;
  description: string;
  query: string;
  scope?: {
    rangeEnabled: boolean;
    rangeUrl?: string;
    pathScope?: string[];
  };
  expectedEvidence: {
    // At least one of these patterns should match
    patterns: Array<{
      type: 'commit' | 'file' | 'diff';
      contains?: string[];
      pathContains?: string[];
    }>;
  };
  expectedLatency: 'fast' | 'deep'; // fast < 20s, deep < 120s
  category: 'summary' | 'regression' | 'symbol' | 'file_change' | 'general';
}

/**
 * Sample evaluation cases
 * Note: These use placeholder SHAs and should be updated with real ones for actual evaluation
 */
export const evalCases: EvalCase[] = [
  // Summary queries
  {
    id: 'summary-1',
    name: 'Basic summary query',
    description: 'Test broad summary of changes in a range',
    query: 'What changed in this range?',
    scope: {
      rangeEnabled: true,
      // Use actual range for real evaluation
    },
    expectedEvidence: {
      patterns: [
        { type: 'commit', contains: [] }, // Expects at least one commit
      ],
    },
    expectedLatency: 'fast',
    category: 'summary',
  },
  {
    id: 'summary-2',
    name: 'Component-scoped summary',
    description: 'Test summary filtered to a specific path scope',
    query: 'What changes were made to the network stack?',
    scope: {
      rangeEnabled: true,
      pathScope: ['net/'],
    },
    expectedEvidence: {
      patterns: [
        { type: 'commit', pathContains: ['net/'] },
      ],
    },
    expectedLatency: 'fast',
    category: 'summary',
  },

  // Regression queries
  {
    id: 'regression-1',
    name: 'Test failure investigation',
    description: 'Investigate why a test might have started failing',
    query: 'Which commits might have caused test failures in the HTTP module?',
    scope: {
      rangeEnabled: true,
      pathScope: ['net/http/'],
    },
    expectedEvidence: {
      patterns: [
        { type: 'commit', pathContains: ['net/http/'] },
        { type: 'diff', pathContains: ['test'] },
      ],
    },
    expectedLatency: 'deep',
    category: 'regression',
  },
  {
    id: 'regression-2',
    name: 'Behavior change investigation',
    description: 'Find changes that might have affected behavior',
    query: 'What changes could have affected timeout handling?',
    scope: {
      rangeEnabled: true,
    },
    expectedEvidence: {
      patterns: [
        { type: 'commit', contains: ['timeout'] },
      ],
    },
    expectedLatency: 'deep',
    category: 'regression',
  },

  // Symbol lookup queries
  {
    id: 'symbol-1',
    name: 'Class lookup',
    description: 'Find information about a specific class',
    query: 'What changes were made to class HttpCache?',
    scope: {
      rangeEnabled: true,
    },
    expectedEvidence: {
      patterns: [
        { type: 'commit', contains: ['HttpCache'] },
        { type: 'diff', contains: ['HttpCache'] },
      ],
    },
    expectedLatency: 'deep',
    category: 'symbol',
  },
  {
    id: 'symbol-2',
    name: 'Function change lookup',
    description: 'Find changes to a specific function',
    query: 'Were there any changes to DoSomething function?',
    scope: {
      rangeEnabled: true,
    },
    expectedEvidence: {
      patterns: [
        { type: 'diff', contains: ['DoSomething'] },
      ],
    },
    expectedLatency: 'deep',
    category: 'symbol',
  },

  // File change queries
  {
    id: 'file-1',
    name: 'Specific file changes',
    description: 'Find changes to a specific file',
    query: 'What changes were made to base/memory.h?',
    scope: {
      rangeEnabled: true,
    },
    expectedEvidence: {
      patterns: [
        { type: 'commit', pathContains: ['base/memory'] },
        { type: 'diff', pathContains: ['base/memory'] },
      ],
    },
    expectedLatency: 'deep',
    category: 'file_change',
  },
  {
    id: 'file-2',
    name: 'Directory changes',
    description: 'Find all changes in a directory',
    query: 'What files were modified in the gpu/ directory?',
    scope: {
      rangeEnabled: true,
      pathScope: ['gpu/'],
    },
    expectedEvidence: {
      patterns: [
        { type: 'commit', pathContains: ['gpu/'] },
      ],
    },
    expectedLatency: 'fast',
    category: 'file_change',
  },

  // General queries
  {
    id: 'general-1',
    name: 'Author-based query',
    description: 'Find commits by a specific pattern in author/message',
    query: 'Were there any security-related changes?',
    scope: {
      rangeEnabled: true,
    },
    expectedEvidence: {
      patterns: [
        { type: 'commit', contains: ['security'] },
      ],
    },
    expectedLatency: 'fast',
    category: 'general',
  },
];

/**
 * Get evaluation cases by category
 */
export function getCasesByCategory(category: EvalCase['category']): EvalCase[] {
  return evalCases.filter(c => c.category === category);
}

/**
 * Get quick evaluation cases (fast latency only)
 */
export function getQuickCases(): EvalCase[] {
  return evalCases.filter(c => c.expectedLatency === 'fast');
}
