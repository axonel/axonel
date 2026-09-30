//! GitHub integration boundary and abstractions.
//!
//! Provides an explicit integration trait for GitHub operations (repos, PRs, issues)
//! with support for real API queries when GITHUB_TOKEN is present, or a deterministic
//! offline/mock fallback for testing and air-gapped development.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubRepoInfo {
    pub name: String,
    pub full_name: String,
    pub html_url: String,
    pub default_branch: String,
    pub is_private: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubPullRequest {
    pub number: u64,
    pub title: String,
    pub body: Option<String>,
    pub html_url: String,
    pub state: String, // "open", "closed", "merged"
    pub head_branch: String,
    pub base_branch: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubIssue {
    pub number: u64,
    pub title: String,
    pub body: Option<String>,
    pub html_url: String,
    pub state: String,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePullRequestPayload {
    pub repo: Option<String>,
    pub title: String,
    pub body: String,
    pub head: String,
    pub base: String,
    pub workflow_id: Option<String>,
    pub task_id: Option<String>,
}

/// Explicit boundary interface for GitHub platform integration.
#[async_trait]
pub trait GitHubIntegration: Send + Sync {
    /// Lists accessible repositories.
    async fn list_repositories(&self) -> Result<Vec<GitHubRepoInfo>, String>;

    /// Lists pull requests for a specific repository.
    async fn list_pull_requests(&self, repo: &str) -> Result<Vec<GitHubPullRequest>, String>;

    /// Creates a pull request in the repository.
    async fn create_pull_request(
        &self,
        repo: &str,
        payload: CreatePullRequestPayload,
    ) -> Result<GitHubPullRequest, String>;

    /// Lists issues for a repository.
    async fn list_issues(&self, repo: &str) -> Result<Vec<GitHubIssue>, String>;

    /// Whether the integration is running in real mode or local/mock fallback.
    fn is_live(&self) -> bool;
}

/// Default implementation that routes to GitHub API when token is provided,
/// or provides a local offline mock implementation for testing and development.
pub struct DefaultGitHubClient {
    token: Option<String>,
    client: reqwest::Client,
}

impl Default for DefaultGitHubClient {
    fn default() -> Self {
        Self::new()
    }
}

impl DefaultGitHubClient {
    pub fn new() -> Self {
        let token = std::env::var("GITHUB_TOKEN")
            .ok()
            .filter(|s| !s.trim().is_empty());
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default();
        Self { token, client }
    }

    pub fn with_token(token: impl Into<String>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default();
        Self {
            token: Some(token.into()),
            client,
        }
    }
}

#[async_trait]
impl GitHubIntegration for DefaultGitHubClient {
    async fn list_repositories(&self) -> Result<Vec<GitHubRepoInfo>, String> {
        let Some(ref token) = self.token else {
            return Ok(vec![
                GitHubRepoInfo {
                    name: "sentinel".to_string(),
                    full_name: "sentinel/sentinel".to_string(),
                    html_url: "https://github.com/sentinel/sentinel".to_string(),
                    default_branch: "main".to_string(),
                    is_private: true,
                },
                GitHubRepoInfo {
                    name: "token-limiter".to_string(),
                    full_name: "local/token-limiter".to_string(),
                    html_url: "https://github.com/local/token-limiter".to_string(),
                    default_branch: "main".to_string(),
                    is_private: false,
                },
            ]);
        };

        let resp = self
            .client
            .get("https://api.github.com/user/repos?sort=updated&per_page=30")
            .header("Authorization", format!("Bearer {}", token))
            .header("User-Agent", "Sentinel-Platform")
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| format!("Failed to call GitHub API: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("GitHub API returned {}: {}", status, text));
        }

        let items: Vec<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse GitHub repos: {}", e))?;

        let mut repos = Vec::new();
        for item in items {
            repos.push(GitHubRepoInfo {
                name: item["name"].as_str().unwrap_or("").to_string(),
                full_name: item["full_name"].as_str().unwrap_or("").to_string(),
                html_url: item["html_url"].as_str().unwrap_or("").to_string(),
                default_branch: item["default_branch"]
                    .as_str()
                    .unwrap_or("main")
                    .to_string(),
                is_private: item["private"].as_bool().unwrap_or(false),
            });
        }
        Ok(repos)
    }

    async fn list_pull_requests(&self, repo: &str) -> Result<Vec<GitHubPullRequest>, String> {
        let Some(ref token) = self.token else {
            return Ok(vec![GitHubPullRequest {
                number: 42,
                title: format!("feat: autonomous updates for {}", repo),
                body: Some("Generated by Plexis autonomous workflow".to_string()),
                html_url: format!("https://github.com/{}/pull/42", repo),
                state: "open".to_string(),
                head_branch: "plexis-agent-patch".to_string(),
                base_branch: "main".to_string(),
                created_at: chrono::Utc::now().to_rfc3339(),
            }]);
        };

        let url = format!(
            "https://api.github.com/repos/{}/pulls?state=all&per_page=20",
            repo
        );
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .header("User-Agent", "Sentinel-Platform")
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| format!("Failed to call GitHub API: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("GitHub API returned {}: {}", status, text));
        }

        let items: Vec<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse GitHub pulls: {}", e))?;

        let mut pulls = Vec::new();
        for item in items {
            pulls.push(GitHubPullRequest {
                number: item["number"].as_u64().unwrap_or(0),
                title: item["title"].as_str().unwrap_or("").to_string(),
                body: item["body"].as_str().map(|s| s.to_string()),
                html_url: item["html_url"].as_str().unwrap_or("").to_string(),
                state: item["state"].as_str().unwrap_or("open").to_string(),
                head_branch: item["head"]["ref"].as_str().unwrap_or("").to_string(),
                base_branch: item["base"]["ref"].as_str().unwrap_or("main").to_string(),
                created_at: item["created_at"].as_str().unwrap_or("").to_string(),
            });
        }
        Ok(pulls)
    }

    async fn create_pull_request(
        &self,
        repo: &str,
        payload: CreatePullRequestPayload,
    ) -> Result<GitHubPullRequest, String> {
        let Some(ref token) = self.token else {
            return Ok(GitHubPullRequest {
                number: 43,
                title: payload.title,
                body: Some(payload.body),
                html_url: format!("https://github.com/{}/pull/43", repo),
                state: "open".to_string(),
                head_branch: payload.head,
                base_branch: payload.base,
                created_at: chrono::Utc::now().to_rfc3339(),
            });
        };

        let url = format!("https://api.github.com/repos/{}/pulls", repo);
        let body = serde_json::json!({
            "title": payload.title,
            "body": payload.body,
            "head": payload.head,
            "base": payload.base,
        });

        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .header("User-Agent", "Sentinel-Platform")
            .header("Accept", "application/vnd.github+json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Failed to call GitHub API: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("GitHub API returned {}: {}", status, text));
        }

        let item: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse created PR: {}", e))?;

        Ok(GitHubPullRequest {
            number: item["number"].as_u64().unwrap_or(0),
            title: item["title"].as_str().unwrap_or(&payload.title).to_string(),
            body: item["body"].as_str().map(|s| s.to_string()),
            html_url: item["html_url"].as_str().unwrap_or("").to_string(),
            state: item["state"].as_str().unwrap_or("open").to_string(),
            head_branch: item["head"]["ref"]
                .as_str()
                .unwrap_or(&payload.head)
                .to_string(),
            base_branch: item["base"]["ref"]
                .as_str()
                .unwrap_or(&payload.base)
                .to_string(),
            created_at: item["created_at"].as_str().unwrap_or("").to_string(),
        })
    }

    async fn list_issues(&self, repo: &str) -> Result<Vec<GitHubIssue>, String> {
        let Some(ref token) = self.token else {
            return Ok(vec![GitHubIssue {
                number: 101,
                title: "Improve token eviction performance in high concurrency".to_string(),
                body: Some("Reported in stress test verification".to_string()),
                html_url: "https://github.com/local/token-limiter/issues/101".to_string(),
                state: "open".to_string(),
                labels: vec!["bug".to_string(), "performance".to_string()],
            }]);
        };

        let url = format!(
            "https://api.github.com/repos/{}/issues?state=open&per_page=20",
            repo
        );
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .header("User-Agent", "Sentinel-Platform")
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| format!("Failed to call GitHub API: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("GitHub API returned {}: {}", status, text));
        }

        let items: Vec<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse GitHub issues: {}", e))?;

        let mut issues = Vec::new();
        for item in items {
            let labels = item["labels"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|l| l["name"].as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();

            issues.push(GitHubIssue {
                number: item["number"].as_u64().unwrap_or(0),
                title: item["title"].as_str().unwrap_or("").to_string(),
                body: item["body"].as_str().map(|s| s.to_string()),
                html_url: item["html_url"].as_str().unwrap_or("").to_string(),
                state: item["state"].as_str().unwrap_or("open").to_string(),
                labels,
            });
        }
        Ok(issues)
    }

    fn is_live(&self) -> bool {
        self.token.is_some()
    }
}
