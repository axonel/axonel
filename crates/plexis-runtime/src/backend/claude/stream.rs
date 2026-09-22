//! Claude Code CLI Stream Translation Protocol
//!
//! Parses and translates structured line-delimited stream-json events from
//! Claude Code (`--print --output-format stream-json --verbose`) into Plexis
//! `ExecutionEvent` structures.

use plexis_core::ids::ExecutionId;
use plexis_core::protocol::ExecutionEvent;
use serde_json::Value;

use crate::agent_host::OutputParser;

/// Translates Claude Code streaming outputs into Plexis protocol events.
#[derive(Debug, Default, Clone)]
pub struct ClaudeCodeStreamParser;

impl ClaudeCodeStreamParser {
    pub fn new() -> Self {
        Self
    }
}

impl OutputParser for ClaudeCodeStreamParser {
    fn parse_line(&self, execution_id: ExecutionId, line: &str) -> Option<ExecutionEvent> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return None;
        }

        // 1. Attempt to parse line as a stream-json object
        if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
            if let Some(obj) = val.as_object() {
                match obj.get("type").and_then(|v| v.as_str()) {
                    // Session initialization: {"type":"system","subtype":"init",...}
                    Some("system") => {
                        let session_id = obj
                            .get("session_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        let model = obj
                            .get("model")
                            .and_then(|v| v.as_str())
                            .unwrap_or("claude");
                        let tools = obj.get("tools").and_then(|v| v.as_array());
                        let tool_count = tools.map(|t| t.len()).unwrap_or(0);
                        return Some(ExecutionEvent::stdout(
                            execution_id,
                            format!(
                                "Claude Code session initialized: {} (model: {}, {} tools)",
                                session_id, model, tool_count
                            ),
                        ));
                    }
                    // Assistant turn: text and tool_use content blocks
                    Some("assistant") => {
                        if let Some(event) =
                            Self::parse_assistant_message(execution_id, obj.get("message"))
                        {
                            return Some(event);
                        }
                    }
                    // Tool results echoed back as a user turn
                    Some("user") => {
                        if let Some(text) = Self::extract_tool_result_text(obj.get("message")) {
                            return Some(ExecutionEvent::stdout(execution_id, text));
                        }
                    }
                    // Terminal result: {"type":"result","subtype":"success",...}
                    Some("result") => {
                        let subtype = obj
                            .get("subtype")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        let result_text = obj
                            .get("result")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        let is_error = obj
                            .get("is_error")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);

                        if is_error {
                            return Some(ExecutionEvent::warning(
                                execution_id,
                                format!("Claude Code result ({subtype}): {result_text}"),
                            ));
                        }
                        if result_text.is_empty() {
                            return Some(ExecutionEvent::stdout(
                                execution_id,
                                format!("Claude Code result ({subtype})."),
                            ));
                        }
                        return Some(ExecutionEvent::stdout(
                            execution_id,
                            format!("Claude Code result ({subtype}): {result_text}"),
                        ));
                    }
                    _ => {}
                }

                // Error payloads without a recognized type
                if let Some(err) = obj.get("error") {
                    let msg = err
                        .get("message")
                        .and_then(|m| m.as_str())
                        .or_else(|| err.as_str())
                        .unwrap_or("Unknown Claude Code error");
                    return Some(ExecutionEvent::warning(
                        execution_id,
                        format!("Claude Code diagnostic: {}", msg),
                    ));
                }
            }
        }

        // 2. Fallback heuristics for non-JSON lines (e.g. CLI notices)
        if trimmed.starts_with("Warning:") {
            return Some(ExecutionEvent::warning(execution_id, trimmed));
        }

        // Default to standard stdout event
        Some(ExecutionEvent::stdout(execution_id, trimmed))
    }
}

