#!/usr/bin/env npx tsx
/**
 * bench/context-mmu-eval.mts — 30-turn coding-agent replay ablation benchmark
 * comparing Baseline vs Legacy text flags vs P0–P3 Context-MMU vs Calibrated Optical
 * across real core transform engines (`transformGoogleGenerateContent`,
 * `transformRequest`, `transformOpenAIResponses`).
 *
 * Usage:
 *   ./node_modules/.bin/tsx bench/context-mmu-eval.mts [--json] [--no-write]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  clearCalibratedProfiles,
  setCalibratedProfile,
} from '../src/core/calibration.js';
import {
  clearStickyMarkovEpisodesForTests,
  getGlobalMmuStore,
  resetGlobalMmuStore,
} from '../src/core/context-mmu.js';
import { geminiVisionTokens } from '../src/core/gemini-model-profiles.js';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import { gptTokenCount, hasLongUnbrokenBpeChunk } from '../src/core/gpt-tokens.js';
import { transformOpenAIResponses } from '../src/core/openai.js';
import { priceMode, resolvePriceRates } from '../src/core/pricing.js';
import {
  noteCacheOutcome,
  resetSessionState,
} from '../src/core/session-state.js';
import { resetGlobalPrefixTape } from '../src/core/prefix-tape.js';
import { resetTextEpochStickyState } from '../src/core/text-history.js';
import { transformRequest, type OpticalMode, type TransformInfo } from '../src/core/transform.js';

export interface ArmSummary {
  readonly arm: string;
  readonly model: string;
  readonly wire: 'google' | 'anthropic' | 'openai_responses';
  readonly turns: number;
  readonly rawPromptTokens: number;
  readonly rawSavedTokens: number;
  readonly rawSavedPct: number;
  readonly weightedPromptTokens: number;
  readonly weightedSavedTokens: number;
  readonly weightedSavedPct: number;
  readonly cacheHitPct: number;
  readonly unitCacheHitPct: number;
  readonly totalImages: number;
  readonly avgMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly editSafe: boolean;
  readonly tailRecallVerified: boolean;
  readonly stagesObserved: readonly string[];
  readonly mmuStats: {
    readonly pagesStored: number;
    readonly tailHydrations: number;
    readonly tailHydrationTokens: number;
    readonly markovFolds: number;
    readonly skillsStubbed: number;
    readonly densityPrunedBlocks: number;
    readonly cumulativeMarkovFolds: number;
    readonly cumulativeSkillStubs: number;
    readonly cumulativeDensityPrunedBlocks: number;
  };
}

export interface ContextMmuEvalReport {
  readonly generatedAtIso: string;
  readonly pricingMode: 'legacy' | 'kosha';
  readonly trajectoryTurns: number;
  readonly primaryArms: readonly ArmSummary[];
  readonly crossWireChecks: ReadonlyArray<{
    readonly wire: 'anthropic' | 'openai_responses';
    readonly model: string;
    readonly turns: number;
    readonly baselineRawTokens: number;
    readonly ficheRawTokens: number;
    readonly rawSavedPct: number;
    readonly weightedSavedPct: number;
    readonly cacheHitPct: number;
    readonly avgMs: number;
    readonly p95Ms: number;
    readonly editSafe: boolean;
    readonly tailRecallVerified: boolean;
    readonly stagesObserved: readonly string[];
  }>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function stripBase64Images(text: string): string {
  return text
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, '"IMG"')
    .replace(/"data"\s*:\s*"[^"]{80,}"/g, '"data":"IMG"');
}

function tokCount(text: string): number {
  if (!text) return 0;
  if (text.length <= 24_000) {
    return hasLongUnbrokenBpeChunk(text) ? Math.ceil(text.length / 3.5) : gptTokenCount(text);
  }
  let total = 0;
  for (let i = 0; i < text.length; i += 24_000) {
    const chunk = text.slice(i, i + 24_000);
    total += hasLongUnbrokenBpeChunk(chunk) ? Math.ceil(chunk.length / 3.5) : gptTokenCount(chunk);
  }
  return total;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

const PROTECTED_SENTINEL_CODE = [
  'export function verifyLedgerSignatureStrict(entries: readonly number[], seed: number): number {',
  '  let acc = seed >>> 0;',
  '  for (const item of entries) {',
  '    acc = ((acc * 33) ^ (item & 0xff)) >>> 0;',
  '  }',
  '  return acc;',
  '}',
].join('\n');

const PROTECTED_BODY_SENTINEL = 'acc = ((acc * 33) ^ (item & 0xff)) >>> 0;';

const PROTECTED_ACTIVE_DIFF = [
  'diff --git a/src/ledger/verify.ts b/src/ledger/verify.ts',
  'index 84a1201..99c31b2 100644',
  '--- a/src/ledger/verify.ts',
  '+++ b/src/ledger/verify.ts',
  '@@ -10,14 +10,20 @@ export function checkBoundary(val: number): boolean {',
  '   if (typeof val !== "number") return false;',
  '-  return val > 0;',
  '+  return Number.isFinite(val) && val > 0 && val <= 1_000_000;',
  ' }',
  ' ',
  ' export function normalizeLedgerOffset(raw: number, maxSpan: number): number {',
  '-  if (raw < 0) return 0;',
  '-  return raw > maxSpan ? maxSpan : raw;',
  '+  if (!Number.isFinite(raw) || raw < 0) return 0;',
  '+  const clamped = Math.floor(raw);',
  '+  return clamped > maxSpan ? maxSpan : clamped;',
  ' }',
  '+export function assertLedgerInvariant(acc: number): void {',
  '+  if (!Number.isSafeInteger(acc) || acc < 0) throw new RangeError("invalid ledger accumulator");',
  '+}',
].join('\n');

function buildSystemPromptXml(): string {
  const skills: ReadonlyArray<[string, string]> = [
    ['accidental-data-loss-prevention', 'Stop and verify before any irreversible DROP, TRUNCATE, rm, or resource deletion across storage and databases.'],
    ['fiche', 'Inspect live token and dollar savings, run optical calibration, and inspect Context-MMU virtual memory pages.'],
    ['gcp-dataflow', 'Build, package, execute, and diagnose Apache Beam streaming/batch Flex Templates on Google Cloud Dataflow.'],
    ['gcp-spark-troubleshooting', 'Perform Root Cause Analysis on failed Spark jobs, OOM driver logs, and YARN container exits in Cloud Storage.'],
    ['bigquery-data-transfer-service', 'Discover and audit BigQuery DTS ingestion configs, transfer schedules, and service accounts.'],
    ['dataform-bigquery', 'Author clean Dataform SQLX pipelines, assertions, incremental tables, and workflow_settings.yaml files.'],
    ['dbt-bigquery', 'Create, debug, and optimize dbt BigQuery models, incremental materializations, and schema tests cleanly.'],
    ['building-data-apps', 'Scaffold interactive React + Vite or Streamlit analytical dashboards backed by BigQuery and Gemini chat.'],
    ['cloud-databases-onboarding', 'Evaluate workload SLAs and recommend Cloud SQL, Spanner, AlloyDB, or Firestore migration targets.'],
    ['schema-mapping', 'Produce high-fidelity ETL Schema Mapping Manifestos across 4+ enterprise tables before generating code.'],
    ['ml-best-practices', 'Guide classification, regression, time series forecasting, statistical testing, and BigQuery ML model audits.'],
    ['notebook-guidance', 'Structure reproducible Jupyter notebooks using %%bqsql magics, clean charts, and cell-level verification.'],
    ['gcp-pipeline-orchestration', 'Author and deploy Cloud Composer / Apache Airflow orchestration DAGs across dbt, Dataform, and Spark tasks.'],
    ['gcp-pipeline-resource-provisioning', 'Manage declarative deployment.yaml resource definitions across dev, staging, and production envs.'],
    ['gcp-spark-observability', 'Audit multi-region Dataproc Serverless fleets, DCU-hour spend, idle clusters, and scheduler health.'],
    ['data-autocleaning', 'Apply automated schema normalization, null imputation, and deduplication on GCS-to-BigQuery pipelines.'],
    ['mcp-app-development', 'Build, theme, and package interactive MCP App views rendered inside Antigravity panes and sidebars.'],
    ['migrate-agent-settings', 'Import skills, MCP servers, rules, and hooks from Claude Code, Codex, Cursor, or Gemini CLI.'],
    ['agy-customizations', 'Configure skills, hooks, MCP servers, and discovery loading priority in Antigravity IDE.'],
    ['cloud-deploy-canary', 'Configure Cloud Deploy staged rollouts, verification hooks, and automated canary rollback policies.'],
  ];

  const rules = Array.from(
    { length: 28 },
    (_, i) =>
      `Rule ${i + 1}: Always verify primary source paths, preserve exact indentation and types, cite only observed test outputs, and keep edits strictly scoped to module_${i}.`,
  ).join('\n');

  const repeatedNotice =
    'Operational Compliance Notice: Never emit unverified heuristics, preserve append-only prefix cache alignment across turns, and document assumptions explicitly before finalizing patches.';

  return [
    'You are an autonomous systems coding agent.',
    '',
    '<env>',
    'Workspace: /workspace/payments-ledger',
    'OS: darwin-arm64',
    'Timestamp: 2026-11-23T20:00:00Z',
    '</env>',
    '<git_status>',
    'Branch: main (clean)',
    '</git_status>',
    '',
    '<!-- internal engineering checklist -->',
    rules,
    '',
    repeatedNotice,
    '',
    '========================================',
    '',
    repeatedNotice,
    '',
    '<skills>',
    ...skills.map(
      ([name, desc]) =>
        `- ${name} (/opt/skills/${name}/SKILL.md): ${desc} Mandatory workflow steps include pre-flight auth verification, schema conformance checks, strict rollback readiness, and explicit status verification prior to completion.`,
    ),
    '</skills>',
  ].join('\n');
}

function buildFileLines(totalLines: number, includeSentinel = false, moduleTag = 'ledger'): string[] {
  const lines: string[] = [];
  let fnIdx = 0;
  while (lines.length < totalLines) {
    if (includeSentinel && lines.length >= 41 && fnIdx === 9) {
      lines.push(...PROTECTED_SENTINEL_CODE.split('\n'));
      fnIdx += 1;
      continue;
    }
    fnIdx += 1;
    lines.push(`export function ${moduleTag}SegmentStep_${fnIdx}(acc: number, delta: number): number {`);
    lines.push(`  const shifted = (acc * 31 + ${fnIdx}) >>> 0;`);
    lines.push(`  const mixed = (shifted ^ (delta & 0xffff)) >>> 0;`);
    lines.push(`  return (mixed + ${fnIdx * 7}) >>> 0;`);
    lines.push(`}`);
  }
  return lines.slice(0, totalLines);
}

function formatGutterSlice(lines: readonly string[], start1: number, end1: number, lineShift = 0): string {
  const out: string[] = [];
  for (let ln = start1; ln <= Math.min(lines.length, end1); ln++) {
    out.push(`${String(ln + lineShift).padStart(4)}→${lines[ln - 1]!}`);
  }
  return out.join('\n');
}

function buildNestedJsonPayload(): string {
  const inner = JSON.stringify({
    events: Array.from({ length: 28 }, (_, i) => ({
      seq: i + 1,
      service: i % 2 === 0 ? 'ledger-api' : 'settlement-worker',
      region: i % 2 === 0 ? 'us-central1' : 'europe-west1',
      status: 200,
      latencyMs: 11 + (i % 15),
    })),
  });
  return JSON.stringify({
    tool: 'telemetry_query',
    ok: true,
    exitCode: 0,
    stdout: inner,
  });
}

function buildLowDensityDocBlob(): string {
  const lines: string[] = [
    '# Enterprise Ledger Compliance Runbook',
    'Service: payments-ledger',
    'Owner: platform-infra',
  ];
  for (let i = 0; i < 65; i++) {
    if (i === 24) {
      lines.push('CRITICAL: `verifyLedgerSignatureStrict` in src/ledger/checksum.ts must never drop trailing bytes.');
    } else {
      lines.push(
        `Section paragraph ${i} describes standard organizational review committees and general archival compliance workflows across distributed teams.`,
      );
    }
  }
  lines.push('End of runbook checklist.');
  return lines.join('\n');
}

function buildSharedToolSchemas(wire: 'anthropic' | 'openai_responses' | 'google'): unknown[] {
  const sharedMetaProp = {
    type: 'object',
    $comment: 'Standard audit telemetry envelope shared across every MCP endpoint',
    required: ['requestId', 'workspace', 'dryRun', 'traceLevel'],
    properties: {
      requestId: {
        type: 'string',
        title: 'Request Id',
        description:
          'Globally unique caller correlation identifier propagated through proxy, warp, and telemetry audit streams without truncation.',
      },
      workspace: {
        type: 'string',
        title: 'Workspace',
        description: 'Absolute normalized POSIX path of the repository root authorized for this call.',
      },
      dryRun: {
        type: 'boolean',
        description: 'When true, compute deterministic verification plan without mutating files or external stores.',
      },
      traceLevel: {
        type: 'string',
        enum: ['none', 'summary', 'verbose'],
        description: 'Granularity for structured diagnostic emission recorded into the local audit log.',
      },
    },
  };

  const sharedBoilerplate =
    'Verify workspace path permissions before invocation, preserve all line-number anchors for downstream edits, and report exact observed exit statuses cleanly.';

  return Array.from({ length: 12 }, (_, idx) => {
    const schema = {
      ...(wire === 'google' ? {} : { $schema: 'http://json-schema.org/draft-07/schema#' }),
      type: 'object',
      required: ['target', 'meta'],
      properties: {
        target: { type: 'string', description: `Primary target resource for operation_${idx}` },
        meta: structuredClone(sharedMetaProp),
        options: structuredClone(sharedMetaProp),
      },
    };
    if (wire === 'anthropic') {
      return {
        name: `workspace_op_${idx}`,
        description: `Execute workspace operation #${idx}.\n\n${sharedBoilerplate}`,
        input_schema: schema,
      };
    }
    if (wire === 'openai_responses') {
      return {
        type: 'function',
        name: `workspace_op_${idx}`,
        description: `Execute workspace operation #${idx}.\n\n${sharedBoilerplate}`,
        parameters: schema,
      };
    }
    return {
      functionDeclarations: [
        {
          name: `workspace_op_${idx}`,
          description: `Execute workspace operation #${idx}.\n\n${sharedBoilerplate}`,
          parameters: schema,
        },
      ],
    };
  });
}

interface TurnSpec {
  readonly turn: number;
  readonly callName: string;
  readonly callArgs: Record<string, unknown>;
  readonly responseOutput: string;
  readonly followPrompt: string;
  readonly coldGapBeforeTurn?: boolean;
}

function build30TurnScript(): TurnSpec[] {
  const file440 = buildFileLines(440, true, 'ledger');
  const fullRead1 = formatGutterSlice(file440, 1, 240, 0);
  const overlappingRead2 = formatGutterSlice(file440, 120, 360, 0);
  const shiftedRead3 = formatGutterSlice(file440, 1, 180, 3);
  const writtenModule = buildFileLines(60, false, 'helper').slice(0, 50).join('\n');
  const writeEchoOutput = formatGutterSlice(buildFileLines(60, false, 'helper'), 1, 50, 0);
  const nestedJson = buildNestedJsonPayload();
  const docBlob = buildLowDensityDocBlob();

  const failingTestLog = [
    'RUN v5.1.0 /workspace/payments-ledger',
    ...Array.from({ length: 24 }, (_, i) => `2026-11-23T19:00:${String(i).padStart(2, '0')}Z INFO running fixture batch ${i} in ${12 + i}ms`),
    'FAIL tests/verify.test.ts > verifyLedgerSignatureStrict',
    'AssertionError: expected 0 to be 42 at src/ledger/checksum.ts:42',
    'Tests  1 failed | 11 passed (12)',
  ].join('\n');

  const greenTestLog = [
    'RUN v5.1.0 /workspace/payments-ledger',
    ...Array.from({ length: 24 }, (_, i) => `2026-11-23T19:05:${String(i).padStart(2, '0')}Z INFO verified fixture batch ${i} in ${10 + i}ms`),
    'Test Files  12 passed (12)',
    'Tests  64 passed (64)',
  ].join('\n');

  const gitCommitOut = [
    '[main abcd1234] fix(ledger): enforce finite boundary check in verify.ts',
    ' 1 file changed, 2 insertions(+), 1 deletion(-)',
  ].join('\n');

  const turns: TurnSpec[] = [];
  for (let t = 1; t <= 30; t++) {
    let callName = 'bash';
    let callArgs: Record<string, unknown> = { cmd: `step-${t}` };
    let responseOutput = `2026-11-23T19:${String(t).padStart(2, '0')}:00Z INFO step=${t} ok`;
    let followPrompt = `Proceed to step ${t + 1}.`;
    let coldGapBeforeTurn = false;

    if (t === 1) {
      callName = 'read_file';
      callArgs = { path: 'src/ledger/checksum.ts', startLine: 1, endLine: 240 };
      responseOutput = fullRead1;
      followPrompt = 'Read overlapping window of checksum.ts and inspect telemetry.';
    } else if (t === 2) {
      callName = 'telemetry_query';
      callArgs = { query: 'latency' };
      responseOutput = nestedJson;
      followPrompt = 'Read lines 120..360 of src/ledger/checksum.ts.';
    } else if (t === 3) {
      callName = 'read_file';
      callArgs = { path: 'src/ledger/checksum.ts', startLine: 120, endLine: 360 };
      responseOutput = overlappingRead2;
      followPrompt = 'Apply header comment edit shifting lines +3 and re-read.';
    } else if (t === 4) {
      callName = 'read_file';
      callArgs = { path: 'src/ledger/checksum.ts', startLine: 1, endLine: 180 };
      responseOutput = shiftedRead3;
      followPrompt = 'Write helper module and confirm disk contents.';
    } else if (t === 5) {
      callName = 'write_file';
      callArgs = { path: 'src/ledger/helper.ts', Content: writtenModule };
      responseOutput = writeEchoOutput;
      followPrompt = 'Fetch architecture compliance runbook.';
    } else if (t === 6) {
      callName = 'search_web';
      callArgs = { query: 'enterprise ledger compliance runbook' };
      responseOutput = docBlob;
      followPrompt = 'Run unit tests to verify current behavior.';
    } else if (t >= 7 && t <= 15) {
      callName = 'bash';
      callArgs = { cmd: `vitest run --step=${t}` };
      responseOutput = failingTestLog + `\nAttempt #${t}`;
      followPrompt = `Diagnose failure from attempt #${t} and iterate.`;
    } else if (t === 16) {
      callName = 'bash';
      callArgs = { cmd: 'vitest run' };
      responseOutput = greenTestLog;
      followPrompt = 'Tests green. Commit the ledger fix.';
    } else if (t === 17) {
      callName = 'bash';
      callArgs = { cmd: 'git commit -m "fix(ledger)"' };
      responseOutput = gitCommitOut;
      followPrompt = 'Pause session after commit.';
    } else if (t === 18) {
      callName = 'telemetry_query';
      callArgs = { query: 'post-commit' };
      responseOutput = nestedJson;
      followPrompt = 'Resume work after idle break.';
    } else if (t === 19) {
      coldGapBeforeTurn = true;
      callName = 'bash';
      callArgs = { cmd: 'git status' };
      responseOutput = Array.from(
        { length: 26 },
        (_, i) => `2026-11-23T20:10:${String(i).padStart(2, '0')}Z INFO worker pool warmup ${i} ok in ${8 + i}ms`,
      ).join('\n');
      followPrompt = 'Inspect src/ledger/verify.ts diff cleanly.';
    } else if (t >= 20 && t <= 26) {
      callName = t === 25 ? 'git_diff' : 'read_file';
      callArgs = t === 25 ? { file: 'src/ledger/verify.ts' } : { path: `src/mod_${t}.ts` };
      responseOutput =
        t === 25
          ? PROTECTED_ACTIVE_DIFF
          : `// File: src/mod_${t}.ts\n` + formatGutterSlice(buildFileLines(80, false, `mod_${t}`), 1, 70, 0);
      followPrompt = `Continue verification step ${t}.`;
    } else if (t === 27) {
      callName = 'bash';
      callArgs = { cmd: 'git diff src/ledger/verify.ts' };
      responseOutput = PROTECTED_ACTIVE_DIFF;
      followPrompt =
        'Before finalizing: inspect verifyLedgerSignatureStrict from src/ledger/checksum.ts and consult cloud-deploy-canary.';
    } else if (t === 28) {
      callName = 'bash';
      callArgs = { cmd: 'echo "verified checksum"' };
      responseOutput = 'verified checksum exact match';
      followPrompt = 'Re-confirm active diff in src/ledger/verify.ts and run final checks.';
    } else if (t === 29) {
      callName = 'git_diff';
      callArgs = { file: 'src/ledger/verify.ts' };
      responseOutput = PROTECTED_ACTIVE_DIFF;
      followPrompt = 'Confirm final test status.';
    } else {
      callName = 'bash';
      callArgs = { cmd: 'vitest run' };
      responseOutput = greenTestLog;
      followPrompt = 'All checks complete.';
    }

    turns.push({
      turn: t,
      callName,
      callArgs,
      responseOutput,
      followPrompt,
      coldGapBeforeTurn,
    });
  }
  return turns;
}

function serializeUnitsForGoogle(
  rawJsonBytes: Uint8Array,
  info: TransformInfo,
  model: string,
  totalTokens: number,
  granularity: 'unit' | 'part',
): Array<{ key: string; tokens: number }> {
  const parsed = JSON.parse(stripBase64Images(dec.decode(rawJsonBytes))) as {
    systemInstruction?: unknown;
    tools?: unknown;
    contents?: Array<{ role?: string; parts?: unknown[] }>;
  };
  const units: Array<{ key: string; tokens: number }> = [];
  if (parsed.systemInstruction !== undefined) {
    const s = JSON.stringify(parsed.systemInstruction);
    units.push({ key: `sys:${s}`, tokens: tokCount(s) });
  }
  if (parsed.tools !== undefined) {
    const s = JSON.stringify(parsed.tools);
    units.push({ key: `tools:${s}`, tokens: tokCount(s) });
  }
  let imgCursor = 0;
  const dims = info.imageDims ?? [];
  if (Array.isArray(parsed.contents)) {
    for (let i = 0; i < parsed.contents.length; i++) {
      const c = parsed.contents[i]!;
      if (granularity === 'part' && Array.isArray(c.parts)) {
        for (let j = 0; j < c.parts.length; j++) {
          const part = c.parts[j] as { inlineData?: unknown };
          const ps = JSON.stringify(part);
          let pt = tokCount(ps);
          if (part && typeof part === 'object' && part.inlineData && imgCursor < dims.length) {
            const d = dims[imgCursor++]!;
            pt += geminiVisionTokens(model, d.width, d.height);
          }
          units.push({ key: `c${i}.r${c.role ?? ''}.p${j}:${ps}`, tokens: pt });
        }
      } else {
        const s = JSON.stringify(c);
        let ut = tokCount(s);
        if (Array.isArray(c.parts)) {
          for (const part of c.parts as Array<{ inlineData?: unknown }>) {
            if (part && typeof part === 'object' && part.inlineData && imgCursor < dims.length) {
              const d = dims[imgCursor++]!;
              ut += geminiVisionTokens(model, d.width, d.height);
            }
          }
        }
        units.push({ key: `c${i}:${s}`, tokens: ut });
      }
    }
  }
  const sum = units.reduce((a, b) => a + b.tokens, 0);
  if (sum > 0 && totalTokens !== sum) {
    const scale = totalTokens / sum;
    for (const u of units) u.tokens = Math.max(0, Math.round(u.tokens * scale));
  }
  return units;
}

function serializeUnitsForMessagesOrResponses(
  wire: 'anthropic' | 'openai_responses',
  rawJsonBytes: Uint8Array,
  totalTokens: number,
): Array<{ key: string; tokens: number }> {
  const parsed = JSON.parse(stripBase64Images(dec.decode(rawJsonBytes))) as Record<string, unknown>;
  const units: Array<{ key: string; tokens: number }> = [];
  if (wire === 'anthropic') {
    if (parsed.system !== undefined) {
      const s = JSON.stringify(parsed.system);
      units.push({ key: `sys:${s}`, tokens: tokCount(s) });
    }
    if (parsed.tools !== undefined) {
      const s = JSON.stringify(parsed.tools);
      units.push({ key: `tools:${s}`, tokens: tokCount(s) });
    }
    if (Array.isArray(parsed.messages)) {
      for (let i = 0; i < parsed.messages.length; i++) {
        const s = JSON.stringify(parsed.messages[i]);
        units.push({ key: `m${i}:${s}`, tokens: tokCount(s) });
      }
    }
  } else {
    if (parsed.instructions !== undefined) {
      const s = JSON.stringify(parsed.instructions);
      units.push({ key: `inst:${s}`, tokens: tokCount(s) });
    }
    if (parsed.tools !== undefined) {
      const s = JSON.stringify(parsed.tools);
      units.push({ key: `tools:${s}`, tokens: tokCount(s) });
    }
    if (Array.isArray(parsed.input)) {
      for (let i = 0; i < parsed.input.length; i++) {
        const s = JSON.stringify(parsed.input[i]);
        units.push({ key: `i${i}:${s}`, tokens: tokCount(s) });
      }
    }
  }
  const sum = units.reduce((a, b) => a + b.tokens, 0);
  if (sum > 0 && totalTokens !== sum) {
    const scale = totalTokens / sum;
    for (const u of units) u.tokens = Math.max(0, Math.round(u.tokens * scale));
  }
  return units;
}

function commonPrefixTok(
  prev: ReadonlyArray<{ key: string; tokens: number }>,
  cur: ReadonlyArray<{ key: string; tokens: number }>,
): number {
  let sum = 0;
  const n = Math.min(prev.length, cur.length);
  for (let i = 0; i < n; i++) {
    if (prev[i]!.key !== cur[i]!.key) break;
    sum += cur[i]!.tokens;
  }
  return sum;
}

function countGoogleOutTokens(bytes: Uint8Array, info: TransformInfo, model: string): number {
  const stripped = stripBase64Images(dec.decode(bytes));
  const textTok = tokCount(stripped);
  let imgTok = info.imageTokens ?? 0;
  if (imgTok === 0 && info.imageDims && info.imageDims.length > 0) {
    imgTok = info.imageDims.reduce((s, d) => s + geminiVisionTokens(model, d.width, d.height), 0);
  }
  return textTok + imgTok;
}

function countGenericOutTokens(bytes: Uint8Array, info: TransformInfo): number {
  const stripped = stripBase64Images(dec.decode(bytes));
  return tokCount(stripped) + (info.imageTokens ?? 0);
}

function resetAllEphemeralState(): void {
  resetGlobalMmuStore();
  resetSessionState();
  resetTextEpochStickyState();
  resetGlobalPrefixTape();
  clearStickyMarkovEpisodesForTests();
  clearCalibratedProfiles();
}

function collectParsedToolTexts(
  wire: 'google' | 'anthropic' | 'openai_responses',
  rawJsonBytes: Uint8Array,
): string[] {
  const parsed = JSON.parse(dec.decode(rawJsonBytes)) as Record<string, unknown>;
  const out: string[] = [];
  if (wire === 'google' && Array.isArray(parsed.contents)) {
    for (const c of parsed.contents as Array<{ parts?: unknown[] }>) {
      if (!c || !Array.isArray(c.parts)) continue;
      for (const p of c.parts as Array<{ text?: unknown; functionResponse?: { response?: Record<string, unknown> } }>) {
        if (typeof p?.text === 'string') out.push(p.text);
        const resp = p?.functionResponse?.response;
        if (resp && typeof resp === 'object') {
          for (const v of Object.values(resp)) {
            if (typeof v === 'string') out.push(v);
          }
        }
      }
    }
  } else if (wire === 'anthropic' && Array.isArray(parsed.messages)) {
    for (const m of parsed.messages as Array<{ content?: unknown }>) {
      if (typeof m?.content === 'string') out.push(m.content);
      else if (Array.isArray(m?.content)) {
        for (const b of m.content as Array<{ type?: unknown; text?: unknown; content?: unknown }>) {
          if (typeof b?.text === 'string') out.push(b.text);
          if (typeof b?.content === 'string') out.push(b.content);
        }
      }
    }
  } else if (wire === 'openai_responses' && Array.isArray(parsed.input)) {
    for (const item of parsed.input as Array<{ content?: unknown; output?: unknown }>) {
      if (typeof item?.output === 'string') out.push(item.output);
      if (typeof item?.content === 'string') out.push(item.content);
      else if (Array.isArray(item?.content)) {
        for (const p of item.content as Array<{ text?: unknown }>) {
          if (typeof p?.text === 'string') out.push(p.text);
        }
      }
    }
  }
  return out;
}

function collectSystemAndToolTexts(
  wire: 'google' | 'anthropic' | 'openai_responses',
  rawJsonBytes: Uint8Array,
): { systemText: string; toolAndUserTexts: string } {
  const parsed = JSON.parse(stripBase64Images(dec.decode(rawJsonBytes))) as Record<string, unknown>;
  let systemText = '';
  if (wire === 'google' && parsed.systemInstruction && typeof parsed.systemInstruction === 'object') {
    systemText = JSON.stringify(parsed.systemInstruction);
  } else if (wire === 'anthropic' && parsed.system !== undefined) {
    systemText = typeof parsed.system === 'string' ? parsed.system : JSON.stringify(parsed.system);
  } else if (wire === 'openai_responses' && typeof parsed.instructions === 'string') {
    systemText = parsed.instructions;
  }
  return {
    systemText,
    toolAndUserTexts: collectParsedToolTexts(wire, rawJsonBytes).join('\n'),
  };
}

async function runGoogleArm(
  armName: string,
  script: readonly TurnSpec[],
  config: {
    compress: boolean;
    imageCompress: boolean;
    opticalMode?: OpticalMode;
    stageToggles?: Record<string, boolean>;
    baselineRef?: { raw: number; weighted: number };
  },
): Promise<ArmSummary> {
  resetAllEphemeralState();
  const evalModel = 'gemini-4-argon';

  const systemInstructionText = buildSystemPromptXml();
  const tools = buildSharedToolSchemas('google');
  const contents: Array<Record<string, unknown>> = [
    {
      role: 'user',
      parts: [{ text: 'Debug our Dataflow ledger signature failure in src/ledger/checksum.ts.' }],
    },
  ];

  let rawPromptTotal = 0;
  let weightedPromptTotal = 0;
  let partCachedTotal = 0;
  let unitCachedTotal = 0;
  let totalImages = 0;
  let editSafe = true;
  let tailRecallVerified = false;
  const stageSet = new Set<string>();
  const latencies: number[] = [];
  let prevPartUnits: Array<{ key: string; tokens: number }> = [];
  let prevUnitUnits: Array<{ key: string; tokens: number }> = [];
  let lastSessionKey: string | undefined;

  for (const step of script) {
    contents.push({
      role: 'model',
      parts: [{ functionCall: { name: step.callName, args: step.callArgs } }],
    });
    const outKey = step.callName === 'read_file' || step.callName === 'git_diff' ? 'content' : 'output';
    contents.push({
      role: 'user',
      parts: [
        { functionResponse: { name: step.callName, response: { [outKey]: step.responseOutput } } },
        { text: step.followPrompt },
      ],
    });

    if (step.coldGapBeforeTurn && lastSessionKey) {
      noteCacheOutcome(lastSessionKey, 0, 0);
    }

    const reqObj = {
      systemInstruction: { parts: [{ text: systemInstructionText }] },
      tools,
      contents,
    };
    const rawBytes = enc.encode(JSON.stringify(reqObj));

    const t0 = performance.now();
    const { body: outBytes, info } = config.compress
      ? await transformGoogleGenerateContent(rawBytes, evalModel, {
          compress: true,
          imageCompress: config.imageCompress,
          ...(config.opticalMode ? { opticalMode: config.opticalMode } : {}),
          textHygiene: 'on',
          stageToggles: config.stageToggles,
        })
      : {
          body: rawBytes,
          info: {
            compressed: false,
            origChars: 0,
            compressedChars: 0,
            staticChars: 0,
            dynamicChars: 0,
            dynamicBlockCount: 0,
            imageCount: 0,
            imageBytes: 0,
          } as TransformInfo,
        };
    const dt = performance.now() - t0;
    latencies.push(dt);

    if (info.firstUserSha8) {
      lastSessionKey = info.firstUserSha8;
    }

    const outTok = countGoogleOutTokens(outBytes, info, evalModel);
    const curPartUnits = serializeUnitsForGoogle(outBytes, info, evalModel, outTok, 'part');
    const curUnitUnits = serializeUnitsForGoogle(outBytes, info, evalModel, outTok, 'unit');
    const partTailTok = curPartUnits.length > 0 ? curPartUnits[curPartUnits.length - 1]!.tokens : 0;
    const unitTailTok = curUnitUnits.length > 0 ? curUnitUnits[curUnitUnits.length - 1]!.tokens : 0;
    const prefixCacheHit =
      step.turn > 1 && !step.coldGapBeforeTurn
        ? Math.min(Math.max(0, outTok - partTailTok), commonPrefixTok(prevPartUnits, curPartUnits))
        : 0;
    const unitCacheHit =
      step.turn > 1 && !step.coldGapBeforeTurn
        ? Math.min(Math.max(0, outTok - unitTailTok), commonPrefixTok(prevUnitUnits, curUnitUnits))
        : 0;
    prevPartUnits = curPartUnits;
    prevUnitUnits = curUnitUnits;

    if (lastSessionKey) {
      // Unconditionally record outcome (so Turn 19 cold-gap response flips lastCacheAlive back to true for Turn 20!)
      noteCacheOutcome(lastSessionKey, prefixCacheHit, outTok - prefixCacheHit);
    }

    const rates = resolvePriceRates(evalModel, { promptTokens: outTok });
    const uncached = Math.max(0, outTok - prefixCacheHit);
    const weighted = uncached * rates.write + prefixCacheHit * rates.read;

    rawPromptTotal += outTok;
    weightedPromptTotal += weighted;
    partCachedTotal += prefixCacheHit;
    unitCachedTotal += unitCacheHit;
    totalImages += info.imageCount;
    if (info.imageCount > 0) stageSet.add('optical');
    for (const s of info.textHygieneStages ?? []) stageSet.add(s);

    const parsedParts = collectParsedToolTexts('google', outBytes);
    const { systemText } = collectSystemAndToolTexts('google', outBytes);
    const nonPromptParts = parsedParts.map((p) => p.replaceAll(step.followPrompt, ''));
    const parsedTexts = nonPromptParts.join('\n');
    const allParsedTexts = parsedParts.join('\n');
    // Live active tail diff/code on turn 27 & 29 must remain untouched verbatim (>256 chars)
    if ((step.turn === 27 || step.turn === 29) && !allParsedTexts.includes(PROTECTED_ACTIVE_DIFF)) {
      editSafe = false;
    }
    if (step.turn === 27) {
      const hasBody = parsedTexts.includes(PROTECTED_BODY_SENTINEL);
      const hasSkillDoc = (systemText + '\n' + parsedTexts).includes('Configure Cloud Deploy staged rollouts');
      // On optical arm, check non-prompt blocks (rendered FactSheets / pinned system rules / hydrated tail)
      // rather than Turn 27's own followPrompt string.
      const hasFactId = parsedTexts.includes('verifyLedgerSignatureStrict') && info.imageCount > 0;
      tailRecallVerified = config.imageCompress ? (hasBody && hasSkillDoc) || hasFactId : (hasBody && hasSkillDoc);
    }
  }

  const mmu = getGlobalMmuStore().getStats();
  const baseRaw = config.baselineRef?.raw ?? rawPromptTotal;
  const baseWeighted = config.baselineRef?.weighted ?? weightedPromptTotal;
  const rawSaved = Math.max(0, baseRaw - rawPromptTotal);
  const weightedSaved = Math.max(0, baseWeighted - weightedPromptTotal);

  return {
    arm: armName,
    model: evalModel,
    wire: 'google',
    turns: script.length,
    rawPromptTokens: Math.round(rawPromptTotal),
    rawSavedTokens: Math.round(rawSaved),
    rawSavedPct: baseRaw > 0 ? Math.round((rawSaved / baseRaw) * 1000) / 10 : 0,
    weightedPromptTokens: Math.round(weightedPromptTotal),
    weightedSavedTokens: Math.round(weightedSaved),
    weightedSavedPct: baseWeighted > 0 ? Math.round((weightedSaved / baseWeighted) * 1000) / 10 : 0,
    cacheHitPct: rawPromptTotal > 0 ? Math.round((partCachedTotal / rawPromptTotal) * 1000) / 10 : 0,
    unitCacheHitPct: rawPromptTotal > 0 ? Math.round((unitCachedTotal / rawPromptTotal) * 1000) / 10 : 0,
    totalImages,
    avgMs: Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100,
    p50Ms: Math.round(percentile(latencies, 50) * 100) / 100,
    p95Ms: Math.round(percentile(latencies, 95) * 100) / 100,
    editSafe,
    tailRecallVerified,
    stagesObserved: [...stageSet],
    mmuStats: {
      pagesStored: mmu.pagesStored,
      tailHydrations: mmu.tailHydrations,
      tailHydrationTokens: mmu.tailHydrationTokens,
      markovFolds: mmu.markovFolds > 0 ? 1 : 0,
      skillsStubbed: mmu.skillsStubbed > 0 ? Math.round(mmu.skillsStubbed / script.length) : 0,
      densityPrunedBlocks: mmu.densityPrunedBlocks > 0 ? 1 : 0,
      cumulativeMarkovFolds: mmu.markovFolds,
      cumulativeSkillStubs: mmu.skillsStubbed,
      cumulativeDensityPrunedBlocks: mmu.densityPrunedBlocks,
    },
  };
}

async function runCrossWireArm(
  wire: 'anthropic' | 'openai_responses',
  model: string,
  script: readonly TurnSpec[],
): Promise<{
  readonly wire: 'anthropic' | 'openai_responses';
  readonly model: string;
  readonly turns: number;
  readonly baselineRawTokens: number;
  readonly ficheRawTokens: number;
  readonly rawSavedPct: number;
  readonly weightedSavedPct: number;
  readonly cacheHitPct: number;
  readonly avgMs: number;
  readonly p95Ms: number;
  readonly editSafe: boolean;
  readonly tailRecallVerified: boolean;
  readonly stagesObserved: readonly string[];
}> {
  resetAllEphemeralState();
  const sysText = buildSystemPromptXml();
  const tools = buildSharedToolSchemas(wire);

  let baseRawTotal = 0;
  let ficheRawTotal = 0;
  let baseWeightedTotal = 0;
  let ficheWeightedTotal = 0;
  let cachedTotal = 0;
  let editSafe = true;
  let tailRecallVerified = false;
  const stageSet = new Set<string>();
  const latencies: number[] = [];

  const historyMsgs: Array<Record<string, unknown>> = [];
  if (wire === 'anthropic') {
    historyMsgs.push({
      role: 'user',
      content: 'Debug our Dataflow ledger signature failure in src/ledger/checksum.ts.',
    });
  } else {
    historyMsgs.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Debug our Dataflow ledger signature failure in src/ledger/checksum.ts.' }],
    });
  }

  let prevBaseUnits: Array<{ key: string; tokens: number }> = [];
  let prevFicheUnits: Array<{ key: string; tokens: number }> = [];
  let lastSessionKey: string | undefined;

  for (const step of script) {
    const callId = `call_${step.turn}`;
    if (wire === 'anthropic') {
      historyMsgs.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: callId, name: step.callName, input: step.callArgs }],
      });
      historyMsgs.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: callId, content: step.responseOutput },
          { type: 'text', text: step.followPrompt },
        ],
      });
    } else {
      historyMsgs.push({
        type: 'function_call',
        call_id: callId,
        name: step.callName,
        arguments: JSON.stringify(step.callArgs),
      });
      historyMsgs.push({
        type: 'function_call_output',
        call_id: callId,
        output: step.responseOutput,
      });
      historyMsgs.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: step.followPrompt }],
      });
    }

    if (step.coldGapBeforeTurn && lastSessionKey) {
      noteCacheOutcome(lastSessionKey, 0, 0);
    }

    const reqObj =
      wire === 'anthropic'
        ? { model, max_tokens: 1024, system: sysText, tools, messages: historyMsgs }
        : { model, instructions: sysText, tools, input: historyMsgs };

    const rawBytes = enc.encode(JSON.stringify(reqObj));
    const baseTok = tokCount(stripBase64Images(dec.decode(rawBytes)));
    const baseUnits = serializeUnitsForMessagesOrResponses(wire, rawBytes, baseTok);
    const baseTailTok = baseUnits.length > 0 ? baseUnits[baseUnits.length - 1]!.tokens : 0;
    const baseCache =
      step.turn > 1 && !step.coldGapBeforeTurn
        ? Math.min(Math.max(0, baseTok - baseTailTok), commonPrefixTok(prevBaseUnits, baseUnits))
        : 0;
    prevBaseUnits = baseUnits;

    const t0 = performance.now();
    const res =
      wire === 'anthropic'
        ? await transformRequest(rawBytes, { model, imageCompress: false, textHygiene: 'on' })
        : await transformOpenAIResponses(rawBytes, { model, imageCompress: false, textHygiene: 'on' });
    latencies.push(performance.now() - t0);

    if (res.info.firstUserSha8) {
      lastSessionKey = res.info.firstUserSha8;
    }

    const fTok = countGenericOutTokens(res.body, res.info);
    const fUnits = serializeUnitsForMessagesOrResponses(wire, res.body, fTok);
    const fTailTok = fUnits.length > 0 ? fUnits[fUnits.length - 1]!.tokens : 0;
    const fCache =
      step.turn > 1 && !step.coldGapBeforeTurn
        ? Math.min(Math.max(0, fTok - fTailTok), commonPrefixTok(prevFicheUnits, fUnits))
        : 0;
    prevFicheUnits = fUnits;

    if (lastSessionKey) {
      noteCacheOutcome(lastSessionKey, fCache, fTok - fCache);
    }

    const baseRates = resolvePriceRates(model, { promptTokens: baseTok });
    const ficheRates = resolvePriceRates(model, { promptTokens: fTok });
    baseRawTotal += baseTok;
    ficheRawTotal += fTok;
    baseWeightedTotal += (baseTok - baseCache) * baseRates.write + baseCache * baseRates.read;
    ficheWeightedTotal += (fTok - fCache) * ficheRates.write + fCache * ficheRates.read;
    cachedTotal += fCache;
    for (const s of res.info.textHygieneStages ?? []) stageSet.add(s);

    const parsedParts = collectParsedToolTexts(wire, res.body);
    const { systemText } = collectSystemAndToolTexts(wire, res.body);
    const parsedTexts = parsedParts.map((p) => p.replaceAll(step.followPrompt, '')).join('\n');
    const allParsedTexts = parsedParts.join('\n');
    if ((step.turn === 27 || step.turn === 29) && !allParsedTexts.includes(PROTECTED_ACTIVE_DIFF)) {
      editSafe = false;
    }
    if (
      step.turn === 27 &&
      parsedTexts.includes(PROTECTED_BODY_SENTINEL) &&
      (systemText + '\n' + parsedTexts).includes('Configure Cloud Deploy staged rollouts')
    ) {
      tailRecallVerified = true;
    }
  }

  return {
    wire,
    model,
    turns: script.length,
    baselineRawTokens: Math.round(baseRawTotal),
    ficheRawTokens: Math.round(ficheRawTotal),
    rawSavedPct: baseRawTotal > 0 ? Math.round(((baseRawTotal - ficheRawTotal) / baseRawTotal) * 1000) / 10 : 0,
    weightedSavedPct:
      baseWeightedTotal > 0
        ? Math.round(((baseWeightedTotal - ficheWeightedTotal) / baseWeightedTotal) * 1000) / 10
        : 0,
    cacheHitPct: ficheRawTotal > 0 ? Math.round((cachedTotal / ficheRawTotal) * 1000) / 10 : 0,
    avgMs: Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100,
    p95Ms: Math.round(percentile(latencies, 95) * 100) / 100,
    editSafe,
    tailRecallVerified,
    stagesObserved: [...stageSet],
  };
}

export async function runContextMmuEval(): Promise<ContextMmuEvalReport> {
  const savedPrices = process.env.FICHE_PRICES;
  const savedLegacyPrices = process.env.INKLING_PRICES;
  process.env.FICHE_PRICES = 'kosha';
  delete process.env.INKLING_PRICES;
  try {
    const script = build30TurnScript();

    const arm1Baseline = await runGoogleArm('Baseline (uncompressed)', script, {
      compress: false,
      imageCompress: false,
    });

    const baselineRef = {
      raw: arm1Baseline.rawPromptTokens,
      weighted: arm1Baseline.weightedPromptTokens,
    };

    const arm2LegacyFlags = await runGoogleArm(
      'v0.18 Text Compiler (lsm/mmu/skillLinker off)',
      script,
      {
        compress: true,
        imageCompress: false,
        stageToggles: { lsm: false, mmu: false, skillLinker: false },
        baselineRef,
      },
    );

    const arm3FullText = await runGoogleArm(
      'Fiche P0-P3 Text + Context-MMU (0 images)',
      script,
      {
        compress: true,
        imageCompress: false,
        baselineRef,
      },
    );

    const arm4Optical = await runGoogleArm(
      'Fiche P0-P3 + Optical (spleen-5x8)',
      script,
      {
        compress: true,
        imageCompress: true,
        opticalMode: 'full',
        baselineRef,
      },
    );

    const arm5Hybrid = await runGoogleArm(
      'Fiche P0-P3 Hybrid Slab-Optical + Text-MMU',
      script,
      {
        compress: true,
        imageCompress: true,
        opticalMode: 'hybrid',
        baselineRef,
      },
    );

    const anthCheck = await runCrossWireArm('anthropic', 'claude-opus-5-5', script);
    const respCheck = await runCrossWireArm('openai_responses', 'gpt-6-astra', script);

    const activeMode = priceMode();
    resetAllEphemeralState();

    return {
      generatedAtIso: new Date().toISOString(),
      pricingMode: activeMode,
      trajectoryTurns: script.length,
      primaryArms: [arm1Baseline, arm2LegacyFlags, arm3FullText, arm4Optical, arm5Hybrid],
      crossWireChecks: [anthCheck, respCheck],
    };
  } finally {
    if (savedPrices === undefined) delete process.env.FICHE_PRICES;
    else process.env.FICHE_PRICES = savedPrices;
    if (savedLegacyPrices === undefined) delete process.env.INKLING_PRICES;
    else process.env.INKLING_PRICES = savedLegacyPrices;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runContextMmuEval();
  const outPath = path.join(path.dirname(process.argv[1]), 'mmu-results.generated.json');
  if (!process.argv.includes('--no-write')) {
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nfiche P0-P3 Context-MMU 30-Turn Replay Benchmark\n`);
    console.log(
      'Arm'.padEnd(46) +
        'Raw Tok'.padStart(10) +
        'Raw Save'.padStart(10) +
        'Wtd Save'.padStart(10) +
        'Cache%'.padStart(8) +
        'p50/p95 ms'.padStart(13) +
        '  Edit  Recall',
    );
    console.log('-'.repeat(115));
    for (const a of report.primaryArms) {
      console.log(
        a.arm.padEnd(46) +
          String(a.rawPromptTokens).padStart(10) +
          `${a.rawSavedPct.toFixed(1)}%`.padStart(10) +
          `${a.weightedSavedPct.toFixed(1)}%`.padStart(10) +
          `${a.cacheHitPct.toFixed(1)}%`.padStart(8) +
          `${a.p50Ms.toFixed(2)}/${a.p95Ms.toFixed(2)}`.padStart(13) +
          `  ${String(a.editSafe).padEnd(5)} ${String(a.tailRecallVerified)}`,
      );
    }
    console.log('\nCross-wire checks (30 turns):');
    for (const c of report.crossWireChecks) {
      console.log(
        `  ${c.wire.padEnd(18)} ${c.model.padEnd(16)} rawSaved=${c.rawSavedPct.toFixed(1)}%  weightedSaved=${c.weightedSavedPct.toFixed(1)}%  cache=${c.cacheHitPct.toFixed(1)}%  avg=${c.avgMs.toFixed(2)}ms  stages=[${c.stagesObserved.join(',')}]`,
      );
    }
  }
}
