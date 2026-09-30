import { chromium } from "playwright";
import { spawn, execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const PORT = 4029;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_PATH = `/tmp/sentinel_m15_${Date.now()}.db`;
const WORKLOAD_DIR = `/tmp/sentinel_workload_m15_${Date.now()}`;
const AUTH_TOKEN = "m15-mission-token-secret-112233";
const ARTIFACTS_DIR = `/tmp/milestone15_artifacts_${Date.now()}`;
const ARTIFACT_DEST = "/home/roonakyadav/.gemini/antigravity/brain/f5e605a3-b2dc-4c5c-8c4d-347413f30290/milestone15_success.png";

console.log("================================================================");
console.log("   SENTINEL / PLEXIS MILESTONE 15: AUTONOMOUS MISSION ENGINE E2E   ");
console.log("================================================================");
console.log(`[E2E Setup] Database path: ${DB_PATH}`);
console.log(`[E2E Setup] Target workload repository: ${WORKLOAD_DIR}`);
console.log(`[E2E Setup] Artifacts directory: ${ARTIFACTS_DIR}`);
console.log(`[E2E Setup] Hardened Auth Token: ${AUTH_TOKEN}\n`);

fs.mkdirSync(WORKLOAD_DIR, { recursive: true });
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

// 1. Setup real Git workload repository: auth_service crate with token verification bug
execFileSync("git", ["init"], { cwd: WORKLOAD_DIR });
execFileSync("git", ["config", "user.name", "Plexis Mission Tester"], { cwd: WORKLOAD_DIR });
execFileSync("git", ["config", "user.email", "mission-tester@sentinel.local"], { cwd: WORKLOAD_DIR });
fs.mkdirSync(path.join(WORKLOAD_DIR, "src"), { recursive: true });
fs.mkdirSync(path.join(WORKLOAD_DIR, "tests"), { recursive: true });

fs.writeFileSync(
  path.join(WORKLOAD_DIR, "Cargo.toml"),
  `[package]
name = "auth_service_m15"
version = "0.1.0"
edition = "2021"

[dependencies]
`,
  "utf-8"
);

// Buggy service: does not accept bearer prefix and always returns false
fs.writeFileSync(
  path.join(WORKLOAD_DIR, "src/lib.rs"),
  `pub fn validate_token(token: &str) -> bool {
    // BUG: hardcoded failure, missing prefix parsing
    let _ = token;
    false
}
`,
  "utf-8"
);

fs.writeFileSync(
  path.join(WORKLOAD_DIR, "tests/auth_tests.rs"),
  `use auth_service_m15::validate_token;

#[test]
fn test_valid_token_with_prefix() {
    let raw = "Bearer secret-valid-token-123";
    assert!(validate_token(raw));
}

#[test]
fn test_invalid_token_fails() {
    let raw = "Bearer invalid-token";
    assert!(!validate_token(raw));
}
`,
  "utf-8"
);

fs.writeFileSync(
  path.join(WORKLOAD_DIR, ".gitignore"),
  `/target\nCargo.lock\n.plexis/\n`,
  "utf-8"
);

execFileSync("git", ["add", "-A"], { cwd: WORKLOAD_DIR });
execFileSync("git", ["commit", "-m", "Initial commit: buggy auth_service token validation"], {
  cwd: WORKLOAD_DIR,
});
const initialCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: WORKLOAD_DIR,
  encoding: "utf-8",
}).trim();
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

// 2. Initialize Plexis workspace
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const plexisCliPath = path.join(projectRoot, "target/debug/plexis");
console.log("\n--- Step 1: Initializing Plexis Workspace ---");
execFileSync(
  plexisCliPath,
  ["init", WORKLOAD_DIR, "--name", "auth_service_project", "--db", DB_PATH],
  { stdio: "inherit" }
);