impl ClaudeCodeStreamParser {
    /// Maps an assistant message's content blocks onto protocol events.
    /// Tool invocations take precedence over text so operational actions are
    /// never dropped when a single line carries both.
    fn parse_assistant_message(
        execution_id: ExecutionId,
        message: Option<&Value>,
    ) -> Option<ExecutionEvent> {
        let content = message?.get("content")?.as_array()?;

        for block in content {
            let block_type = block.get("type").and_then(|v| v.as_str());
            if block_type == Some("tool_use") {
                let tool = block.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                let details = block.get("input").cloned().unwrap_or_else(
                    || serde_json::json!({ "note": "tool invocation without input payload" }),
                );
                let action = Self::infer_tool_action(tool);
                return Some(ExecutionEvent::tool_action(
                    execution_id,
                    tool,
                    action,
                    details,
                ));
            }
        }

        for block in content {
            if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                    return Some(ExecutionEvent::stdout(execution_id, text));
                }
            }
        }

        None
    }

    /// Flattens a tool_result content block (string or array form) to text.
    fn extract_tool_result_text(message: Option<&Value>) -> Option<String> {
        let content = message?.get("content")?;

        if let Some(text) = content.as_str() {
            return Some(text.to_string());
        }

        if let Some(blocks) = content.as_array() {
            let mut parts = Vec::new();
            for block in blocks {
                match block.get("type").and_then(|v| v.as_str()) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                            parts.push(text.to_string());
                        }
                    }
                    _ => {
                        // Non-text tool results are kept as compact JSON for visibility
                        parts.push(block.to_string());
                    }
                }
            }
            if !parts.is_empty() {
                return Some(parts.join("\n"));
            }
        }

        None
    }

    /// Infers a coarse action label for a tool invocation.
    fn infer_tool_action(tool: &str) -> &'static str {
        match tool {
            "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => "edit",
            "Read" | "Glob" | "Grep" | "LS" => "inspect",
            "Bash" | "BashOutput" | "KillShell" => "execute",
            "Task" | "WebFetch" | "WebSearch" => "delegate",
            _ => "execute",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use plexis_core::protocol::ExecutionEventType;

    #[test]
    fn test_parse_system_init() {
        let parser = ClaudeCodeStreamParser::new();
        let exec_id = ExecutionId::new();
        let json = r#"{"type":"system","subtype":"init","session_id":"abc-123","model":"claude-sonnet-4-5","cwd":"/repo","tools":["Bash","Read","Edit"]}"#;

        let ev = parser.parse_line(exec_id, json).expect("parsed event");
        assert_eq!(ev.execution_id, exec_id);
        match ev.event {
            ExecutionEventType::Stdout { text } => {
                assert!(text.contains("abc-123"));
                assert!(text.contains("claude-sonnet-4-5"));
                assert!(text.contains("3 tools"));
            }
            _ => panic!("Expected Stdout, got {:?}", ev.event),
        }
    }

    #[test]
    fn test_parse_assistant_tool_use() {
        let parser = ClaudeCodeStreamParser::new();
        let exec_id = ExecutionId::new();
        let json = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"cargo test"}}]}}"#;

        let ev = parser.parse_line(exec_id, json).expect("parsed event");
        match ev.event {
            ExecutionEventType::ToolAction {
                tool,
                action,
                details,
            } => {
                assert_eq!(tool, "Bash");
                assert_eq!(action, "execute");
                assert_eq!(details["command"], "cargo test");
            }
            _ => panic!("Expected ToolAction, got {:?}", ev.event),
        }
    }

    #[test]
    fn test_parse_assistant_text_block() {
        let parser = ClaudeCodeStreamParser::new();
        let exec_id = ExecutionId::new();
        let json = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Refactoring the parser module now."}]}}"#;

        let ev = parser.parse_line(exec_id, json).expect("parsed event");
        match ev.event {
            ExecutionEventType::Stdout { text } => {
                assert!(text.contains("Refactoring the parser module"));
            }
            _ => panic!("Expected Stdout, got {:?}", ev.event),
        }
    }

    #[test]
    fn test_parse_assistant_tool_use_preferred_over_text() {
        let parser = ClaudeCodeStreamParser::new();
        let exec_id = ExecutionId::new();
        let json = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"editing"},{"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"src/lib.rs"}}]}}"#;

        let ev = parser.parse_line(exec_id, json).expect("parsed event");
        match ev.event {
            ExecutionEventType::ToolAction { tool, action, .. } => {
                assert_eq!(tool, "Edit");
                assert_eq!(action, "edit");
            }
            _ => panic!("Expected ToolAction, got {:?}", ev.event),
        }
    }

    #[test]
    fn test_parse_user_tool_result_string_content() {
        let parser = ClaudeCodeStreamParser::new();
        let exec_id = ExecutionId::new();
        let json = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"test result: ok. 12 passed"}]}}"#;

        let ev = parser.parse_line(exec_id, json).expect("parsed event");
        match ev.event {
            ExecutionEventType::Stdout { text } => {
                assert!(text.contains("12 passed"));
            }
            _ => panic!("Expected Stdout, got {:?}", ev.event),
        }
    }

    #[test]
    fn test_parse_result_success() {
        let parser = ClaudeCodeStreamParser::new();
        let exec_id = ExecutionId::new();
        let json = r#"{"type":"result","subtype":"success","is_error":false,"result":"Fixed the failing tests.","num_turns":4,"total_cost_usd":0.12}"#;

        let ev = parser.parse_line(exec_id, json).expect("parsed event");
        match ev.event {
            ExecutionEventType::Stdout { text } => {
                assert!(text.contains("success"));
                assert!(text.contains("Fixed the failing tests."));
            }
            _ => panic!("Expected Stdout, got {:?}", ev.event),
        }
    }

    #[test]
    fn test_parse_result_error_is_warning() {
        let parser = ClaudeCodeStreamParser::new();
        let exec_id = ExecutionId::new();
        let json = r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":"Stopped after 10 turns."}"#;

        let ev = parser.parse_line(exec_id, json).expect("parsed event");
        match ev.event {
            ExecutionEventType::Warning { message } => {
                assert!(message.contains("error_max_turns"));
            }
            _ => panic!("Expected Warning, got {:?}", ev.event),
        }
    }

    #[test]
    fn test_parse_plain_text_fallback() {
        let parser = ClaudeCodeStreamParser::new();
        let exec_id = ExecutionId::new();
        let text = "Running cargo test...";

        let ev = parser.parse_line(exec_id, text).expect("parsed event");
        match ev.event {
            ExecutionEventType::Stdout { text: t } => {
                assert_eq!(t, "Running cargo test...");
            }
            _ => panic!("Expected Stdout, got {:?}", ev.event),
        }
    }

    #[test]
    fn test_parse_empty_line_returns_none() {
        let parser = ClaudeCodeStreamParser::new();
        let exec_id = ExecutionId::new();
        assert!(parser.parse_line(exec_id, "").is_none());
        assert!(parser.parse_line(exec_id, "   ").is_none());
    }
}
