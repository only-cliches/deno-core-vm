use lazy_static::lazy_static;
use neon::prelude::*;
use std::collections::HashMap;
use std::sync::RwLock;
use std::sync::atomic::AtomicUsize;

mod bridge;
mod native_api;
mod worker;

use crate::bridge::promise::PromiseSettler;
use crate::bridge::types::{EvalOptions, JsValueBridge};
use crate::worker::messages::DenoMsg;
use crate::worker::state::WorkerHandle;
use crate::worker::stream_plane::NativeIncomingPlane;

lazy_static! {
    pub static ref WORKERS: RwLock<HashMap<usize, WorkerHandle>> = RwLock::new(HashMap::new());
    pub(crate) static ref NEXT_ID: AtomicUsize = AtomicUsize::new(1);
}

/// Parses eval options from input data and validates it for runtime bridge internals.
pub(crate) fn parse_eval_options<'a>(cx: &mut FunctionContext<'a>, idx: i32) -> EvalOptions {
    EvalOptions::from_neon(cx, idx).unwrap_or_default()
}

/// Mk err.
pub(crate) fn mk_err(message: impl Into<String>) -> JsValueBridge {
    crate::bridge::errors::error("Error", message)
}

/// Queue deno msg or reject with backpressure.
pub(crate) fn queue_deno_msg_or_reject_with_backpressure(
    tx: tokio::sync::mpsc::Sender<DenoMsg>,
    msg: DenoMsg,
) {
    if let Err(err) = tx.blocking_send(msg) {
        match err.0 {
            DenoMsg::Eval {
                deferred: Some(deferred),
                ..
            } => deferred.reject_with_error("Runtime is closed"),
            DenoMsg::Close { deferred }
            | DenoMsg::Memory { deferred }
            | DenoMsg::SetGlobal { deferred, .. }
            | DenoMsg::RegisterModule { deferred, .. }
            | DenoMsg::ClearModule { deferred, .. } => deferred.reject_with_error("Runtime is closed"),
            DenoMsg::Eval { deferred: None, .. }
            | DenoMsg::PostMessage { .. }
            | DenoMsg::PostMessageTyped { .. }
            | DenoMsg::PostStreamChunk { .. }
            | DenoMsg::PostStreamChunkRaw { .. }
            | DenoMsg::PostStreamChunkRawBin { .. }
            | DenoMsg::PostStreamChunks { .. }
            | DenoMsg::PostStreamChunksRaw { .. }
            | DenoMsg::PostStreamControl { .. } => {}
        }
    }
}

/// Deno control tx for worker.
pub(crate) fn deno_control_tx_for_worker(
    worker_id: usize,
) -> Option<tokio::sync::mpsc::Sender<DenoMsg>> {
    WORKERS
        .read()
        .ok()
        .and_then(|map| map.get(&worker_id).map(|w| w.deno_tx.clone()))
}

/// Deno data tx for worker.
pub(crate) fn deno_data_tx_for_worker(worker_id: usize) -> Option<tokio::sync::mpsc::Sender<DenoMsg>> {
    WORKERS
        .read()
        .ok()
        .and_then(|map| map.get(&worker_id).map(|w| w.deno_data_tx.clone()))
}

/// Native stream plane for worker.
pub(crate) fn native_stream_plane_for_worker(worker_id: usize) -> Option<std::sync::Arc<NativeIncomingPlane>> {
    let map = WORKERS.read().ok()?;
    let handle = map.get(&worker_id)?;
    let guard = handle.native_stream_plane.lock().ok()?;
    guard.clone()
}

/// Queue deno msg or reject.
pub(crate) fn queue_deno_msg_or_reject<F>(worker_id: usize, settler: PromiseSettler, mk_msg: F)
where
    F: FnOnce(PromiseSettler) -> DenoMsg,
{
    let msg = mk_msg(settler);
    let tx = if msg.is_data_plane() {
        deno_data_tx_for_worker(worker_id)
    } else {
        deno_control_tx_for_worker(worker_id)
    };
    if let Some(tx) = tx {
        queue_deno_msg_or_reject_with_backpressure(tx, msg);
    } else {
        match msg {
            DenoMsg::Eval {
                deferred: Some(deferred),
                ..
            } => deferred.reject_with_value_via_channel(mk_err("Runtime is closed")),
            DenoMsg::Close { deferred }
            | DenoMsg::Memory { deferred }
            | DenoMsg::SetGlobal { deferred, .. }
            | DenoMsg::RegisterModule { deferred, .. }
            | DenoMsg::ClearModule { deferred, .. } => {
                deferred.reject_with_value_via_channel(mk_err("Runtime is closed"))
            }
            DenoMsg::Eval { deferred: None, .. }
            | DenoMsg::PostMessage { .. }
            | DenoMsg::PostMessageTyped { .. }
            | DenoMsg::PostStreamChunk { .. }
            | DenoMsg::PostStreamChunkRaw { .. }
            | DenoMsg::PostStreamChunkRawBin { .. }
            | DenoMsg::PostStreamChunks { .. }
            | DenoMsg::PostStreamChunksRaw { .. }
            | DenoMsg::PostStreamControl { .. } => {}
        }
    }
}

#[neon::main]
// Main.
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("DenoWorker", native_api::create_worker)?;
    Ok(())
}
