/**
 * Gitiles URL Parser
 * Parses Gitiles log URLs to extract commit range information
 */

import {
  ParsedRangeUrl,
  ValidationError,
  isValidSha,
  normalizeSha,
  isAllowedGitilesHost,
  getConfig,
} from '@chromium-search/shared';

// Pattern to match Gitiles log URLs with range
// Example: https://chromium.googlesource.com/chromium/src/+log/abc123..def456
const GITILES_LOG_RANGE_PATTERN = /\/\+log\/([a-fA-F0-9]{7,40})\.\.([a-fA-F0-9]{7,40})/;

// Pattern to match the repo base URL
// Example: https://chromium.googlesource.com/chromium/src
const REPO_BASE_PATTERN = /^(https?:\/\/[^/]+)(\/[^+]+)/;

/**
 * Parse a Gitiles log URL to extract the commit range
 * 
 * @param url - Gitiles log URL (e.g., https://chromium.googlesource.com/chromium/src/+log/A..B?pretty=fuller)
 * @returns Parsed range information
 * @throws ValidationError if URL is invalid
 */
export function parseRangeFromGitilesUrl(url: string): ParsedRangeUrl {
  if (!url || typeof url !== 'string') {
    throw new ValidationError('URL is required and must be a string');
  }

  const trimmedUrl = url.trim();

  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedUrl);
  } catch {
    throw new ValidationError('Invalid URL format', { url: trimmedUrl });
  }

  // Check allowed hosts
  const config = getConfig();
  if (!isAllowedGitilesHost(trimmedUrl, config.security.allowedGitilesHosts)) {
    throw new ValidationError('URL host is not allowed', {
      url: trimmedUrl,
      allowedHosts: config.security.allowedGitilesHosts,
    });
  }

  // Extract repo base URL
  const fullPath = parsedUrl.origin + parsedUrl.pathname;
  const repoMatch = fullPath.match(REPO_BASE_PATTERN);
  if (!repoMatch) {
    throw new ValidationError('Could not extract repository base URL', { url: trimmedUrl });
  }
  const repoBaseUrl = (repoMatch[1] + repoMatch[2].replace(/\/\+log\/.*$/, '')).replace(/\/$/, '');

  // Extract commit range
  const rangeMatch = parsedUrl.pathname.match(GITILES_LOG_RANGE_PATTERN);
  if (!rangeMatch) {
    throw new ValidationError(
      'Could not extract commit range from URL. Expected format: .../+log/<SHA1>..<SHA2>',
      { url: trimmedUrl }
    );
  }

  const [, startSha, endSha] = rangeMatch;

  // Validate SHAs
  if (!isValidSha(startSha)) {
    throw new ValidationError('Invalid start SHA', { sha: startSha });
  }
  if (!isValidSha(endSha)) {
    throw new ValidationError('Invalid end SHA', { sha: endSha });
  }

  return {
    startSha: normalizeSha(startSha),
    endSha: normalizeSha(endSha),
    repoBaseUrl,
  };
}

/**
 * Build a Gitiles log URL from a range
 * 
 * @param repoBaseUrl - Repository base URL
 * @param startSha - Start commit SHA
 * @param endSha - End commit SHA
 * @returns Gitiles log URL
 */
export function buildGitilesLogUrl(repoBaseUrl: string, startSha: string, endSha: string): string {
  return `${repoBaseUrl}/+log/${startSha}..${endSha}`;
}

/**
 * Build a Gitiles commit URL
 * 
 * @param repoBaseUrl - Repository base URL
 * @param sha - Commit SHA
 * @returns Gitiles commit URL
 */
export function buildCommitUrl(repoBaseUrl: string, sha: string): string {
  return `${repoBaseUrl}/+/${sha}`;
}

/**
 * Build a Gitiles file URL at a specific revision
 * 
 * @param repoBaseUrl - Repository base URL
 * @param revision - Commit SHA or HEAD
 * @param path - File path
 * @returns Gitiles file URL
 */
export function buildFileUrl(repoBaseUrl: string, revision: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
  return `${repoBaseUrl}/+/${revision}/${normalizedPath}`;
}

/**
 * Build a Gitiles raw file URL (for fetching content)
 * 
 * @param repoBaseUrl - Repository base URL
 * @param revision - Commit SHA or HEAD
 * @param path - File path
 * @returns Gitiles raw file URL with format=TEXT
 */
export function buildRawFileUrl(repoBaseUrl: string, revision: string, path: string): string {
  return `${buildFileUrl(repoBaseUrl, revision, path)}?format=TEXT`;
}

/**
 * Build a Gitiles JSON log URL
 * 
 * @param repoBaseUrl - Repository base URL
 * @param startSha - Start commit SHA
 * @param endSha - End commit SHA
 * @returns Gitiles log URL with JSON format
 */
export function buildJsonLogUrl(repoBaseUrl: string, startSha: string, endSha: string): string {
  return `${repoBaseUrl}/+log/${startSha}..${endSha}?format=JSON`;
}

/**
 * Build a Gitiles JSON commit URL
 * 
 * @param repoBaseUrl - Repository base URL
 * @param sha - Commit SHA
 * @returns Gitiles commit URL with JSON format
 */
export function buildJsonCommitUrl(repoBaseUrl: string, sha: string): string {
  return `${repoBaseUrl}/+/${sha}?format=JSON`;
}

/**
 * Build a Gitiles diff URL
 * 
 * @param repoBaseUrl - Repository base URL
 * @param sha - Commit SHA
 * @returns Gitiles diff URL
 */
export function buildDiffUrl(repoBaseUrl: string, sha: string): string {
  return `${repoBaseUrl}/+/${sha}^!`;
}

/**
 * Build a Gitiles diff URL with TEXT format
 * 
 * @param repoBaseUrl - Repository base URL
 * @param sha - Commit SHA
 * @returns Gitiles diff URL with TEXT format
 */
export function buildTextDiffUrl(repoBaseUrl: string, sha: string): string {
  return `${repoBaseUrl}/+/${sha}^!?format=TEXT`;
}
