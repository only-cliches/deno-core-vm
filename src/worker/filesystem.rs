use cpu_time::ProcessTime;
use deno_core::error::CoreError;
use deno_core::{FastString, extension};
use deno_error::JsErrorBox;
use deno_runtime::BootstrapOptions;
use deno_runtime::deno_core::{self, ModuleLoader, ModuleSource, ModuleType, resolve_url, v8};
use deno_runtime::permissions::RuntimePermissionDescriptorParser;
use deno_runtime::worker::{MainWorker, WorkerOptions, WorkerServiceOptions};

use deno_permissions::PermissionDescriptorParser;

use deno_fs::{FileSystem, FsFileType, OpenOptions, RealFs};
use deno_io::fs::FsResult;
use deno_permissions::{CheckedPath, CheckedPathBuf};
use deno_resolver::npm::{DenoInNpmPackageChecker, NpmResolver};
use sys_traits::impls::RealSys;

use crate::bridge::types::{EvalOptions, JsValueBridge};
use crate::bridge::v8_codec;
use crate::worker::dispatch::{dispatch_node_msg, handle_deno_msg};
use crate::worker::messages::{DenoMsg, EvalReply, ExecStats, NodeMsg};
use crate::worker::state::RuntimeLimits;

use deno_permissions::{Permissions, PermissionsContainer, PermissionsOptions};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

use tokio::sync::mpsc;

use deno_core::url::Url;

#[derive(Debug, Clone)]
pub struct SandboxFs {
    inner: RealFs,
    cwd: Arc<PathBuf>,
}

impl SandboxFs {
   pub fn new(cwd: PathBuf) -> Self {
        Self {
            inner: RealFs::default(),
            cwd: Arc::new(cwd),
        }
    }
}

impl FileSystem for SandboxFs {
    fn cwd(&self) -> FsResult<PathBuf> {
        Ok((*self.cwd).clone())
    }

    fn tmp_dir(&self) -> FsResult<PathBuf> {
        self.inner.tmp_dir()
    }

