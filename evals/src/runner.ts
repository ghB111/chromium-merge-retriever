/**
 * Evaluation Runner
 * Runs evaluation cases and reports metrics
 */

import {
  createLogger,
  createTimer,
  type Evidence,
  type SessionScope,
} from '@chromium-search/shared';

import { getOrchestrator } from '@chromium-search/agent';
import { evalCases, getQuickCases, type EvalCase } from './dataset.js';

// ============================================================================
// Types
// ============================================================================

interface EvalResult {
  caseId: string;
  caseName: string;
  success: boolean;
  latencyMs: number;
  latencyCategory: 'fast' | 'deep' | 'timeout';
  evidenceFound: boolean;
  evidenceCount: number;
  matchedPatterns: string[];
  error?: string;
}

interface EvalReport {
  timestamp: string;
  totalCases: number;
  passed: number;
  failed: number;
  byCategory: Record<string, { total: number; passed: number }>;
  byLatency: {
    fast: { count: number; avgMs: number };
    deep: { count: number; avgMs: number };
    timeout: number;
  };
  results: EvalResult[];
}

// ============================================================================
// Evaluation Logic
// ============================================================================

const logger = createLogger('EvalRunner');

/**
 * Check if evidence matches expected patterns
 */
function checkEvidence(
  evidence: Evidence[],
  expected: EvalCase['expectedEvidence']
): { matched: boolean; matchedPatterns: string[] } {
  const matchedPatterns: string[] = [];

  for (const pattern of expected.patterns) {
    let matched = false;

    for (const ev of evidence) {
      // Check type match
      if (pattern.type === 'commit' && ev.type !== 'commit') continue;
      if (pattern.type === 'diff' && ev.type !== 'diff_excerpt') continue;
      if (pattern.type === 'file' && ev.type !== 'file_excerpt') continue;

      // Check contains patterns
      if (pattern.contains && pattern.contains.length > 0) {
        const content = JSON.stringify(ev).toLowerCase();
        if (pattern.contains.some(c => content.includes(c.toLowerCase()))) {
          matched = true;
        }
      }

      // Check path patterns
      if (pattern.pathContains && pattern.pathContains.length > 0) {
        let path = '';
        if (ev.type === 'commit') {
          // Check if whyRelevant mentions the path
          path = ev.whyRelevant.toLowerCase();
        } else if (ev.type === 'diff_excerpt') {
          path = ev.file.toLowerCase();
        } else if (ev.type === 'file_excerpt') {
          path = ev.path.toLowerCase();
        }

        if (pattern.pathContains.some(p => path.includes(p.toLowerCase()))) {
          matched = true;
        }
      }

      // If no specific requirements, just having evidence of the right type counts
      if (!pattern.contains?.length && !pattern.pathContains?.length) {
        matched = true;
      }

      if (matched) break;
    }

    if (matched) {
      matchedPatterns.push(`${pattern.type}:${pattern.contains?.join(',') || pattern.pathContains?.join(',') || 'any'}`);
    }
  }

  // Success if at least one pattern matched
  return {
    matched: matchedPatterns.length > 0,
    matchedPatterns,
  };
}

/**
 * Run a single evaluation case
 */
