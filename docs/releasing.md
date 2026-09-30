# Sentinel Release Engineering & Packaging Guide

This document outlines the canonical release criteria, packaging procedures, checksum verification, and version-bumping steps for project maintainers.

---

## 1. Pre-Release Checklist

Before tagging or publishing any release, verify that all release gates are satisfied:

| Gate | Verification Command | Requirement |
| :--- | :--- | :--- |
| **Git Status** | `git status` | Working tree must be completely clean; branch is `main`. |
| **Workspace Tests** | `cargo test --workspace` | 100% pass rate across all workspace crates. |
| **Formatting** | `cargo fmt --all -- --check` | 0 formatting deviations. |
| **Clippy** | `cargo clippy --workspace --all-targets -- -D warnings` | 0 compiler or linter warnings. |
| **Frontend Build** | `npm --prefix web ci && npm --prefix web run build` | Assets compile cleanly into `web/dist/`. |
| **M19 Acceptance** | `node web/tests/m19_acceptance_tests.mjs` | Human review package and acceptance gate pass. |
| **M20 Reliability**| `node web/tests/m20_integration_reliability_tests.mjs` | Transactional integration and crash recovery pass. |
| **Browser E2E** | `node web/tests/e2e_release_candidate.mjs` | 15/15 assertions pass in Chromium. |
| **Continuous Integration** | GitHub Actions | Remote pipeline is completely green on `origin/main`. |

---

## 2. Building Release Binaries

Sentinel compiles into a standalone production binary:

```bash
# 1. Build the production release binary
cargo build --release -p plexis-server --bin sentinel

# 2. Verify binary version and help output
./target/release/sentinel --version
./target/release/sentinel --help

# 3. Strip debug symbols for distribution
strip target/release/sentinel
```

---

## 3. Packaging & Checksums

Create the release tarball and compute SHA-256 checksums:

```bash
VERSION="0.1.1"
TARGET="x86_64-unknown-linux-gnu"
ARCHIVE_NAME="sentinel-v${VERSION}-${TARGET}.tar.gz"

# Create staging directory
mkdir -p dist/bin
cp target/release/sentinel dist/bin/
cp README.md LICENSE SECURITY.md dist/

# Create archive
tar -czvf "${ARCHIVE_NAME}" -C dist .

# Generate SHA-256 checksum
sha256sum "${ARCHIVE_NAME}" > "${ARCHIVE_NAME}.sha256"

# Verify checksum
sha256sum -c "${ARCHIVE_NAME}.sha256"
```

---

## 4. Version Bumping Procedure

When preparing a new release:

1. Update version in `Cargo.toml`:
   ```toml
   [workspace.package]
   version = "X.Y.Z"
   ```
2. Update version in `web/package.json`:
   ```json
   "version": "X.Y.Z"
   ```
3. Update `CHANGELOG.md` with release notes following Keep a Changelog conventions.
4. Run `cargo check` to update `Cargo.lock`.
5. Commit and tag:
   ```bash
   git commit -am "release: vX.Y.Z"
   git tag -a "vX.Y.Z" -m "Release vX.Y.Z"
   git push origin main --tags
   ```