// 3. Start Plexis server
console.log("\n--- Step 2: Starting Authoritative Server ---");
function startServerProcess() {
  const env = {
    ...process.env,
    PORT: PORT.toString(),
    PLEXIS_DB_PATH: DB_PATH,
    PLEXIS_AUTH_TOKEN: AUTH_TOKEN,
    RUST_LOG: "info",
  };
  const binary = path.join(projectRoot, "target/debug/plexis-server");
  const p = spawn(binary, [], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", (d) => process.stdout.write(`[SERVER] ${d}`));
  p.stderr.on("data", (d) => process.stderr.write(`[SERVER ERR] ${d}`));
  return p;
}

let serverProc = startServerProcess();

async function cleanup() {
  console.log("\n--- Cleaning Up Resources ---");
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

async function waitForServer(timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server failed to start within ${timeoutMs}ms`);
}

await waitForServer();
console.log(`✓ Plexis server operational on ${BASE_URL}`);

// Fetch workspace ID
const wsRes = await fetch(`${BASE_URL}/api/v1/workspaces`, {
  headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
});
const workspaces = await wsRes.json();
if (!workspaces || workspaces.length === 0) {
  throw new Error("No workspaces found");
}
const workspaceId = workspaces[0].id;
console.log(`✓ Found workspace ID: ${workspaceId} (${workspaces[0].name})`);

// 4. Phase 1: Launch Long-Horizon Mission
console.log("\n--- Step 3: Launching Durable Autonomous Mission ---");
const missionPayload = {
  title: "Long-Horizon Autonomous Mission: Auth Service Quality Gate",
  objective: "Fix the failing tests in tests/auth_tests.rs by modifying src/lib.rs to properly parse Bearer prefix and validate the token. Run cargo test to verify, then commit your changes to git.",
  workspace_id: workspaceId,
  metadata: {
    backend: "gemini_cli",
  },
  budget: {
    max_duration_secs: 7200,
    max_concurrent_agents: 4,
    max_executions: 20,
    max_recovery_attempts: 5,
    max_planner_iterations: 10,
    max_stagnant_cycles: 4,
  },
  stopping_condition: {
    required_tests_pass: true,
    working_tree_clean: true,
    required_commit_exists: true,
  },
  auto_start: true,
};

const createMissionRes = await fetch(`${BASE_URL}/api/v1/missions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(missionPayload),
});

if (!createMissionRes.ok) {
  throw new Error(`Create mission failed: ${await createMissionRes.text()}`);
}
let mission = await createMissionRes.json();
console.log(`✓ Mission created and started: ID=${mission.id}, State=${mission.state}`);

// 5. Phase 2: Autonomous Multi-Cycle Execution & Genuine Failure Recovery
console.log("\n--- Step 4: Autonomous Multi-Cycle Progression & Adaptive Replanning ---");

// Step 1: Cycle 0 -> Investigation & verification failure on initial defect, RecoveryController strategy mutation, replanning
console.log("Executing Step for Cycle 0 (Investigation & Defect Isolation)...");
let stepRes = await fetch(`${BASE_URL}/api/v1/missions/${mission.id}/step`, {
  method: "POST",
  headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
});
if (!stepRes.ok) {
  throw new Error(`Cycle 0 step failed: ${await stepRes.text()}`);
}
mission = await stepRes.json();
console.log(`✓ Cycle 0 complete. Next Cycle Index=${mission.cycle_index}, State=${mission.state}`);

if (mission.cycle_index !== 1 || mission.state !== "replanning") {
  throw new Error(`Expected Cycle 0 to replan with cycle_index 1 and state replanning, got index ${mission.cycle_index} state ${mission.state}`);
}

// Query checkpoints to verify durability
let ckptRes = await fetch(`${BASE_URL}/api/v1/missions/${mission.id}/checkpoints`, {
  headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
});
let ckpts = await ckptRes.json();
console.log(`✓ Durable checkpoints stored: ${ckpts.length} checkpoint(s)`);
if (ckpts.length === 0) throw new Error("Expected at least 1 checkpoint");

// 6. Phase 3: Server Restart & Startup Reconciliation Test
console.log("\n--- Step 5: Testing Server Restart Crash Resumption ---");
console.log("Sending SIGTERM to active server process...");
serverProc.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 1200));

console.log("Restarting Plexis server against identical SQLite DB...");
serverProc = startServerProcess();
await waitForServer();
console.log("✓ Server successfully restarted!");

// Verify mission was reconciled and is queryable
const statusAfterRestartRes = await fetch(`${BASE_URL}/api/v1/missions/${mission.id}/status`, {
  headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
});
if (!statusAfterRestartRes.ok) {
  throw new Error(`Mission not found after restart: ${await statusAfterRestartRes.text()}`);
}
const statusAfterRestart = await statusAfterRestartRes.json();
console.log(`✓ Mission reconciled after server restart. Current State=${statusAfterRestart.mission.state}, Checkpoint Cycle=${statusAfterRestart.latest_checkpoint?.cycle_index}`);

