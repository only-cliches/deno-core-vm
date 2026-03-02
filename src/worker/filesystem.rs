use deno_core::url::Url;
use deno_fs::{FileSystem, FsFileType, OpenOptions, RealFs};
use deno_io::fs::FsResult;
use deno_permissions::{CheckedPath, CheckedPathBuf};
use std::path::{Path, PathBuf};
use std::sync::Arc;

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

pub fn normalize_startup_url(cwd: &Path, raw: Option<&str>) -> Option<Url> {
    let raw = raw.map(|s| s.trim()).filter(|s| !s.is_empty())?;

    let cwd_abs = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());

    // Accept both file:// URLs and relative/absolute filesystem paths.
    let candidate_path: PathBuf = if raw.starts_with("file://") {
        let u = Url::parse(raw).ok()?;
        u.to_file_path().ok()?
    } else {
        let p = Path::new(raw);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            cwd_abs.join(p)
        }
    };

    let file_abs = std::fs::canonicalize(&candidate_path).ok()?;

    // Enforce sandbox: startup must remain under configured cwd.
    if !file_abs.starts_with(&cwd_abs) {
        return None;
    }

    if !file_abs.is_file() {
        return None;
    }

    Url::from_file_path(file_abs).ok()
}

impl FileSystem for SandboxFs {
    fn cwd(&self) -> FsResult<PathBuf> {
        Ok((*self.cwd).clone())
    }

    fn tmp_dir(&self) -> FsResult<PathBuf> {
        self.inner.tmp_dir()
    }

    fn chdir(&self, _path: &CheckedPath<'_>) -> FsResult<()> {
        // Keep runtime cwd fixed to sandbox root for deterministic path policy.
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
        // Path safety is enforced by CheckedPath + permission layer; delegate IO.
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

#[cfg(test)]
mod tests {
    use super::{dir_url_from_path, normalize_cwd, normalize_startup_url, sandboxed_path_list};
    use std::path::{Path, PathBuf};

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).expect("create temp dir");
        p
    }

    #[test]
    fn normalize_cwd_handles_file_urls_and_relative_paths() {
        let fallback = std::env::current_dir().expect("cwd");
        assert_eq!(normalize_cwd(None), fallback);
        assert_eq!(normalize_cwd(Some("   ")), fallback);

        let root = unique_temp_dir("normalize-cwd");
        let as_url = deno_core::url::Url::from_directory_path(&root)
            .expect("url")
            .to_string();
        assert_eq!(normalize_cwd(Some(&as_url)), root);

        let rel = normalize_cwd(Some("subdir"));
        assert_eq!(rel, fallback.join("subdir"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn normalize_startup_url_allows_in_sandbox_and_blocks_outside() {
        let root = unique_temp_dir("startup-root");
        let inside = root.join("main.js");
        std::fs::write(&inside, "console.log('ok');").expect("write inside");

        let outside_root = unique_temp_dir("startup-outside");
        let outside = outside_root.join("outside.js");
        std::fs::write(&outside, "console.log('outside');").expect("write outside");

        let in_url = normalize_startup_url(&root, Some("main.js"));
        assert!(in_url.is_some(), "expected startup inside sandbox to be allowed");

        let out_url = normalize_startup_url(&root, outside.to_str());
        assert!(out_url.is_none(), "expected startup outside sandbox to be blocked");

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside_root);
    }

    #[test]
    fn sandboxed_path_list_filters_outside_and_invalid_inputs() {
        let root = unique_temp_dir("sandbox-list-root");
        let nested = root.join("nested");
        std::fs::create_dir_all(&nested).expect("nested dir");
        let inside_file = nested.join("a.txt");
        std::fs::write(&inside_file, "x").expect("write inside file");

        let outside_root = unique_temp_dir("sandbox-list-outside");
        let outside_file = outside_root.join("b.txt");
        std::fs::write(&outside_file, "y").expect("write outside file");

        let inside_rel = Path::new("nested").join("a.txt").to_string_lossy().to_string();
        let outside_abs = outside_file.to_string_lossy().to_string();
        let items = vec![" ".to_string(), inside_rel, outside_abs];

        let out = sandboxed_path_list(&root, &items);
        assert_eq!(out.len(), 1);
        assert!(out[0].ends_with("a.txt"));

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside_root);
    }

    #[test]
    fn dir_url_from_path_returns_file_scheme() {
        let root = unique_temp_dir("dir-url");
        let url = dir_url_from_path(&root);
        assert_eq!(url.scheme(), "file");
        assert!(url.as_str().starts_with("file://"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn normalize_startup_url_rejects_directory_and_accepts_file_url_inside() {
        let root = unique_temp_dir("startup-file-url");
        let file = root.join("entry.ts");
        std::fs::write(&file, "export {};").expect("write file");

        let dir_attempt = normalize_startup_url(&root, Some("."));
        assert!(dir_attempt.is_none(), "directory should not be accepted as startup");

        let file_url = deno_core::url::Url::from_file_path(&file)
            .expect("file url")
            .to_string();
        let ok = normalize_startup_url(&root, Some(&file_url));
        assert!(ok.is_some(), "file:// URL inside sandbox should be accepted");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn sandboxed_path_list_accepts_file_url_inside_and_blocks_file_url_outside() {
        let root = unique_temp_dir("sandbox-file-url-root");
        let inside = root.join("inside.js");
        std::fs::write(&inside, "1").expect("write inside");

        let outside_root = unique_temp_dir("sandbox-file-url-outside");
        let outside = outside_root.join("outside.js");
        std::fs::write(&outside, "1").expect("write outside");

        let inside_url = deno_core::url::Url::from_file_path(&inside)
            .expect("inside url")
            .to_string();
        let outside_url = deno_core::url::Url::from_file_path(&outside)
            .expect("outside url")
            .to_string();

        let out = sandboxed_path_list(&root, &[inside_url, outside_url]);
        assert_eq!(out.len(), 1);
        assert!(out[0].ends_with("inside.js"));

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside_root);
    }
}
