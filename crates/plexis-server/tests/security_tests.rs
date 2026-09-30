use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use std::process::Command;
use tower::ServiceExt;

use plexis_server::{create_router, AppState};
use plexis_storage::SqliteStore;

/// Test A: Default bind address is loopback (127.0.0.1), unauthenticated requests
/// are allowed in local loopback mode, and /api/v1/auth/status reports local_loopback.
#[tokio::test]
async fn test_a_default_bind_loopback_auth_status() {
    let store = SqliteStore::open_in_memory().expect("open sqlite in-memory");
    let state = AppState::new(store).with_auth_token(None);
    assert_eq!(state.bind_host, "127.0.0.1");
    assert!(state.is_loopback);
    assert!(state.auth_token.is_none());

    let app = create_router(state);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/auth/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("auth status request");

    assert_eq!(res.status(), StatusCode::OK);
    let body = res.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["auth_required"], false);
    assert_eq!(json["mode"], "local_loopback");
    assert_eq!(json["bind_host"], "127.0.0.1");
    assert_eq!(json["is_loopback"], true);
}

/// Test B: Non-loopback bind (0.0.0.0) without auth token fails startup with
/// non-zero exit code and explicit fatal error message.
#[test]
fn test_b_non_loopback_without_auth_fails_startup() {
    // Locate the sentinel / plexis-server binary
    let bin_path = env!("CARGO_BIN_EXE_sentinel");
    let db_path = format!(
        "/tmp/sentinel_sec_test_b_{}.db",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );

    let output = Command::new(bin_path)
        .arg("serve")
        .arg("--host")
        .arg("0.0.0.0")
        .arg("--port")
        .arg("4099")
        .arg("--db")
        .arg(&db_path)
        .env_remove("SENTINEL_AUTH_TOKEN")
        .env_remove("PLEXIS_AUTH_TOKEN")
        .output()
        .expect("failed to execute sentinel serve");

    assert!(
        !output.status.success(),
        "Server should fail startup when binding to 0.0.0.0 without auth"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("FATAL SECURITY ERROR")
            || stderr.contains("NON-LOOPBACK BIND REQUIRES AUTHENTICATION"),
        "Stderr should contain fatal security error, got: {}",
        stderr
    );
}

/// Test C: Non-loopback bind with --auth-token succeeds.
#[tokio::test]
async fn test_c_non_loopback_with_auth_flag_succeeds() {
    let store = SqliteStore::open_in_memory().expect("open sqlite in-memory");
    let state = AppState::new(store)
        .with_bind_host("0.0.0.0", false)
        .with_auth_token(Some("secret-token-123".to_string()));

    assert_eq!(state.bind_host, "0.0.0.0");
    assert!(!state.is_loopback);
    assert_eq!(state.auth_token.as_deref(), Some("secret-token-123"));

    let app = create_router(state);

    // /api/v1/auth/status is a public probe
    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/auth/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("auth status request");

    assert_eq!(res.status(), StatusCode::OK);
    let body = res.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["auth_required"], true);
    assert_eq!(json["mode"], "token");
    assert_eq!(json["bind_host"], "0.0.0.0");
    assert_eq!(json["is_loopback"], false);
}

/// Test D: Non-loopback bind with SENTINEL_AUTH_TOKEN environment variable succeeds.
#[tokio::test]
async fn test_d_non_loopback_with_sentinel_auth_token_env() {
    std::env::set_var("SENTINEL_AUTH_TOKEN", "env-token-xyz");
    let store = SqliteStore::open_in_memory().expect("open sqlite in-memory");
    let state = AppState::new(store).with_bind_host("0.0.0.0", false);
    std::env::remove_var("SENTINEL_AUTH_TOKEN");

    assert_eq!(state.auth_token.as_deref(), Some("env-token-xyz"));

    let app = create_router(state);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/auth/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("auth status request");

    assert_eq!(res.status(), StatusCode::OK);
    let body = res.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["auth_required"], true);
    assert_eq!(json["mode"], "token");
}

/// Test E: When auth token is configured, unauthenticated requests to protected endpoints
/// are rejected with 401 Unauthorized, while authenticated requests succeed.
#[tokio::test]
async fn test_e_auth_enforcement_on_protected_endpoints() {
    let store = SqliteStore::open_in_memory().expect("open sqlite in-memory");
    let state = AppState::new(store).with_auth_token(Some("protected-secret-token".to_string()));
    let app = create_router(state);

    // Unauthenticated request to protected endpoint /api/v1/workflows
    let unauth_res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/workflows")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("unauth request");

    assert_eq!(unauth_res.status(), StatusCode::UNAUTHORIZED);

    // Authenticated request with Bearer token
    let auth_res = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/workflows")
                .header("Authorization", "Bearer protected-secret-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("auth request");

    assert_eq!(auth_res.status(), StatusCode::OK);
}

/// Test F: /api/v1/auth/status accurately reports bind_host and is_loopback,
/// and NEVER claims "local_loopback" when bound to a non-loopback interface.
#[tokio::test]
async fn test_f_auth_status_never_claims_loopback_when_non_loopback() {
    let store = SqliteStore::open_in_memory().expect("open sqlite in-memory");
    // Simulate non-loopback bind without auth
    let state = AppState::new(store)
        .with_bind_host("192.168.1.100", false)
        .with_auth_token(None);
    assert!(!state.is_loopback);

    let app = create_router(state);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/auth/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("auth status request");

    assert_eq!(res.status(), StatusCode::OK);
    let body = res.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["bind_host"], "192.168.1.100");
    assert_eq!(json["is_loopback"], false);
    // Crucial check: mode MUST NOT be "local_loopback"
    assert_ne!(json["mode"], "local_loopback");
    assert_eq!(json["mode"], "unauthenticated");
}
