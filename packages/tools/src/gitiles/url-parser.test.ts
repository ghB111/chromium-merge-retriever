/**
 * URL Parser Tests
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  parseRangeFromGitilesUrl,
  buildGitilesLogUrl,
  buildCommitUrl,
  buildFileUrl,
  buildRawFileUrl,
  buildJsonLogUrl,
  buildJsonCommitUrl,
  buildDiffUrl,
  buildTextDiffUrl,
} from './url-parser.js';

// Set up environment for config
beforeAll(() => {
  process.env.ALLOWED_GITILES_HOSTS = 'chromium.googlesource.com';
});

describe('parseRangeFromGitilesUrl', () => {
  it('should parse a standard log URL', () => {
    const url = 'https://chromium.googlesource.com/chromium/src/+log/abc1234..def5678';
    const result = parseRangeFromGitilesUrl(url);

    expect(result.startSha).toBe('abc1234');
    expect(result.endSha).toBe('def5678');
    expect(result.repoBaseUrl).toBe('https://chromium.googlesource.com/chromium/src');
  });

  it('should parse URL with query parameters', () => {
    const url = 'https://chromium.googlesource.com/chromium/src/+log/abc1234..def5678?pretty=fuller';
    const result = parseRangeFromGitilesUrl(url);

    expect(result.startSha).toBe('abc1234');
    expect(result.endSha).toBe('def5678');
  });

  it('should parse URL with full 40-char SHAs', () => {
    const url = 'https://chromium.googlesource.com/chromium/src/+log/abc1234567890123456789012345678901234567..def1234567890123456789012345678901234567';
    const result = parseRangeFromGitilesUrl(url);

    expect(result.startSha).toBe('abc1234567890123456789012345678901234567');
    expect(result.endSha).toBe('def1234567890123456789012345678901234567');
  });

  it('should normalize SHAs to lowercase', () => {
    const url = 'https://chromium.googlesource.com/chromium/src/+log/ABC1234..DEF5678';
    const result = parseRangeFromGitilesUrl(url);

    expect(result.startSha).toBe('abc1234');
    expect(result.endSha).toBe('def5678');
  });

  it('should throw on invalid URL format', () => {
    expect(() => parseRangeFromGitilesUrl('not-a-url')).toThrow();
  });

  it('should throw on missing range', () => {
    const url = 'https://chromium.googlesource.com/chromium/src/+log/';
    expect(() => parseRangeFromGitilesUrl(url)).toThrow();
  });

  it('should throw on disallowed host', () => {
    const url = 'https://github.com/chromium/chromium/+log/abc1234..def5678';
    expect(() => parseRangeFromGitilesUrl(url)).toThrow();
  });

  it('should throw on invalid SHA (too short)', () => {
    const url = 'https://chromium.googlesource.com/chromium/src/+log/abc..def';
    expect(() => parseRangeFromGitilesUrl(url)).toThrow();
  });

  it('should throw on invalid SHA (non-hex)', () => {
    const url = 'https://chromium.googlesource.com/chromium/src/+log/ghijklm..nopqrst';
    expect(() => parseRangeFromGitilesUrl(url)).toThrow();
  });

  it('should throw on empty input', () => {
    expect(() => parseRangeFromGitilesUrl('')).toThrow();
  });
});

describe('URL builders', () => {
  const repoBaseUrl = 'https://chromium.googlesource.com/chromium/src';

  describe('buildGitilesLogUrl', () => {
    it('should build log URL', () => {
      const url = buildGitilesLogUrl(repoBaseUrl, 'abc1234', 'def5678');
      expect(url).toBe('https://chromium.googlesource.com/chromium/src/+log/abc1234..def5678');
    });
  });

  describe('buildCommitUrl', () => {
    it('should build commit URL', () => {
      const url = buildCommitUrl(repoBaseUrl, 'abc1234');
      expect(url).toBe('https://chromium.googlesource.com/chromium/src/+/abc1234');
    });
  });

  describe('buildFileUrl', () => {
    it('should build file URL', () => {
      const url = buildFileUrl(repoBaseUrl, 'abc1234', 'net/http/http_util.cc');
      expect(url).toBe('https://chromium.googlesource.com/chromium/src/+/abc1234/net/http/http_util.cc');
    });

    it('should handle leading slash in path', () => {
      const url = buildFileUrl(repoBaseUrl, 'abc1234', '/net/http/http_util.cc');
      expect(url).toBe('https://chromium.googlesource.com/chromium/src/+/abc1234/net/http/http_util.cc');
    });
  });

  describe('buildRawFileUrl', () => {
    it('should build raw file URL with format=TEXT', () => {
      const url = buildRawFileUrl(repoBaseUrl, 'abc1234', 'net/http/http_util.cc');
      expect(url).toBe('https://chromium.googlesource.com/chromium/src/+/abc1234/net/http/http_util.cc?format=TEXT');
    });
  });

  describe('buildJsonLogUrl', () => {
    it('should build JSON log URL', () => {
      const url = buildJsonLogUrl(repoBaseUrl, 'abc1234', 'def5678');
      expect(url).toBe('https://chromium.googlesource.com/chromium/src/+log/abc1234..def5678?format=JSON');
    });
  });

  describe('buildJsonCommitUrl', () => {
    it('should build JSON commit URL', () => {
      const url = buildJsonCommitUrl(repoBaseUrl, 'abc1234');
      expect(url).toBe('https://chromium.googlesource.com/chromium/src/+/abc1234?format=JSON');
    });
  });

  describe('buildDiffUrl', () => {
    it('should build diff URL', () => {
      const url = buildDiffUrl(repoBaseUrl, 'abc1234');
      expect(url).toBe('https://chromium.googlesource.com/chromium/src/+/abc1234^!');
    });
  });

  describe('buildTextDiffUrl', () => {
    it('should build text diff URL', () => {
      const url = buildTextDiffUrl(repoBaseUrl, 'abc1234');
      expect(url).toBe('https://chromium.googlesource.com/chromium/src/+/abc1234^!?format=TEXT');
    });
  });
});
