import { spawn, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const PORT = 4025;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_PATH = `/tmp/sentinel_m13_live_${Date.now()}.db`;
const WORKLOAD_DIR = `/tmp/sentinel_workload_m13_live_${Date.now()}`;
const AUTH_TOKEN = "m13-live-hardened-auth-token-556677";
const ARTIFACTS_DIR = `/tmp/milestone13_live_artifacts_${Date.now()}`;

console.log("================================================================");
console.log("   SENTINEL / PLEXIS MILESTONE 13: REAL LIVE GEMINI CODING E2E   ");
console.log("================================================================");
console.log(`[E2E Setup] Database path: ${DB_PATH}`);
console.log(`[E2E Setup] Target workload repository: ${WORKLOAD_DIR}`);
console.log(`[E2E Setup] Artifacts directory: ${ARTIFACTS_DIR}`);
console.log(`[E2E Setup] Hardened Auth Token: ${AUTH_TOKEN}\n`);

// 1. Verify Gemini CLI binary existence
let geminiPath = null;
try {
  geminiPath = execFileSync("which", ["gemini"], { encoding: "utf-8" }).trim();
} catch {
  // check standard path
  const standardPath = path.join(os.homedir(), ".local/bin/gemini");
  if (fs.existsSync(standardPath)) {
    geminiPath = standardPath;
  }
}

if (!geminiPath || !fs.existsSync(geminiPath)) {
  console.error("✗ FATAL: Gemini CLI binary not found on host machine.");
  console.error("Please install Gemini CLI or ensure it is in PATH / ~/.local/bin/gemini.");
  process.exit(1);
}

let geminiVersion = "unknown";
try {
  geminiVersion = execFileSync(geminiPath, ["--version"], { encoding: "utf-8" }).trim();
} catch (e) {
  console.error(`✗ FATAL: Failed to query gemini version: ${e.message}`);
  process.exit(1);
}

console.log(`✓ Gemini binary discovered: ${geminiPath} (v${geminiVersion})`);

// 2. Authentication Gate: check credentials strictly without mock fallback
function checkGeminiAuthentication() {
  // Check env vars
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0) {
    return { authenticated: true, source: "GEMINI_API_KEY environment variable" };
  }
  if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_API_KEY.trim().length > 0) {
    return { authenticated: true, source: "GOOGLE_API_KEY environment variable" };
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    return { authenticated: true, source: "GOOGLE_APPLICATION_CREDENTIALS" };
  }

  // Check ~/.gemini/google_accounts.json
  const accountsPath = path.join(os.homedir(), ".gemini/google_accounts.json");
  if (fs.existsSync(accountsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(accountsPath, "utf-8"));
      if (data && data.active && typeof data.active === "string" && data.active.trim().length > 0) {
        return { authenticated: true, source: `Google Account OAuth (${data.active})` };
      }
    } catch {
      // Ignore parse error
    }
  }

  // Check system keyring (secret-tool) for gemini-cli-api-key
  try {
    const secretOut = execFileSync(
      "secret-tool",
      ["lookup", "service", "gemini-cli-api-key", "account", "default-api-key"],
      { encoding: "utf-8" }
    ).trim();
    if (secretOut.length > 0) {
      const parsed = JSON.parse(secretOut);
      const token = parsed?.token?.accessToken;
      if (token && token.trim().length > 0) {
        process.env.GEMINI_API_KEY = token;
        return { authenticated: true, source: "System Keyring (gemini-cli-api-key / default-api-key)" };
      }
    }
  } catch {}

  return {
    authenticated: false,
    reason: "No active Google account found in ~/.gemini/google_accounts.json and GEMINI_API_KEY / GOOGLE_API_KEY not set.",
  };
}

const authState = checkGeminiAuthentication();

if (!authState.authenticated) {
  console.error("\n----------------------------------------------------------------");
  console.error("  FATAL: LIVE GEMINI CODING EXECUTION GATED — AUTH MISSING      ");
  console.error("----------------------------------------------------------------");
  console.error(`[Auth Status] Authenticated: false`);
  console.error(`[Auth Reason] ${authState.reason}`);
  console.error("\nTo enable real live Gemini execution on this machine, perform ONE of:");
  console.error("  Option A (Interactive Login): Run `gemini` in an interactive terminal and complete browser OAuth.");
  console.error("  Option B (API Key): Export `GEMINI_API_KEY=\"<your-api-key>\"` in your shell environment.");
  console.error("\nPer Milestone 13 specification, this test exits non-zero when live credentials");
  console.error("are absent, preventing false positives and ensuring genuine audit integrity.");
  console.error("----------------------------------------------------------------\n");
  process.exit(1);
}

