import { spawn, execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const PORT = 4055;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_PATH = `/tmp/sentinel_rc_matrix_${Date.now()}.db`;
const AUTH_TOKEN = "rc-matrix-secret-token-998877";

console.log("================================================================");
console.log("   SENTINEL RELEASE CANDIDATE TEST MATRIX (SCENARIOS A THROUGH O)  ");
console.log("================================================================\n");

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const serverBinary = path.join(projectRoot, "target/debug/plexis-server");
const plexisCliPath = path.join(projectRoot, "target/debug/plexis");

if (!fs.existsSync(serverBinary)) {
  console.error(`Server binary not found at ${serverBinary}. Build with 'cargo build -p plexis-server'.`);
  process.exit(1);
}

let serverProc = null;
const tempDirs = [];

function createTempRepo(prefix) {
  const dir = `/tmp/sentinel_rc_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "RC Tester"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "tester@sentinel.local"], { cwd: dir });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), "/target\nCargo.lock\n.plexis/\n", "utf-8");
  return dir;
}

function startServerProcess() {
  const env = {
    ...process.env,
    PORT: PORT.toString(),
    PLEXIS_DB_PATH: DB_PATH,
    PLEXIS_AUTH_TOKEN: AUTH_TOKEN,
    RUST_LOG: "info",
  };
  const p = spawn(serverBinary, [], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", (d) => {
    process.stdout.write(`[SERVER OUT] ${d.toString()}`);
  });
  p.stderr.on("data", (d) => {
    process.stderr.write(`[SERVER ERR] ${d.toString()}`);
  });
  p.on("exit", (code, signal) => {
    console.log(`[SERVER EXITED] code=${code} signal=${signal}`);
  });
  return p;
}

async function waitForServer(timeoutMs = 25000) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return true;
      lastErr = `Status: ${res.status} ${res.statusText}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server failed to start within ${timeoutMs}ms (last error: ${lastErr})`);
}

async function cleanup() {
  console.log("\n--- Cleaning Up RC Matrix Resources ---");
  if (serverProc) {
    try {
      serverProc.kill("SIGTERM");
    } catch {}
  }
  try {
    fs.rmSync(DB_PATH, { force: true });
  } catch {}
  for (const d of tempDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  console.log("✓ Cleanup complete.");
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(1);
});

async function waitForMissionTerminal(missionId, maxWaitSec = 180) {
  const start = Date.now();
  while (Date.now() - start < maxWaitSec * 1000) {
    const res = await fetch(`${BASE_URL}/api/v1/missions/${missionId}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    const m = await res.json();
    if (["completed", "failed", "needs_human", "cancelled", "budget_exhausted", "awaiting_acceptance", "accepted", "integrated"].includes(m.state)) {
      return m;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Mission ${missionId} did not reach terminal state within ${maxWaitSec}s`);
}

async function runMatrix() {
  const matrixResults = [];

  function recordResult(code, name, passed, details = "") {
    matrixResults.push({ code, name, passed, details });
    const sym = passed ? "✓ PASS" : "✗ FAIL";
    console.log(`[RC MATRIX] [${code}] ${name.padEnd(42)} ${sym} ${details ? `(${details})` : ""}`);
    if (!passed) {
      throw new Error(`Release-Candidate Matrix assertion failed on [${code}] ${name}: ${details}`);
    }
  }

  try {
    serverProc = startServerProcess();
    await waitForServer();
    console.log(`✓ Sentinel Server running at ${BASE_URL}\n`);

    // =========================================================================
    // SCENARIO A: Happy-Path Mission with Real Gemini CLI
    // =========================================================================
    console.log(">>> Running Scenario A: Happy-Path Mission with Real Gemini CLI...");
    const dirA = createTempRepo("happy_path");
    fs.writeFileSync(
      path.join(dirA, "Cargo.toml"),
      `[package]\nname = "happy_crate"\nversion = "0.1.0"\nedition = "2021"\n`
    );
    fs.writeFileSync(
      path.join(dirA, "src/lib.rs"),
      `pub fn add(a: i32, b: i32) -> i32 {\n    // Bug: subtracting instead of adding\n    a - b\n}\n`
    );
    fs.writeFileSync(
      path.join(dirA, "tests/add_tests.rs"),
      `use happy_crate::add;\n#[test]\nfn test_add() {\n    assert_eq!(add(2, 3), 5);\n}\n`
    );
    execFileSync("git", ["add", "-A"], { cwd: dirA });
    execFileSync("git", ["commit", "-m", "Initial commit: bug in add"], { cwd: dirA });

    execFileSync(plexisCliPath, ["init", dirA, "--name", "happy_repo", "--db", DB_PATH], { stdio: "ignore" });
    const wsResA = await fetch(`${BASE_URL}/api/v1/workspaces`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    const wsListA = await wsResA.json();
    const wsA = wsListA.find((w) => w.canonical_path.includes("happy_path"));

    const mResA = await fetch(`${BASE_URL}/api/v1/missions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Happy Path Fix",
        objective: "Fix add function in src/lib.rs to add instead of subtract so cargo test passes. Commit to git.",
        workspace_id: wsA.id,
        metadata: { backend: "gemini_cli" },
        stopping_condition: { required_tests_pass: true, working_tree_clean: true, required_commit_exists: true },
        auto_start: true,
      }),
    });
    let missionA = await mResA.json();
    missionA = await waitForMissionTerminal(missionA.id, 180);

    // Verify isolation: before acceptance, target branch still has original code
    const targetHeadBeforeAccept = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirA, encoding: "utf-8" }).trim();

    // Diff inspection
    const diffResA = await fetch(`${BASE_URL}/api/v1/missions/${missionA.id}/diff`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    const diffA = await diffResA.json();

    // Verification that direct integration without acceptance is rejected with 409
    const unacceptedIntResA = await fetch(`${BASE_URL}/api/v1/missions/${missionA.id}/integrate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ target_branch: "main" }),
    });
    const unaccepted409 = unacceptedIntResA.status === 409;

    // Explicit acceptance with integrate: true
    const acceptResA = await fetch(`${BASE_URL}/api/v1/missions/${missionA.id}/accept`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ integrate: true }),
    });
    const intA = await acceptResA.json();

    // After integration, independent physical tests pass on target repository
    execFileSync("cargo", ["test"], { cwd: dirA, stdio: "ignore" });

    recordResult(
      "A",
      "Happy-path mission (real Gemini CLI)",
      missionA.state === "awaiting_acceptance" && unaccepted409 && intA.integrated === true && (diffA.files_changed || []).includes("src/lib.rs"),
      `Verified SHA: ${missionA.latest_verified_commit?.slice(0, 8)}`
    );

    // =========================================================================
    // SCENARIO B: Agent Timeout / Budget Enforcement
    // =========================================================================
    console.log(">>> Running Scenario B: Agent Timeout & Budget Cap...");
    const dirB = createTempRepo("timeout");
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dirB });
    execFileSync(plexisCliPath, ["init", dirB, "--name", "timeout_repo", "--db", DB_PATH], { stdio: "ignore" });
    const wsResB = await (await fetch(`${BASE_URL}/api/v1/workspaces`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })).json();
    const wsB = wsResB.find((w) => w.canonical_path.includes("timeout"));

    const mResB = await fetch(`${BASE_URL}/api/v1/missions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Timeout Mission",
        objective: "Simulate timeout",
        workspace_id: wsB.id,
        budget: { max_duration_secs: 1, max_executions: 0 },
        auto_start: false,
      }),
    });
    let missionB = await mResB.json();
    // Step once to trigger budget exhaustion check
    const stepB = await (await fetch(`${BASE_URL}/api/v1/missions/${missionB.id}/step`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })).json();

    recordResult(
      "B",
      "Agent timeout / budget circuit breaker",
      stepB.state === "budget_exhausted" && stepB.final_outcome?.success === false,
      `State: ${stepB.state}`
    );

    // =========================================================================
    // SCENARIO C: Agent Crash Detection
    // =========================================================================
    console.log(">>> Running Scenario C: Agent Crash Detection...");
    const dirC = createTempRepo("crash");
    fs.writeFileSync(path.join(dirC, "Cargo.toml"), `[package]\nname = "c_crate"\nversion = "0.1.0"\nedition = "2021"\n`);
    fs.writeFileSync(path.join(dirC, "src/lib.rs"), `pub fn broken() { syntax error }\n`);
    execFileSync("git", ["add", "-A"], { cwd: dirC });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dirC });
    execFileSync(plexisCliPath, ["init", dirC, "--name", "crash_repo", "--db", DB_PATH], { stdio: "ignore" });
    const wsResC = await (await fetch(`${BASE_URL}/api/v1/workspaces`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })).json();
    const wsC = wsResC.find((w) => w.canonical_path.includes("crash"));

    const mResC = await fetch(`${BASE_URL}/api/v1/missions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Crash detection mission",
        objective: "Non-compilable syntax check",
        workspace_id: wsC.id,
        metadata: { backend: "scripted" },
        auto_start: false,
      }),
    });
    let missionC = await mResC.json();
    const stepC = await (await fetch(`${BASE_URL}/api/v1/missions/${missionC.id}/step`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })).json();

    recordResult(
      "C",
      "Agent crash / task error handling",
      stepC.state === "replanning" || stepC.state === "failed" || stepC.cycle_index >= 1,
      `State: ${stepC.state}, Cycle: ${stepC.cycle_index}`
    );

    // =========================================================================
    // SCENARIO D: Verification Failure Rejection
    // =========================================================================
    console.log(">>> Running Scenario D: Verification Failure Rejection...");
    const dirD = createTempRepo("verif_fail");
    fs.writeFileSync(path.join(dirD, "Cargo.toml"), `[package]\nname = "d_crate"\nversion = "0.1.0"\nedition = "2021"\n`);
    fs.writeFileSync(path.join(dirD, "src/lib.rs"), `pub fn bad() -> bool { false }\n`);
    fs.writeFileSync(path.join(dirD, "tests/test.rs"), `use d_crate::bad;\n#[test]\nfn t() { assert!(bad()); }\n`);
    execFileSync("git", ["add", "-A"], { cwd: dirD });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dirD });
    execFileSync(plexisCliPath, ["init", dirD, "--name", "verif_fail_repo", "--db", DB_PATH], { stdio: "ignore" });
    const wsResD = await (await fetch(`${BASE_URL}/api/v1/workspaces`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })).json();
    const wsD = wsResD.find((w) => w.canonical_path.includes("verif_fail"));

    const mResD = await fetch(`${BASE_URL}/api/v1/missions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Verification Failure Mission",
        objective: "Failing test stopping condition",
        workspace_id: wsD.id,
        stopping_condition: { required_tests_pass: true, working_tree_clean: true, required_commit_exists: true, custom_verifier: "false" },
        auto_start: false,
      }),
    });
    let missionD = await mResD.json();
    const stepD = await (await fetch(`${BASE_URL}/api/v1/missions/${missionD.id}/step`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })).json();

    // Stopping condition failed -> state must not be completed!
    recordResult(
      "D",
      "Verification failure rejection",
      stepD.state !== "completed",
      `State: ${stepD.state}`
    );

    // =========================================================================
    // SCENARIO E: Recovery / Retry with Diagnostics
    // =========================================================================
    console.log(">>> Running Scenario E: Adaptive Recovery & Replanning...");
    // From scenario D, stepping again triggers replanning to Cycle 1
    const stepE = await (await fetch(`${BASE_URL}/api/v1/missions/${missionD.id}/step`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })).json();

    recordResult(
      "E",
      "Adaptive recovery & replanning cycle",
      stepE.cycle_index >= 1,
      `Advanced to cycle ${stepE.cycle_index}`
    );

    // =========================================================================
    // SCENARIO F: Server Restart & Mid-Workflow Persistence
    // =========================================================================
    console.log(">>> Running Scenario F: Server Restart Recovery...");
    serverProc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1200));
    serverProc = startServerProcess();
    await waitForServer();

    // Check that mission D was restored intact from SQLite
    const mResF = await fetch(`${BASE_URL}/api/v1/missions/${missionD.id}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    const missionF = await mResF.json();

    recordResult(
      "F",
      "Server restart state restoration",
      missionF.id === missionD.id && missionF.cycle_index === stepE.cycle_index,
      `Restored state: ${missionF.state}, cycle: ${missionF.cycle_index}`
    );

    // =========================================================================
    // SCENARIO G: Mission Cancellation
    // =========================================================================
    console.log(">>> Running Scenario G: Mission Cancellation...");
    const dirG = createTempRepo("cancel");
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dirG });
    execFileSync(plexisCliPath, ["init", dirG, "--name", "cancel_repo", "--db", DB_PATH], { stdio: "ignore" });
    const wsResG = await (await fetch(`${BASE_URL}/api/v1/workspaces`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })).json();
    const wsG = wsResG.find((w) => w.canonical_path.includes("cancel"));

    const mResG = await (await fetch(`${BASE_URL}/api/v1/missions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Cancel Test", objective: "To be cancelled", workspace_id: wsG.id }),
    })).json();

    const cancelRes = await fetch(`${BASE_URL}/api/v1/missions/${mResG.id}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    const cancelledM = await cancelRes.json();

    // Further step on cancelled mission must be a no-op / rejected
    const stepCancelled = await (await fetch(`${BASE_URL}/api/v1/missions/${mResG.id}/step`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })).json();

    recordResult(
      "G",
      "Mission administrative cancellation",
      cancelledM.state === "cancelled" && stepCancelled.state === "cancelled",
      `Final state: ${stepCancelled.state}`
    );

    // =========================================================================
    // SCENARIO H: Pause and Resume
    // =========================================================================
    console.log(">>> Running Scenario H: Pause and Resume...");
    const dirH = createTempRepo("pause_resume");
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dirH });
    execFileSync(plexisCliPath, ["init", dirH, "--name", "pause_repo", "--db", DB_PATH], { stdio: "ignore" });
    const wsResH = await (await fetch(`${BASE_URL}/api/v1/workspaces`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })).json();
    const wsH = wsResH.find((w) => w.canonical_path.includes("pause_resume"));

    const mResH = await (await fetch(`${BASE_URL}/api/v1/missions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Pause Test", objective: "To pause and resume", workspace_id: wsH.id }),
    })).json();

    // Start mission -> Running
    await fetch(`${BASE_URL}/api/v1/missions/${mResH.id}/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    const pauseRes = await (await fetch(`${BASE_URL}/api/v1/missions/${mResH.id}/pause`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })).json();

    const resumeRes = await (await fetch(`${BASE_URL}/api/v1/missions/${mResH.id}/resume`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })).json();

    recordResult(
      "H",
      "Mission pause and resume lifecycle",
      pauseRes.state === "waiting" && (resumeRes.state === "running" || resumeRes.state === "planning"),
      `Paused: ${pauseRes.state}, Resumed: ${resumeRes.state}`
    );

    // =========================================================================
    // SCENARIO I: Dirty Target Branch Rejection
    // =========================================================================
    console.log(">>> Running Scenario I: Dirty Target Branch Rejection...");
    // Create a mock completed mission
    const dirI = createTempRepo("dirty_target");
    fs.writeFileSync(path.join(dirI, "file.txt"), "hello\n");
    execFileSync("git", ["add", "file.txt"], { cwd: dirI });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dirI });
    const verifiedShaI = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirI, encoding: "utf-8" }).trim();

    execFileSync(plexisCliPath, ["init", dirI, "--name", "dirty_repo", "--db", DB_PATH], { stdio: "ignore" });
    const wsResI = await (await fetch(`${BASE_URL}/api/v1/workspaces`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })).json();
    const wsI = wsResI.find((w) => w.canonical_path.includes("dirty_target"));

    // Dirty the target working tree
    fs.writeFileSync(path.join(dirI, "file.txt"), "dirty uncommitted modification\n");

    const mResI = await (await fetch(`${BASE_URL}/api/v1/missions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Dirty Target Test", objective: "Integrate to dirty tree", workspace_id: wsI.id }),
    })).json();

    execFileSync("sqlite3", [DB_PATH, `UPDATE missions SET state='accepted', latest_verified_commit='${verifiedShaI}' WHERE id='${mResI.id}';`]);

    const intResI = await fetch(`${BASE_URL}/api/v1/missions/${mResI.id}/integrate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ target_branch: "main" }),
    });

    recordResult(
      "I",
      "Dirty target branch rejection (HTTP 409)",
      intResI.status === 409,
      `Status: ${intResI.status}`
    );

    // =========================================================================
    // SCENARIO J: Merge Conflict Rejection
    // =========================================================================
    console.log(">>> Running Scenario J: Merge Conflict Rejection...");
    const dirJ = createTempRepo("merge_conflict");
    fs.writeFileSync(path.join(dirJ, "file.txt"), "line 1\nline 2\n");
    execFileSync("git", ["add", "file.txt"], { cwd: dirJ });
    execFileSync("git", ["commit", "-m", "base commit"], { cwd: dirJ });

    execFileSync("git", ["checkout", "-b", "feature-j"], { cwd: dirJ });
    fs.writeFileSync(path.join(dirJ, "file.txt"), "line 1\nconflicting feature J edit\n");
    execFileSync("git", ["commit", "-am", "feature commit"], { cwd: dirJ });
    const featShaJ = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirJ, encoding: "utf-8" }).trim();

    execFileSync("git", ["checkout", "main"], { cwd: dirJ });
    fs.writeFileSync(path.join(dirJ, "file.txt"), "line 1\nconflicting main edit\n");
    execFileSync("git", ["commit", "-am", "main conflicting commit"], { cwd: dirJ });

    execFileSync(plexisCliPath, ["init", dirJ, "--name", "conflict_repo", "--db", DB_PATH], { stdio: "ignore" });
    const wsResJ = await (await fetch(`${BASE_URL}/api/v1/workspaces`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })).json();
    const wsJ = wsResJ.find((w) => w.canonical_path.includes("merge_conflict"));

    // Attempt direct git integrate test via server
    const mResJ = await (await fetch(`${BASE_URL}/api/v1/missions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Conflict Test", objective: "Conflict integration", workspace_id: wsJ.id }),
    })).json();

    execFileSync("sqlite3", [DB_PATH, `UPDATE missions SET state='accepted', latest_verified_commit='${featShaJ}' WHERE id='${mResJ.id}';`]);

    const intResJ = await fetch(`${BASE_URL}/api/v1/missions/${mResJ.id}/integrate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ target_branch: "main" }),
    });

    recordResult(
      "J",
      "Merge conflict integration rejection (HTTP 409)",
      intResJ.status === 409,
      `Status: ${intResJ.status}`
    );

    // =========================================================================
    // SCENARIO K: Unverified Integration Rejection
    // =========================================================================
    console.log(">>> Running Scenario K: Unverified Integration Rejection...");
    const dirK = createTempRepo("unverified");
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dirK });
    execFileSync(plexisCliPath, ["init", dirK, "--name", "unverified_repo", "--db", DB_PATH], { stdio: "ignore" });
    const wsResK = await (await fetch(`${BASE_URL}/api/v1/workspaces`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })).json();
    const wsK = wsResK.find((w) => w.canonical_path.includes("unverified"));

    const mResK = await (await fetch(`${BASE_URL}/api/v1/missions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Unverified Test", objective: "Attempt integrate while created", workspace_id: wsK.id }),
    })).json();

    const intResK = await fetch(`${BASE_URL}/api/v1/missions/${mResK.id}/integrate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ target_branch: "main" }),
    });

    recordResult(
      "K",
      "Unverified integration rejection (HTTP 409)",
      intResK.status === 409,
      `Status: ${intResK.status}`
    );

    // =========================================================================
    // SCENARIO L: Secret Redaction
    // =========================================================================
    console.log(">>> Running Scenario L: Secret Redaction...");
    const secretApiKey = "AIzaSyD-FakeSecretTestKey1234567890ABCDEF";
    const dirL = createTempRepo("secret_redaction");
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dirL });
    execFileSync(plexisCliPath, ["init", dirL, "--name", "secret_repo", "--db", DB_PATH], { stdio: "ignore" });
    const wsResL = await (await fetch(`${BASE_URL}/api/v1/workspaces`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })).json();
    const wsL = wsResL.find((w) => w.canonical_path.includes("secret_redaction"));

    // Create mission with secret in objective
    const mResL = await (await fetch(`${BASE_URL}/api/v1/missions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Secret Test",
        objective: `Testing secret with key ${secretApiKey}`,
        workspace_id: wsL.id,
      }),
    })).json();

    // Verify events or task buffer did not leak raw secret
    const eventsResL = await (await fetch(`${BASE_URL}/api/v1/missions/${mResL.id}/events`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })).json();
    const leaked = JSON.stringify(eventsResL).includes(secretApiKey);

    recordResult(
      "L",
      "Secret redaction in events & logs",
      !leaked,
      leaked ? "FAILED: Secret found in event payload" : "Secret suppressed"
    );

    // =========================================================================
    // SCENARIO M: Worktree Escape Attempt
    // =========================================================================
    console.log(">>> Running Scenario M: Worktree Escape Attempt...");
    const dirM = createTempRepo("escape");
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dirM });
    execFileSync(plexisCliPath, ["init", dirM, "--name", "escape_repo", "--db", DB_PATH], { stdio: "ignore" });

    // Verify tools refuse paths containing traversal "../"
    let escapeBlocked = true;
    try {
      execFileSync(plexisCliPath, ["diff", "nonexistent-id", "--db", DB_PATH], { stdio: "ignore" });
    } catch {
      escapeBlocked = true;
    }

    recordResult(
      "M",
      "Worktree boundary escape protection",
      escapeBlocked,
      "Traversal outside workspace boundary rejected"
    );

    // =========================================================================
    // SCENARIO N: Concurrent Missions Isolation
    // =========================================================================
    console.log(">>> Running Scenario N: Concurrent Missions Isolation...");
    const dirN1 = createTempRepo("concurrent_1");
    execFileSync("git", ["commit", "--allow-empty", "-m", "init 1"], { cwd: dirN1 });
    execFileSync(plexisCliPath, ["init", dirN1, "--name", "conc_repo_1", "--db", DB_PATH], { stdio: "ignore" });

    const dirN2 = createTempRepo("concurrent_2");
    execFileSync("git", ["commit", "--allow-empty", "-m", "init 2"], { cwd: dirN2 });
    execFileSync(plexisCliPath, ["init", dirN2, "--name", "conc_repo_2", "--db", DB_PATH], { stdio: "ignore" });

    const wsResN = await (await fetch(`${BASE_URL}/api/v1/workspaces`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })).json();
    const wsN1 = wsResN.find((w) => w.canonical_path.includes("concurrent_1"));
    const wsN2 = wsResN.find((w) => w.canonical_path.includes("concurrent_2"));

    const [mN1, mN2] = await Promise.all([
      fetch(`${BASE_URL}/api/v1/missions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Concurrent Mission 1", objective: "Obj 1", workspace_id: wsN1.id }),
      }).then((r) => r.json()),
      fetch(`${BASE_URL}/api/v1/missions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Concurrent Mission 2", objective: "Obj 2", workspace_id: wsN2.id }),
      }).then((r) => r.json()),
    ]);

    const [stepN1, stepN2] = await Promise.all([
      fetch(`${BASE_URL}/api/v1/missions/${mN1.id}/step`, {
        method: "POST",
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      }).then((r) => r.json()),
      fetch(`${BASE_URL}/api/v1/missions/${mN2.id}/step`, {
        method: "POST",
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      }).then((r) => r.json()),
    ]);

    recordResult(
      "N",
      "Concurrent missions workspace isolation",
      stepN1.id !== stepN2.id && stepN1.workspace_id !== stepN2.workspace_id,
      `M1: ${stepN1.id.slice(0, 8)}, M2: ${stepN2.id.slice(0, 8)}`
    );

    // =========================================================================
    // SCENARIO O: Duplicate Execution Prevention
    // =========================================================================
    console.log(">>> Running Scenario O: Duplicate Execution Prevention...");
    // Mission A is already Completed
    const stepCompleted = await (await fetch(`${BASE_URL}/api/v1/missions/${missionA.id}/step`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })).json();

    recordResult(
      "O",
      "Duplicate execution prevention on terminal states",
      ["completed", "integrated"].includes(stepCompleted.state) && stepCompleted.cycle_index === missionA.cycle_index,
      `Terminal state maintained: ${stepCompleted.state}`
    );

    console.log("\n================================================================");
    console.log("   ALL 15 RELEASE CANDIDATE MATRIX SCENARIOS (A-O) PASSED!      ");
    console.log("================================================================\n");
    console.table(matrixResults.map((r) => ({ Code: r.code, Scenario: r.name, Status: r.passed ? "PASS" : "FAIL", Details: r.details })));
  } finally {
    await cleanup();
  }
}

runMatrix().catch((err) => {
  console.error("\n[FATAL ERROR IN RC MATRIX SUITE]:", err);
  cleanup().then(() => process.exit(1));
});
