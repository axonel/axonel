/**
 * Sentinel Clean Install Smoke Test
 *
 * Verifies the complete documented installation procedure from docs/REPRODUCIBLE_RELEASE.md:
 * 1. Test binary --help and --version from release build
 * 2. Start server on default loopback (port 4399)
 * 3. Verify /health and /api/v1/auth/status
 * 4. Verify static web SPA is served at root /
 * 5. Verify workspace registration via REST API
 * 6. Verify mission creation via REST API
 * 7. Verify non-loopback without auth exits with code 1
 */

import { spawn, execFileSync } from 'child_process';
import http from 'http';
import path from 'path';
import fs from 'fs';

const CLEAN_DIR = fs.existsSync('/tmp/sentinel_clean_install_test')
  ? '/tmp/sentinel_clean_install_test'
  : process.cwd();
const BIN_PATH = fs.existsSync(path.join(CLEAN_DIR, 'target/release/sentinel'))
  ? path.join(CLEAN_DIR, 'target/release/sentinel')
  : path.resolve('target/release/sentinel');
const PORT = 4399;
const DB_PATH = `/tmp/clean_install_${Date.now()}.db`;
const REPO_DIR = `/tmp/clean_install_repo_${Date.now()}`;

function log(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function request(method, reqPath, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path: reqPath,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(data), raw: data });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, data: null, raw: data });
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

async function main() {
  log('========================================================================');
  log('   SENTINEL CLEAN-INSTALL & RELEASE BUILD SMOKE VERIFICATION');
  log('========================================================================\n');

  if (!fs.existsSync(BIN_PATH)) {
    throw new Error(`Release binary not found at ${BIN_PATH}. Did release build complete?`);
  }
  log(`Found release binary at: ${BIN_PATH}`);

  // 1. Test --help
  log('Step 1: Testing sentinel --help...');
  const helpOut = execFileSync(BIN_PATH, ['--help'], { encoding: 'utf8' });
  if (!helpOut.includes('Usage: sentinel') || !helpOut.includes('serve')) {
    throw new Error(`Unexpected --help output:\n${helpOut}`);
  }
  log('✓ Step 1: sentinel --help is clean and complete.');

  // 2. Test --version
  log('Step 2: Testing sentinel --version...');
  const verOut = execFileSync(BIN_PATH, ['--version'], { encoding: 'utf8' });
  if (!verOut.includes('0.1.1') && !verOut.includes('0.1.0')) {
    throw new Error(`Unexpected --version output: ${verOut}`);
  }
  log(`✓ Step 2: sentinel --version outputs: ${verOut.trim()}`);

  // 3. Test non-loopback without auth fails hard
  log('Step 3: Verifying non-loopback bind without auth token fails hard...');
  let failedAsExpected = false;
  try {
    execFileSync(BIN_PATH, ['serve', '--host', '0.0.0.0', '--port', String(PORT), '--db', DB_PATH], { stdio: 'pipe' });
  } catch (err) {
    if (err.status === 1) {
      failedAsExpected = true;
    }
  }
  if (!failedAsExpected) {
    throw new Error('Expected non-loopback startup without auth to fail with exit code 1, but it succeeded or returned unexpected exit code');
  }
  log('✓ Step 3: Server correctly refused non-loopback startup with exit code 1.');

  // 4. Start server on loopback default
  log(`Step 4: Starting Sentinel release server on 127.0.0.1:${PORT}...`);
  const server = spawn(BIN_PATH, ['serve', '--host', '127.0.0.1', '--port', String(PORT), '--db', DB_PATH], {
    cwd: CLEAN_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RUST_LOG: 'info' },
  });

  server.stderr.on('data', (d) => {
    // console.error(`[SERVER] ${d.toString()}`);
  });

  try {
    // Wait for server ready
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      try {
        const h = await request('GET', '/health');
        if (h.status === 200) {
          healthy = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!healthy) throw new Error('Sentinel server failed to respond on /health within timeout');
    log('✓ Step 4: Sentinel server started and is healthy on loopback.');

    // 5. Verify auth status
    log('Step 5: Verifying /api/v1/auth/status...');
    const authRes = await request('GET', '/api/v1/auth/status');
    if (authRes.status !== 200 || !authRes.data.is_loopback || authRes.data.auth_required) {
      throw new Error(`Unexpected auth status: ${authRes.raw}`);
    }
    log(`✓ Step 5: Auth status truthful (is_loopback=${authRes.data.is_loopback}, auth_required=${authRes.data.auth_required})`);

    // 6. Verify Web SPA root
    log('Step 6: Verifying Web UI static assets served at /...');
    const rootRes = await request('GET', '/');
    if (rootRes.status !== 200 || !rootRes.raw.includes('<!doctype html>')) {
      throw new Error(`Expected Web UI HTML at /, got status ${rootRes.status}: ${rootRes.raw.substring(0, 100)}`);
    }
    log('✓ Step 6: Web Dashboard SPA is cleanly served at root /. (HTTP 200)');

    // 7. Register workspace
    log('Step 7: Testing workspace registration...');
    fs.mkdirSync(REPO_DIR, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: REPO_DIR });
    execFileSync('git', ['config', 'user.name', 'Clean Test'], { cwd: REPO_DIR });
    execFileSync('git', ['config', 'user.email', 'clean@sentinel.local'], { cwd: REPO_DIR });
    fs.writeFileSync(path.join(REPO_DIR, 'README.md'), '# Test Repo\n');
    execFileSync('git', ['add', 'README.md'], { cwd: REPO_DIR });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: REPO_DIR });

    const wsRes = await request('POST', '/api/v1/workspaces', {
      name: 'Clean Install Test Workspace',
      canonical_path: REPO_DIR,
    });
    if (wsRes.status !== 200 && wsRes.status !== 201) {
      throw new Error(`Workspace registration failed: ${wsRes.raw}`);
    }
    const wsId = wsRes.data.id;
    log(`✓ Step 7: Workspace registered successfully with ID: ${wsId}`);

    // 8. Create mission
    log('Step 8: Testing mission creation...');
    const missionRes = await request('POST', '/api/v1/missions', {
      title: 'Clean Install Smoke Mission',
      objective: 'Verify mission creation flow from clean release install.',
      workspace_id: wsId,
      budget: { max_duration_secs: 600 },
      stopping_condition: { working_tree_clean: true },
      auto_start: false,
    });
    if (missionRes.status !== 200 && missionRes.status !== 201) {
      throw new Error(`Mission creation failed: ${missionRes.raw}`);
    }
    const missionId = missionRes.data.id;
    log(`✓ Step 8: Mission created successfully with ID: ${missionId} (State: ${missionRes.data.state})`);

    log('\n========================================================================');
    log('   CLEAN-INSTALL SMOKE TEST: ALL 8 STEPS PASSED (100%)');
    log('========================================================================\n');
  } finally {
    server.kill('SIGTERM');
    try {
      fs.rmSync(DB_PATH, { force: true });
      fs.rmSync(REPO_DIR, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error('FATAL ERROR in clean install smoke test:', err);
  process.exit(1);
});
