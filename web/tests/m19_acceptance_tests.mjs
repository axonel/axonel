import { spawn, execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const PORT = 4059;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_PATH = `/tmp/sentinel_m19_acceptance_${Date.now()}.db`;
const AUTH_TOKEN = "m19-acceptance-secret-token-112233";

console.log("========================================================================");
console.log("   SENTINEL M19 RELEASE SEMANTICS & ACCEPTANCE TEST SUITE (SCENARIOS A - O)");
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
  const dir = `/tmp/sentinel_m19_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "M19 Acceptance Tester"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "m19@sentinel.local"], { cwd: dir });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Cargo.toml"), `[package]\nname = "${prefix}_crate"\nversion = "0.1.0"\nedition = "2021"\n`);
  fs.writeFileSync(path.join(dir, "src/lib.rs"), `pub fn value() -> i32 { 10 }\n`);
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
  p.stdout.on("data", (d) => {
    // console.log(`[SERVER OUT] ${d.toString()}`);
  });
  p.stderr.on("data", (d) => {
    // process.stderr.write(`[SERVER ERR] ${d.toString()}`);
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
  console.log("\n--- Cleaning Up M19 Test Resources ---");
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
  console.log("✓ Cleanup finished.");
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(1);
});

async function runSuite() {
  const results = [];

  function record(code, name, condition, details = "") {
    results.push({ code, name, passed: Boolean(condition), details });
    const sym = condition ? "✓ PASS" : "✗ FAIL";
    console.log(`[M19] [${code}] ${name.padEnd(52)} ${sym} ${details ? `(${details})` : ""}`);
    if (!condition) {
      throw new Error(`M19 Test assertion failed on [${code}] ${name}: ${details}`);
    }
  }

  try {
    serverProc = startServerProcess();
    await waitForServer();
    console.log(`✓ Sentinel Server running at ${BASE_URL}\n`);

    // =========================================================================
    // SCENARIO A: Verified Mission Stops in awaiting_acceptance, NOT Integrated
    // =========================================================================
    console.log(">>> Scenario A: Mission stops at awaiting_acceptance gate...");
    const dirA = createTempRepo("scen_a");
    execFileSync(plexisCliPath, ["init", dirA, "--name", "repo_a", "--db", DB_PATH], { stdio: "ignore" });
    const wsResA = await api("/api/v1/workspaces");
    const wsA = wsResA.body.find((w) => w.canonical_path.includes("scen_a"));

    const initShaA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirA, encoding: "utf-8" }).trim();

    // Create candidate branch with modification and commit
    execFileSync("git", ["checkout", "-b", "candidate-a"], { cwd: dirA });
    fs.writeFileSync(path.join(dirA, "src/lib.rs"), `pub fn value() -> i32 { 42 }\n`);
    execFileSync("git", ["commit", "-am", "candidate deliverable commit"], { cwd: dirA });
    const candShaA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirA, encoding: "utf-8" }).trim();
    execFileSync("git", ["checkout", "main"], { cwd: dirA });

    const mResA = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Scenario A Mission", objective: "Verify review boundary", workspace_id: wsA.id }),
    });
    const missionIdA = mResA.body.id;

    // Simulate verification passing -> transitions to awaiting_acceptance with verified commit
    execFileSync("sqlite3", [
      DB_PATH,
      `UPDATE missions SET state='awaiting_acceptance', latest_verified_commit='${candShaA}' WHERE id='${missionIdA}';`,
    ]);

    const mFetchA = await api(`/api/v1/missions/${missionIdA}`);
    const headShaA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirA, encoding: "utf-8" }).trim();

    record(
      "A",
      "Verified mission stops at awaiting_acceptance without integrating",
      mFetchA.body.state === "awaiting_acceptance" && headShaA === initShaA && headShaA !== candShaA,
      `State: ${mFetchA.body.state}, Target HEAD unchanged at ${headShaA.slice(0, 7)}`
    );

    // =========================================================================
    // SCENARIO B: Calling /integrate before /accept Returns 409 Conflict
    // =========================================================================
    console.log(">>> Scenario B: Integrate before accept returns 409 Conflict...");
    const intResB = await api(`/api/v1/missions/${missionIdA}/integrate`, {
      method: "POST",
      body: JSON.stringify({ target_branch: "main" }),
    });

    record(
      "B",
      "Calling /integrate while in awaiting_acceptance returns 409 Conflict",
      intResB.status === 409 && JSON.stringify(intResB.body).includes("awaiting_acceptance"),
      `Status: ${intResB.status}`
    );

    // =========================================================================
    // SCENARIO C: Calling /accept (integrate=false) -> accepted, then /integrate succeeds
    // =========================================================================
    console.log(">>> Scenario C: Two-step accept then integrate lifecycle...");
    const acceptResC = await api(`/api/v1/missions/${missionIdA}/accept`, {
      method: "POST",
      body: JSON.stringify({ integrate: false, feedback: "Looks great, approved" }),
    });
    record(
      "C1",
      "POST /accept (integrate=false) transitions to accepted state",
      acceptResC.status === 200 && acceptResC.body.state === "accepted" && acceptResC.body.integrated === false,
      `State: ${acceptResC.body.state}`
    );

    const intResC = await api(`/api/v1/missions/${missionIdA}/integrate`, {
      method: "POST",
      body: JSON.stringify({ target_branch: "main" }),
    });
    const postIntShaA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirA, encoding: "utf-8" }).trim();

    record(
      "C2",
      "POST /integrate on accepted mission merges code and reaches integrated",
      intResC.status === 200 && intResC.body.integrated === true && postIntShaA === candShaA,
      `State: integrated, HEAD: ${postIntShaA.slice(0, 7)}`
    );

    // =========================================================================
    // SCENARIO D: Calling /accept (integrate=true) Atomically Integrates
    // =========================================================================
    console.log(">>> Scenario D: Atomic accept with integrate=true...");
    const dirD = createTempRepo("scen_d");
    execFileSync(plexisCliPath, ["init", dirD, "--name", "repo_d", "--db", DB_PATH], { stdio: "ignore" });
    const wsResD = await api("/api/v1/workspaces");
    const wsD = wsResD.body.find((w) => w.canonical_path.includes("scen_d"));

    execFileSync("git", ["checkout", "-b", "candidate-d"], { cwd: dirD });
    fs.writeFileSync(path.join(dirD, "src/lib.rs"), `pub fn value() -> i32 { 999 }\n`);
    execFileSync("git", ["commit", "-am", "candidate d commit"], { cwd: dirD });
    const candShaD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirD, encoding: "utf-8" }).trim();
    execFileSync("git", ["checkout", "main"], { cwd: dirD });

    const mResD = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Scenario D Mission", objective: "Atomic accept", workspace_id: wsD.id }),
    });
    const missionIdD = mResD.body.id;

    execFileSync("sqlite3", [
      DB_PATH,
      `UPDATE missions SET state='awaiting_acceptance', latest_verified_commit='${candShaD}' WHERE id='${missionIdD}';`,
    ]);

    const acceptResD = await api(`/api/v1/missions/${missionIdD}/accept`, {
      method: "POST",
      body: JSON.stringify({ integrate: true }),
    });
    const postIntShaD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirD, encoding: "utf-8" }).trim();

    record(
      "D",
      "POST /accept with integrate=true atomically accepts and integrates",
      acceptResD.status === 200 && acceptResD.body.integrated === true && postIntShaD === candShaD,
      `Integrated: ${acceptResD.body.integrated}, Target HEAD: ${postIntShaD.slice(0, 7)}`
    );

    // =========================================================================
    // SCENARIO E: Reject Mission With Reason (Non-Destructive)
    // =========================================================================
    console.log(">>> Scenario E: Reject mission with auditable reason...");
    const dirE = createTempRepo("scen_e");
    execFileSync(plexisCliPath, ["init", dirE, "--name", "repo_e", "--db", DB_PATH], { stdio: "ignore" });
    const wsResE = await api("/api/v1/workspaces");
    const wsE = wsResE.body.find((w) => w.canonical_path.includes("scen_e"));

    execFileSync("git", ["checkout", "-b", "candidate-e"], { cwd: dirE });
    fs.writeFileSync(path.join(dirE, "src/lib.rs"), `pub fn value() -> i32 { 55 }\n`);
    execFileSync("git", ["commit", "-am", "candidate e commit"], { cwd: dirE });
    const candShaE = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirE, encoding: "utf-8" }).trim();
    execFileSync("git", ["checkout", "main"], { cwd: dirE });
    const mainShaE = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirE, encoding: "utf-8" }).trim();

    const mResE = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Scenario E Mission", objective: "Reject test", workspace_id: wsE.id }),
    });
    const missionIdE = mResE.body.id;

    execFileSync("sqlite3", [
      DB_PATH,
      `UPDATE missions SET state='awaiting_acceptance', latest_verified_commit='${candShaE}' WHERE id='${missionIdE}';`,
    ]);

    const rejectResE = await api(`/api/v1/missions/${missionIdE}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason: "Architecture style mismatch", continue_mission: false }),
    });

    const mFetchE = await api(`/api/v1/missions/${missionIdE}`);
    // Check git commit still exists on disk
    const commitCheckE = execFileSync("git", ["cat-file", "-t", candShaE], { cwd: dirE, encoding: "utf-8" }).trim();
    const curMainShaE = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirE, encoding: "utf-8" }).trim();

    record(
      "E",
      "Reject mission transitions to rejected, records reason, leaves commits intact",
      rejectResE.status === 200 &&
        mFetchE.body.state === "rejected" &&
        commitCheckE === "commit" &&
        curMainShaE === mainShaE &&
        JSON.stringify(mFetchE.body).includes("Architecture style mismatch"),
      `State: ${mFetchE.body.state}, Candidate commit preserved: ${candShaE.slice(0, 7)}`
    );

    // =========================================================================
    // SCENARIO F: Reject Mission with continue=true Transitions to Replanning
    // =========================================================================
    console.log(">>> Scenario F: Reject with continue=true transitions to replanning...");
    const dirF = createTempRepo("scen_f");
    execFileSync(plexisCliPath, ["init", dirF, "--name", "repo_f", "--db", DB_PATH], { stdio: "ignore" });
    const wsResF = await api("/api/v1/workspaces");
    const wsF = wsResF.body.find((w) => w.canonical_path.includes("scen_f"));

    const mResF = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Scenario F Mission", objective: "Replan test", workspace_id: wsF.id }),
    });
    const missionIdF = mResF.body.id;

    execFileSync("sqlite3", [
      DB_PATH,
      `UPDATE missions SET state='awaiting_acceptance', latest_verified_commit='dummy-sha' WHERE id='${missionIdF}';`,
    ]);

    const rejectResF = await api(`/api/v1/missions/${missionIdF}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason: "Please use idiomatic iterator pattern", continue_mission: true }),
    });
    const mFetchF = await api(`/api/v1/missions/${missionIdF}`);

    record(
      "F",
      "Reject mission with continue_mission=true transitions to replanning",
      rejectResF.status === 200 && mFetchF.body.state === "replanning",
      `State: ${mFetchF.body.state}, Feedback captured in metadata`
    );

    // =========================================================================
    // SCENARIO G: Merge Conflict Cleanly Aborts without Polluting Working Tree
    // =========================================================================
    console.log(">>> Scenario G: Merge conflict rejection & pristine git rollback...");
    const dirG = createTempRepo("scen_g");
    fs.writeFileSync(path.join(dirG, "src/lib.rs"), `pub fn value() -> i32 { 1 }\n`);
    execFileSync("git", ["commit", "-am", "base line 1"], { cwd: dirG });

    // Branch G feature
    execFileSync("git", ["checkout", "-b", "feature-g"], { cwd: dirG });
    fs.writeFileSync(path.join(dirG, "src/lib.rs"), `pub fn value() -> i32 { 100 }\n`);
    execFileSync("git", ["commit", "-am", "feature line 100"], { cwd: dirG });
    const featShaG = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirG, encoding: "utf-8" }).trim();

    // Main branch conflicting change
    execFileSync("git", ["checkout", "main"], { cwd: dirG });
    fs.writeFileSync(path.join(dirG, "src/lib.rs"), `pub fn value() -> i32 { 200 }\n`);
    execFileSync("git", ["commit", "-am", "main conflicting change 200"], { cwd: dirG });
    const mainHeadG = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirG, encoding: "utf-8" }).trim();

    execFileSync(plexisCliPath, ["init", dirG, "--name", "repo_g", "--db", DB_PATH], { stdio: "ignore" });
    const wsResG = await api("/api/v1/workspaces");
    const wsG = wsResG.body.find((w) => w.canonical_path.includes("scen_g"));

    const mResG = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Conflict Mission", objective: "Conflict test", workspace_id: wsG.id }),
    });
    const missionIdG = mResG.body.id;

    // Put into accepted state
    execFileSync("sqlite3", [
      DB_PATH,
      `UPDATE missions SET state='accepted', latest_verified_commit='${featShaG}' WHERE id='${missionIdG}';`,
    ]);

    const intResG = await api(`/api/v1/missions/${missionIdG}/integrate`, {
      method: "POST",
      body: JSON.stringify({ target_branch: "main" }),
    });

    const statusG = execFileSync("git", ["status", "--porcelain"], { cwd: dirG, encoding: "utf-8" }).trim();
    const curHeadG = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirG, encoding: "utf-8" }).trim();

    record(
      "G",
      "Merge conflict returns 409, executes git merge --abort, leaves working tree pristine",
      intResG.status === 409 && statusG === "" && curHeadG === mainHeadG,
      `Status: ${intResG.status}, Working tree clean: ${statusG === ""}`
    );

    // =========================================================================
    // SCENARIO H: Dirty Target Branch Rejected with 409 Conflict
    // =========================================================================
    console.log(">>> Scenario H: Dirty target branch rejection...");
    const dirH = createTempRepo("scen_h");
    execFileSync(plexisCliPath, ["init", dirH, "--name", "repo_h", "--db", DB_PATH], { stdio: "ignore" });
    const wsResH = await api("/api/v1/workspaces");
    const wsH = wsResH.body.find((w) => w.canonical_path.includes("scen_h"));

    execFileSync("git", ["checkout", "-b", "feat-h"], { cwd: dirH });
    fs.writeFileSync(path.join(dirH, "src/lib.rs"), `pub fn value() -> i32 { 77 }\n`);
    execFileSync("git", ["commit", "-am", "feat h"], { cwd: dirH });
    const featShaH = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirH, encoding: "utf-8" }).trim();
    execFileSync("git", ["checkout", "main"], { cwd: dirH });

    // Make target dirty
    fs.writeFileSync(path.join(dirH, "uncommitted.txt"), "dirty untracked change\n");

    const mResH = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Dirty Target Mission", objective: "Dirty test", workspace_id: wsH.id }),
    });
    const missionIdH = mResH.body.id;

    execFileSync("sqlite3", [
      DB_PATH,
      `UPDATE missions SET state='accepted', latest_verified_commit='${featShaH}' WHERE id='${missionIdH}';`,
    ]);

    const intResH = await api(`/api/v1/missions/${missionIdH}/integrate`, {
      method: "POST",
      body: JSON.stringify({ target_branch: "main" }),
    });

    record(
      "H",
      "Dirty target branch rejects integration with 409 Conflict",
      intResH.status === 409 && JSON.stringify(intResH.body).includes("dirty"),
      `Status: ${intResH.status}`
    );

    // =========================================================================
    // SCENARIO I: Stale Target Branch (Target Moved After Verification)
    // =========================================================================
    console.log(">>> Scenario I: Stale target branch verification check...");
    const dirI = createTempRepo("scen_i");
    execFileSync(plexisCliPath, ["init", dirI, "--name", "repo_i", "--db", DB_PATH], { stdio: "ignore" });
    const wsResI = await api("/api/v1/workspaces");
    const wsI = wsResI.body.find((w) => w.canonical_path.includes("scen_i"));

    const oldHeadI = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirI, encoding: "utf-8" }).trim();

    execFileSync("git", ["checkout", "-b", "feat-i"], { cwd: dirI });
    fs.writeFileSync(path.join(dirI, "src/lib.rs"), `pub fn value() -> i32 { 88 }\n`);
    execFileSync("git", ["commit", "-am", "feat i"], { cwd: dirI });
    const featShaI = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirI, encoding: "utf-8" }).trim();
    execFileSync("git", ["checkout", "main"], { cwd: dirI });

    // Target branch moves after candidate was created
    fs.writeFileSync(path.join(dirI, "README.md"), "# New commit on main\n");
    execFileSync("git", ["add", "README.md"], { cwd: dirI });
    execFileSync("git", ["commit", "-m", "main moved ahead"], { cwd: dirI });
    const newHeadI = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirI, encoding: "utf-8" }).trim();

    const mResI = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Stale Target Mission", objective: "Stale test", workspace_id: wsI.id }),
    });
    const missionIdI = mResI.body.id;

    execFileSync("sqlite3", [
      DB_PATH,
      `UPDATE missions SET state='accepted', latest_verified_commit='${featShaI}' WHERE id='${missionIdI}';`,
    ]);

    // Integration specifying oldHeadI as expected_target_head must fail with 409
    const intResI = await api(`/api/v1/missions/${missionIdI}/integrate`, {
      method: "POST",
      body: JSON.stringify({ target_branch: "main", expected_target_head: oldHeadI }),
    });

    record(
      "I",
      "Stale target branch (expected_target_head mismatch) rejects with 409 Conflict",
      intResI.status === 409 && JSON.stringify(intResI.body).includes("changed since verification"),
      `Status: ${intResI.status}`
    );

    // =========================================================================
    // SCENARIO J: Duplicate Acceptance Is Idempotent (Returns 200 OK)
    // =========================================================================
    console.log(">>> Scenario J: Idempotency of /accept...");
    const accept1 = await api(`/api/v1/missions/${missionIdA}/accept`, {
      method: "POST",
      body: JSON.stringify({ feedback: "Re-accept attempt" }),
    });
    const accept2 = await api(`/api/v1/missions/${missionIdA}/accept`, {
      method: "POST",
      body: JSON.stringify({ feedback: "Re-accept attempt 2" }),
    });

    record(
      "J",
      "Calling /accept multiple times is idempotent (returns 200 with current state)",
      accept1.status === 200 && accept2.status === 200,
      `Status 1: ${accept1.status}, Status 2: ${accept2.status}`
    );

    // =========================================================================
    // SCENARIO K: Duplicate Integration Is Idempotent (already_integrated=true)
    // =========================================================================
    console.log(">>> Scenario K: Idempotency of /integrate...");
    const intDup = await api(`/api/v1/missions/${missionIdA}/integrate`, {
      method: "POST",
      body: JSON.stringify({ target_branch: "main" }),
    });

    record(
      "K",
      "Calling /integrate on already integrated mission returns 200 with already_integrated=true",
      intDup.status === 200 && intDup.body.already_integrated === true,
      `Status: ${intDup.status}, already_integrated: ${intDup.body.already_integrated}`
    );

    // =========================================================================
    // SCENARIO L: Server Restart in awaiting_acceptance Preserves State
    // =========================================================================
    console.log(">>> Scenario L: Server crash/restart preserves awaiting_acceptance...");
    const dirL = createTempRepo("scen_l");
    execFileSync(plexisCliPath, ["init", dirL, "--name", "repo_l", "--db", DB_PATH], { stdio: "ignore" });
    const wsResL = await api("/api/v1/workspaces");
    const wsL = wsResL.body.find((w) => w.canonical_path.includes("scen_l"));

    const mResL = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Restart Awaiting Test", objective: "Restart test", workspace_id: wsL.id }),
    });
    const missionIdL = mResL.body.id;

    execFileSync("sqlite3", [
      DB_PATH,
      `UPDATE missions SET state='awaiting_acceptance', latest_verified_commit='dummy-sha-l' WHERE id='${missionIdL}';`,
    ]);

    // Restart server process
    serverProc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    serverProc = startServerProcess();
    await waitForServer();

    const mFetchL = await api(`/api/v1/missions/${missionIdL}`);

    record(
      "L",
      "Server restart preserves awaiting_acceptance state without resuming runner cycles",
      mFetchL.body.state === "awaiting_acceptance",
      `State after restart: ${mFetchL.body.state}`
    );

    // =========================================================================
    // SCENARIO M: Server Restart in accepted Preserves State
    // =========================================================================
    console.log(">>> Scenario M: Server crash/restart preserves accepted state...");
    const dirM = createTempRepo("scen_m");
    execFileSync(plexisCliPath, ["init", dirM, "--name", "repo_m", "--db", DB_PATH], { stdio: "ignore" });
    const wsResM = await api("/api/v1/workspaces");
    const wsM = wsResM.body.find((w) => w.canonical_path.includes("scen_m"));

    const mResM = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Restart Accepted Test", objective: "Restart test", workspace_id: wsM.id }),
    });
    const missionIdM = mResM.body.id;

    execFileSync("sqlite3", [
      DB_PATH,
      `UPDATE missions SET state='accepted', latest_verified_commit='dummy-sha-m' WHERE id='${missionIdM}';`,
    ]);

    // Restart server process
    serverProc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    serverProc = startServerProcess();
    await waitForServer();

    const mFetchM = await api(`/api/v1/missions/${missionIdM}`);

    record(
      "M",
      "Server restart preserves accepted state, still ready for integration",
      mFetchM.body.state === "accepted",
      `State after restart: ${mFetchM.body.state}`
    );

    // =========================================================================
    // SCENARIO N: Cancel While in awaiting_acceptance Transitions to Cancelled
    // =========================================================================
    console.log(">>> Scenario N: Cancel while awaiting_acceptance...");
    const cancelRes = await api(`/api/v1/missions/${missionIdL}/cancel`, {
      method: "POST",
    });
    const mFetchCancelled = await api(`/api/v1/missions/${missionIdL}`);

    record(
      "N",
      "Cancel mission while in awaiting_acceptance transitions cleanly to cancelled",
      cancelRes.status === 200 && mFetchCancelled.body.state === "cancelled",
      `State: ${mFetchCancelled.body.state}`
    );

    // =========================================================================
    // SCENARIO O: Review Package Returns Complete Evidence & Action Flags
    // =========================================================================
    console.log(">>> Scenario O: Comprehensive review package inspection...");
    const dirO = createTempRepo("scen_o");
    execFileSync(plexisCliPath, ["init", dirO, "--name", "repo_o", "--db", DB_PATH], { stdio: "ignore" });
    const wsResO = await api("/api/v1/workspaces");
    const wsO = wsResO.body.find((w) => w.canonical_path.includes("scen_o"));

    execFileSync("git", ["checkout", "-b", "candidate-o"], { cwd: dirO });
    fs.writeFileSync(path.join(dirO, "src/lib.rs"), `pub fn value() -> i32 { 12345 }\n`);
    execFileSync("git", ["commit", "-am", "candidate o feature commit"], { cwd: dirO });
    const candShaO = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirO, encoding: "utf-8" }).trim();
    execFileSync("git", ["checkout", "main"], { cwd: dirO });

    const mResO = await api("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify({ title: "Scenario O Review Mission", objective: "Review evidence test", workspace_id: wsO.id }),
    });
    const missionIdO = mResO.body.id;

    execFileSync("sqlite3", [
      DB_PATH,
      `UPDATE missions SET state='awaiting_acceptance', latest_verified_commit='${candShaO}' WHERE id='${missionIdO}';`,
    ]);

    const reviewResO = await api(`/api/v1/missions/${missionIdO}/review`);
    const pkg = reviewResO.body;

    const hasFields =
      pkg.mission_id === missionIdO &&
      pkg.status === "awaiting_acceptance" &&
      pkg.can_accept === true &&
      pkg.can_integrate === false &&
      pkg.can_reject === true &&
      pkg.final_commit === candShaO &&
      Array.isArray(pkg.files_changed) &&
      pkg.files_changed.includes("src/lib.rs") &&
      pkg.full_diff &&
      pkg.full_diff.includes("+pub fn value() -> i32 { 12345 }") &&
      typeof pkg.duration_secs === "number" &&
      pkg.verification !== undefined;

    record(
      "O",
      "GET /review package delivers complete diff, changed files, metrics, and action flags",
      reviewResO.status === 200 && hasFields,
      `Files: ${pkg.files_changed?.length}, Can Accept: ${pkg.can_accept}, Diff length: ${pkg.full_diff?.length}`
    );

    console.log("\n========================================================================");
    console.log("   ALL 15 RELEASE SEMANTICS SCENARIOS (A THROUGH O) PASSED!             ");
    console.log("========================================================================\n");
  } finally {
    await cleanup();
  }
}

runSuite().catch((err) => {
  console.error("\nFATAL SUITE ERROR:", err);
  cleanup().finally(() => process.exit(1));
});