console.log(`✓ Gemini authentication verified via: ${authState.source}`);

// 3. Setup clean Git workload repository with a genuine bug in multiply()
fs.mkdirSync(WORKLOAD_DIR, { recursive: true });
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

execFileSync("git", ["init"], { cwd: WORKLOAD_DIR });
execFileSync("git", ["config", "user.name", "Plexis Live Gemini Tester"], { cwd: WORKLOAD_DIR });
execFileSync("git", ["config", "user.email", "live-gemini@sentinel.local"], { cwd: WORKLOAD_DIR });
fs.mkdirSync(path.join(WORKLOAD_DIR, "src"), { recursive: true });

fs.writeFileSync(
  path.join(WORKLOAD_DIR, "Cargo.toml"),
  "[package]\nname = \"calc_multiply_live\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
  "utf-8"
);

// Buggy implementation: multiply(a, b) returns a + b
fs.writeFileSync(
  path.join(WORKLOAD_DIR, "src", "lib.rs"),
  `pub fn multiply(a: i32, b: i32) -> i32 {
    a + b // Genuine bug: addition instead of multiplication
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_multiply() {
        assert_eq!(multiply(3, 4), 12);
    }
}
`,
  "utf-8"
);

execFileSync("git", ["add", "-A"], { cwd: WORKLOAD_DIR });
execFileSync("git", ["commit", "-m", "Initial commit with multiply bug"], { cwd: WORKLOAD_DIR });
const initialCommitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: WORKLOAD_DIR, encoding: "utf-8" }).trim();
console.log(`✓ Initialized git workload repository. Initial commit: ${initialCommitSha}`);

// Confirm cargo test fails initially
let initialTestFailed = false;
try {
  execFileSync("cargo", ["test"], { cwd: WORKLOAD_DIR, stdio: "ignore" });
} catch {
  initialTestFailed = true;
}
if (initialTestFailed) {
  console.log("✓ Baseline confirmed: cargo test fails on initial buggy repository");
} else {
  console.error("✗ Expected initial cargo test to fail!");
  process.exit(1);
}

// 4. Initialize Plexis workspace
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const plexisCliPath = path.join(projectRoot, "target/debug/plexis");

console.log("\n--- Step 1: Initializing Plexis Workspace ---");
execFileSync(
  plexisCliPath,
  ["init", WORKLOAD_DIR, "--name", "calc_multiply_live_project", "--db", DB_PATH],
  { stdio: "inherit" }
);

// 5. Start Plexis server
console.log("\n--- Step 2: Starting Plexis Server ---");
const serverEnv = {
  ...process.env,
  PORT: PORT.toString(),
  PLEXIS_DB_PATH: DB_PATH,
  PLEXIS_AUTH_TOKEN: AUTH_TOKEN,
  RUST_LOG: "info",
};
const serverBinary = path.join(projectRoot, "target/debug/plexis-server");
const serverProc = spawn(serverBinary, [], {
  cwd: projectRoot,
  env: serverEnv,
  stdio: ["ignore", "pipe", "pipe"],
});

serverProc.stdout.on("data", (d) => {
  // Optional debug logging
});
serverProc.stderr.on("data", (d) => {
  // Optional debug logging
});

async function cleanup() {
  console.log("\n--- Cleaning Up Server & Workload Resources ---");
  try {
    serverProc.kill("SIGTERM");
  } catch {}
  try {
    fs.rmSync(DB_PATH, { force: true });
    fs.rmSync(WORKLOAD_DIR, { recursive: true, force: true });
    fs.rmSync(ARTIFACTS_DIR, { recursive: true, force: true });
  } catch {}
  console.log("✓ Cleanup complete.");
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(1);
});

