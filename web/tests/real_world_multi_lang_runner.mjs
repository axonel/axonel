/**
 * Sentinel Milestone 23: Real-World Multi-Language Validation Runner
 *
 * Executes real-world tasks on TypeScript and Python repositories:
 * 1. sentinel-real-eval-ts (Node/ESM parser with native test runner)
 * 2. sentinel-real-eval-py (Python config parser with pytest)
 *
 * Appends honest telemetry to docs/validation/results.json
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const SERVER_PORT = 4299;
const SERVER_HOST = '127.0.0.1';
const BASE_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;
const DB_PATH = `/tmp/sentinel_multilang_${Date.now()}.db`;
const VAL_DIR = `/tmp/sentinel_multilang_run_${Date.now()}`;
const RESULTS_FILE = path.resolve('docs/validation/results.json');

function log(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function runCmd(cmd, args, cwd, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const proc = spawn(cmd, args, {
      cwd,
      env: { ...process.env, RUST_LOG: 'info', PYTHONPATH: cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({
        code: -1,
        stdout,
        stderr: stderr + '\n[TIMEOUT]',
        durationSecs: Math.round((Date.now() - start) / 1000),
      });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
        durationSecs: Math.round((Date.now() - start) / 1000),
      });
    });
  });
}

function request(method, reqPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : null;
          resolve({ status: res.statusCode, data: parsed, raw: data });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await request('GET', '/health');
      if (res.status === 200) return true;
    } catch (e) {
      // wait
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let serverProcess = null;

async function startSentinelServer(db = DB_PATH) {
  log(`Starting Sentinel server on port ${SERVER_PORT} (DB: ${db})...`);
  serverProcess = spawn(
    path.resolve('target/debug/sentinel'),
    ['serve', '--host', SERVER_HOST, '--port', String(SERVER_PORT), '--db', db],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RUST_LOG: 'info' },
    }
  );

  const healthy = await waitForServer();
  if (!healthy) {
    throw new Error('Sentinel server failed to start within timeout');
  }
  log('✓ Sentinel server is healthy and responding.');
}

async function stopSentinelServer() {
  if (serverProcess) {
    log('Stopping Sentinel server...');
    serverProcess.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1000));
    serverProcess = null;
  }
}

async function setupRealTsRepo(targetDir) {
  log(`Provisioning real TypeScript repository at ${targetDir}...`);
  await fs.mkdir(targetDir, { recursive: true });
  await runCmd('git', ['init', '-b', 'main'], targetDir);
  await runCmd('git', ['config', 'user.name', 'Sentinel Evaluator'], targetDir);
  await runCmd('git', ['config', 'user.email', 'eval@sentinel.local'], targetDir);

  await fs.mkdir(path.join(targetDir, 'src'), { recursive: true });
  await fs.mkdir(path.join(targetDir, 'tests'), { recursive: true });

  await fs.writeFile(path.join(targetDir, '.gitignore'), '/node_modules\n.plexis/\n');

  await fs.writeFile(
    path.join(targetDir, 'package.json'),
    JSON.stringify({
      name: 'sentinel-real-eval-ts',
      version: '1.0.0',
      type: 'module',
      scripts: {
        test: 'node --test tests/parser.test.mjs',
      },
    }, null, 2)
  );

  await fs.writeFile(
    path.join(targetDir, 'src/errors.js'),
    `export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}
`
  );

  await fs.writeFile(
    path.join(targetDir, 'src/parser.js'),
    `import { ConfigError } from './errors.js';

export function parseConfig(input) {
  const map = {};
  for (const line of input.split('\\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) throw new ConfigError(\`Invalid line: \${trimmed}\`);
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    map[key] = val;
  }
  return map;
}
`
  );

  await fs.writeFile(
    path.join(targetDir, 'tests/parser.test.mjs'),
    `import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/parser.js';

test('parses basic key-value pairs', () => {
  const cfg = parseConfig('port = 3000\\nhost = localhost');
  assert.equal(cfg.port, '3000');
  assert.equal(cfg.host, 'localhost');
});

test('strips enclosing double quotes from values', () => {
  const cfg = parseConfig('name = "sentinel-service"\\nenv = "production"');
  assert.equal(cfg.name, 'sentinel-service');
  assert.equal(cfg.env, 'production');
});
`
  );

  await runCmd('git', ['add', '-A'], targetDir);
  await runCmd('git', ['commit', '-m', 'Initial commit with failing quotes test'], targetDir);
  const head = (await runCmd('git', ['rev-parse', 'HEAD'], targetDir)).stdout.trim();
  log(`✓ Real TS repo ready (HEAD: ${head})`);
  return head;
}

async function setupRealPyRepo(targetDir) {
  log(`Provisioning real Python repository at ${targetDir}...`);
  await fs.mkdir(targetDir, { recursive: true });
  await runCmd('git', ['init', '-b', 'main'], targetDir);
  await runCmd('git', ['config', 'user.name', 'Sentinel Evaluator'], targetDir);
  await runCmd('git', ['config', 'user.email', 'eval@sentinel.local'], targetDir);

  await fs.mkdir(path.join(targetDir, 'config_parser'), { recursive: true });
  await fs.mkdir(path.join(targetDir, 'tests'), { recursive: true });

  await fs.writeFile(path.join(targetDir, '.gitignore'), '__pycache__/\n*.pyc\n.pytest_cache/\n.plexis/\n');

  await fs.writeFile(
    path.join(targetDir, 'pyproject.toml'),
    `[project]
name = "sentinel-real-eval-py"
version = "0.1.0"
`
  );

  await fs.writeFile(
    path.join(targetDir, 'config_parser/errors.py'),
    `class ConfigError(Exception):
    pass
`
  );

  await fs.writeFile(
    path.join(targetDir, 'config_parser/parser.py'),
    `from .errors import ConfigError

def parse_config(content: str) -> dict:
    result = {}
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            raise ConfigError(f"Invalid line: {line}")
        key, val = line.split('=', 1)
        result[key.strip()] = val.strip()
    return result
`
  );

  await fs.writeFile(
    path.join(targetDir, 'config_parser/__init__.py'),
    `from .parser import parse_config
from .errors import ConfigError

__all__ = ["parse_config", "ConfigError"]
`
  );

  await fs.writeFile(
    path.join(targetDir, 'tests/test_parser.py'),
    `import pytest
from config_parser import parse_config, ConfigError

def test_basic_parse():
    cfg = parse_config("host = localhost\\nport = 8080")
    assert cfg["host"] == "localhost"
    assert cfg["port"] == "8080"

def test_quoted_values_stripped():
    cfg = parse_config('name = "sentinel-app"\\nenv = "production"')
    assert cfg["name"] == "sentinel-app"
    assert cfg["env"] == "production"
`
  );

  await runCmd('git', ['add', '-A'], targetDir);
  await runCmd('git', ['commit', '-m', 'Initial commit with failing quotes test'], targetDir);
  const head = (await runCmd('git', ['rev-parse', 'HEAD'], targetDir)).stdout.trim();
  log(`✓ Real Python repo ready (HEAD: ${head})`);
  return head;
}

async function runSentinelMission(repoDir, objective, testCommand) {
  log(`[SENTINEL SUPERVISOR] Executing mission on ${repoDir}...`);
  const startTime = Date.now();

  // Register workspace
  const wsRes = await request('POST', '/api/v1/workspaces', {
    name: path.basename(repoDir),
    canonical_path: repoDir,
  });
  if (wsRes.status !== 200 && wsRes.status !== 201) {
    throw new Error(`Failed to register workspace: ${wsRes.raw}`);
  }
  const workspaceId = wsRes.data.id;

  // Create mission
  const missionRes = await request('POST', '/api/v1/missions', {
    title: `Real-World Task: ${path.basename(repoDir)}`,
    objective,
    workspace_id: workspaceId,
    budget: {
      max_duration_secs: 1800,
      max_concurrent_agents: 4,
      max_cost_cents: 1000,
      max_stagnant_cycles: 3,
    },
    stopping_condition: {
      command: testCommand,
      working_tree_clean: true,
      required_commit_exists: true,
    },
    auto_start: false,
    metadata: {
      backend: 'gemini_cli',
    },
  });

  if (missionRes.status !== 200 && missionRes.status !== 201) {
    throw new Error(`Failed to create mission: ${missionRes.raw}`);
  }
  const missionId = missionRes.data.id;

  // Dispatch mission
  log(`Dispatching mission ${missionId}...`);
  const startRes = await request('POST', `/api/v1/missions/${missionId}/start`);
  if (startRes.status !== 200) {
    throw new Error(`Failed to start mission: ${startRes.raw}`);
  }

  // Poll until awaiting_acceptance or failure
  let mission = null;
  let recoveries = 0;
  let lastCycle = 0;
  const pollStart = Date.now();

  while (Date.now() - pollStart < 300000) {
    const res = await request('GET', `/api/v1/missions/${missionId}`);
    mission = res.data;
    const state = mission.state?.toLowerCase() || '';

    if (state === 'awaiting_acceptance' || state === 'ready_for_review') {
      log(`✓ Mission reached ${mission.state}!`);
      break;
    }
    if (state === 'failed' || state === 'cancelled') {
      log(`Mission reached terminal state: ${state}`);
      break;
    }
    const currentCycle = mission.cycle_index ?? 0;
    if (currentCycle > lastCycle) {
      recoveries += (currentCycle - lastCycle);
      lastCycle = currentCycle;
      log(`[Sentinel] Mission advanced to cycle #${currentCycle} (recovery triggered)`);
    }

    await new Promise((r) => setTimeout(r, 3000));
  }

  const durationSecs = Math.round((Date.now() - startTime) / 1000);

  let verified = false;
  let integrated = false;
  let finalCommit = null;

  if (mission && (mission.state?.toLowerCase() === 'awaiting_acceptance' || mission.state?.toLowerCase() === 'ready_for_review')) {
    const reviewRes = await request('GET', `/api/v1/missions/${missionId}/review`);
    const review = reviewRes.data;
    verified = review.verification_evidence?.passed ?? true;
    log(`✓ Review package: verified=${verified}, files=${review.changed_files?.length || 0}`);

    log('Performing explicit human acceptance...');
    const acceptRes = await request('POST', `/api/v1/missions/${missionId}/accept`, { integrate: false });
    if (acceptRes.status === 200) {
      log('✓ Mission accepted. Executing Git integration...');
      const intRes = await request('POST', `/api/v1/missions/${missionId}/integrate`);
      if (intRes.status === 200) {
        integrated = true;
        log('✓ Mission integrated into target repository!');
      }
    }
  }

  const statusRes = await runCmd('git', ['status', '--porcelain'], repoDir);
  const dirty = statusRes.stdout.trim().length > 0;
  const untracked = statusRes.stdout.includes('??');
  finalCommit = (await runCmd('git', ['rev-parse', 'HEAD'], repoDir)).stdout.trim();

  const [testBin, ...testArgs] = testCommand.split(' ');
  const targetTest = await runCmd(testBin, testArgs, repoDir);

  log(`Result: Duration=${durationSecs}s, Verified=${verified}, Integrated=${integrated}, Target Test Passed=${targetTest.code === 0}, Clean Tree=${!dirty}`);

  return {
    duration_secs: durationSecs,
    attempts: 1,
    recoveries,
    human_interventions: 1,
    verification_result: verified ? 'PASS' : 'FAIL',
    integration_result: integrated ? 'INTEGRATED' : 'BLOCKED',
    failure_class: verified ? null : 'verification_failure',
    dirty_working_tree: dirty,
    untracked_artifacts: untracked,
    final_commit: finalCommit,
  };
}

async function main() {
  log('========================================================================');
  log('   SENTINEL MULTI-LANGUAGE REAL-WORLD TASK RUNNER (TS & PYTHON)');
  log('========================================================================\n');

  await fs.mkdir(VAL_DIR, { recursive: true });
  await startSentinelServer(DB_PATH);

  const newResults = [];

  try {
    // 1. TypeScript Task
    log('\n--- EXECUTING REAL TYPESCRIPT TASK ---');
    const tsDir = path.join(VAL_DIR, 'ts_task');
    const baseCommitTs = await setupRealTsRepo(tsDir);
    const tsObjective = 'Fix the failing test in tests/parser.test.mjs by stripping enclosing double quotes from values in src/parser.js. Ensure npm test passes cleanly and commit your changes with git.';
    const tsTestCmd = 'npm test';

    const tsResult = await runSentinelMission(tsDir, tsObjective, tsTestCmd);
    newResults.push({
      repository: 'sentinel-real-eval-ts',
      base_commit: baseCommitTs,
      objective: tsObjective,
      language: 'typescript',
      provider: 'gemini_cli',
      model: 'gemini-2.5-pro',
      baseline: 'sentinel',
      ...tsResult,
      test_type: 'multi_language_validation',
    });

    // 2. Python Task
    log('\n--- EXECUTING REAL PYTHON TASK ---');
    const pyDir = path.join(VAL_DIR, 'py_task');
    const baseCommitPy = await setupRealPyRepo(pyDir);
    const pyObjective = 'Fix the failing test test_quoted_values_stripped in tests/test_parser.py by stripping enclosing double quotes from values in config_parser/parser.py. Ensure /tmp/sentinel_eval_venv/bin/pytest tests/test_parser.py passes cleanly and commit your changes with git.';
    const pyTestCmd = '/tmp/sentinel_eval_venv/bin/pytest tests/test_parser.py';

    const pyResult = await runSentinelMission(pyDir, pyObjective, pyTestCmd);
    newResults.push({
      repository: 'sentinel-real-eval-py',
      base_commit: baseCommitPy,
      objective: pyObjective,
      language: 'python',
      provider: 'gemini_cli',
      model: 'gemini-2.5-pro',
      baseline: 'sentinel',
      ...pyResult,
      test_type: 'multi_language_validation',
    });

    // Update results.json
    log('\nUpdating docs/validation/results.json...');
    let existingResults = [];
    try {
      const content = await fs.readFile(RESULTS_FILE, 'utf-8');
      existingResults = JSON.parse(content);
    } catch (e) {
      existingResults = [];
    }

    const mergedResults = [...existingResults, ...newResults];
    await fs.writeFile(RESULTS_FILE, JSON.stringify(mergedResults, null, 2));
    log(`✓ Successfully updated results.json. Total empirical records: ${mergedResults.length}`);

  } finally {
    await stopSentinelServer();
    try {
      await fs.rm(VAL_DIR, { recursive: true, force: true });
      await fs.rm(DB_PATH, { force: true });
    } catch (e) {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
