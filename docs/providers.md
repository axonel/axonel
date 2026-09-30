# Agent Providers & CLI Adapters

Sentinel decouples the supervisor and control plane from the underlying coding agent. You can run external CLI coding agents (like Google Gemini CLI), local LLMs, or deterministic mock agents for testing.

---

## 1. Supported Providers & Adapters

| Provider / Adapter | Execution Mode | Sandbox / Confinement | Requirements | Primary Use Case |
| :--- | :--- | :--- | :--- | :--- |
| **Gemini CLI** (`gemini`) | CLI Subprocess (`LocalAgentHost`) | Worktree + POSIX PGID | `gemini` CLI installed, `GEMINI_API_KEY` | Real-world autonomous coding, refactoring, bug-fixing |
| **Fake Agent** (`fake`) | CLI Subprocess (`plexis-fake-agent`) | Worktree + POSIX PGID | Built-in Cargo binary | Local testing, CI/CD pipelines, reproducible benchmarks |
| **Gemini API** (`gemini-api`) | Direct HTTP API Client | In-process Tool Invocation | `GEMINI_API_KEY` | Direct API-driven planning and synthesis |
| **OpenAI API** (`openai`) | Direct HTTP API Client | In-process Tool Invocation | `OPENAI_API_KEY` | OpenAI GPT-4o / o1 / o3 models |
| **Ollama** (`ollama`) | Direct HTTP API Client | In-process Tool Invocation | Local Ollama daemon | Air-gapped / offline local model execution |

---

## 2. Gemini CLI Adapter

The Gemini CLI adapter connects Sentinel to Google's official `gemini` CLI tool.

### Prerequisites

1. Install the `gemini` CLI tool and ensure it is available in your `$PATH`.
2. Set your API key:
   ```bash
   export GEMINI_API_KEY="your-gemini-api-key"
   ```

### Execution Lifecycle

1. **Worktree Provisioning:** Sentinel provisions an isolated worktree at `.plexis/worktrees/<mission-id>`.
2. **Subprocess Invocation:** `LocalAgentHost` spawns the `gemini` binary into a dedicated POSIX process group (PGID).
3. **Environment Scrubbing:** Sensitive host environment variables (e.g. `SENTINEL_AUTH_TOKEN`, AWS credentials) are scrubbed before launching the subprocess.
4. **Stream Parsing:** Stdout and stderr from the CLI are parsed in real time into structured events (tool calls, file edits, thinking steps) and streamed to the Sentinel Web UI via Server-Sent Events (SSE).
5. **Termination & Cleanup:** When the CLI exits or is cancelled, Sentinel terminates the entire process group (`SIGTERM` -> `SIGKILL`), ensuring no orphan child processes remain.

---

## 3. Deterministic Fake Agent (Offline Mode)

For local development, CI/CD, and regression testing without incurring LLM costs or requiring internet access, Sentinel includes `plexis-fake-agent`.

### How It Works

`plexis-fake-agent` is a standalone Rust binary that emulates an agent's behavior deterministically based on test scenarios:

```bash
# Build the fake agent
cargo build -p plexis-fake-agent --bin fake_agent

# Run a mission using the fake agent
sentinel mission create \
  --prompt "Fix math library add function" \
  --repo-path "/path/to/test-repo" \
  --stopping-condition "cargo test" \
  --agent-bin "./target/debug/fake_agent"
```

The fake agent inspects the target repository, applies a pre-programmed fix to satisfy the stopping conditions, and exits with code `0`.

---

## 4. Configuration & Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | API key used for Google Gemini CLI or API adapter. | None (Required for Gemini) |
| `OPENAI_API_KEY` | API key used for OpenAI adapter. | None (Required for OpenAI) |
| `OLLAMA_BASE_URL` | Base URL for local Ollama server. | `http://localhost:11434` |
| `SENTINEL_AGENT_TIMEOUT` | Monotonic timeout in seconds for agent subprocesses. | `300` (5 minutes) |
| `SENTINEL_AGENT_BIN` | Override path to the external agent executable. | System `$PATH` resolution |

---

## 5. Implementing a Custom Agent Adapter

To add a new CLI or API agent adapter, implement the `AgentBackend` trait from `plexis-runtime`:

```rust
use async_trait::async_trait;
use plexis_core::Result;
use std::path::Path;

#[async_trait]
pub trait AgentBackend: Send + Sync {
    /// Launch the agent against an isolated worktree.
    async fn execute(
        &self,
        mission_id: &str,
        worktree_path: &Path,
        prompt: &str,
    ) -> Result<ExecutionResult>;

    /// Abort an active execution by terminating its process group.
    async fn cancel(&self, mission_id: &str) -> Result<()>;
}
```
