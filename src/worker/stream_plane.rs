use serde::Serialize;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::OnceLock;
use tokio::sync::Notify;

const STREAM_CREDIT_FLUSH_DEFAULT: u32 = 256 * 1024;

fn debug_enabled() -> bool {
  static ENABLED: OnceLock<bool> = OnceLock::new();
  *ENABLED.get_or_init(|| {
    std::env::var("DENO_DIRECTOR_NATIVE_STREAM_DEBUG")
      .ok()
      .map(|v| v == "1")
      .unwrap_or(false)
  })
}

#[derive(Debug)]
enum NativeStreamEvent {
  Chunk(Vec<u8>),
  Close,
  Error(String),
}

struct NativeIncomingStream {
  key: String,
  queue: VecDeque<NativeStreamEvent>,
  native_active: bool,
  waiting_reader: bool,
  #[allow(dead_code)]
  pending_credit: u32,
}

struct NativeIncomingPlaneInner {
  streams: HashMap<u32, NativeIncomingStream>,
  key_to_id: HashMap<String, u32>,
  backlog: HashMap<String, u32>,
  pending_by_id: HashMap<u32, VecDeque<NativeStreamEvent>>,
}

impl NativeIncomingPlaneInner {
  fn new() -> Self {
    Self {
      streams: HashMap::new(),
      key_to_id: HashMap::new(),
      backlog: HashMap::new(),
      pending_by_id: HashMap::new(),
    }
  }
}

pub struct NativeIncomingPlane {
  inner: Mutex<NativeIncomingPlaneInner>,
  cv: Condvar,
  accept_notify: Notify,
  read_notify: Notify,
  #[allow(dead_code)]
  credit_flush_bytes: u32,
}

#[derive(Serialize)]
pub struct NativeReadReply {
  pub kind: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub chunk: Option<serde_json::Value>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub message: Option<String>,
}

pub enum NativeReadEvent {
  Chunk(Vec<u8>),
  Close,
  Error(String),
}