async function runCase(evalCase: EvalCase, testScope?: SessionScope): Promise<EvalResult> {
  const timer = createTimer();

  try {
    const orchestrator = getOrchestrator();

    // Build scope
    const scope: SessionScope = testScope || {
      rangeEnabled: evalCase.scope?.rangeEnabled ?? true,
      range: evalCase.scope?.rangeUrl ? null : { startSha: 'HEAD~100', endSha: 'HEAD' },
      pathScope: evalCase.scope?.pathScope ?? [],
    };

    // Run the agent
    const result = await orchestrator.run({
      sessionId: `eval_${evalCase.id}`,
      scope,
      query: evalCase.query,
      includeDebug: true,
    });

    const latencyMs = timer.elapsed();

    // Check evidence
    const { matched, matchedPatterns } = checkEvidence(result.evidence, evalCase.expectedEvidence);

    // Determine latency category
    let latencyCategory: 'fast' | 'deep' | 'timeout' = 'deep';
    if (latencyMs < 20000) {
      latencyCategory = 'fast';
    } else if (latencyMs > 120000) {
      latencyCategory = 'timeout';
    }

    // Success criteria
    const latencyOk = evalCase.expectedLatency === 'deep' 
      ? latencyCategory !== 'timeout'
      : latencyCategory === 'fast';

    return {
      caseId: evalCase.id,
      caseName: evalCase.name,
      success: matched && latencyOk,
      latencyMs,
      latencyCategory,
      evidenceFound: result.evidence.length > 0,
      evidenceCount: result.evidence.length,
      matchedPatterns,
    };
  } catch (error) {
    return {
      caseId: evalCase.id,
      caseName: evalCase.name,
      success: false,
      latencyMs: timer.elapsed(),
      latencyCategory: 'timeout',
      evidenceFound: false,
      evidenceCount: 0,
      matchedPatterns: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Run all evaluation cases
 */
async function runEvaluation(
  cases: EvalCase[],
  testScope?: SessionScope
): Promise<EvalReport> {
  const results: EvalResult[] = [];

  logger.info({ caseCount: cases.length }, 'Starting evaluation');

  for (const evalCase of cases) {
    logger.info({ caseId: evalCase.id, name: evalCase.name }, 'Running case');
    const result = await runCase(evalCase, testScope);
    results.push(result);

    logger.info(
      {
        caseId: result.caseId,
        success: result.success,
        latencyMs: result.latencyMs,
        evidenceCount: result.evidenceCount,
      },
      result.success ? 'Case passed' : 'Case failed'
    );
  }

  // Compute report
  const byCategory: Record<string, { total: number; passed: number }> = {};
  const byLatencyFast: number[] = [];
  const byLatencyDeep: number[] = [];
  let timeoutCount = 0;

  for (const result of results) {
    const cat = cases.find(c => c.id === result.caseId)?.category ?? 'general';
    if (!byCategory[cat]) {
      byCategory[cat] = { total: 0, passed: 0 };
    }
    byCategory[cat].total++;
    if (result.success) byCategory[cat].passed++;

    if (result.latencyCategory === 'fast') {
      byLatencyFast.push(result.latencyMs);
    } else if (result.latencyCategory === 'deep') {
      byLatencyDeep.push(result.latencyMs);
    } else {
      timeoutCount++;
    }
  }

  const avgFast = byLatencyFast.length > 0
    ? byLatencyFast.reduce((a, b) => a + b, 0) / byLatencyFast.length
    : 0;
  const avgDeep = byLatencyDeep.length > 0
    ? byLatencyDeep.reduce((a, b) => a + b, 0) / byLatencyDeep.length
    : 0;

  return {
    timestamp: new Date().toISOString(),
    totalCases: results.length,
    passed: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    byCategory,
    byLatency: {
      fast: { count: byLatencyFast.length, avgMs: Math.round(avgFast) },
      deep: { count: byLatencyDeep.length, avgMs: Math.round(avgDeep) },
      timeout: timeoutCount,
    },
    results,
  };
}

/**
 * Print evaluation report
 */
function printReport(report: EvalReport): void {
  console.log('\n========================================');
  console.log('       EVALUATION REPORT');
  console.log('========================================\n');

  console.log(`Timestamp: ${report.timestamp}`);
  console.log(`Total Cases: ${report.totalCases}`);
  console.log(`Passed: ${report.passed} (${((report.passed / report.totalCases) * 100).toFixed(1)}%)`);
  console.log(`Failed: ${report.failed}`);

  console.log('\n--- By Category ---');
  for (const [cat, stats] of Object.entries(report.byCategory)) {
    const pct = ((stats.passed / stats.total) * 100).toFixed(1);
    console.log(`  ${cat}: ${stats.passed}/${stats.total} (${pct}%)`);
  }

  console.log('\n--- Latency ---');
  console.log(`  Fast (<20s): ${report.byLatency.fast.count} cases, avg ${report.byLatency.fast.avgMs}ms`);
  console.log(`  Deep (20-120s): ${report.byLatency.deep.count} cases, avg ${report.byLatency.deep.avgMs}ms`);
  console.log(`  Timeout (>120s): ${report.byLatency.timeout} cases`);

  console.log('\n--- Results ---');
  for (const result of report.results) {
    const status = result.success ? '✓' : '✗';
    console.log(`  ${status} ${result.caseId}: ${result.caseName}`);
    console.log(`      Latency: ${result.latencyMs}ms (${result.latencyCategory})`);
    console.log(`      Evidence: ${result.evidenceCount} items`);
    if (result.matchedPatterns.length > 0) {
      console.log(`      Matched: ${result.matchedPatterns.join(', ')}`);
    }
    if (result.error) {
      console.log(`      Error: ${result.error}`);
    }
  }

  console.log('\n========================================\n');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const quick = args.includes('--quick');

  // Set up environment
  process.env.LOG_LEVEL = 'warn';
  process.env.DEBUG_ENABLED = 'true';

  const cases = quick ? getQuickCases() : evalCases;

  console.log(`Running ${cases.length} evaluation cases (${quick ? 'quick' : 'full'} mode)...`);

  const report = await runEvaluation(cases);
  printReport(report);

  // Exit with error if any failures
  process.exit(report.failed > 0 ? 1 : 0);
}

main().catch(console.error);

export { runEvaluation, runCase, printReport };
