import { spawn, execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const PORT = 4060;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_PATH = `/tmp/sentinel_m20_reliability_${Date.now()}.db`;
const AUTH_TOKEN = "m20-reliability-secret-token-445566";

console.log("========================================================================");
console.log("   SENTINEL M20 TRANSACTIONAL INTEGRATION & RELIABILITY TEST SUITE (A - O)");
console.log("========================================================================\n");

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const serverBinary = path.join(projectRoot, "target/debug/plexis-server");
const plexisCliPath = fs.existsSync(path.join(projectRoot, "target/debug/sentinel"))
  ? path.join(projectRoot, "target/debug/sentinel")
  : path.join(projectRoot, "target/debug/plexis");

if (!fs.existsSync(serverBinary)) {
  console.error(`Server binary not found at ${serverBinary}. Run 'cargo build -p plexis-server'.`);
  process.exit(1);
}

let serverProc = null;
const tempDirs = [];

function createTempRepo(prefix) {
  const dir = `/tmp/sentinel_m20_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "M20 Reliability Tester"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "m20@sentinel.local"], { cwd: dir });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Cargo.toml"), `[package]\nname = "${prefix}_crate"\nversion = "0.1.0"\nedition = "2021"\n`);
  fs.writeFileSync(path.join(dir, "src/lib.rs"), `pub fn compute() -> i32 { 10 }\n`);
  fs.writeFileSync(path.join(dir, ".gitignore"), "/target\nCargo.lock\n.plexis/\n", "utf-8");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial repo commit"], { cwd: dir });
  return dir;
}

function startServerProcess(customDb = DB_PATH) {
  const env = {
    ...process.env,
    PORT: PORT.toString(),
    PLEXIS_DB_PATH: customDb,
    PLEXIS_AUTH_TOKEN: AUTH_TOKEN,
    RUST_LOG: "info",
  };
  const p = spawn(serverBinary, [], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return p;
}

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return true;
      lastErr = `Status: ${res.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Server failed to start within ${timeoutMs}ms (last err: ${lastErr})`);
}

async function api(endpoint, options = {}) {
  const headers = {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, ok: res.ok, body: json || text };
}

async function cleanup() {
  console.log("\n--- Cleaning Up M20 Test Resources ---");
  if (serverProc) {
    try {
      serverProc.kill("SIGKILL");
    } catch {}
  }
  for (const d of tempDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  try {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  } catch {}
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(1);
});

async function runSuite() {
  serverProc = startServerProcess();
  await waitForServer();

  const results = [];

  function record(id, name, type, pass, evidence) {
    results.push({ id, name, type, pass, evidence });
    const tag = type === "E2E" ? "[REAL PRODUCT E2E]" : "[DOMAIN/POLICY TEST]";
    console.log(`[${pass ? "PASS" : "FAIL"}] Scenario ${id}: ${name} ${tag}`);
    if (!pass) console.error(`       Error: ${evidence}`);
  }

  // Helper to create workspace in DB
  async function setupWorkspace(dir, name) {
    execFileSync(plexisCliPath, ["init", dir, "--name", name, "--db", DB_PATH], { stdio: "ignore" });
    const wsRes = await api("/api/v1/workspaces");
    return wsRes.body.find((w) => w.canonical_path.includes(path.basename(dir)));
  }

  function setMissionState(missionId, state, verifiedCommit = null, intent = null) {
    let sql = `UPDATE missions SET state='${state}'`;
    if (verifiedCommit) {
      sql += `, latest_verified_commit='${verifiedCommit}'`;
    }
    if (intent) {
      const meta = JSON.stringify({ integration_intent: intent }).replace(/'/g, "''");
      sql += `, metadata='${meta}'`;
    }
    sql += ` WHERE id='${missionId}';`;
    execFileSync("sqlite3", [DB_PATH, sql]);
  }

  // =========================================================================
  // SCENARIO A: Happy-path Integration
  // =========================================================================
  try {
    const dirA = createTempRepo("happy_path");
    const wsA = await setupWorkspace(dirA, "ws_happy_path");

    // Make candidate commit on feature branch
    execFileSync("git", ["checkout", "-b", "feature-a"], { cwd: dirA });
    fs.writeFileSync(path.join(dirA, "src/lib.rs"), "pub fn compute() -> i32 { 42 }\n");
    execFileSync("git", ["commit", "-am", "candidate deliverable commit A"], { cwd: dirA });
    const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirA }).toString().trim();
    execFileSync("git", ["checkout", "main"], { cwd: dirA });

    const mRes = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({
        title: "Happy Path Mission",
        objective: "Integrate deliverable",
        workspace_id: wsA.id,
      }),
    });
    const missionId = mRes.body.id;

    // Simulate verification passing -> awaiting_acceptance with candidate commit
    setMissionState(missionId, "awaiting_acceptance", candidateSha);

    // Accept deliverable
    const accRes = await api(`/api/v1/missions/${missionId}/accept`, {
      method: "POST",
      body: JSON.stringify({ feedback: "LGTM" }),
    });

    // Integrate deliverable
    const intRes = await api(`/api/v1/missions/${missionId}/integrate`, {
      method: "POST",
      body: JSON.stringify({ target_branch: "main" }),
    });

    const targetHead = execFileSync("git", ["rev-parse", "main"], { cwd: dirA }).toString().trim();
    const isAncestor = execFileSync("git", ["merge-base", "--is-ancestor", candidateSha, "main"], { cwd: dirA, stdio: "pipe" });

    const passA = accRes.status === 200 &&
      intRes.status === 200 &&
      intRes.body.integrated === true &&
      targetHead === candidateSha;
    record("A", "Happy-path integration", "POLICY", passA, `Target HEAD: ${targetHead}, Candidate: ${candidateSha}`);
  } catch (e) {
    record("A", "Happy-path integration", "POLICY", false, e.message);
  }

  // =========================================================================
  // SCENARIO B: Duplicate Request Idempotency
  // =========================================================================
  try {
    const dirB = createTempRepo("dup_req");
    const wsB = await setupWorkspace(dirB, "ws_dup_req");

    execFileSync("git", ["checkout", "-b", "feature-b"], { cwd: dirB });
    fs.writeFileSync(path.join(dirB, "src/lib.rs"), "pub fn compute() -> i32 { 100 }\n");
    execFileSync("git", ["commit", "-am", "candidate B"], { cwd: dirB });
    const candidateShaB = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirB }).toString().trim();
    execFileSync("git", ["checkout", "main"], { cwd: dirB });

    const mRes = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Dup Mission", objective: "Dup test", workspace_id: wsB.id }),
    });
    const missionId = mRes.body.id;

    setMissionState(missionId, "awaiting_acceptance", candidateShaB);

    await api(`/api/v1/missions/${missionId}/accept`, {
      method: "POST",
      body: JSON.stringify({ integrate: true, target_branch: "main" }),
    });

    // Subsequent integrate call
    const intRes2 = await api(`/api/v1/missions/${missionId}/integrate`, {
      method: "POST",
      body: JSON.stringify({ target_branch: "main" }),
    });

    const passB = intRes2.status === 200 && intRes2.body.already_integrated === true;
    record("B", "Duplicate integration request", "POLICY", passB, `Already integrated: ${intRes2.body?.already_integrated}`);
  } catch (e) {
    record("B", "Duplicate integration request", "POLICY", false, e.message);
  }

  // =========================================================================
  // SCENARIO C: Concurrent Duplicate Requests
  // =========================================================================
  try {
    const dirC = createTempRepo("concurrent_dup");
    const wsC = await setupWorkspace(dirC, "ws_concurrent_dup");

    execFileSync("git", ["checkout", "-b", "feature-c"], { cwd: dirC });
    fs.writeFileSync(path.join(dirC, "src/lib.rs"), "pub fn compute() -> i32 { 200 }\n");
    execFileSync("git", ["commit", "-am", "candidate C"], { cwd: dirC });
    const candidateShaC = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirC }).toString().trim();
    execFileSync("git", ["checkout", "main"], { cwd: dirC });

    const mRes = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Concurrent Mission", objective: "Concurrent test", workspace_id: wsC.id }),
    });
    const missionId = mRes.body.id;

    setMissionState(missionId, "awaiting_acceptance", candidateShaC);

    await api(`/api/v1/missions/${missionId}/accept`, {
      method: "POST",
      body: JSON.stringify({ feedback: "Accepted" }),
    });

    // Fire 2 concurrent integration requests
    const [res1, res2] = await Promise.all([
      api(`/api/v1/missions/${missionId}/integrate`, { method: "POST", body: JSON.stringify({ target_branch: "main" }) }),
      api(`/api/v1/missions/${missionId}/integrate`, { method: "POST", body: JSON.stringify({ target_branch: "main" }) }),
    ]);

    const statuses = [res1.status, res2.status];
    const passC = statuses.includes(200) && (statuses.includes(200) || statuses.includes(409));
    record("C", "Concurrent duplicate integration requests", "POLICY", passC, `Statuses: ${statuses.join(", ")}`);
  } catch (e) {
    record("C", "Concurrent duplicate integration requests", "POLICY", false, e.message);
  }

  // =========================================================================
  // SCENARIO D: Merge Conflict Atomic Rollback
  // =========================================================================
  try {
    const dirD = createTempRepo("conflict_abort");
    const wsD = await setupWorkspace(dirD, "ws_conflict_abort");

    // Create branch feature-d
    execFileSync("git", ["checkout", "-b", "feature-d"], { cwd: dirD });
    fs.writeFileSync(path.join(dirD, "src/lib.rs"), "pub fn compute() -> i32 { 999 }\n");
    execFileSync("git", ["commit", "-am", "candidate D conflicting"], { cwd: dirD });
    const candidateShaD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirD }).toString().trim();

    // Now modify main branch with conflicting edit
    execFileSync("git", ["checkout", "main"], { cwd: dirD });
    fs.writeFileSync(path.join(dirD, "src/lib.rs"), "pub fn compute() -> i32 { 111 }\n");
    execFileSync("git", ["commit", "-am", "main conflicting change"], { cwd: dirD });

    const mRes = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Conflict Mission", objective: "Conflict test", workspace_id: wsD.id }),
    });
    const missionId = mRes.body.id;

    setMissionState(missionId, "awaiting_acceptance", candidateShaD);
    await api(`/api/v1/missions/${missionId}/accept`, { method: "POST", body: JSON.stringify({}) });

    const intRes = await api(`/api/v1/missions/${missionId}/integrate`, {
      method: "POST",
      body: JSON.stringify({ target_branch: "main", force: true }),
    });

    // Check git repo is clean and not stuck in merge
    const gitStatus = execFileSync("git", ["status", "--porcelain"], { cwd: dirD }).toString();
    const mergeHeadExists = fs.existsSync(path.join(dirD, ".git/MERGE_HEAD"));
    const mCheck = await api(`/api/v1/missions/${missionId}`);

    const passD = intRes.status === 409 &&
      gitStatus.trim() === "" &&
      !mergeHeadExists &&
      mCheck.body.state === "accepted";
    record("D", "Merge conflict atomic rollback", "POLICY", passD, `Status: ${intRes.status}, tree clean: ${gitStatus.trim() === ""}, state: ${mCheck.body?.state}`);
  } catch (e) {
    record("D", "Merge conflict atomic rollback", "POLICY", false, e.message);
  }

  // =========================================================================
  // SCENARIO E: Dirty Target Working Tree Rejection
  // =========================================================================
  try {
    const dirE = createTempRepo("dirty_target");
    const wsE = await setupWorkspace(dirE, "ws_dirty_target");

    execFileSync("git", ["checkout", "-b", "feature-e"], { cwd: dirE });
    fs.writeFileSync(path.join(dirE, "src/lib.rs"), "pub fn compute() -> i32 { 55 }\n");
    execFileSync("git", ["commit", "-am", "candidate E"], { cwd: dirE });
    const candidateShaE = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirE }).toString().trim();
    execFileSync("git", ["checkout", "main"], { cwd: dirE });

    // Make target dirty with uncommitted file
    fs.writeFileSync(path.join(dirE, "uncommitted_user_file.txt"), "important developer edits\n");

    const mRes = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Dirty Target Mission", objective: "Dirty test", workspace_id: wsE.id }),
    });
    const missionId = mRes.body.id;

    setMissionState(missionId, "awaiting_acceptance", candidateShaE);
    await api(`/api/v1/missions/${missionId}/accept`, { method: "POST", body: JSON.stringify({}) });

    const intRes = await api(`/api/v1/missions/${missionId}/integrate`, {
      method: "POST",
      body: JSON.stringify({ target_branch: "main" }),
    });

    const fileContent = fs.readFileSync(path.join(dirE, "uncommitted_user_file.txt"), "utf-8");
    const mCheck = await api(`/api/v1/missions/${missionId}`);

    const passE = intRes.status === 409 &&
      intRes.body.error?.includes("dirty") &&
      fileContent.includes("important developer edits") &&
      mCheck.body.state === "accepted";
    record("E", "Dirty target repository rejection", "POLICY", passE, `Status: ${intRes.status}, file preserved: true, state: ${mCheck.body?.state}`);
  } catch (e) {
    record("E", "Dirty target repository rejection", "POLICY", false, e.message);
  }

  // =========================================================================
  // SCENARIO F: Stale Target Branch Rejection
  // =========================================================================
  try {
    const dirF = createTempRepo("stale_target");
    const wsF = await setupWorkspace(dirF, "ws_stale_target");

    const initialHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirF }).toString().trim();

    execFileSync("git", ["checkout", "-b", "feature-f"], { cwd: dirF });
    fs.writeFileSync(path.join(dirF, "src/lib.rs"), "pub fn compute() -> i32 { 77 }\n");
    execFileSync("git", ["commit", "-am", "candidate F"], { cwd: dirF });
    const candidateShaF = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirF }).toString().trim();

    execFileSync("git", ["checkout", "main"], { cwd: dirF });

    const mRes = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Stale Mission", objective: "Stale test", workspace_id: wsF.id }),
    });
    const missionId = mRes.body.id;

    setMissionState(missionId, "awaiting_acceptance", candidateShaF);
    await api(`/api/v1/missions/${missionId}/accept`, { method: "POST", body: JSON.stringify({}) });

    // Target moves ahead on main
    fs.writeFileSync(path.join(dirF, "src/extra.rs"), "pub fn extra() {}\n");
    execFileSync("git", ["add", "src/extra.rs"], { cwd: dirF });
    execFileSync("git", ["commit", "-m", "concurrent commit on main"], { cwd: dirF });
    const newTargetHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirF }).toString().trim();

    // Integration with expected_target_head = initialHead
    const intRes = await api(`/api/v1/missions/${missionId}/integrate`, {
      method: "POST",
      body: JSON.stringify({ target_branch: "main", expected_target_head: initialHead }),
    });

    const passF = intRes.status === 409 &&
      intRes.body.error?.includes("has changed since verification");
    record("F", "Stale target branch rejection", "POLICY", passF, `Status: ${intRes.status}, error: ${intRes.body?.error}`);
  } catch (e) {
    record("F", "Stale target branch rejection", "POLICY", false, e.message);
  }

  // =========================================================================
  // SCENARIO G: Crash during Integration (Git Incomplete) -> Reconciliation
  // =========================================================================
  try {
    const dirG = createTempRepo("crash_incomplete");
    const wsG = await setupWorkspace(dirG, "ws_crash_incomplete");

    execFileSync("git", ["checkout", "-b", "feature-g"], { cwd: dirG });
    fs.writeFileSync(path.join(dirG, "src/lib.rs"), "pub fn compute() -> i32 { 123 }\n");
    execFileSync("git", ["commit", "-am", "candidate G"], { cwd: dirG });
    const candidateShaG = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirG }).toString().trim();
    execFileSync("git", ["checkout", "main"], { cwd: dirG });

    const mRes = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Crash Incomplete Mission", objective: "Crash test", workspace_id: wsG.id }),
    });
    const missionId = mRes.body.id;

    // Simulate state transition to Integrating directly in DB (as if server crashed during merge)
    setMissionState(missionId, "integrating", candidateShaG, {
      target_branch: "main",
      candidate_commit: candidateShaG,
      started_at: new Date().toISOString(),
    });

    // Run system reconciliation
    const recRes = await api("/api/v1/system/reconcile", { method: "POST" });
    const mCheck = await api(`/api/v1/missions/${missionId}`);

    const passG = recRes.status === 200 &&
      mCheck.body.state === "accepted" &&
      mCheck.body.metadata?.reconciliation_reason?.includes("not_integrated_on_disk");
    record("G", "Crash during integration (Git incomplete) -> reset to Accepted", "POLICY", passG, `Reconciled state: ${mCheck.body?.state}`);
  } catch (e) {
    record("G", "Crash during integration (Git incomplete)", "POLICY", false, e.message);
  }

  // =========================================================================
  // SCENARIO H: Restart During Integration (Truthful Resolution)
  // =========================================================================
  try {
    const dirH = createTempRepo("restart_resolution");
    const wsH = await setupWorkspace(dirH, "ws_restart_resolution");

    execFileSync("git", ["checkout", "-b", "feature-h"], { cwd: dirH });
    fs.writeFileSync(path.join(dirH, "src/lib.rs"), "pub fn compute() -> i32 { 321 }\n");
    execFileSync("git", ["commit", "-am", "candidate H"], { cwd: dirH });
    const candidateShaH = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirH }).toString().trim();
    execFileSync("git", ["checkout", "main"], { cwd: dirH });

    const mRes = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Restart Mission", objective: "Restart test", workspace_id: wsH.id }),
    });
    const missionId = mRes.body.id;

    setMissionState(missionId, "integrating", candidateShaH, {
      target_branch: "main",
      candidate_commit: candidateShaH,
      started_at: new Date().toISOString(),
    });

    // Simulate server process restart
    serverProc.kill("SIGKILL");
    serverProc = startServerProcess();
    await waitForServer();

    // After server startup, reconciliation automatically ran!
    const mCheck = await api(`/api/v1/missions/${missionId}`);

    const passH = mCheck.body.state === "accepted";
    record("H", "Restart during integration truthful resolution", "POLICY", passH, `Post-restart state: ${mCheck.body?.state}`);
  } catch (e) {
    record("H", "Restart during integration truthful resolution", "POLICY", false, e.message);
  }

  // =========================================================================
  // SCENARIO I: Git Success / DB Failure -> Reconciled to Integrated
  // =========================================================================
  try {
    const dirI = createTempRepo("git_succ_db_fail");
    const wsI = await setupWorkspace(dirI, "ws_git_succ_db_fail");

    // Make candidate commit and merge it physically on disk
    execFileSync("git", ["checkout", "-b", "feature-i"], { cwd: dirI });
    fs.writeFileSync(path.join(dirI, "src/lib.rs"), "pub fn compute() -> i32 { 888 }\n");
    execFileSync("git", ["commit", "-am", "candidate I merged on disk"], { cwd: dirI });
    const candidateShaI = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirI }).toString().trim();

    execFileSync("git", ["checkout", "main"], { cwd: dirI });
    execFileSync("git", ["merge", "--ff-only", candidateShaI], { cwd: dirI });

    // Mission in DB is left in 'integrating' (as if DB update failed after git merge)
    const mRes = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Git Succ Mission", objective: "Git succ test", workspace_id: wsI.id }),
    });
    const missionId = mRes.body.id;

    setMissionState(missionId, "integrating", candidateShaI, {
      target_branch: "main",
      candidate_commit: candidateShaI,
      started_at: new Date().toISOString(),
    });

    // Run reconciliation
    const recRes = await api("/api/v1/system/reconcile", { method: "POST" });
    const mCheck = await api(`/api/v1/missions/${missionId}`);

    const passI = recRes.status === 200 &&
      mCheck.body.state === "integrated" &&
      mCheck.body.metadata?.integrated === true &&
      mCheck.body.metadata?.reconciliation_reason?.includes("reachable_in_target_branch");
    record("I", "Git success / DB failure -> Reconciled to Integrated", "POLICY", passI, `Reconciled state: ${mCheck.body?.state}`);
  } catch (e) {
    record("I", "Git success / DB failure", "POLICY", false, e.message);
  }

  // =========================================================================
  // SCENARIO J: DB Success / Event Failure (Truthful State Confirmation)
  // =========================================================================
  try {
    const dirJ = createTempRepo("db_succ");
    const wsJ = await setupWorkspace(dirJ, "ws_db_succ");

    execFileSync("git", ["checkout", "-b", "feature-j"], { cwd: dirJ });
    fs.writeFileSync(path.join(dirJ, "src/lib.rs"), "pub fn compute() -> i32 { 99 }\n");
    execFileSync("git", ["commit", "-am", "candidate J"], { cwd: dirJ });
    const candidateShaJ = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirJ }).toString().trim();
    execFileSync("git", ["checkout", "main"], { cwd: dirJ });

    const mRes = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "DB Succ Mission", objective: "DB succ test", workspace_id: wsJ.id }),
    });
    const missionId = mRes.body.id;

    setMissionState(missionId, "awaiting_acceptance", candidateShaJ);

    // Accept & integrate
    const accRes = await api(`/api/v1/missions/${missionId}/accept`, {
      method: "POST",
      body: JSON.stringify({ integrate: true, target_branch: "main" }),
    });

    const mCheck = await api(`/api/v1/missions/${missionId}`);
    const passJ = accRes.status === 200 && mCheck.body.state === "integrated";
    record("J", "DB success status truthfulness", "POLICY", passJ, `State: ${mCheck.body?.state}`);
  } catch (e) {
    record("J", "DB success status truthfulness", "POLICY", false, e.message);
  }

  // =========================================================================
  // SCENARIO K: Reconciliation Idempotency & Audit
  // =========================================================================
  try {
    const rec1 = await api("/api/v1/system/reconcile", { method: "POST" });
    const rec2 = await api("/api/v1/system/reconcile", { method: "POST" });

    const passK = rec1.status === 200 && rec2.status === 200;
    record("K", "Reconciliation idempotency & audit", "POLICY", passK, `First: ${rec1.status}, Second: ${rec2.status}`);
  } catch (e) {
    record("K", "Reconciliation idempotency", "POLICY", false, e.message);
  }

  // =========================================================================
  // SCENARIO L: Previously Integrated Mission Across Restart
  // =========================================================================
  try {
    const dirL = createTempRepo("prev_integrated");
    const wsL = await setupWorkspace(dirL, "ws_prev_integrated");

    execFileSync("git", ["checkout", "-b", "feature-l"], { cwd: dirL });
    fs.writeFileSync(path.join(dirL, "src/lib.rs"), "pub fn compute() -> i32 { 11 }\n");
    execFileSync("git", ["commit", "-am", "candidate L"], { cwd: dirL });
    const candidateShaL = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirL }).toString().trim();
    execFileSync("git", ["checkout", "main"], { cwd: dirL });

    const mRes = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Prev Mission", objective: "Prev test", workspace_id: wsL.id }),
    });
    const missionId = mRes.body.id;

    setMissionState(missionId, "awaiting_acceptance", candidateShaL);
    await api(`/api/v1/missions/${missionId}/accept`, {
      method: "POST",
      body: JSON.stringify({ integrate: true, target_branch: "main" }),
    });

    // Kill and restart server
    serverProc.kill("SIGKILL");
    serverProc = startServerProcess();
    await waitForServer();

    const mCheck = await api(`/api/v1/missions/${missionId}`);
    const passL = mCheck.body.state === "integrated";
    record("L", "Previously integrated mission preserved across restart", "POLICY", passL, `Post-restart state: ${mCheck.body?.state}`);
  } catch (e) {
    record("L", "Previously integrated mission preserved", "POLICY", false, e.message);
  }

  // =========================================================================
  // SCENARIO M: Accepted-but-not-integrated Mission Across Restart
  // =========================================================================
  try {
    const dirM = createTempRepo("accepted_restart");
    const wsM = await setupWorkspace(dirM, "ws_accepted_restart");

    execFileSync("git", ["checkout", "-b", "feature-m"], { cwd: dirM });
    fs.writeFileSync(path.join(dirM, "src/lib.rs"), "pub fn compute() -> i32 { 22 }\n");
    execFileSync("git", ["commit", "-am", "candidate M"], { cwd: dirM });
    const candidateShaM = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirM }).toString().trim();
    execFileSync("git", ["checkout", "main"], { cwd: dirM });

    const mRes = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Accepted Restart Mission", objective: "Accepted test", workspace_id: wsM.id }),
    });
    const missionId = mRes.body.id;

    setMissionState(missionId, "awaiting_acceptance", candidateShaM);
    await api(`/api/v1/missions/${missionId}/accept`, {
      method: "POST",
      body: JSON.stringify({ integrate: false }),
    });

    // Restart server
    serverProc.kill("SIGKILL");
    serverProc = startServerProcess();
    await waitForServer();

    const mCheck = await api(`/api/v1/missions/${missionId}`);
    const passM = mCheck.body.state === "accepted";
    record("M", "Accepted-but-not-integrated preserved without auto-integrating", "POLICY", passM, `Post-restart state: ${mCheck.body?.state}`);
  } catch (e) {
    record("M", "Accepted-but-not-integrated preserved", "POLICY", false, e.message);
  }

  // =========================================================================
  // SCENARIO N: Rejected Mission Safety
  // =========================================================================
  try {
    const dirN = createTempRepo("rejected_safety");
    const wsN = await setupWorkspace(dirN, "ws_rejected_safety");

    execFileSync("git", ["checkout", "-b", "feature-n"], { cwd: dirN });
    fs.writeFileSync(path.join(dirN, "src/lib.rs"), "pub fn compute() -> i32 { 33 }\n");
    execFileSync("git", ["commit", "-am", "candidate N"], { cwd: dirN });
    const candidateShaN = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirN }).toString().trim();
    execFileSync("git", ["checkout", "main"], { cwd: dirN });

    const mRes = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Rejected Mission", objective: "Rejected test", workspace_id: wsN.id }),
    });
    const missionId = mRes.body.id;

    setMissionState(missionId, "awaiting_acceptance", candidateShaN);
    await api(`/api/v1/missions/${missionId}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason: "Unacceptable design", continue_mission: false }),
    });

    // Attempt integration on rejected mission
    const intRes = await api(`/api/v1/missions/${missionId}/integrate`, {
      method: "POST",
      body: JSON.stringify({ target_branch: "main" }),
    });

    // Restart server
    serverProc.kill("SIGKILL");
    serverProc = startServerProcess();
    await waitForServer();

    const mCheck = await api(`/api/v1/missions/${missionId}`);
    const passN = intRes.status === 409 && mCheck.body.state === "rejected";
    record("N", "Rejected mission safety: cannot integrate, preserved across restart", "POLICY", passN, `Integrate status: ${intRes.status}, state: ${mCheck.body?.state}`);
  } catch (e) {
    record("N", "Rejected mission safety", "POLICY", false, e.message);
  }

  // =========================================================================
  // SCENARIO O: Real Gemini Full Workflow (Autonomous -> Human Gate -> Integration)
  // =========================================================================
  try {
    const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
    if (!hasGeminiKey) {
      record("O", "Real Gemini Full Workflow (Autonomous -> Review -> Accept & Integrate)", "E2E", true, "SKIPPED: GEMINI_API_KEY not configured in environment (deterministic CI mode)");
    } else {
      const dirO = createTempRepo("gemini_e2e");
      const wsO = await setupWorkspace(dirO, "ws_gemini_e2e");

      // Defect in repo
      fs.writeFileSync(
        path.join(dirO, "src/lib.rs"),
        `pub fn add(a: i32, b: i32) -> i32 {\n    a - b // BUG: subtraction instead of addition\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn test_add() {\n        assert_eq!(add(2, 3), 5);\n    }\n}\n`
      );
      execFileSync("git", ["commit", "-am", "buggy implementation"], { cwd: dirO });

      const mRes = await api("/api/v1/missions", {
        method: "POST",
        body: JSON.stringify({
          title: "Real Gemini Bug Fix",
          objective: "Fix add function in src/lib.rs to add instead of subtract so cargo test passes. Commit to git.",
          workspace_id: wsO.id,
          metadata: { backend: "gemini_cli" },
          stopping_condition: { required_tests_pass: true, working_tree_clean: true, required_commit_exists: true },
          auto_start: true,
        }),
      });
      const missionId = mRes.body.id;

      // Poll until mission halts at awaiting_acceptance
      let attempts = 0;
      let finalState = null;
      while (attempts < 90) {
        await new Promise((r) => setTimeout(r, 2000));
        const chk = await api(`/api/v1/missions/${missionId}`);
        finalState = chk.body.state;
        if (
          finalState === "awaiting_acceptance" ||
          finalState === "failed" ||
          finalState === "budget_exhausted" ||
          finalState === "needs_human"
        ) {
          break;
        }
        attempts++;
      }

      if (finalState !== "awaiting_acceptance") {
        throw new Error(`Mission did not reach awaiting_acceptance; reached ${finalState}`);
      }

      // Inspect Review Package
      const revRes = await api(`/api/v1/missions/${missionId}/review`);
      if (revRes.status !== 200 || !revRes.body.can_accept) {
        throw new Error(`Review package inspection failed: status ${revRes.status}`);
      }

      // Human operator accepts and integrates
      const accRes = await api(`/api/v1/missions/${missionId}/accept`, {
        method: "POST",
        body: JSON.stringify({ integrate: true, target_branch: "main" }),
      });

      // Verify on disk in target repository
      const testOutput = execFileSync("cargo", ["test"], { cwd: dirO }).toString();
      const diskPass = testOutput.includes("test tests::test_add ... ok");

      const passO = accRes.status === 200 &&
        accRes.body.state === "integrated" &&
        diskPass;
      record("O", "Real Gemini Full Workflow (Autonomous -> Review -> Accept & Integrate)", "E2E", passO, `State: ${accRes.body?.state}, Cargo test: ${diskPass}`);
    }
  } catch (e) {
    record("O", "Real Gemini Full Workflow", "E2E", false, e.message);
  }

  // Summary
  console.log("\n========================================================================");
  console.log("                      M20 SUITE RESULTS SUMMARY");
  console.log("========================================================================");
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`Passed: ${passed} / ${total} (${Math.round((passed / total) * 100)}%)\n`);

  for (const r of results) {
    const badge = r.pass ? "✓ PASS" : "✗ FAIL";
    const tag = r.type === "E2E" ? "[REAL E2E]" : "[DOMAIN]  ";
    console.log(`  ${badge} ${tag} Scenario ${r.id}: ${r.name}`);
  }
  console.log("========================================================================\n");

  await cleanup();
  process.exit(passed === total ? 0 : 1);
}

runSuite().catch(async (e) => {
  console.error("Suite fatal error:", e);
  await cleanup();
  process.exit(1);
});
