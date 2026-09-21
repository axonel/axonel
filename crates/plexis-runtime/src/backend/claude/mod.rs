//! Anthropic Claude Code CLI External Agent Subsystem
//!
//! Provides executable discovery, capability probing, stream translation,
//! and process supervision integration for the official Claude Code CLI.

pub mod backend;
pub mod probe;
pub mod stream;

pub use backend::ClaudeCodeBackend;
pub use probe::{ClaudeAuthStatus, ClaudeCapabilities, ClaudeCapabilityProbe};
pub use stream::ClaudeCodeStreamParser;
