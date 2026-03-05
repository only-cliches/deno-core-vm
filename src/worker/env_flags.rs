use std::sync::OnceLock;

pub fn native_stream_plane_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("DENO_DIRECTOR_NATIVE_STREAM_PLANE")
            .ok()
            .map(|v| v == "1")
            .unwrap_or(false)
    })
}

pub fn native_stream_debug_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("DENO_DIRECTOR_NATIVE_STREAM_DEBUG")
            .ok()
            .map(|v| v == "1")
            .unwrap_or(false)
    })
}
