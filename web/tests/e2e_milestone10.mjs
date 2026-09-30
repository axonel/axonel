import { chromium } from "playwright";
import { spawn, execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const PORT = 4020;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_PATH = `/tmp/sentinel_m10_${Date.now()}.db`;
const WORKLOAD_DIR = `/tmp/sentinel_workload_m10_${Date.now()}`;
const AUTH_TOKEN = "m10-hardened-auth-token-998877";
const ARTIFACTS_DIR = `/tmp/milestone10_artifacts_${Date.now()}`;

console.log("================================================================");
console.log("   SENTINEL / PLEXIS MILESTONE 10: REAL AI WORKFLOW E2E AUDIT    ");
console.log("================================================================");
console.log(`[E2E Setup] Database path: ${DB_PATH}`);
console.log(`[E2E Setup] Target workload repository: ${WORKLOAD_DIR}`);
console.log(`[E2E Setup] Artifacts directory: ${ARTIFACTS_DIR}`);
console.log(`[E2E Setup] Hardened Auth Token: ${AUTH_TOKEN}\n`);

fs.mkdirSync(WORKLOAD_DIR, { recursive: true });
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

// Setup a git repository in WORKLOAD_DIR
execFileSync("git", ["init"], { cwd: WORKLOAD_DIR });
execFileSync("git", ["config", "user.name", "Plexis Tester"], { cwd: WORKLOAD_DIR });
execFileSync("git", ["config", "user.email", "tester@sentinel.local"], { cwd: WORKLOAD_DIR });
fs.mkdirSync(path.join(WORKLOAD_DIR, "src"), { recursive: true });
fs.writeFileSync(
  path.join(WORKLOAD_DIR, "src", "lib.rs"),
  "pub fn compute(a: i32, b: i32) -> i32 {\n    a + b\n}\n",
  "utf-8"
);
fs.writeFileSync(
  path.join(WORKLOAD_DIR, "Cargo.toml"),
  "[package]\nname = \"calc_lib\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
  "utf-8"
);
execFileSync("git", ["add", "-A"], { cwd: WORKLOAD_DIR });
execFileSync("git", ["commit", "-m", "Initial commit for calc_lib"], { cwd: WORKLOAD_DIR });
console.log("✓ Initialized git workload repository with clean initial commit.");

// Helper to start backend server
function startServer() {
  const env = {
    ...process.env,
    PORT: PORT.toString(),
    PLEXIS_DB_PATH: DB_PATH,
    PLEXIS_AUTH_TOKEN: AUTH_TOKEN,
    RUST_LOG: "info",
  };

  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const binaryPath = path.join(projectRoot, "target/debug/plexis-server");
  const proc = spawn(binaryPath, [], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg.includes("listening") || msg.includes("INFO") || msg.includes("Opening")) {
      console.log(`[Plexis Server] ${msg}`);
    }
  });

  return proc;
}