// 7. Phase 4: Autonomous Execution of Replanned Cycle 1 via Real Google Gemini CLI Agent
console.log("\n--- Step 6: Autonomous Execution of Replanned Cycle 1 (Real Gemini CLI Agent) ---");
console.log("Executing Step for Cycle 1: Real Gemini CLI repairs src/lib.rs, verifies cargo test, and commits without any manual intervention...");

stepRes = await fetch(`${BASE_URL}/api/v1/missions/${mission.id}/step`, {
  method: "POST",
  headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
});
if (!stepRes.ok) {
  throw new Error(`Cycle 1 step failed: ${await stepRes.text()}`);
}
mission = await stepRes.json();
console.log(`✓ Cycle 1 execution complete. State=${mission.state}, Latest Verified Commit=${mission.latest_verified_commit}`);

// 8. Phase 5: Authoritative Physical Verification on Disk
console.log("\n--- Step 7: Final Step - Physical Stopping Condition Verification ---");
console.log(`✓ Final Mission State: ${mission.state}`);
console.log(`✓ Verified Commit SHA: ${mission.latest_verified_commit}`);
console.log(`✓ Final Outcome: ${JSON.stringify(mission.final_outcome)}`);

if (mission.state !== "completed") {
  throw new Error(`Expected mission state 'completed', got '${mission.state}'`);
}
if (!mission.latest_verified_commit || mission.latest_verified_commit === initialCommitSha) {
  throw new Error(`Expected new verified commit SHA differing from initial commit SHA (${initialCommitSha}), got ${mission.latest_verified_commit}`);
}
if (!mission.final_outcome?.success) {
  throw new Error("Expected final outcome success to be true");
}

// Authoritative check on disk: zero manual intervention, real cargo test passes
console.log("Running independent cargo test on disk...");
execFileSync("cargo", ["test"], { cwd: WORKLOAD_DIR, stdio: "inherit" });
console.log("✓ cargo test independently passes on disk!");

// Authoritative check on disk: working tree clean
const gitStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: WORKLOAD_DIR,
  encoding: "utf-8",
}).trim();
if (gitStatus.length > 0) {
  throw new Error(`Expected clean git working tree, found dirty status:\n${gitStatus}`);
}
console.log("✓ Git working tree is completely clean.");

const currentHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: WORKLOAD_DIR,
  encoding: "utf-8",
}).trim();
if (currentHead !== mission.latest_verified_commit) {
  throw new Error(`HEAD commit (${currentHead}) does not match mission latest_verified_commit (${mission.latest_verified_commit})`);
}
console.log(`✓ Verified authoritative Git commit created by autonomous agent: ${currentHead}`);

const commitLog = execFileSync("git", ["log", "-n", "1"], {
  cwd: WORKLOAD_DIR,
  encoding: "utf-8",
});
console.log(`✓ Commit provenance log:\n${commitLog}`);
console.log("✓ All physical stopping conditions verified independently on disk!");

// 9. Phase 6: Stagnation Detection & Human Escalation Verification
console.log("\n--- Step 8: Verifying Stagnation Detection & Human Escalation ---");
const stagnantMissionPayload = {
  title: "Stagnation Bound Verification Mission",
  objective: "Test that non-progressing objective triggers human escalation",
  workspace_id: workspaceId,
  budget: {
    max_duration_secs: 3600,
    max_concurrent_agents: 2,
    max_executions: 10,
    max_recovery_attempts: 2,
    max_planner_iterations: 5,
    max_stagnant_cycles: 2,
  },
  stopping_condition: {
    required_tests_pass: false,
    working_tree_clean: false,
    required_commit_exists: false,
    custom_verifier: "false",
  },
  auto_start: true,
};