// Wait for server health
let serverReady = false;
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (res.ok) {
      serverReady = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

if (!serverReady) {
  console.error("✗ Plexis server failed to start within 10s");
  await cleanup();
  process.exit(1);
}
console.log(`✓ Plexis server healthy on ${BASE_URL}`);

// 6. Query Gemini capability probe endpoint
console.log("\n--- Step 3: Probing Gemini Capability ---");
const probeRes = await fetch(`${BASE_URL}/api/v1/agent-host/backends/gemini`, {
  headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
});
const probeData = await probeRes.json();
console.log(`✓ Probe response:`, JSON.stringify(probeData, null, 2));

if (!probeData.available) {
  console.error("✗ Gemini backend reports unavailable from Plexis server probe!");
  await cleanup();
  process.exit(1);
}

// 7. Launch genuine Gemini workflow
console.log("\n--- Step 4: Dispatching Genuine Gemini Coding Execution ---");
const objective =
  "Fix the multiply implementation in src/lib.rs so that multiply(a, b) computes a * b and cargo test passes. Run cargo test to verify. Stage and commit the fix with git: git add -A && git commit -m 'fix: correct multiplication implementation'.";

const execRes = await fetch(`${BASE_URL}/api/v1/agent-host/executions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    agent_id: "agent_gemini_live",
    role: "Autonomous Developer",
    objective,
    workspace_path: WORKLOAD_DIR,
    backend: "gemini_cli",
    execution_policy: "autonomous",
    timeout_secs: 180,
  }),
});

if (!execRes.ok) {
  const errText = await execRes.text();
  console.error(`✗ Execution request failed: HTTP ${execRes.status}: ${errText}`);
  await cleanup();
  process.exit(1);
}

const execRecord = await execRes.json();
console.log(`✓ Gemini execution launched!`);
console.log(`  Execution ID: ${execRecord.execution_id}`);
console.log(`  PID: ${execRecord.pid}`);
console.log(`  Exit Code: ${execRecord.exit_code}`);
console.log(`  Summary: ${execRecord.summary}`);
console.log(`  Changed Files (reported): ${JSON.stringify(execRecord.changed_files)}`);
console.log(`  Commit SHA (reported): ${execRecord.commit_sha}`);

// 8. Independent Verification directly from disk / Git
console.log("\n--- Step 5: Independent Repository & Test Verification ---");

// A. Check cargo test
let testPassed = false;
try {
  execFileSync("cargo", ["test"], { cwd: WORKLOAD_DIR, stdio: "inherit" });
  testPassed = true;
  console.log("✓ Physical verification: cargo test PASSED in target repository!");
} catch (e) {
  console.error("✗ Physical verification failed: cargo test did NOT pass!");
}

// B. Check git log
const finalCommitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: WORKLOAD_DIR, encoding: "utf-8" }).trim();
const gitLogMsg = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: WORKLOAD_DIR, encoding: "utf-8" }).trim();
const statusPorcelain = execFileSync("git", ["status", "--porcelain"], { cwd: WORKLOAD_DIR, encoding: "utf-8" }).trim();

console.log(`[Git Audit] Initial SHA: ${initialCommitSha}`);
console.log(`[Git Audit] Final SHA:   ${finalCommitSha}`);
console.log(`[Git Audit] Commit Message:\n${gitLogMsg}`);
console.log(`[Git Audit] Working tree status: ${statusPorcelain.length === 0 ? "Clean" : statusPorcelain}`);

// C. Verify source code change physically
const srcContent = fs.readFileSync(path.join(WORKLOAD_DIR, "src/lib.rs"), "utf-8");
const bugFixedInSource = srcContent.includes("a * b");
console.log(`[Source Audit] src/lib.rs modified with 'a * b': ${bugFixedInSource}`);

const commitAdvanced = finalCommitSha !== initialCommitSha;
if (commitAdvanced) {
  console.log("✓ Physical verification: Real Git commit was physically created by Gemini!");
} else {
  console.warn("! Warning: HEAD SHA did not advance (Gemini may have left uncommitted changes).");
}

if (!testPassed || !bugFixedInSource) {
  console.error("✗ Live Gemini execution did not resolve the failing test or fix source.");
  await cleanup();
  process.exit(1);
}

console.log("\n================================================================");
console.log("  REAL LIVE GEMINI CODING EXECUTION: PASSED                     ");
console.log("================================================================");
console.log(`  REAL_LIVE_GEMINI_E2E=passed`);
console.log(`  PID: ${execRecord.pid}`);
console.log(`  Commit SHA: ${finalCommitSha}`);
console.log(`  Duration: ${execRecord.duration_ms}ms`);

await cleanup();
process.exit(0);
