/**
 * Sentinel README Screenshot Generator
 *
 * Runs the real Sentinel server, launches Playwright Chromium, drives the full
 * autonomous mission lifecycle, and captures focused, high-resolution screenshots
 * for the README and documentation reflecting the latest UI refactor and brand identity.
 */

import { spawn, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { chromium } from "@playwright/test";

const PORT = 4088;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_PATH = `/tmp/sentinel_screenshots_${Date.now()}.db`;
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const releaseBinary = path.join(projectRoot, "target/release/sentinel");
const debugBinary = path.join(projectRoot, "target/debug/sentinel");
const binToUse = fs.existsSync(releaseBinary) ? releaseBinary : debugBinary;

const outDirHero = path.join(projectRoot, "docs/readme-assets/hero");
const outDirScreens = path.join(projectRoot, "docs/readme-assets/screenshots");
fs.mkdirSync(outDirHero, { recursive: true });
fs.mkdirSync(outDirScreens, { recursive: true });

console.log("========================================================================");
console.log("   SENTINEL README SCREENSHOT GENERATOR (REFRACTORED UI)");
console.log(`   Binary in use: ${binToUse}`);
console.log("========================================================================\n");

let serverProc = null;
const tempDirs = [];

function createTargetRepo() {
  const dir = `/tmp/sentinel_screens_repo_${Date.now()}`;
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);

  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Sentinel Supervisor Agent"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "agent@sentinel.local"], { cwd: dir });

  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "Cargo.toml"),
    `[package]\nname = "math_demo"\nversion = "0.1.0"\nedition = "2021"\n`
  );
  fs.writeFileSync(
    path.join(dir, "src/lib.rs"),
    `pub fn add(a: i32, b: i32) -> i32 {\n    a - b // BUG: subtraction instead of addition\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn test_add() {\n        assert_eq!(add(2, 3), 5);\n    }\n}\n`
  );
  fs.writeFileSync(path.join(dir, ".gitignore"), "/target\nCargo.lock\n.plexis/\n", "utf-8");

  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial buggy math implementation"], { cwd: dir });
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
  const args = ["serve", "--host", "127.0.0.1", "--port", PORT.toString(), "--db", DB_PATH];
  const p = spawn(binToUse, args, {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return p;
}

async function waitForServer(timeoutMs = 15000) {
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

async function cleanup() {
  console.log("\n--- Cleaning Up Resources ---");
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

async function run() {
  let browser = null;
  try {
    const targetRepoDir = createTargetRepo();
    serverProc = startServer();
    await waitForServer();
    console.log("✓ Server healthy on loopback.");

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2, // High-DPI retina screenshots
    });
    const page = await context.newPage();
    page.on("dialog", async (dialog) => {
      console.log(`[Browser Dialog] ${dialog.message()}`);
      await dialog.accept();
    });

    console.log("Navigating to Sentinel UI...");
    await page.goto(BASE_URL, { waitUntil: "networkidle" });

    // Register Workspace
    console.log("Registering workspace in UI...");
    await page.click('button[title="Switch project workspace"]');
    await page.waitForSelector('text="Project Workspaces"', { timeout: 5000 });
    const addWsBtn = page.locator('button:has-text("Register Workspace"), button:has-text("Register First Workspace")').first();
    await addWsBtn.click();
    await page.fill('input[placeholder*="token-limiter"]', "Math Demo");
    await page.fill('input[placeholder*="/home/user/Projects"]', targetRepoDir);
    await page.click('button[type="button"]:has-text("Register Workspace")');
    await page.waitForTimeout(500);

    const closeWsBtn = page.locator('button:has-text("Close")').first();
    if (await closeWsBtn.isVisible()) await closeWsBtn.click();
    await page.waitForTimeout(1000);

    // Launch Mission with fake_agent
    console.log("Launching autonomous mission...");
    const launchBtn = page.locator('button:has-text("Launch Mission")').first();
    await launchBtn.click();
    await page.waitForSelector('text="Launch Autonomous Mission"', { timeout: 5000 });
    await page.fill('input[placeholder*="Long-Horizon"]', "Fix Math Addition Bug");
    await page.fill(
      'textarea[placeholder*="Describe the software engineering goal"]',
      "Fix the subtraction bug in src/lib.rs so add(2, 3) == 5. Verify passing cargo test and commit."
    );
    await page.selectOption('form select:has(option[value="fake_agent"])', "fake_agent");
    await page.click('button[type="submit"]:has-text("Launch Mission")');

    // Wait for mission to reach READY FOR REVIEW
    console.log("Waiting for autonomous execution and physical verification...");
    const readyBadge = page.locator('span:has-text("READY FOR REVIEW")').first();
    await readyBadge.waitFor({ state: "visible", timeout: 35000 });
    await page.waitForTimeout(1500);
    console.log("✓ Mission reached READY FOR REVIEW ('AwaitingAcceptance').");

    // 1. Capture Dashboard Hero Screenshot
    console.log("Capturing hero dashboard screenshot...");
    const heroPath = path.join(outDirHero, "dashboard-hero.png");
    await page.screenshot({ path: heroPath });
    console.log(`✓ Saved hero: ${heroPath}`);

    // 2. Capture Mission Detail & Isolated Worktree Card
    console.log("Capturing isolated worktree detail card...");
    const detailPanel = page.locator('div:has-text("CURRENT STATUS")').locator("xpath=ancestor::div[contains(@class, 'space-y-4') or contains(@class, 'flex-1')]").first();
    const worktreeCropPath = path.join(outDirScreens, "01-isolated-worktree.png");
    if (await detailPanel.isVisible()) {
      await detailPanel.screenshot({ path: worktreeCropPath });
    } else {
      await page.screenshot({ path: worktreeCropPath, clip: { x: 260, y: 60, width: 1160, height: 800 } });
    }
    console.log(`✓ Saved worktree crop: ${worktreeCropPath}`);

    // 3. Capture Independent Physical Verification Card
    console.log("Capturing independent physical verification...");
    const verificationSection = page.locator('div:has-text("STOPPING CONDITIONS")').locator("xpath=ancestor::div[contains(@class, 'rounded')]").first();
    const verificationCropPath = path.join(outDirScreens, "02-independent-verification.png");
    if (await verificationSection.isVisible()) {
      await verificationSection.screenshot({ path: verificationCropPath });
    } else {
      await page.screenshot({ path: verificationCropPath, clip: { x: 260, y: 350, width: 1160, height: 400 } });
    }
    console.log(`✓ Saved verification crop: ${verificationCropPath}`);

    // 4. Open Review Package Modal & Capture Diff
    console.log("Opening Review Package modal...");
    const reviewBtn = page.locator('button:has-text("Inspect Review Package"), button:has-text("Review")').first();
    await reviewBtn.click();
    await page.waitForSelector('text="Mission Deliverable Review"', { timeout: 10000 });
    await page.waitForTimeout(1000);

    console.log("Capturing unified diff viewer...");
    const modal = page.locator('div[role="dialog"], div.fixed:has-text("Mission Deliverable Review")').first();
    const diffCropPath = path.join(outDirScreens, "03-review-diff.png");
    await modal.screenshot({ path: diffCropPath });
    console.log(`✓ Saved review package & diff: ${diffCropPath}`);

    // Close modal
    const closeBtn = page.locator('button:has-text("Close"), button[title="Close"]').first();
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
      await page.waitForTimeout(500);
    }

    // 5. Capture Human Acceptance Actions (banner on the main dashboard)
    console.log("Capturing human acceptance action banner...");
    const reviewBanner = page.locator('div:has-text("Physical Verification Passed")').locator("xpath=ancestor::div[contains(@class, 'rounded')]").first();
    const acceptanceCropPath = path.join(outDirScreens, "04-human-acceptance.png");
    if (await reviewBanner.isVisible()) {
      await reviewBanner.screenshot({ path: acceptanceCropPath });
      console.log(`✓ Saved acceptance banner: ${acceptanceCropPath}`);
    }

    // 6. Click Accept & Integrate on the dashboard banner
    console.log("Clicking 'Accept & Integrate'...");
    const acceptIntegrateBtn = page.locator('button:has-text("Accept & Integrate")').first();
    await acceptIntegrateBtn.click();
    await page.waitForTimeout(2000);

    const integratedBadge = page.locator('span:has-text("INTEGRATED")').first();
    await integratedBadge.waitFor({ state: "visible", timeout: 10000 });
    console.log("✓ Mission transitioned to INTEGRATED.");

    const integrationCropPath = path.join(outDirScreens, "05-git-integration.png");
    const integratedDetail = page.locator('div:has-text("CURRENT STATUS")').locator("xpath=ancestor::div[contains(@class, 'space-y-4') or contains(@class, 'flex-1')]").first();
    if (await integratedDetail.isVisible()) {
      await integratedDetail.screenshot({ path: integrationCropPath });
    } else {
      await page.screenshot({ path: integrationCropPath, clip: { x: 260, y: 60, width: 1160, height: 500 } });
    }
    console.log(`✓ Saved integration crop: ${integrationCropPath}`);

    // 7. Capture Overview Dashboard
    console.log("Capturing Overview Dashboard...");
    await page.click('button:has-text("Overview")');
    await page.waitForTimeout(1000);
    const overviewCropPath = path.join(outDirScreens, "06-operational-overview.png");
    await page.screenshot({ path: overviewCropPath });
    console.log(`✓ Saved overview dashboard: ${overviewCropPath}`);

    // 8. Capture Agent Fleet Governance Table
    console.log("Capturing Agent Fleet Governance Table...");
    await page.click('button:has-text("Agents")');
    await page.waitForTimeout(1000);
    // Click the first row to expand the inspector drawer
    const firstAgentRow = page.locator('tbody tr').first();
    if (await firstAgentRow.isVisible()) {
      await firstAgentRow.click();
      await page.waitForTimeout(500);
    }
    const agentsCropPath = path.join(outDirScreens, "07-agent-fleet.png");
    await page.screenshot({ path: agentsCropPath });
    console.log(`✓ Saved agent fleet: ${agentsCropPath}`);

    console.log("\n========================================================================");
    console.log("   ALL 8 SCREENSHOTS CAPTURED SUCCESSFULLY!");
    console.log("========================================================================\n");
  } finally {
    if (browser) await browser.close();
    await cleanup();
  }
}

run().catch((err) => {
  console.error("Screenshot capture failed:", err);
  cleanup().then(() => process.exit(1));
});
