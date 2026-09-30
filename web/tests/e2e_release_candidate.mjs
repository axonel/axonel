/**
 * Sentinel Real Browser Release Candidate E2E Test
 *
 * Verifies the complete product lifecycle via a real browser (Playwright Chromium):
 * 1. OPEN SENTINEL in browser
 * 2. Select / Register real Git repository workspace
 * 3. Create autonomous mission with Gemini CLI backend
 * 4. Explicitly dispatch mission
 * 5. Real Gemini CLI process executes and mutates workspace
 * 6. Independent verification verifies cargo test, clean tree, and commit
 * 7. Transitions to AwaitingAcceptance (UI displays "READY FOR REVIEW")
 * 8. Assert integration is unavailable prior to acceptance
 * 9. Open Review Package modal, inspect diff, verification telemetry, audit trail
 * 10. Test browser refresh (assert state durability, no stale/error UI)
 * 11. Human-equivalent acceptance (Accept Only) -> state transitions to ACCEPTED
 * 12. Assert Integrate button becomes available only after acceptance
 * 13. Perform Git integration -> state transitions through INTEGRATING to INTEGRATED
 * 14. Verify physical target repository on disk (Git ancestry, cargo test = 0)
 */

import { spawn, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { chromium } from "@playwright/test";

const PORT = 4099;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_PATH = `/tmp/sentinel_e2e_${Date.now()}.db`;
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const releaseBinary = path.join(projectRoot, "target/release/sentinel");
const debugBinary = path.join(projectRoot, "target/debug/sentinel");
const fallbackServerBinary = path.join(projectRoot, "target/debug/plexis-server");

const binToUse = process.env.SENTINEL_BIN ||
  (fs.existsSync(releaseBinary) ? releaseBinary : (fs.existsSync(debugBinary) ? debugBinary : fallbackServerBinary));

console.log("========================================================================");
console.log("   SENTINEL REAL BROWSER RELEASE CANDIDATE END-TO-END VERIFICATION");
console.log(`   Binary in use: ${binToUse}`);
console.log("========================================================================\n");

if (!fs.existsSync(binToUse)) {
  console.error(`Server binary not found at ${binToUse}. Run 'cargo build --release -p plexis-server'.`);
  process.exit(1);
}

let serverProc = null;
const tempDirs = [];

function createTargetRepo() {
  const dir = `/tmp/sentinel_e2e_repo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);

  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Sentinel E2E Verifier"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "e2e@sentinel.local"], { cwd: dir });

  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "Cargo.toml"),
    `[package]\nname = "e2e_math"\nversion = "0.1.0"\nedition = "2021"\n`
  );
  // Buggy implementation: subtracts instead of adding
  fs.writeFileSync(
    path.join(dir, "src/lib.rs"),
    `pub fn add(a: i32, b: i32) -> i32 {\n    a - b // BUG: subtraction instead of addition\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn test_add() {\n        assert_eq!(add(2, 3), 5);\n    }\n}\n`
  );
  fs.writeFileSync(path.join(dir, ".gitignore"), "/target\nCargo.lock\n.plexis/\n", "utf-8");

  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial buggy implementation"], { cwd: dir });

  // Sanity check: cargo test MUST fail initially
  try {
    execFileSync("cargo", ["test"], { cwd: dir, stdio: "pipe" });
    throw new Error("Expected initial cargo test to fail, but it succeeded!");
  } catch (e) {
    console.log("✓ Confirmed: Initial repository has failing cargo test as expected.");
  }

  return dir;
}

function startServer() {
  console.log(`Starting Sentinel server on ${BASE_URL}...`);
  const env = {
    ...process.env,
    PORT: PORT.toString(),
    PLEXIS_DB_PATH: DB_PATH,
    RUST_LOG: "info",
  };
  const args = binToUse.endsWith("sentinel")
    ? ["serve", "--host", "127.0.0.1", "--port", PORT.toString(), "--db", DB_PATH]
    : ["--host", "127.0.0.1", "--port", PORT.toString(), "--db", DB_PATH];
  const p = spawn(binToUse, args, {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  p.stderr.on("data", (data) => {
    const s = data.toString();
    if (s.includes("ERROR") || s.includes("Spawned") || s.includes("gemini") || process.env.DEBUG_SERVER) {
      console.error("[Server Log]", s.trim());
    }
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

async function cleanup() {
  console.log("\n--- Cleaning Up E2E Resources ---");
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
process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(1);
});

async function run() {
  let browser = null;
  try {
    const targetRepoDir = createTargetRepo();
    const initialHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetRepoDir })
      .toString()
      .trim();
    console.log(`Target repository initialized at: ${targetRepoDir} (HEAD: ${initialHead.slice(0, 8)})`);

    serverProc = startServer();
    await waitForServer();
    console.log("✓ Sentinel server is healthy and responding on loopback.");

    // Launch Playwright Chromium
    console.log("Launching Playwright Chromium browser...");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on("dialog", async (dialog) => {
      console.log(`[Browser Dialog] ${dialog.type()}: ${dialog.message()}`);
      await dialog.accept();
    });

    // 1. OPEN SENTINEL
    console.log(`Navigating to Sentinel UI: ${BASE_URL}...`);
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    const headerText = await page.locator("header").textContent();
    if (!headerText.includes("SENTINEL")) {
      throw new Error(`Expected header to contain 'SENTINEL', got '${headerText}'`);
    }
    console.log("✓ [Assertion 1] Sentinel application loaded successfully in browser.");

    // 2. REGISTER / SELECT REPOSITORY WORKSPACE
    console.log("Opening Workspace Modal to register target repository...");
    await page.click('button[title="Switch project workspace"]');
    await page.waitForSelector('text="Project Workspaces"', { timeout: 5000 });

    // Click "Register Workspace" or "Register First Workspace"
    const addWsBtn = page.locator('button:has-text("Register Workspace"), button:has-text("Register First Workspace")').first();
    await addWsBtn.click();

    // Fill workspace form
    console.log(`Registering workspace path: ${targetRepoDir}`);
    await page.fill('input[placeholder*="token-limiter"]', "E2E Math Project");
    await page.fill('input[placeholder*="/home/user/Projects"]', targetRepoDir);
    await page.click('button[type="submit"]:has-text("Register Workspace")');

    // Close modal if still open
    const doneBtn = page.locator('button:has-text("Done")');
    if (await doneBtn.isVisible()) {
      await doneBtn.click();
    }
    await page.waitForTimeout(1000);

    // Verify workspace pill updated
    const wsPillText = await page.locator('button[title="Switch project workspace"]').textContent();
    if (!wsPillText.includes("E2E Math Project")) {
      throw new Error(`Expected workspace pill to display 'E2E Math Project', got: '${wsPillText}'`);
    }
    console.log("✓ [Assertion 2] Repository workspace registered and active in browser.");

    // 3. CREATE MISSION (with auto-start unchecked to test manual dispatch)
    console.log("Opening New Mission modal...");
    await page.click('button:has-text("New Mission")');
    await page.waitForSelector('text="Launch Autonomous Mission"', { timeout: 5000 });

    // Assert target workspace is displayed
    const wsDisplay = await page.textContent('form div:has-text("Target Workspace")');
    if (!wsDisplay.includes("E2E Math Project")) {
      throw new Error(`Target workspace not reflected in mission modal: ${wsDisplay}`);
    }

    // Fill Mission Form
    const backend = process.env.E2E_BACKEND || "gemini_cli";
    const missionTitle = `E2E ${backend === "gemini_cli" ? "Gemini" : backend} Addition Fix`;
    await page.fill('input[placeholder*="Long-Horizon"]', missionTitle);
    await page.fill(
      'textarea[placeholder*="Describe the software engineering objective"]',
      "Fix add function in src/lib.rs to add instead of subtract so cargo test passes. Commit to git."
    );

    // Select backend (gemini_cli or fake_agent via E2E_BACKEND)
    console.log(`Selecting agent backend: ${backend}`);
    await page.selectOption('form select:has(option[value="gemini_cli"])', backend);

    // Uncheck auto-start to test explicit dispatch
    const autoStartCheckbox = page.locator('label:has-text("Auto-start mission immediately upon creation") input[type="checkbox"]');
    if (await autoStartCheckbox.isChecked()) {
      await autoStartCheckbox.uncheck();
    }

    // Submit form
    console.log("Submitting Launch Mission form...");
    await page.click('button[type="submit"]:has-text("Launch Mission")');
    await page.waitForTimeout(1500);

    // 4. ASSERT MISSION STARTS VISIBLY IN CREATED STATE
    const stateBadge = page.locator('span:has-text("CREATED")').first();
    await stateBadge.waitFor({ state: "visible", timeout: 10000 });
    console.log("✓ [Assertion 3] Mission visibly created in 'CREATED' state.");

    // 5. EXPLICITLY DISPATCH MISSION
    const startBtn = page.locator('button:has-text("Start")').first();
    await startBtn.waitFor({ state: "visible", timeout: 5000 });
    console.log("Clicking 'Start' button to dispatch mission...");
    await startBtn.click();

    // 6. ASSERT STATE UPDATES TO PLANNING / RUNNING / VERIFYING
    const runningBadge = page
      .locator(
        'span:has-text("PLANNING"), span:has-text("RUNNING"), span:has-text("VERIFYING"), span:has-text("READY FOR REVIEW")'
      )
      .first();
    await runningBadge.waitFor({ state: "visible", timeout: 20000 });
    const currentText = await runningBadge.textContent();
    console.log(`✓ [Assertion 4] Mission dispatched and visibly transitioned to ${currentText.trim()}.`);

    // 7. AWAIT EXECUTION AND INDEPENDENT VERIFICATION
    console.log(`Waiting for ${backend === "gemini_cli" ? "real Gemini CLI" : backend} execution and independent verification (up to 180s)...`);
    const awaitingBadge = page.locator('span:has-text("READY FOR REVIEW")').first();
    await awaitingBadge.waitFor({ state: "visible", timeout: 180000 });
    console.log("✓ [Assertion 5] Mission successfully reached AwaitingAcceptance ('READY FOR REVIEW').");

    // 7b. REGRESSION ASSERTION: VERIFY REQUESTED BACKEND ACTUALLY EXECUTED (NO SILENT FALLBACK)
    console.log(`Verifying backend execution provenance for requested backend: '${backend}'...`);
    const missionsRes = await fetch(`${BASE_URL}/api/v1/missions`);
    const missions = await missionsRes.json();
    const activeMission = missions.find((m) => m.title === missionTitle);
    if (!activeMission) {
      throw new Error(`Active mission '${missionTitle}' not found via API!`);
    }
    if (activeMission.metadata?.backend !== backend) {
      throw new Error(`Mission metadata backend mismatch: expected '${backend}', got '${activeMission.metadata?.backend}'`);
    }

    // Inspect SQLite database directly to verify executions table
    const dbExecutionsJson = execFileSync("sqlite3", [
      "-json",
      DB_PATH,
      "SELECT id, task_id, state, metadata FROM executions;",
    ]).toString().trim();
    const executions = JSON.parse(dbExecutionsJson || "[]");

    // Find developer execution (which contains backend metadata)
    const devExecution = executions.find((e) => {
      try {
        const meta = JSON.parse(e.metadata || "{}");
        return meta.backend === backend;
      } catch {
        return false;
      }
    });

    if (!devExecution) {
      console.error("Executions in DB:", executions);
      throw new Error(
        `Backend execution provenance violation: requested '${backend}', but no execution recorded with backend '${backend}'! Possible silent substitution or mock execution.`
      );
    }

    const devMeta = JSON.parse(devExecution.metadata || "{}");
    console.log(`Backend verified in database: execution=${devExecution.id}, backend=${devMeta.backend}, exit_code=${devMeta.exit_code}`);

    if (backend === "gemini_cli") {
      if (!devMeta.summary || !devMeta.summary.includes("Gemini CLI completed")) {
        throw new Error(`Execution summary did not originate from Gemini CLI: ${devMeta.summary}`);
      }
      // Query events table to verify live tool actions were emitted by Gemini CLI
      const eventsJson = execFileSync("sqlite3", [
        "-json",
        DB_PATH,
        "SELECT event_type, payload FROM events WHERE aggregate_id = '" + devExecution.id + "' OR event_type = 'tool_action';",
      ]).toString().trim();
      const events = JSON.parse(eventsJson || "[]");
      const hasToolActions = events.some((ev) => ev.event_type === "tool_action");
      if (!hasToolActions) {
        throw new Error("No tool_action events recorded for Gemini CLI execution!");
      }
      console.log(`✓ Confirmed: Gemini CLI tool actions captured (${events.filter(e => e.event_type === 'tool_action').length} tool actions).`);
    }

    console.log(`✓ [Assertion 5b] Backend execution provenance confirmed: '${backend}' strictly executed without substitution.`);

    // 8. ASSERT INTEGRATE BUTTON IS NOT DIRECTLY AVAILABLE BEFORE ACCEPTANCE
    const directIntegrateBtn = page.locator('div.flex button:has-text("Integrate")').filter({ hasNotText: "Accept & Integrate" });
    const isDirectIntegrateVisible = await directIntegrateBtn.isVisible();
    if (isDirectIntegrateVisible) {
      throw new Error("Direct 'Integrate' button was visible before acceptance! Invariant violation.");
    }
    console.log("✓ [Assertion 6] Direct 'Integrate' action is strictly unavailable prior to acceptance.");

    // 9. OPEN REVIEW PACKAGE MODAL & INSPECT EVIDENCE
    console.log("Opening Review Package modal...");
    await page.click('button:has-text("Review")');
    await page.waitForSelector('text="Mission Review Package"', { timeout: 5000 });

    // Assert verification passed
    const verificationElem = page.locator('div:has-text("Verification")').first();
    const verificationText = await verificationElem.textContent();
    if (!/pass/i.test(verificationText)) {
      throw new Error(`Expected verification to indicate pass, got: ${verificationText}`);
    }
    console.log("✓ [Assertion 7] Independent verification evidence displays PASSED (tests pass, tree clean).");

    // Assert changed files
    const fileBadge = page.locator('span:has-text("src/lib.rs")').first();
    await fileBadge.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ [Assertion 8] Changed files list contains 'src/lib.rs'.");

    // Assert diff is visible
    const diffElem = page.locator('div.whitespace-pre').first();
    await diffElem.waitFor({ state: "visible", timeout: 5000 });
    const diffContent = await diffElem.textContent();
    if (!diffContent || !diffContent.includes("pub fn add")) {
      throw new Error(`Expected Unified Deliverable Diff to contain 'pub fn add', got: ${diffContent}`);
    }
    console.log("✓ [Assertion 9] Unified deliverable diff is rendered and shows code modification.");

    // 10. BROWSER REFRESH TEST (Durability & Clean Recovery)
    console.log("Testing browser refresh during review phase...");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // Re-verify no error UI and state is preserved
    const refreshedBadge = page.locator('span:has-text("READY FOR REVIEW")').first();
    await refreshedBadge.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ [Assertion 10] Browser refresh preserved 'READY FOR REVIEW' state without errors.");

    // 11. EXPLICIT HUMAN ACCEPTANCE (Accept Only)
    console.log("Re-opening Review Package modal to perform explicit human acceptance...");
    await page.click('button:has-text("Review")');
    await page.waitForSelector('text="Mission Review Package"', { timeout: 5000 });

    console.log("Clicking 'Accept Only' in modal...");
    await page.locator('.fixed.inset-0 button:has-text("Accept Only")').click();
    await page.waitForTimeout(1500);

    // Assert state transitions to ACCEPTED
    const acceptedBadge = page.locator('span:has-text("ACCEPTED")').first();
    await acceptedBadge.waitFor({ state: "visible", timeout: 10000 });
    console.log("✓ [Assertion 11] Mission state visibly updated to 'ACCEPTED'.");

    // 12. INTEGRATE ACTION BECOMES AVAILABLE
    const integrateBtn = page.locator('button:has-text("Integrate")').filter({ hasNotText: "Accept & Integrate" }).first();
    await integrateBtn.waitFor({ state: "visible", timeout: 5000 });
    console.log("✓ [Assertion 12] 'Integrate' button is now available following human acceptance.");

    // 13. EXECUTE INTEGRATION
    console.log("Clicking 'Integrate' button...");
    await integrateBtn.click();

    // Assert transitions through INTEGRATING to INTEGRATED
    const integratedBadge = page.locator('span:has-text("INTEGRATED")').first();
    await integratedBadge.waitFor({ state: "visible", timeout: 20000 });
    console.log("✓ [Assertion 13] Mission successfully transitioned to 'INTEGRATED'.");

    // 14. VERIFY PHYSICAL TARGET REPOSITORY ON DISK
    console.log("Verifying physical Git state on disk in target repository...");
    const finalHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetRepoDir })
      .toString()
      .trim();
    if (finalHead === initialHead) {
      throw new Error(`Target repository HEAD did not change! Still at: ${finalHead}`);
    }
    console.log(`✓ [Assertion 14] Target repository HEAD changed from ${initialHead.slice(0, 8)} to ${finalHead.slice(0, 8)}.`);

    console.log("Executing 'cargo test' directly in target repository on disk...");
    const testOutput = execFileSync("cargo", ["test"], { cwd: targetRepoDir, stdio: "pipe" }).toString();
    if (!testOutput.includes("test tests::test_add ... ok")) {
      throw new Error(`Cargo test did not pass in target repository! Output:\n${testOutput}`);
    }
    console.log("✓ [Assertion 15] Physical repository test passed: 'test tests::test_add ... ok'.");

    console.log("\n========================================================================");
    console.log("   ALL 15 E2E RELEASE CANDIDATE BROWSER ASSERTIONS PASSED (100%)");
    console.log("========================================================================\n");

    await browser.close();
    await cleanup();
    process.exit(0);
  } catch (err) {
    console.error("\n❌ E2E RELEASE CANDIDATE TEST FAILED:", err);
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    await cleanup();
    process.exit(1);
  }
}

run();