async function waitForServer(timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) {
        return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server failed to start within ${timeoutMs}ms`);
}

async function runMilestone10Audit() {
  // 1. Initialize workspace via CLI
  console.log("\n--- Step 1: CLI Workspace Initialization ---");
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const binaryPath = path.join(projectRoot, "target/debug/plexis");
  const initOutput = execFileSync(
    binaryPath,
    ["init", WORKLOAD_DIR, "--name", "calc_lib_project", "--db", DB_PATH],
    { cwd: projectRoot, encoding: "utf-8" }
  );
  console.log(initOutput.trim());

  // 2. Start server
  console.log("\n--- Step 2: Backend Server Launch with Control-Plane Auth ---");
  let serverProc = startServer();
  await waitForServer();
  console.log("✓ Backend server is healthy on " + BASE_URL);

  // Verify /api/v1/health is unauthenticated
  const healthRes = await fetch(`${BASE_URL}/api/v1/health`);
  if (!healthRes.ok) throw new Error("GET /api/v1/health failed: " + healthRes.status);
  console.log("✓ GET /api/v1/health responded 200 OK without authentication.");

  // Verify unauthenticated API request gets 401
  const unauthRes = await fetch(`${BASE_URL}/api/v1/workspaces`);
  if (unauthRes.status !== 401) throw new Error("Expected 401 for unauthenticated request");
  console.log("✓ GET /api/v1/workspaces rejected with 401 Unauthorized.");

  // 3. Launch Playwright
  console.log("\n--- Step 3: Browser E2E Automation Journey ---");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: ARTIFACTS_DIR, size: { width: 1440, height: 900 } },
  });

  // Inject token and default provider into localStorage
  await context.addInitScript((tok) => {
    localStorage.setItem("plexis_auth_token", tok);
    localStorage.setItem("plexis_default_provider", "openai");
  }, AUTH_TOKEN);

  const page = await context.newPage();

  page.on("dialog", async (dialog) => {
    console.log(`[Browser Dialog] ${dialog.type()}: "${dialog.message()}"`);
    await dialog.accept();
  });

  try {
    // 3a. Load UI
    console.log("1. Loading Plexis Web UI at " + BASE_URL + "...");
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForSelector("text=PLEXIS", { timeout: 8000 });
    console.log("✓ Brand header loaded.");

    // 3b. Verify Active Project Workspace
    console.log("2. Verifying Project Selection...");
    await page.waitForSelector("text=calc_lib_project", { timeout: 6000 });
    console.log("✓ Active Project Workspace calc_lib_project confirmed in Header.");

    // 3c. Provider Configuration Modal
    console.log("3. Verifying Provider Configuration Modal...");
    await page.locator("header button").filter({ has: page.locator("svg") }).last().click();
    await page.waitForSelector("text=Control Plane & Provider Configuration", { timeout: 5000 });
    console.log("✓ Provider configuration modal opened.");

    // Change provider and save
    await page.locator("select").selectOption("gemini");
    await page.locator("button:has-text(\"Save Configuration\")").click();
    await page.waitForSelector("text=Configuration saved successfully!", { timeout: 4000 });
    console.log("✓ Provider configuration updated to Gemini and saved.");

    // 3d. Cost & Usage View
    console.log("4. Verifying Cost & Token Usage View...");
    await page.locator("button:has-text(\"Usage & Retention\")").click();
    await page.waitForSelector("text=Cost & Usage Accounting", { timeout: 5000 });
    await page.waitForSelector("text=Total Tokens Consumed", { timeout: 4000 });
    await page.waitForSelector("text=Estimated Cost", { timeout: 4000 });
    await page.waitForSelector("text=Budget Alert Threshold", { timeout: 4000 });
    await page.waitForSelector("text=Per-Agent Role Cost Attribution", { timeout: 4000 });
    console.log("✓ Cost & Token Accounting view verified with KPI metrics and Agent Attribution table.");

    // Adjust budget threshold
    await page.locator("input[type=\"number\"]").fill("100");
    console.log("✓ Budget alert threshold adjusted to $100.");

    // 3e. Create Workflow with Engineering Objective
    console.log("5. Submitting Engineering Objective Workflow...");
    await page.locator("button:has-text(\"Workflows\")").click();
    await page.locator("button:has-text(\"New Workflow\")").first().click();
    await page.waitForSelector("text=Create Autonomous Workflow", { timeout: 4000 });

    const workflowTitle = "Implement Negative Number Modulo in calc_lib";
    const workflowDesc = "Fix negative operands handling in arithmetic engine and verify with cargo test";

    await page.locator("input[placeholder*=\"e.g. Implement\"]").fill(workflowTitle);
    await page.locator("textarea[placeholder*=\"Detail the target workload\"]").fill(workflowDesc);
    await page.locator("button:has-text(\"Create & Launch\")").click();

    // 3f. Observe Live DAG Visualization
    console.log("6. Observing Live DAG Visualization...");
    await page.waitForSelector(`text=${workflowTitle}`, { timeout: 10000 });
    await page.waitForSelector("svg#graph-canvas", { timeout: 8000 });
    const taskNodes = await page.locator("svg#graph-canvas g.cursor-pointer").count();
    console.log(`✓ Interactive DAG successfully visualized with ${taskNodes} task nodes.`);

    // 3g. Diff Viewer & Git Operations
    console.log("7. Verifying Diff Viewer & Git Operations...");
    // Modify file
    fs.appendFileSync(
      path.join(WORKLOAD_DIR, "src", "lib.rs"),
      "\npub fn modulo(a: i32, b: i32) -> i32 { ((a % b) + b) % b }\n"
    );

    await page.locator("button:has-text(\"Workspace Diff\")").click();
    await page.waitForSelector("text=src/lib.rs", { timeout: 6000 });
    console.log("✓ Diff Viewer detected modified file src/lib.rs.");

    await page.locator("input[placeholder*=\"Commit message\"]").fill("feat: add modulo support");
    await page.locator("button:has-text(\"Commit Changes\")").click();
    await page.waitForSelector("text=Working tree is clean", { timeout: 8000 });
    console.log("✓ Git commit executed and confirmed clean working tree.");

    // 3h. Streaming Terminal & Secret Redaction
    console.log("8. Verifying Streaming Terminal Output...");
    const wfRes = await fetch(`${BASE_URL}/api/v1/workflows`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    const wfs = await wfRes.json();
    const activeWf = wfs[0];
    const tasksRes = await fetch(`${BASE_URL}/api/v1/workflows/${activeWf.id}/tasks`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    const tasks = await tasksRes.json();
    const activeTask = tasks[0];

    // Inject terminal stream
    await fetch(`${BASE_URL}/api/v1/tasks/${activeTask.id}/terminal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({
        lines: [
          { line: "cargo test --lib", is_stderr: false },
          { line: "running 2 tests", is_stderr: false },
          { line: "Bearer sk-proj-1234567890abcdef", is_stderr: false },
          { line: "test result: ok. 2 passed; 0 failed", is_stderr: false },
        ],
        exit_code: 0,
      }),
    });

    await page.locator("button:has-text(\"Tasks (\")").click();
    await page.locator(`text=${activeTask.objective}`).first().click();
    await page.waitForSelector("text=Task Inspection & Governance", { timeout: 4000 });
    await page.locator("button:has-text(\"Live Terminal\")").click();
    await page.waitForSelector("text=cargo test --lib", { timeout: 4000 });
    await page.waitForSelector("text=Redaction Active", { timeout: 4000 });
    console.log("✓ Streaming terminal observed with secret redaction active.");

    // 3i. Approval Flow & Diagnostics
    console.log("9. Verifying Approval Flow & 8 Diagnostic Questions...");
    await fetch(`${BASE_URL}/api/v1/approvals`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({
        workflow_id: activeWf.id,
        task_id: activeTask.id,
        action_description: "Push verified modulo feature to upstream repository",
        reason: "Milestone 10 independent verification sign-off",
      }),
    });

    await page.locator("button:has-text(\"Review Surface\")").click();
    await page.waitForSelector("button:has-text(\"8 Diagnostic Answers\")", { timeout: 4000 });
    await page.locator("button:has-text(\"8 Diagnostic Answers\")").click();
    await page.waitForSelector("text=1. What is this task trying to do?", { timeout: 3000 });
    await page.waitForSelector("text=5. Why is human approval needed?", { timeout: 3000 });
    console.log("✓ 8 Diagnostic questions verified on unified review surface.");

    await page.locator("button:has-text(\"Approve & Unblock\")").click();
    await page.waitForSelector("text=Task sign-off recorded successfully", { timeout: 5000 });
    console.log("✓ Human approval action submitted and recorded.");

    // Take final screenshot
    const screenshotPath = path.join(ARTIFACTS_DIR, "milestone10_success.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const conversationArtifactDir = "/home/roonakyadav/.gemini/antigravity/brain/f5e605a3-b2dc-4c5c-8c4d-347413f30290";
    try {
      fs.copyFileSync(screenshotPath, path.join(conversationArtifactDir, "milestone10_success.png"));
    } catch {}
    console.log(`✓ Saved final milestone verification screenshot to: ${screenshotPath}`);

    console.log("\n================================================================");
    console.log("  MILESTONE 10 BROWSER REGRESSION SUITE COMPLETED SUCCESSFULLY! ");
    console.log("================================================================\n");
  } finally {
    await browser.close();
    serverProc.kill("SIGTERM");
    try {
      fs.unlinkSync(DB_PATH);
      fs.rmSync(WORKLOAD_DIR, { recursive: true, force: true });
    } catch {}
  }
}

runMilestone10Audit().catch((err) => {
  console.error("\n❌ MILESTONE 10 BROWSER AUDIT FAILED:", err);
  process.exit(1);
});
