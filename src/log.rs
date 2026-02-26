use std::io::{self, Write};

#[inline]
pub fn log_line(args: std::fmt::Arguments<'_>) {
    // Best-effort: never panic if stdout is unavailable.
    // Ignore broken pipe / EAGAIN / any IO errors.
    let mut out = io::stdout().lock();
    let _ = out.write_fmt(args);
    let _ = out.write_all(b"\n");
}

#[macro_export]
macro_rules! dw_log {
    ($($t:tt)*) => {{
       // $crate::log::log_line(format_args!($($t)*));
    }};
}