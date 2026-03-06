use std::collections::HashMap;
use std::sync::Mutex;

use crate::worker::state::EnvConfig;

#[derive(Debug, Clone)]
pub enum EnvAccess {
    Deny,
    AllowAll,
    AllowKeys(std::collections::HashSet<String>),
}

impl EnvAccess {
    /// Checks whether allows and returns the boolean result for runtime environment variable access control.
    pub fn allows(&self, key: &str) -> bool {
        match self {
            Self::Deny => false,
            Self::AllowAll => true,
            Self::AllowKeys(keys) => keys.contains(key),
        }
    }
}

#[derive(Debug)]
pub struct EnvRuntimeState {
    pub vars: Mutex<HashMap<String, String>>,
    pub access: EnvAccess,
}

/// Valid env key.
pub fn valid_env_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 4096 && !k.contains('\0')
}

/// Env access from permissions.
pub fn env_access_from_permissions(permissions: Option<&serde_json::Value>) -> EnvAccess {
    let Some(cfg) = permissions else {
        return EnvAccess::Deny;
    };

    if *cfg == serde_json::Value::Bool(true) {
        return EnvAccess::AllowAll;
    }
    if *cfg == serde_json::Value::Bool(false) {
        return EnvAccess::Deny;
    }

    let Some(v) = cfg.get("env") else {
        return EnvAccess::Deny;
    };

    if *v == serde_json::Value::Bool(true) {
        return EnvAccess::AllowAll;
    }

    if let Some(arr) = v.as_array() {
        let mut keys = std::collections::HashSet::new();
        for it in arr.iter() {
            if let Some(s) = it.as_str() {
                keys.insert(s.to_string());
            }
        }
        return EnvAccess::AllowKeys(keys);
    }

    EnvAccess::Deny
}

/// Merges env snapshot while preserving invariants required by runtime environment variable access control.
pub fn merge_env_snapshot(
    mut snapshot: HashMap<String, String>,
    cfg: Option<&EnvConfig>,
) -> HashMap<String, String> {
    if let Some(EnvConfig::Map(map)) = cfg {
        for (k, v) in map.iter() {
            if !valid_env_key(k) {
                continue;
            }
            snapshot.insert(k.clone(), v.clone());
        }
    }
    snapshot
}

#[cfg(test)]
mod tests {
    use super::{EnvAccess, env_access_from_permissions, valid_env_key};

    #[test]
    // Valid env key enforces empty nul and length limits.
    fn valid_env_key_enforces_empty_nul_and_length_limits() {
        assert!(!valid_env_key(""));
        assert!(!valid_env_key("BAD\0KEY"));
        assert!(valid_env_key(&"A".repeat(4096)));
        assert!(!valid_env_key(&"A".repeat(4097)));
    }

    #[test]
    // Env access allows helper matches mode.
    fn env_access_allows_helper_matches_mode() {
        assert!(!EnvAccess::Deny.allows("A"));
        assert!(EnvAccess::AllowAll.allows("A"));

        let allow_list = env_access_from_permissions(Some(&serde_json::json!({
            "env": ["A", "B"]
        })));
        assert!(allow_list.allows("A"));
        assert!(!allow_list.allows("C"));
    }

    #[test]
    // Env access invalid or false config denies.
    fn env_access_invalid_or_false_config_denies() {
        let false_cfg = env_access_from_permissions(Some(&serde_json::json!({ "env": false })));
        assert!(matches!(false_cfg, EnvAccess::Deny));
        let false_shorthand = env_access_from_permissions(Some(&serde_json::Value::Bool(false)));
        assert!(matches!(false_shorthand, EnvAccess::Deny));

        let true_shorthand = env_access_from_permissions(Some(&serde_json::Value::Bool(true)));
        assert!(matches!(true_shorthand, EnvAccess::AllowAll));

        let invalid_cfg = env_access_from_permissions(Some(&serde_json::json!({ "env": 123 })));
        assert!(matches!(invalid_cfg, EnvAccess::Deny));
    }

    #[test]
    // Env access array ignores non strings and deduplicates.
    fn env_access_array_ignores_non_strings_and_deduplicates() {
        let cfg = env_access_from_permissions(Some(&serde_json::json!({
            "env": ["A", "A", 1, null, true, "B"]
        })));
        match cfg {
            EnvAccess::AllowKeys(keys) => {
                assert_eq!(keys.len(), 2);
                assert!(keys.contains("A"));
                assert!(keys.contains("B"));
            }
            other => panic!("expected allow keys, got {:?}", other),
        }
    }
}
