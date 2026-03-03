use lazy_static::lazy_static;
use neon::prelude::*;
use std::collections::HashMap;
use std::sync::RwLock;
use std::sync::atomic::AtomicUsize;
use tokio::sync::mpsc::error::TrySendError;

mod bridge;
mod native_api;
mod worker;

use crate::bridge::promise::PromiseSettler;
use crate::bridge::types::{EvalOptions, JsValueBridge};
use crate::worker::messages::DenoMsg;
use crate::worker::state::WorkerHandle;

lazy_static! {
    pub static ref WORKERS: RwLock<HashMap<usize, WorkerHandle>> = RwLock::new(HashMap::new());
    pub(crate) static ref NEXT_ID: AtomicUsize = AtomicUsize::new(1);
}

pub(crate) fn parse_eval_options<'a>(cx: &mut FunctionContext<'a>, idx: i32) -> EvalOptions {
    EvalOptions::from_neon(cx, idx).unwrap_or_default()
}

pub(crate) fn mk_err(message: impl Into<String>) -> JsValueBridge {
    crate::bridge::errors::error("Error", message)
}

pub(crate) fn try_send_deno_msg_or_reject(tx: &tokio::sync::mpsc::Sender<DenoMsg>, msg: DenoMsg) {
    match tx.try_send(msg) {
        Ok(()) => {}
        Err(TrySendError::Full(msg)) | Err(TrySendError::Closed(msg)) => match msg {
            DenoMsg::Eval {
                deferred: Some(deferred),
                ..
            } => {
                deferred.reject_with_error("Runtime is closed or request queue is full");
            }

            DenoMsg::Close { deferred }
            | DenoMsg::Memory { deferred }
            | DenoMsg::SetGlobal { deferred, .. } => {
                deferred.reject_with_error("Runtime is closed or request queue is full");
            }

            DenoMsg::Eval { deferred: None, .. } | DenoMsg::PostMessage { .. } => {}
        },
    }
}

pub(crate) fn deno_tx_for_worker(worker_id: usize) -> Option<tokio::sync::mpsc::Sender<DenoMsg>> {
    WORKERS
        .read()
        .ok()
        .and_then(|map| map.get(&worker_id).map(|w| w.deno_tx.clone()))
}

pub(crate) fn queue_deno_msg_or_reject<F>(worker_id: usize, settler: PromiseSettler, mk_msg: F)
where
    F: FnOnce(PromiseSettler) -> DenoMsg,
{
    if let Some(tx) = deno_tx_for_worker(worker_id) {
        try_send_deno_msg_or_reject(&tx, mk_msg(settler));
    } else {
        settler.reject_with_value_via_channel(mk_err("Runtime is closed or request queue is full"));
    }
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("DenoWorker", native_api::create_worker)?;
    Ok(())
}