impl NativeIncomingPlane {
  fn lock_inner(&self) -> MutexGuard<'_, NativeIncomingPlaneInner> {
    match self.inner.lock() {
      Ok(g) => g,
      Err(poisoned) => {
        if debug_enabled() {
          eprintln!("[native-stream] warning: poisoned mutex recovered");
        }
        poisoned.into_inner()
      }
    }
  }

  pub fn new(credit_flush_bytes: Option<u32>) -> Self {
    Self {
      inner: Mutex::new(NativeIncomingPlaneInner::new()),
      cv: Condvar::new(),
      accept_notify: Notify::new(),
      read_notify: Notify::new(),
      credit_flush_bytes: credit_flush_bytes.filter(|v| *v > 0).unwrap_or(STREAM_CREDIT_FLUSH_DEFAULT),
    }
  }

  pub fn has_stream(&self, stream_id: u32) -> bool {
    let inner = self.lock_inner();
    let has = inner.streams.contains_key(&stream_id);
    if debug_enabled() && !has {
      let keys = inner.streams.keys().copied().collect::<Vec<_>>();
      eprintln!(
        "[native-stream] has_stream miss id={} plane={:p} keys={:?}",
        stream_id,
        self,
        keys
      );
    }
    has
  }

  pub fn is_native_active(&self, stream_id: u32) -> bool {
    self
      .lock_inner()
      .streams
      .get(&stream_id)
      .map(|stream| stream.native_active)
      .unwrap_or(false)
  }

  pub fn mark_native_active(&self, stream_id: u32) -> bool {
    let mut inner = self.lock_inner();
    let Some(stream) = inner.streams.get_mut(&stream_id) else {
      return false;
    };
    stream.native_active = true;
    true
  }

  pub fn accept_poll(&self, key: &str) -> i32 {
    let mut inner = self.lock_inner();
    if let Some(id) = inner.backlog.remove(key) {
      let mut found = false;
      if let Some(stream) = inner.streams.get_mut(&id) {
        stream.native_active = true;
        found = true;
      }
      if debug_enabled() {
        eprintln!(
          "[native-stream] accept poll key={} id={} found={} streams={}",
          key,
          id,
          found,
          inner.streams.len()
        );
      }
      return i32::try_from(id).unwrap_or(-1);
    }
    0
  }

  pub async fn accept_wait(&self, key: &str) -> i32 {
    loop {
      let polled = self.accept_poll(key);
      if polled != 0 {
        return polled;
      }
      self.accept_notify.notified().await;
    }
  }

  pub fn open(&self, stream_id_text: &str, key: &str) -> bool {
    let stream_id = match stream_id_text.parse::<u32>() {
      Ok(v) if v > 0 => v,
      _ => return false,
    };
    let mut inner = self.lock_inner();
    if inner.streams.contains_key(&stream_id) {
      return true;
    }
    if inner.key_to_id.contains_key(key) || inner.backlog.contains_key(key) {
      return true;
    }
    let mut queue = inner
      .pending_by_id
      .remove(&stream_id)
      .unwrap_or_default();
    inner.streams.insert(
      stream_id,
      NativeIncomingStream {
        key: key.to_string(),
        queue: std::mem::take(&mut queue),
        native_active: false,
        waiting_reader: false,
        pending_credit: 0,
      },
    );
    inner.key_to_id.insert(key.to_string(), stream_id);
    inner.backlog.insert(key.to_string(), stream_id);
    self.accept_notify.notify_waiters();
    self.cv.notify_all();
    if debug_enabled() {
      eprintln!("[native-stream] open id={} key={} plane={:p}", stream_id, key, self);
    }
    true
  }

  pub fn discard(&self, stream_id: u32) -> bool {
    self.discard_with_wake(stream_id).0
  }

  pub fn discard_with_wake(&self, stream_id: u32) -> (bool, bool) {
    let mut inner = self.lock_inner();
    inner.pending_by_id.remove(&stream_id);
    let wake = inner
      .streams
      .get(&stream_id)
      .map(|s| s.waiting_reader)
      .unwrap_or(false);
    let Some(stream) = inner.streams.remove(&stream_id) else {
      if debug_enabled() {
        eprintln!("[native-stream] discard miss id={} plane={:p}", stream_id, self);
      }
      return (false, wake);
    };
    inner.key_to_id.remove(&stream.key);
    inner.backlog.remove(&stream.key);
    if debug_enabled() {
      eprintln!("[native-stream] discard id={} plane={:p}", stream_id, self);
    }
    self.read_notify.notify_waiters();
    self.accept_notify.notify_waiters();
    self.cv.notify_all();
    (true, wake)
  }

  pub fn push_chunk(&self, stream_id: u32, chunk: Vec<u8>) -> bool {
    self.push_chunk_with_wake(stream_id, chunk).0
  }

  pub fn push_chunk_with_wake(&self, stream_id: u32, chunk: Vec<u8>) -> (bool, bool) {
    let mut inner = self.lock_inner();
    let Some(stream) = inner.streams.get_mut(&stream_id) else {
      if debug_enabled() {
        eprintln!("[native-stream] queue pending chunk id={} bytes={}", stream_id, chunk.len());
      }
      inner
        .pending_by_id
        .entry(stream_id)
        .or_default()
        .push_back(NativeStreamEvent::Chunk(chunk));
      self.read_notify.notify_waiters();
      self.cv.notify_all();
      return (true, false);
    };
    let wake = stream.waiting_reader;
    stream.waiting_reader = false;
    if debug_enabled() {
      let preview = chunk.iter().take(8).copied().collect::<Vec<_>>();
      eprintln!("[native-stream] chunk->queue id={} bytes={} head={:?}", stream_id, chunk.len(), preview);
    }
    stream.queue.push_back(NativeStreamEvent::Chunk(chunk));
    self.read_notify.notify_waiters();
    self.cv.notify_all();
    (true, wake)
  }

  pub fn close(&self, stream_id: u32) -> bool {
    self.close_with_wake(stream_id).0
  }

  pub fn error(&self, stream_id: u32, message: String) -> bool {
    self.error_with_wake(stream_id, message).0
  }

  pub fn close_with_wake(&self, stream_id: u32) -> (bool, bool) {
    self.push_terminal_with_wake(stream_id, NativeStreamEvent::Close)
  }

  pub fn error_with_wake(&self, stream_id: u32, message: String) -> (bool, bool) {
    self.push_terminal_with_wake(stream_id, NativeStreamEvent::Error(message))
  }

  fn push_terminal_with_wake(&self, stream_id: u32, terminal: NativeStreamEvent) -> (bool, bool) {
    let mut inner = self.lock_inner();
    let Some(stream) = inner.streams.get_mut(&stream_id) else {
      let pending = inner.pending_by_id.entry(stream_id).or_default();
      pending.clear();
      pending.push_back(terminal);
      self.read_notify.notify_waiters();
      self.cv.notify_all();
      return (true, false);
    };
    let wake = stream.waiting_reader;
    stream.waiting_reader = false;
    stream.queue.clear();
    stream.queue.push_back(terminal);
    self.read_notify.notify_waiters();
    self.cv.notify_all();
    (true, wake)
  }

  pub fn read_poll_event(&self, stream_id: u32) -> Option<NativeReadEvent> {
    let mut inner = self.lock_inner();
    let stream = inner.streams.get_mut(&stream_id)?;
    let Some(event) = stream.queue.pop_front() else {
      stream.waiting_reader = true;
      return None;
    };
    stream.waiting_reader = false;
    match event {
      NativeStreamEvent::Chunk(chunk) => {
        if debug_enabled() {
          let preview = chunk.iter().take(8).copied().collect::<Vec<_>>();
          eprintln!("[native-stream] read-poll chunk id={} bytes={} head={:?}", stream_id, chunk.len(), preview);
        }
        Some(NativeReadEvent::Chunk(chunk))
      }
      NativeStreamEvent::Close => {
        let key = stream.key.clone();
        inner.streams.remove(&stream_id);
        inner.key_to_id.remove(&key);
        inner.backlog.remove(&key);
        Some(NativeReadEvent::Close)
      }
      NativeStreamEvent::Error(message) => {
        let key = stream.key.clone();
        inner.streams.remove(&stream_id);
        inner.key_to_id.remove(&key);
        inner.backlog.remove(&key);
        Some(NativeReadEvent::Error(message))
      }
    }
  }

  pub fn read_poll(&self, stream_id: u32) -> Option<NativeReadReply> {
    match self.read_poll_event(stream_id)? {
      NativeReadEvent::Chunk(chunk) => Some(NativeReadReply {
        kind: "chunk".to_string(),
        chunk: Some(serde_json::Value::Array(
          chunk
            .iter()
            .map(|b| serde_json::Value::from(*b))
            .collect::<Vec<_>>(),
        )),
        message: None,
      }),
      NativeReadEvent::Close => Some(NativeReadReply {
        kind: "close".to_string(),
        chunk: None,
        message: None,
      }),
      NativeReadEvent::Error(message) => Some(NativeReadReply {
        kind: "error".to_string(),
        chunk: None,
        message: Some(message),
      }),
    }
  }

  pub fn read_wait_sync(&self, stream_id: u32) -> NativeReadReply {
    if debug_enabled() {
      eprintln!("[native-stream] read-wait-sync enter id={} plane={:p}", stream_id, self);
    }
    let mut inner = self.lock_inner();
    loop {
      if !inner.streams.contains_key(&stream_id) {
        if debug_enabled() {
          eprintln!("[native-stream] read-wait-sync close(missing) id={}", stream_id);
        }
        return NativeReadReply {
          kind: "close".to_string(),
          chunk: None,
          message: None,
        };
      }
      let stream = match inner.streams.get_mut(&stream_id) {
        Some(v) => v,
        None => continue,
      };
      if let Some(event) = stream.queue.pop_front() {
        return match event {
          NativeStreamEvent::Chunk(chunk) => {
            if debug_enabled() {
              eprintln!("[native-stream] read-wait-sync chunk id={} bytes={}", stream_id, chunk.len());
            }
            NativeReadReply {
              kind: "chunk".to_string(),
              chunk: Some(serde_json::Value::Array(
                chunk
                  .iter()
                  .map(|b| serde_json::Value::from(*b))
                  .collect::<Vec<_>>(),
              )),
              message: None,
            }
          }
          NativeStreamEvent::Close => {
            if debug_enabled() {
              eprintln!("[native-stream] read-wait-sync close id={}", stream_id);
            }
            let key = stream.key.clone();
            inner.streams.remove(&stream_id);
            inner.key_to_id.remove(&key);
            inner.backlog.remove(&key);
            NativeReadReply {
              kind: "close".to_string(),
              chunk: None,
              message: None,
            }
          }
          NativeStreamEvent::Error(message) => {
            if debug_enabled() {
              eprintln!("[native-stream] read-wait-sync error id={}", stream_id);
            }
            let key = stream.key.clone();
            inner.streams.remove(&stream_id);
            inner.key_to_id.remove(&key);
            inner.backlog.remove(&key);
            NativeReadReply {
              kind: "error".to_string(),
              chunk: None,
              message: Some(message),
            }
          }
        };
      }
      match self.cv.wait(inner) {
        Ok(waited) => inner = waited,
        Err(poisoned) => {
          if debug_enabled() {
            eprintln!("[native-stream] warning: poisoned wait mutex recovered");
          }
          inner = poisoned.into_inner();
        }
      }
    }
  }

  pub fn read_blocking(&self, stream_id: u32, timeout_ms: u64) -> Option<NativeReadReply> {
    let start = std::time::Instant::now();
    let deadline = start
      .checked_add(std::time::Duration::from_millis(timeout_ms))
      .unwrap_or_else(std::time::Instant::now);
    if debug_enabled() {
      eprintln!(
        "[native-stream] read-blocking start id={} timeout_ms={} initial_wait_ms={}",
        stream_id,
        timeout_ms,
        deadline.saturating_duration_since(start).as_millis()
      );
    }
    let mut inner = self.lock_inner();
    loop {
      let stream = inner.streams.get_mut(&stream_id)?;
      if let Some(event) = stream.queue.pop_front() {
        return match event {
          NativeStreamEvent::Chunk(chunk) => {
            if debug_enabled() {
              eprintln!("[native-stream] read-blocking chunk id={} bytes={}", stream_id, chunk.len());
            }
            Some(NativeReadReply {
              kind: "chunk".to_string(),
              chunk: Some(serde_json::Value::Array(
                chunk
                  .iter()
                  .map(|b| serde_json::Value::from(*b))
                  .collect::<Vec<_>>(),
              )),
              message: None,
            })
          }
          NativeStreamEvent::Close => {
            let key = stream.key.clone();
            inner.streams.remove(&stream_id);
            inner.key_to_id.remove(&key);
            inner.backlog.remove(&key);
            Some(NativeReadReply {
              kind: "close".to_string(),
              chunk: None,
              message: None,
            })
          }
          NativeStreamEvent::Error(message) => {
            let key = stream.key.clone();
            inner.streams.remove(&stream_id);
            inner.key_to_id.remove(&key);
            inner.backlog.remove(&key);
            Some(NativeReadReply {
              kind: "error".to_string(),
              chunk: None,
              message: Some(message),
            })
          }
        };
      }
      let now = std::time::Instant::now();
      if now >= deadline {
        return None;
      }
      let wait_for = deadline.saturating_duration_since(now);
      match self.cv.wait_timeout(inner, wait_for) {
        Ok(waited) => {
          inner = waited.0;
          if waited.1.timed_out() {
            return None;
          }
        }
        Err(poisoned) => {
          if debug_enabled() {
            eprintln!("[native-stream] warning: poisoned wait mutex recovered");
          }
          inner = poisoned.into_inner().0;
        }
      }
    }
  }

  pub async fn read_wait(&self, stream_id: u32) -> NativeReadReply {
    match self.read_wait_event(stream_id).await {
      NativeReadEvent::Chunk(chunk) => NativeReadReply {
        kind: "chunk".to_string(),
        chunk: Some(serde_json::Value::Array(
          chunk
            .iter()
            .map(|b| serde_json::Value::from(*b))
            .collect::<Vec<_>>(),
        )),
        message: None,
      },
      NativeReadEvent::Close => NativeReadReply {
        kind: "close".to_string(),
        chunk: None,
        message: None,
      },
      NativeReadEvent::Error(message) => NativeReadReply {
        kind: "error".to_string(),
        chunk: None,
        message: Some(message),
      },
    }
  }

  pub async fn read_wait_event(&self, stream_id: u32) -> NativeReadEvent {
    loop {
      if let Some(out) = self.read_poll_event(stream_id) {
        return out;
      }
      if !self.has_stream(stream_id) {
        return NativeReadEvent::Close;
      }
      self.read_notify.notified().await;
    }
  }
}