    fn chdir(&self, _path: &CheckedPath<'_>) -> FsResult<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Deno.chdir is disabled",
        )
        .into())
    }

    fn umask(&self, mask: Option<u32>) -> FsResult<u32> {
        self.inner.umask(mask)
    }

    fn open_sync(
        &self,
        path: &CheckedPath<'_>,
        options: OpenOptions,
    ) -> FsResult<std::rc::Rc<dyn deno_io::fs::File>> {
        self.inner.open_sync(path, options)
    }

    fn open_async<'a, 'async_trait>(
        &'a self,
        path: CheckedPathBuf,
        options: OpenOptions,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = FsResult<std::rc::Rc<dyn deno_io::fs::File>>>
                + 'async_trait,
        >,
    >
    where
        Self: 'async_trait,
        'a: 'async_trait,
    {
        self.inner.open_async(path, options)
    }

    fn mkdir_sync(
        &self,
        path: &CheckedPath<'_>,
        recursive: bool,
        mode: Option<u32>,
    ) -> FsResult<()> {
        self.inner.mkdir_sync(path, recursive, mode)
    }

    fn mkdir_async<'life0, 'async_trait>(
        &'life0 self,
        path: CheckedPathBuf,
        recursive: bool,
        mode: Option<u32>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<()>> + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.mkdir_async(path, recursive, mode)
    }

    fn chmod_sync(&self, path: &CheckedPath<'_>, mode: u32) -> FsResult<()> {
        self.inner.chmod_sync(path, mode)
    }

    fn chmod_async<'life0, 'async_trait>(
        &'life0 self,
        path: CheckedPathBuf,
        mode: u32,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<()>> + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.chmod_async(path, mode)
    }

    fn chown_sync(
        &self,
        path: &CheckedPath<'_>,
        uid: Option<u32>,
        gid: Option<u32>,
    ) -> FsResult<()> {
        self.inner.chown_sync(path, uid, gid)
    }

    fn chown_async<'life0, 'async_trait>(
        &'life0 self,
        path: CheckedPathBuf,
        uid: Option<u32>,
        gid: Option<u32>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<()>> + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.chown_async(path, uid, gid)
    }

    fn lchmod_sync(&self, path: &CheckedPath<'_>, mode: u32) -> FsResult<()> {
        self.inner.lchmod_sync(path, mode)
    }

    fn lchmod_async<'life0, 'async_trait>(
        &'life0 self,
        path: CheckedPathBuf,
        mode: u32,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<()>> + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.lchmod_async(path, mode)
    }

    fn lchown_sync(
        &self,
        path: &CheckedPath<'_>,
        uid: Option<u32>,
        gid: Option<u32>,
    ) -> FsResult<()> {
        self.inner.lchown_sync(path, uid, gid)
    }

    fn lchown_async<'life0, 'async_trait>(
        &'life0 self,
        path: CheckedPathBuf,
        uid: Option<u32>,
        gid: Option<u32>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<()>> + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.lchown_async(path, uid, gid)
    }

    fn remove_sync(&self, path: &CheckedPath<'_>, recursive: bool) -> FsResult<()> {
        self.inner.remove_sync(path, recursive)
    }

    fn remove_async<'life0, 'async_trait>(
        &'life0 self,
        path: CheckedPathBuf,
        recursive: bool,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<()>> + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.remove_async(path, recursive)
    }

    fn copy_file_sync(&self, oldpath: &CheckedPath<'_>, newpath: &CheckedPath<'_>) -> FsResult<()> {
        self.inner.copy_file_sync(oldpath, newpath)
    }

    fn copy_file_async<'life0, 'async_trait>(
        &'life0 self,
        oldpath: CheckedPathBuf,
        newpath: CheckedPathBuf,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<()>> + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.copy_file_async(oldpath, newpath)
    }

    fn cp_sync(&self, path: &CheckedPath<'_>, new_path: &CheckedPath<'_>) -> FsResult<()> {
        self.inner.cp_sync(path, new_path)
    }

    fn cp_async<'life0, 'async_trait>(
        &'life0 self,
        path: CheckedPathBuf,
        new_path: CheckedPathBuf,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<()>> + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.cp_async(path, new_path)
    }

    fn stat_sync(&self, path: &CheckedPath<'_>) -> FsResult<deno_io::fs::FsStat> {
        self.inner.stat_sync(path)
    }

    fn stat_async<'life0, 'async_trait>(
        &'life0 self,
        path: CheckedPathBuf,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = FsResult<deno_io::fs::FsStat>> + 'async_trait>,
    >
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.stat_async(path)
    }

    fn lstat_sync(&self, path: &CheckedPath<'_>) -> FsResult<deno_io::fs::FsStat> {
        self.inner.lstat_sync(path)
    }

    fn lstat_async<'life0, 'async_trait>(
        &'life0 self,
        path: CheckedPathBuf,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = FsResult<deno_io::fs::FsStat>> + 'async_trait>,
    >
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.lstat_async(path)
    }

    fn exists_sync(&self, path: &CheckedPath<'_>) -> bool {
        self.inner.exists_sync(path)
    }

    fn exists_async<'life0, 'async_trait>(
        &'life0 self,
        path: CheckedPathBuf,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<bool>> + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.exists_async(path)
    }

    fn read_dir_sync(&self, path: &CheckedPath<'_>) -> FsResult<Vec<deno_fs::FsDirEntry>> {
        self.inner.read_dir_sync(path)
    }

    fn read_dir_async<'life0, 'async_trait>(
        &'life0 self,
        path: CheckedPathBuf,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = FsResult<Vec<deno_fs::FsDirEntry>>> + 'async_trait>,
    >
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.read_dir_async(path)
    }

    fn rename_sync(&self, oldpath: &CheckedPath<'_>, newpath: &CheckedPath<'_>) -> FsResult<()> {
        self.inner.rename_sync(oldpath, newpath)
    }

    fn rename_async<'life0, 'async_trait>(
        &'life0 self,
        oldpath: CheckedPathBuf,
        newpath: CheckedPathBuf,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<()>> + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.rename_async(oldpath, newpath)
    }

    fn rmdir_sync(&self, path: &CheckedPath<'_>) -> FsResult<()> {
        self.inner.rmdir_sync(path)
    }

    fn rmdir_async<'life0, 'async_trait>(
        &'life0 self,
        path: CheckedPathBuf,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<()>> + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.rmdir_async(path)
    }

    fn truncate_sync(&self, path: &CheckedPath<'_>, len: u64) -> FsResult<()> {
        self.inner.truncate_sync(path, len)
    }

    fn truncate_async<'life0, 'async_trait>(
        &'life0 self,
        path: CheckedPathBuf,
        len: u64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<()>> + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.truncate_async(path, len)
    }

    fn utime_sync(
        &self,
        path: &CheckedPath,
        atime_secs: i64,
        atime_nanos: u32,
        mtime_secs: i64,
        mtime_nanos: u32,
    ) -> FsResult<()> {
        self.inner
            .utime_sync(path, atime_secs, atime_nanos, mtime_secs, mtime_nanos)
    }

    fn utime_async<'life0, 'async_trait>(
        &'life0 self,
        path: CheckedPathBuf,
        atime_secs: i64,
        atime_nanos: u32,
        mtime_secs: i64,
        mtime_nanos: u32,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<()>> + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner
            .utime_async(path, atime_secs, atime_nanos, mtime_secs, mtime_nanos)
    }

    fn lutime_sync(
        &self,
        path: &CheckedPath,
        atime_secs: i64,
        atime_nanos: u32,
        mtime_secs: i64,
        mtime_nanos: u32,
    ) -> FsResult<()> {
        self.inner
            .lutime_sync(path, atime_secs, atime_nanos, mtime_secs, mtime_nanos)
    }

    fn lutime_async<'life0, 'async_trait>(
        &'life0 self,
        path: CheckedPathBuf,
        atime_secs: i64,
        atime_nanos: u32,
        mtime_secs: i64,
        mtime_nanos: u32,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<()>> + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner
            .lutime_async(path, atime_secs, atime_nanos, mtime_secs, mtime_nanos)
    }

    fn read_link_sync(&self, path: &CheckedPath<'_>) -> FsResult<PathBuf> {
        self.inner.read_link_sync(path)
    }

    fn read_link_async<'life0, 'async_trait>(
        &'life0 self,
        path: CheckedPathBuf,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<PathBuf>> + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.read_link_async(path)
    }

    fn realpath_sync(&self, path: &CheckedPath<'_>) -> FsResult<PathBuf> {
        self.inner.realpath_sync(path)
    }

    fn realpath_async<'life0, 'async_trait>(
        &'life0 self,
        path: CheckedPathBuf,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<PathBuf>> + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.realpath_async(path)
    }

    fn link_sync(&self, oldpath: &CheckedPath<'_>, newpath: &CheckedPath<'_>) -> FsResult<()> {
        self.inner.link_sync(oldpath, newpath)
    }

    fn link_async<'life0, 'async_trait>(
        &'life0 self,
        oldpath: CheckedPathBuf,
        newpath: CheckedPathBuf,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<()>> + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.link_async(oldpath, newpath)
    }

    fn symlink_sync(
        &self,
        oldpath: &CheckedPath,
        newpath: &CheckedPath,
        file_type: Option<FsFileType>,
    ) -> FsResult<()> {
        self.inner.symlink_sync(oldpath, newpath, file_type)
    }

    fn symlink_async<'life0, 'async_trait>(
        &'life0 self,
        oldpath: CheckedPathBuf,
        newpath: CheckedPathBuf,
        file_type: Option<FsFileType>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<()>> + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.symlink_async(oldpath, newpath, file_type)
    }

    fn write_file_sync(
        &self,
        path: &CheckedPath,
        options: OpenOptions,
        data: &[u8],
    ) -> FsResult<()> {
        self.inner.write_file_sync(path, options, data)
    }

    fn write_file_async<'life0, 'async_trait>(
        &'life0 self,
        path: CheckedPathBuf,
        options: OpenOptions,
        data: Box<[u8]>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FsResult<()>> + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
    {
        self.inner.write_file_async(path, options, data)
    }
}

pub fn normalize_cwd(raw: Option<&str>) -> PathBuf {
    let fallback = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    let Some(raw) = raw.map(|s| s.trim()).filter(|s| !s.is_empty()) else {
        return fallback;
    };

    if raw.starts_with("file://") {
        if let Ok(u) = Url::parse(raw) {
            if let Ok(p) = u.to_file_path() {
                return p;
            }
        }
        return fallback;
    }

    let p = Path::new(raw);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        fallback.join(p)
    }
}

pub fn dir_url_from_path(p: &Path) -> Url {
    Url::from_directory_path(p).unwrap_or_else(|_| Url::parse("file:///").expect("file url"))
}
pub fn sandboxed_path_list(root: &Path, items: &[String]) -> Vec<String> {
    let root_abs = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut out = Vec::with_capacity(items.len());
    for it in items {
        let it = it.trim();
        if it.is_empty() {
            continue;
        }
        let p = if it.starts_with("file://") {
            Url::parse(it)
                .ok()
                .and_then(|u| u.to_file_path().ok())
                .unwrap_or_else(|| root_abs.clone())
        } else {
            let pp = Path::new(it);
            if pp.is_absolute() {
                pp.to_path_buf()
            } else {
                root_abs.join(pp)
            }
        };

        let abs = std::fs::canonicalize(&p).unwrap_or(p);
        if abs.starts_with(&root_abs) {
            out.push(abs.to_string_lossy().to_string());
        }
    }
    out
}