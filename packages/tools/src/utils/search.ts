/**
 * Search utilities for searching within retrieved content
 */

// Search utilities

// ============================================================================
// Types
// ============================================================================

export interface SearchMatch {
  line: number;
  content: string;
  context: {
    before: string[];
    after: string[];
  };
}

export interface SearchResult {
  path: string;
  revision?: string;
  matches: SearchMatch[];
  totalMatches: number;
}

// ============================================================================
// Text Search
// ============================================================================

/**
 * Search for a pattern in text content
 */
export function searchInText(
  content: string,
  pattern: string | RegExp,
  options: { contextLines?: number; maxMatches?: number } = {}
): SearchMatch[] {
  const { contextLines = 2, maxMatches = 50 } = options;
  const lines = content.split('\n');
  const matches: SearchMatch[] = [];

  const regex = typeof pattern === 'string' 
    ? new RegExp(escapeRegex(pattern), 'gi')
    : pattern;

  for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
    if (regex.test(lines[i])) {
      matches.push({
        line: i + 1,
        content: lines[i],
        context: {
          before: lines.slice(Math.max(0, i - contextLines), i),
          after: lines.slice(i + 1, i + 1 + contextLines),
        },
      });
      // Reset regex lastIndex for next iteration
      regex.lastIndex = 0;
    }
  }

  return matches;
}

/**
 * Search across multiple files
 */
export function searchInFiles(
  files: Array<{ path: string; content: string; revision?: string }>,
  pattern: string | RegExp,
  options: { contextLines?: number; maxMatchesPerFile?: number; maxTotalMatches?: number } = {}
): SearchResult[] {
  const { maxMatchesPerFile = 20, maxTotalMatches = 100 } = options;
  const results: SearchResult[] = [];
  let totalFound = 0;

  for (const file of files) {
    if (totalFound >= maxTotalMatches) break;

    const remaining = maxTotalMatches - totalFound;
    const matches = searchInText(file.content, pattern, {
      ...options,
      maxMatches: Math.min(maxMatchesPerFile, remaining),
    });

    if (matches.length > 0) {
      results.push({
        path: file.path,
        revision: file.revision,
        matches,
        totalMatches: matches.length,
      });
      totalFound += matches.length;
    }
  }

  return results;
}

// ============================================================================
// Diff Search
// ============================================================================

export interface DiffSearchMatch {
  sha: string;
  file: string;
  line: number;
  content: string;
  isAddition: boolean;
  isDeletion: boolean;
}

/**
 * Search within diff content
 */
export function searchInDiffs(
  diffs: Array<{ sha: string; diffs: Array<{ file: string; excerpt: string }> }>,
  pattern: string | RegExp,
  options: { maxMatches?: number } = {}
): DiffSearchMatch[] {
  const { maxMatches = 100 } = options;
  const results: DiffSearchMatch[] = [];

  const regex = typeof pattern === 'string'
    ? new RegExp(escapeRegex(pattern), 'gi')
    : pattern;

  for (const commit of diffs) {
    if (results.length >= maxMatches) break;

    for (const fileDiff of commit.diffs) {
      if (results.length >= maxMatches) break;

      const lines = fileDiff.excerpt.split('\n');
      let lineNum = 0;

      for (const line of lines) {
        if (results.length >= maxMatches) break;

        // Skip diff headers
        if (line.startsWith('diff --git') || 
            line.startsWith('index ') || 
            line.startsWith('---') || 
            line.startsWith('+++')) {
          continue;
        }

        // Track line numbers from @@ headers
        const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
        if (hunkMatch) {
          lineNum = parseInt(hunkMatch[1], 10);
          continue;
        }

        if (regex.test(line)) {
          results.push({
            sha: commit.sha,
            file: fileDiff.file,
            line: lineNum,
            content: line,
            isAddition: line.startsWith('+'),
            isDeletion: line.startsWith('-'),
          });
          regex.lastIndex = 0;
        }

        if (!line.startsWith('-')) {
          lineNum++;
        }
      }
    }
  }

  return results;
}

// ============================================================================
// Utilities
// ============================================================================

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Highlight matches in text
 */
export function highlightMatches(
  text: string,
  pattern: string | RegExp,
  marker = '**'
): string {
  const regex = typeof pattern === 'string'
    ? new RegExp(`(${escapeRegex(pattern)})`, 'gi')
    : new RegExp(`(${pattern.source})`, pattern.flags.includes('i') ? 'gi' : 'g');

  return text.replace(regex, `${marker}$1${marker}`);
}

/**
 * Extract context around a match
 */
export function extractContext(
  content: string,
  matchIndex: number,
  contextChars = 100
): string {
  const start = Math.max(0, matchIndex - contextChars);
  const end = Math.min(content.length, matchIndex + contextChars);
  
  let result = content.slice(start, end);
  
  if (start > 0) result = '...' + result;
  if (end < content.length) result = result + '...';
  
  return result;
}
