//! Google Gemini CLI External Agent Subsystem
//!
//! Provides executable discovery, capability probing, stream translation,
//! and process supervision integration for the official Gemini CLI.

pub mod backend;
pub mod probe;
pub mod stream;

pub use crate::backend::git_verify::{GitPreState, GitVerificationResult, GitVerifier};
pub use backend::GeminiCliBackend;
pub use probe::{GeminiAuthStatus, GeminiCapabilities, GeminiCapabilityProbe};
pub use stream::GeminiStreamParser;