const stagRes = await fetch(`${BASE_URL}/api/v1/missions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(stagnantMissionPayload),
});
let stagMission = await stagRes.json();

// Step 1: stagnant = 1
const stagRes2 = await fetch(`${BASE_URL}/api/v1/missions/${stagMission.id}/step`, {
  method: "POST",
  headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
});
stagMission = await stagRes2.json();
console.log(`✓ Stagnation cycle 1: Stagnant Count=${stagMission.budget_consumed.stagnant_cycles}`);

// Step 2: stagnant = 2 -> triggers NeedsHuman escalation
const stagRes3 = await fetch(`${BASE_URL}/api/v1/missions/${stagMission.id}/step`, {
  method: "POST",
  headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
});
stagMission = await stagRes3.json();
console.log(`✓ Stagnation cycle 2: State=${stagMission.state}, EscalationReason=${stagMission.escalation_reason}`);

if (stagMission.state !== "needs_human") {
  throw new Error(`Expected needs_human state, got ${stagMission.state}`);
}

// Resolve escalation via API
console.log("Resolving human escalation with 'replan' operator decision...");
const resolveRes = await fetch(`${BASE_URL}/api/v1/missions/${stagMission.id}/resolve`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ decision: "replan" }),
});
stagMission = await resolveRes.json();
console.log(`✓ Escalation resolved: State=${stagMission.state}`);
if (stagMission.state !== "replanning") {
  throw new Error(`Expected replanning state, got ${stagMission.state}`);
}

// 10. Phase 7: Strict Resource Budget Exhaustion Verification
console.log("\n--- Step 9: Verifying Resource Budget Exhaustion ---");
const budgetMissionPayload = {
  title: "Budget Limit Verification Mission",
  objective: "Test strict halting when planner budget is exhausted",
  workspace_id: workspaceId,
  budget: {
    max_duration_secs: 3600,
    max_concurrent_agents: 2,
    max_executions: 1, // Tiny budget limit of 1 execution!
    max_recovery_attempts: 2,
    max_planner_iterations: 5,
    max_stagnant_cycles: 5,
  },
  stopping_condition: {
    required_tests_pass: false,
    working_tree_clean: false,
    required_commit_exists: false,
    custom_verifier: "false",
  },
  auto_start: true,
};

const budgetRes = await fetch(`${BASE_URL}/api/v1/missions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(budgetMissionPayload),
});
let budgetMission = await budgetRes.json();

// Step 1: triggers replan, consumes 1 planner iteration
let stepBudgetRes = await fetch(`${BASE_URL}/api/v1/missions/${budgetMission.id}/step`, {
  method: "POST",
  headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
});
budgetMission = await stepBudgetRes.json();

// Step 2: budget exhausted check fires
stepBudgetRes = await fetch(`${BASE_URL}/api/v1/missions/${budgetMission.id}/step`, {
  method: "POST",
  headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
});
budgetMission = await stepBudgetRes.json();
console.log(`✓ Budget Mission State: ${budgetMission.state}`);
if (budgetMission.state !== "budget_exhausted") {
  throw new Error(`Expected budget_exhausted state, got ${budgetMission.state}`);
}
console.log("✓ Budget exhaustion halted mission deterministically!");

// 11. Phase 8: Playwright Visual Verification
console.log("\n--- Step 10: Playwright Visual Verification & UI Audit ---");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

// Seed localStorage with token
await page.goto(`${BASE_URL}`);
await page.evaluate((tok) => {
  localStorage.setItem("plexis_auth_token", tok);
}, AUTH_TOKEN);

await page.goto(`${BASE_URL}`);
await page.waitForLoadState("networkidle");

// Click on Missions tab
console.log("Navigating to Missions tab...");
const missionsTab = page.locator("button", { hasText: "Missions" });
await missionsTab.click();
await page.waitForTimeout(1000);

// Wait for mission dashboard to render
await page.waitForSelector("text=Autonomous Mission Engine");
console.log("✓ Missions Dashboard rendered in UI!");

// Take screenshot
const screenshotPath = path.join(ARTIFACTS_DIR, "milestone15_success.png");
await page.screenshot({ path: screenshotPath, fullPage: true });
console.log(`✓ Screenshot captured: ${screenshotPath}`);

// Copy screenshot to required artifact path
try {
  fs.copyFileSync(screenshotPath, ARTIFACT_DEST);
  console.log(`✓ Copied artifact screenshot to ${ARTIFACT_DEST}`);
} catch (e) {
  console.warn(`Could not copy screenshot to ${ARTIFACT_DEST}: ${e}`);
}
try {
  const docsDir = path.join(projectRoot, "docs");
  if (fs.existsSync(docsDir)) {
    fs.copyFileSync(screenshotPath, path.join(docsDir, "milestone15_success.png"));
    console.log(`✓ Copied artifact screenshot to docs/milestone15_success.png`);
  }
} catch {}

await browser.close();

console.log("\n================================================================");
console.log("   ✓ MILESTONE 15 LONG-HORIZON AUTONOMOUS MISSION FULLY PROVEN!   ");
console.log("================================================================");

await cleanup();
process.exit(0);
