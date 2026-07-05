use chrono::Utc;
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::ffi::CString;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::os::raw::{c_int, c_uint};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::ptr;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_ID: &str = "texlens";
const TRAY_SHOW_LABEL: &str = "Show TeXLens";
const TRAY_RESTART_LABEL: &str = "Restart";
const TRAY_QUIT_LABEL: &str = "Quit";
const TRAY_BACKEND_ENV: &str = "TEXLENS_TRAY_BACKEND";
const TRAY_CAPTURE_EVENT: &str = "texlens-tray-capture";
const DEFAULT_HOTKEY: &str = "Ctrl+Alt+M";

#[derive(Default)]
struct SidecarState {
    child: Mutex<Option<Child>>,
}

#[derive(Default)]
struct TrayState {
    handle: Mutex<Option<ksni::blocking::Handle<TexLensTray>>>,
}

struct TexLensTray {
    app: AppHandle,
    capture_label: String,
}

struct XEmbedTrayCallbacks {
    app: AppHandle,
    menu: *mut gtk_sys::GtkWidget,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayBackend {
    Auto,
    StatusNotifier,
    XEmbed,
    Off,
}

#[derive(Debug, Serialize)]
struct AppPaths {
    config_dir: String,
    data_dir: String,
    cache_dir: String,
    model_dir: String,
    capture_dir: String,
}

#[derive(Debug, Serialize)]
struct ToolStatus {
    name: String,
    available: bool,
    path: Option<String>,
    note: Option<String>,
}

#[derive(Debug, Serialize)]
struct EnvironmentReport {
    os: String,
    display_server: String,
    session_type: Option<String>,
    paths: AppPaths,
    tools: Vec<ToolStatus>,
}

#[derive(Debug, Serialize)]
struct CaptureResult {
    path: String,
    captured_at: String,
}

#[derive(Debug, Serialize)]
struct PdfPreviewResult {
    path: String,
}

#[derive(Debug, Serialize)]
struct LatexCompileResult {
    ok: bool,
    returncode: i32,
    stdout: String,
    stderr: String,
    error_summary: String,
    pdf_path: Option<String>,
    preview_image_path: Option<String>,
    preview_image_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct SidecarLaunchOptions {
    host: Option<String>,
    port: Option<u16>,
}

#[derive(Debug, Serialize)]
struct SidecarStatus {
    running: bool,
    pid: Option<u32>,
    endpoint: String,
}

fn project_dirs() -> Result<ProjectDirs, String> {
    ProjectDirs::from("dev", "texlens", "texlens")
        .ok_or_else(|| "Unable to resolve XDG project directories".to_string())
}

fn app_paths() -> Result<AppPaths, String> {
    let dirs = project_dirs()?;
    let config_dir = dirs.config_dir().to_path_buf();
    let data_dir = dirs.data_dir().to_path_buf();
    let cache_dir = dirs.cache_dir().to_path_buf();
    let model_dir = cache_dir.join("models");
    let capture_dir = cache_dir.join("captures");

    for dir in [&config_dir, &data_dir, &cache_dir, &model_dir, &capture_dir] {
        std::fs::create_dir_all(dir)
            .map_err(|err| format!("Unable to create {}: {err}", dir.display()))?;
    }

    Ok(AppPaths {
        config_dir: config_dir.display().to_string(),
        data_dir: data_dir.display().to_string(),
        cache_dir: cache_dir.display().to_string(),
        model_dir: model_dir.display().to_string(),
        capture_dir: capture_dir.display().to_string(),
    })
}

fn command_path(name: &str) -> Option<String> {
    Command::new("which")
        .arg(name)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
}

fn dev_repo_root() -> Option<PathBuf> {
    let mut current = std::env::current_dir().ok()?;
    loop {
        if current.join("sidecar").join("pyproject.toml").exists() {
            return Some(current);
        }
        if !current.pop() {
            break;
        }
    }

    let manifest_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)?;
    if manifest_root
        .join("sidecar")
        .join("pyproject.toml")
        .exists()
    {
        return Some(manifest_root);
    }

    None
}

fn sidecar_project_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(appdir) = std::env::var_os("APPDIR").map(PathBuf::from) {
        candidates.push(appdir.join("usr/lib/TeXLens/_up_/sidecar"));
        candidates.push(appdir.join("usr/lib/TeXLens/sidecar"));
    }
    let resource_error = match app.path().resource_dir() {
        Ok(resource_dir) => {
            candidates.push(resource_dir.join("_up_").join("sidecar"));
            candidates.push(resource_dir.join("sidecar"));
            None
        }
        Err(err) => Some(err.to_string()),
    };
    for candidate in candidates {
        if candidate.join("pyproject.toml").exists() {
            return Ok(candidate);
        }
    }
    if let Some(root) = dev_repo_root() {
        return Ok(root.join("sidecar"));
    }
    Err(format!(
        "Unable to locate bundled sidecar project. APPDIR={:?}; resource_dir_error={:?}",
        std::env::var_os("APPDIR"),
        resource_error
    ))
}

fn sidecar_endpoint(host: &str, port: u16) -> String {
    format!("http://{host}:{port}")
}

fn probe_sidecar_health(host: &str, port: u16) -> bool {
    let Some(addr) = (host, port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| addrs.next())
    else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(700)));

    let request =
        format!("GET /health HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    (response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200"))
        && response.contains("\"ok\":true")
}

#[tauri::command]
fn get_app_paths() -> Result<AppPaths, String> {
    app_paths()
}

#[tauri::command]
fn check_environment() -> Result<EnvironmentReport, String> {
    let paths = app_paths()?;
    let session_type = std::env::var("XDG_SESSION_TYPE").ok();
    let display_server = if std::env::var("WAYLAND_DISPLAY").is_ok() {
        "wayland"
    } else if std::env::var("DISPLAY").is_ok() {
        "x11"
    } else {
        "unknown"
    }
    .to_string();

    let tool_names = [
        ("import", "X11 region screenshot via ImageMagick"),
        ("xclip", "Clipboard integration"),
        ("nvidia-smi", "GPU metrics"),
        ("uv", "Python sidecar environment"),
        ("python", "Python runtime"),
        ("xelatex", "Optional LaTeX PDF preview"),
        ("latexmk", "Optional LaTeX PDF preview"),
    ];

    let tools = tool_names
        .iter()
        .map(|(name, note)| {
            let path = command_path(name);
            ToolStatus {
                name: (*name).to_string(),
                available: path.is_some(),
                path,
                note: Some((*note).to_string()),
            }
        })
        .collect();

    Ok(EnvironmentReport {
        os: std::env::consts::OS.to_string(),
        display_server,
        session_type,
        paths,
        tools,
    })
}

#[tauri::command]
fn capture_region() -> Result<CaptureResult, String> {
    if std::env::var("WAYLAND_DISPLAY").is_ok() && std::env::var("DISPLAY").is_err() {
        return Err(
            "Wayland screenshot capture is not supported in v0.1. Use X11 or import an image."
                .to_string(),
        );
    }

    let import_path = command_path("import")
        .ok_or_else(|| "ImageMagick `import` is required for X11 region capture".to_string())?;
    let paths = app_paths()?;
    let captured_at = Utc::now().to_rfc3339();
    let filename = format!("capture-{}.png", Utc::now().format("%Y%m%dT%H%M%S%.3fZ"));
    let out_path = PathBuf::from(paths.capture_dir).join(filename);

    // Let the toolbar click fully settle before ImageMagick starts listening for a selection.
    std::thread::sleep(std::time::Duration::from_millis(350));

    let status = Command::new(import_path)
        .arg(out_path.as_os_str())
        .status()
        .map_err(|err| format!("Failed to launch ImageMagick import: {err}"))?;

    if !status.success() {
        return Err("Screenshot capture was cancelled or failed".to_string());
    }

    Ok(CaptureResult {
        path: out_path.display().to_string(),
        captured_at,
    })
}

fn render_pdf_preview_file(pdf_path: &Path) -> Result<PathBuf, String> {
    let pdftoppm_path = command_path("pdftoppm")
        .ok_or_else(|| "Poppler `pdftoppm` is required for PDF preview".to_string())?;
    if !pdf_path.exists() {
        return Err(format!(
            "PDF preview source does not exist: {}",
            pdf_path.display()
        ));
    }

    let paths = app_paths()?;
    let preview_dir = PathBuf::from(paths.cache_dir).join("previews");
    std::fs::create_dir_all(&preview_dir)
        .map_err(|err| format!("Unable to create {}: {err}", preview_dir.display()))?;
    let output_base = preview_dir.join(format!(
        "compile-preview-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
    ));
    let output_path = output_base.with_extension("png");
    if output_path.exists() {
        std::fs::remove_file(&output_path).map_err(|err| {
            format!(
                "Unable to remove stale preview {}: {err}",
                output_path.display()
            )
        })?;
    }

    let output = Command::new(pdftoppm_path)
        .arg("-singlefile")
        .arg("-png")
        .arg("-r")
        .arg("160")
        .arg(pdf_path)
        .arg(&output_base)
        .output()
        .map_err(|err| format!("Failed to launch pdftoppm: {err}"))?;

    if !output.status.success() || !output_path.exists() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to render PDF preview: {}", stderr.trim()));
    }

    Ok(output_path)
}

fn render_pdf_preview_pages(pdf_path: &Path) -> Result<Vec<PathBuf>, String> {
    let pdftoppm_path = command_path("pdftoppm")
        .ok_or_else(|| "Poppler `pdftoppm` is required for PDF preview".to_string())?;
    if !pdf_path.exists() {
        return Err(format!(
            "PDF preview source does not exist: {}",
            pdf_path.display()
        ));
    }

    let paths = app_paths()?;
    let preview_dir = PathBuf::from(paths.cache_dir).join("previews");
    std::fs::create_dir_all(&preview_dir)
        .map_err(|err| format!("Unable to create {}: {err}", preview_dir.display()))?;
    let output_base = preview_dir.join(format!(
        "compile-preview-{}",
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
    ));

    let output = Command::new(pdftoppm_path)
        .arg("-png")
        .arg("-r")
        .arg("160")
        .arg("-f")
        .arg("1")
        .arg(pdf_path)
        .arg(&output_base)
        .output()
        .map_err(|err| format!("Failed to launch pdftoppm: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Failed to render PDF preview pages: {}",
            stderr.trim()
        ));
    }

    let prefix = output_base
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Unable to resolve PDF preview output prefix".to_string())?
        .to_string();
    let mut pages = std::fs::read_dir(&preview_dir)
        .map_err(|err| format!("Unable to read {}: {err}", preview_dir.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().and_then(|ext| ext.to_str()) == Some("png")
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(&prefix))
        })
        .collect::<Vec<_>>();
    pages.sort_by_key(|path| {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .and_then(|stem| stem.rsplit('-').next())
            .and_then(|page| page.parse::<u32>().ok())
            .unwrap_or(0)
    });
    if pages.is_empty() {
        return Err("PDF preview rendering did not produce any pages".to_string());
    }
    Ok(pages)
}

#[tauri::command]
fn render_pdf_preview(pdf_path: String) -> Result<PdfPreviewResult, String> {
    let output_path = render_pdf_preview_file(Path::new(&pdf_path))?;
    Ok(PdfPreviewResult {
        path: output_path.display().to_string(),
    })
}

#[tauri::command]
fn compile_latex_preview(latex: String) -> Result<LatexCompileResult, String> {
    let engine = command_path("latexmk")
        .or_else(|| command_path("xelatex"))
        .ok_or_else(|| "No latexmk/xelatex toolchain found.".to_string())?;
    let tmp_path = std::env::temp_dir().join(format!(
        "texlens-latex-{}-{}",
        std::process::id(),
        Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
    ));
    std::fs::create_dir_all(&tmp_path)
        .map_err(|err| format!("Unable to create {}: {err}", tmp_path.display()))?;
    let tex_path = tmp_path.join("document.tex");
    std::fs::write(&tex_path, latex)
        .map_err(|err| format!("Unable to write {}: {err}", tex_path.display()))?;

    let mut command = Command::new(&engine);
    if Path::new(&engine)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "latexmk")
    {
        command
            .arg("-xelatex")
            .arg("-interaction=nonstopmode")
            .arg("-halt-on-error")
            .arg("document.tex");
    } else {
        command
            .arg("-interaction=nonstopmode")
            .arg("-halt-on-error")
            .arg("document.tex");
    }
    let output = command
        .current_dir(&tmp_path)
        .output()
        .map_err(|err| format!("Failed to launch LaTeX compiler: {err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let pdf_path = tmp_path.join("document.pdf");
    let mut exported_pdf = None;
    let mut preview_images = Vec::new();

    if output.status.success() {
        if !pdf_path.exists() {
            let _ = std::fs::remove_dir_all(&tmp_path);
            return Err("LaTeX compiler completed without producing document.pdf".to_string());
        }

        let export_dir = PathBuf::from(app_paths()?.data_dir).join("exports");
        std::fs::create_dir_all(&export_dir)
            .map_err(|err| format!("Unable to create {}: {err}", export_dir.display()))?;
        let target = export_dir.join("preview.pdf");
        std::fs::copy(&pdf_path, &target)
            .map_err(|err| format!("Unable to copy preview PDF to {}: {err}", target.display()))?;
        preview_images = match render_pdf_preview_pages(&target) {
            Ok(paths) => paths,
            Err(err) => {
                let _ = std::fs::remove_dir_all(&tmp_path);
                return Err(err);
            }
        }
        .into_iter()
        .map(|path| path.display().to_string())
        .collect();
        exported_pdf = Some(target.display().to_string());
    }

    let _ = std::fs::remove_dir_all(&tmp_path);
    Ok(LatexCompileResult {
        ok: output.status.success(),
        returncode: output.status.code().unwrap_or(-1),
        error_summary: if output.status.success() {
            String::new()
        } else {
            summarize_latex_errors(&stdout, &stderr)
        },
        stdout: tail_chars(&stdout, 12000),
        stderr: tail_chars(&stderr, 12000),
        pdf_path: exported_pdf,
        preview_image_path: preview_images.first().cloned(),
        preview_image_paths: preview_images,
    })
}

fn tail_chars(value: &str, limit: usize) -> String {
    let len = value.chars().count();
    value.chars().skip(len.saturating_sub(limit)).collect()
}

fn summarize_latex_errors(stdout: &str, stderr: &str) -> String {
    let lines: Vec<&str> = stdout.lines().chain(stderr.lines()).collect();
    let mut interesting = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if !is_latex_error_line(line) {
            continue;
        }
        let start = index.saturating_sub(2);
        let end = usize::min(lines.len(), index + 4);
        for item in &lines[start..end] {
            if !is_generic_latexmk_line(item) {
                interesting.push((*item).to_string());
            }
        }
        interesting.push(String::new());
    }

    if interesting.is_empty() {
        lines
            .into_iter()
            .filter(|line| !line.trim().is_empty() && !is_generic_latexmk_line(line))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        interesting.join("\n")
    }
}

fn is_latex_error_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with('!')
        || trimmed.starts_with("l.")
        || trimmed.contains("LaTeX Error")
        || trimmed.contains("Package ") && trimmed.contains(" Error")
        || trimmed.contains("Undefined control sequence")
        || trimmed.contains("Missing $ inserted")
        || trimmed.contains("Runaway argument")
        || trimmed.contains("Emergency stop")
        || trimmed.contains("Misplaced alignment tab")
        || trimmed.contains("Extra alignment tab")
        || trimmed.contains("File ") && trimmed.contains(" not found")
}

fn is_generic_latexmk_line(line: &str) -> bool {
    line.contains("Latexmk: Sometimes, the -f option")
        || line.contains("Latexmk: Using bibtex")
        || line.contains("But normally, you will need to correct")
        || line.contains("clean out generated files before rerunning")
}

#[tauri::command]
fn start_sidecar(
    app: AppHandle,
    state: tauri::State<'_, SidecarState>,
    options: Option<SidecarLaunchOptions>,
) -> Result<SidecarStatus, String> {
    let mut guard = state
        .child
        .lock()
        .map_err(|_| "Sidecar state lock is poisoned".to_string())?;
    let host = options
        .as_ref()
        .and_then(|item| item.host.clone())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port = options.as_ref().and_then(|item| item.port).unwrap_or(8765);

    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|err| err.to_string())?.is_none() {
            return Ok(SidecarStatus {
                running: true,
                pid: Some(child.id()),
                endpoint: sidecar_endpoint(&host, port),
            });
        }
    }
    *guard = None;

    if probe_sidecar_health(&host, port) {
        return Ok(SidecarStatus {
            running: true,
            pid: None,
            endpoint: sidecar_endpoint(&host, port),
        });
    }

    let sidecar_dir = sidecar_project_dir(&app)?;
    let sidecar_env_dir = PathBuf::from(app_paths()?.cache_dir).join("sidecar-venv");
    let sidecar_log_path = PathBuf::from(app_paths()?.cache_dir).join("sidecar.log");
    let root = sidecar_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| sidecar_dir.clone());
    let mut command = Command::new("uv");
    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&sidecar_log_path)
        .map_err(|err| {
            format!(
                "Unable to open sidecar log {}: {err}",
                sidecar_log_path.display()
            )
        })?;
    let _ = writeln!(
        log,
        "\n=== TeXLens sidecar start {} ===\nproject={}\nvenv={}",
        Utc::now().to_rfc3339(),
        sidecar_dir.display(),
        sidecar_env_dir.display()
    );
    let stderr_log = log
        .try_clone()
        .map_err(|err| format!("Unable to clone sidecar log handle: {err}"))?;
    command
        .arg("run")
        .arg("--project")
        .arg(&sidecar_dir)
        .arg("--locked")
        .arg("--extra")
        .arg("pdf")
        .arg("texlens-sidecar")
        .arg("--host")
        .arg(&host)
        .arg("--port")
        .arg(port.to_string())
        .current_dir(root)
        .env("UV_PROJECT_ENVIRONMENT", sidecar_env_dir)
        .env("UV_LINK_MODE", "copy")
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH")
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr_log));

    let child = command
        .spawn()
        .map_err(|err| format!("Failed to start Python sidecar with uv: {err}"))?;
    let pid = child.id();
    *guard = Some(child);

    Ok(SidecarStatus {
        running: true,
        pid: Some(pid),
        endpoint: sidecar_endpoint(&host, port),
    })
}

#[tauri::command]
fn stop_sidecar(state: tauri::State<'_, SidecarState>) -> Result<SidecarStatus, String> {
    let mut guard = state
        .child
        .lock()
        .map_err(|_| "Sidecar state lock is poisoned".to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }

    if probe_sidecar_health("127.0.0.1", 8765) {
        return Ok(SidecarStatus {
            running: true,
            pid: None,
            endpoint: sidecar_endpoint("127.0.0.1", 8765),
        });
    }

    Ok(SidecarStatus {
        running: false,
        pid: None,
        endpoint: sidecar_endpoint("127.0.0.1", 8765),
    })
}

#[tauri::command]
fn sidecar_status(state: tauri::State<'_, SidecarState>) -> Result<SidecarStatus, String> {
    let mut guard = state
        .child
        .lock()
        .map_err(|_| "Sidecar state lock is poisoned".to_string())?;

    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|err| err.to_string())?.is_none() {
            return Ok(SidecarStatus {
                running: true,
                pid: Some(child.id()),
                endpoint: sidecar_endpoint("127.0.0.1", 8765),
            });
        }
    }

    *guard = None;
    if probe_sidecar_health("127.0.0.1", 8765) {
        return Ok(SidecarStatus {
            running: true,
            pid: None,
            endpoint: sidecar_endpoint("127.0.0.1", 8765),
        });
    }

    Ok(SidecarStatus {
        running: false,
        pid: None,
        endpoint: sidecar_endpoint("127.0.0.1", 8765),
    })
}

fn restore_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn request_capture_from_tray(app: &AppHandle) {
    let _ = app.emit(TRAY_CAPTURE_EVENT, ());
}

fn restart_with_tauri_dev(app: &AppHandle) {
    match spawn_tauri_dev_restart() {
        Ok(()) => app.exit(0),
        Err(err) => eprintln!("Unable to restart TeXLens with pnpm tauri:dev: {err}"),
    }
}

fn spawn_tauri_dev_restart() -> Result<(), String> {
    let root = dev_repo_root().ok_or_else(|| "Unable to locate TeXLens repo root".to_string())?;
    let command = "sleep 1; exec pnpm tauri:dev";

    Command::new("setsid")
        .arg("sh")
        .arg("-lc")
        .arg(command)
        .current_dir(&root)
        .stdin(Stdio::null())
        .spawn()
        .or_else(|_| {
            Command::new("sh")
                .arg("-lc")
                .arg(command)
                .current_dir(&root)
                .stdin(Stdio::null())
                .spawn()
        })
        .map(|_| ())
        .map_err(|err| {
            format!(
                "Failed to spawn pnpm tauri:dev in {}: {err}",
                root.display()
            )
        })
}

fn setup_close_to_tray(app: &mut tauri::App) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let close_target = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = close_target.hide();
            }
        });
    }
}

fn texlens_tray_icon() -> ksni::Icon {
    static ICON: LazyLock<ksni::Icon> = LazyLock::new(|| {
        let image = tauri::include_image!("./icons/icon.png");
        let mut data = image.rgba().to_vec();
        for pixel in data.chunks_exact_mut(4) {
            pixel.rotate_right(1);
        }
        ksni::Icon {
            width: image.width() as i32,
            height: image.height() as i32,
            data,
        }
    });
    ICON.clone()
}

impl ksni::Tray for TexLensTray {
    fn id(&self) -> String {
        TRAY_ID.to_string()
    }

    fn title(&self) -> String {
        "TeXLens".to_string()
    }

    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        vec![texlens_tray_icon()]
    }

    fn tool_tip(&self) -> ksni::ToolTip {
        ksni::ToolTip {
            title: "TeXLens".to_string(),
            description: "Local LaTeX OCR workbench".to_string(),
            icon_pixmap: self.icon_pixmap(),
            ..Default::default()
        }
    }

    fn activate(&mut self, _x: i32, _y: i32) {
        restore_main_window(&self.app);
    }

    fn secondary_activate(&mut self, _x: i32, _y: i32) {
        restore_main_window(&self.app);
    }

    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        use ksni::menu::StandardItem;
        vec![
            StandardItem {
                label: self.capture_label.clone(),
                activate: Box::new(|tray: &mut Self| request_capture_from_tray(&tray.app)),
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: TRAY_SHOW_LABEL.to_string(),
                activate: Box::new(|tray: &mut Self| restore_main_window(&tray.app)),
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: TRAY_RESTART_LABEL.to_string(),
                icon_name: "view-refresh".to_string(),
                activate: Box::new(|tray: &mut Self| restart_with_tauri_dev(&tray.app)),
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: TRAY_QUIT_LABEL.to_string(),
                icon_name: "application-exit".to_string(),
                activate: Box::new(|tray: &mut Self| tray.app.exit(0)),
                ..Default::default()
            }
            .into(),
        ]
    }
}

fn selected_tray_backend() -> TrayBackend {
    let Some(value) = std::env::var_os(TRAY_BACKEND_ENV) else {
        return TrayBackend::Auto;
    };
    match value.to_string_lossy().to_ascii_lowercase().as_str() {
        "" | "auto" => TrayBackend::Auto,
        "sni" | "statusnotifier" | "status-notifier" | "appindicator" => {
            TrayBackend::StatusNotifier
        }
        "xembed" | "gtk" => TrayBackend::XEmbed,
        "off" | "none" | "disabled" => TrayBackend::Off,
        other => {
            eprintln!("Unknown {TRAY_BACKEND_ENV} value `{other}`; using auto tray backend");
            TrayBackend::Auto
        }
    }
}

fn is_x11_display() -> bool {
    if std::env::var_os("DISPLAY").is_none() {
        return false;
    }
    match std::env::var("XDG_SESSION_TYPE") {
        Ok(value) => value.eq_ignore_ascii_case("x11"),
        Err(_) => std::env::var_os("WAYLAND_DISPLAY").is_none(),
    }
}

fn is_i3_session() -> bool {
    ["XDG_CURRENT_DESKTOP", "DESKTOP_SESSION"]
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .any(|value| {
            value
                .split([':', ';', ','])
                .any(|item| item.trim().eq_ignore_ascii_case("i3"))
        })
}

fn should_prefer_xembed_tray() -> bool {
    is_x11_display() && is_i3_session()
}

fn saved_hotkey_hint() -> Option<String> {
    if let Ok(value) = std::env::var("TEXLENS_HOTKEY") {
        let value = value.trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }

    let config_dir = project_dirs().ok()?.config_dir().to_path_buf();
    let settings_path = config_dir.join("settings.json");
    let payload = std::fs::read_to_string(settings_path).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&payload).ok()?;
    value
        .get("hotkey")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
}

fn tray_capture_label() -> String {
    format!(
        "Capture Region ({})",
        saved_hotkey_hint().unwrap_or_else(|| DEFAULT_HOTKEY.to_string())
    )
}

fn setup_status_notifier_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use ksni::blocking::TrayMethods;

    let handle = TexLensTray {
        app: app.app_handle().clone(),
        capture_label: tray_capture_label(),
    }
    .assume_sni_available(true)
    .spawn()?;

    let state = app.state::<TrayState>();
    let mut tray_handle = state.handle.lock().map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::Other, "Tray state lock is poisoned")
    })?;
    *tray_handle = Some(handle);

    Ok(())
}

fn xembed_tray_icon_file() -> std::io::Result<PathBuf> {
    let paths = app_paths().map_err(std::io::Error::other)?;
    let icon_path = PathBuf::from(paths.cache_dir).join("texlens-tray-icon.png");
    std::fs::write(&icon_path, include_bytes!("../icons/icon.png"))?;
    Ok(icon_path)
}

unsafe fn connect_gtk_signal(
    instance: *mut gobject_sys::GObject,
    signal: &str,
    callback: gobject_sys::GCallback,
    data: glib_sys::gpointer,
) -> Result<(), Box<dyn std::error::Error>> {
    let signal = CString::new(signal)?;
    gobject_sys::g_signal_connect_data(
        instance,
        signal.as_ptr(),
        callback,
        data,
        None,
        gobject_sys::G_CONNECT_DEFAULT,
    );
    Ok(())
}

fn status_icon_activate_callback() -> gobject_sys::GCallback {
    unsafe {
        let callback = xembed_status_icon_activate
            as unsafe extern "C" fn(*mut gtk_sys::GtkStatusIcon, glib_sys::gpointer);
        Some(std::mem::transmute::<
            unsafe extern "C" fn(*mut gtk_sys::GtkStatusIcon, glib_sys::gpointer),
            unsafe extern "C" fn(),
        >(callback))
    }
}

fn status_icon_popup_menu_callback() -> gobject_sys::GCallback {
    unsafe {
        let callback = xembed_status_icon_popup_menu
            as unsafe extern "C" fn(*mut gtk_sys::GtkStatusIcon, c_uint, u32, glib_sys::gpointer);
        Some(std::mem::transmute::<
            unsafe extern "C" fn(*mut gtk_sys::GtkStatusIcon, c_uint, u32, glib_sys::gpointer),
            unsafe extern "C" fn(),
        >(callback))
    }
}

fn menu_item_show_callback() -> gobject_sys::GCallback {
    unsafe {
        let callback = xembed_menu_item_show
            as unsafe extern "C" fn(*mut gtk_sys::GtkMenuItem, glib_sys::gpointer);
        Some(std::mem::transmute::<
            unsafe extern "C" fn(*mut gtk_sys::GtkMenuItem, glib_sys::gpointer),
            unsafe extern "C" fn(),
        >(callback))
    }
}

fn menu_item_capture_callback() -> gobject_sys::GCallback {
    unsafe {
        let callback = xembed_menu_item_capture
            as unsafe extern "C" fn(*mut gtk_sys::GtkMenuItem, glib_sys::gpointer);
        Some(std::mem::transmute::<
            unsafe extern "C" fn(*mut gtk_sys::GtkMenuItem, glib_sys::gpointer),
            unsafe extern "C" fn(),
        >(callback))
    }
}

fn menu_item_restart_callback() -> gobject_sys::GCallback {
    unsafe {
        let callback = xembed_menu_item_restart
            as unsafe extern "C" fn(*mut gtk_sys::GtkMenuItem, glib_sys::gpointer);
        Some(std::mem::transmute::<
            unsafe extern "C" fn(*mut gtk_sys::GtkMenuItem, glib_sys::gpointer),
            unsafe extern "C" fn(),
        >(callback))
    }
}

fn menu_item_quit_callback() -> gobject_sys::GCallback {
    unsafe {
        let callback = xembed_menu_item_quit
            as unsafe extern "C" fn(*mut gtk_sys::GtkMenuItem, glib_sys::gpointer);
        Some(std::mem::transmute::<
            unsafe extern "C" fn(*mut gtk_sys::GtkMenuItem, glib_sys::gpointer),
            unsafe extern "C" fn(),
        >(callback))
    }
}

unsafe extern "C" fn xembed_position_menu(
    menu: *mut gtk_sys::GtkMenu,
    x: *mut c_int,
    y: *mut c_int,
    push_in: *mut glib_sys::gboolean,
    user_data: glib_sys::gpointer,
) {
    gtk_sys::gtk_status_icon_position_menu(
        menu,
        x,
        y,
        push_in,
        user_data as *mut gtk_sys::GtkStatusIcon,
    );
}

unsafe extern "C" fn xembed_status_icon_activate(
    _status_icon: *mut gtk_sys::GtkStatusIcon,
    user_data: glib_sys::gpointer,
) {
    let callbacks = &*(user_data as *const XEmbedTrayCallbacks);
    restore_main_window(&callbacks.app);
}

unsafe extern "C" fn xembed_status_icon_popup_menu(
    status_icon: *mut gtk_sys::GtkStatusIcon,
    button: c_uint,
    activate_time: u32,
    user_data: glib_sys::gpointer,
) {
    let callbacks = &*(user_data as *const XEmbedTrayCallbacks);
    gtk_sys::gtk_menu_popup(
        callbacks.menu as *mut gtk_sys::GtkMenu,
        ptr::null_mut(),
        ptr::null_mut(),
        Some(xembed_position_menu),
        status_icon as glib_sys::gpointer,
        button,
        activate_time,
    );
}

unsafe extern "C" fn xembed_menu_item_show(
    _item: *mut gtk_sys::GtkMenuItem,
    user_data: glib_sys::gpointer,
) {
    let callbacks = &*(user_data as *const XEmbedTrayCallbacks);
    restore_main_window(&callbacks.app);
}

unsafe extern "C" fn xembed_menu_item_capture(
    _item: *mut gtk_sys::GtkMenuItem,
    user_data: glib_sys::gpointer,
) {
    let callbacks = &*(user_data as *const XEmbedTrayCallbacks);
    request_capture_from_tray(&callbacks.app);
}

unsafe extern "C" fn xembed_menu_item_restart(
    _item: *mut gtk_sys::GtkMenuItem,
    user_data: glib_sys::gpointer,
) {
    let callbacks = &*(user_data as *const XEmbedTrayCallbacks);
    restart_with_tauri_dev(&callbacks.app);
}

unsafe extern "C" fn xembed_menu_item_quit(
    _item: *mut gtk_sys::GtkMenuItem,
    user_data: glib_sys::gpointer,
) {
    let callbacks = &*(user_data as *const XEmbedTrayCallbacks);
    callbacks.app.exit(0);
}

fn setup_xembed_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if !is_x11_display() {
        return Err(Box::new(std::io::Error::other(
            "XEmbed tray requires an X11 DISPLAY",
        )));
    }

    unsafe {
        if gtk_sys::gtk_init_check(ptr::null_mut(), ptr::null_mut()) == 0 {
            return Err(Box::new(std::io::Error::other(
                "GTK could not initialize the XEmbed tray",
            )));
        }
    }

    let icon_path = xembed_tray_icon_file()?;
    let icon_path = CString::new(icon_path.to_string_lossy().as_bytes())?;
    let title = CString::new("TeXLens")?;
    let tooltip = CString::new("TeXLens - Local LaTeX OCR workbench")?;
    let name = CString::new(TRAY_ID)?;
    let capture_label = CString::new(tray_capture_label())?;
    let show_label = CString::new(TRAY_SHOW_LABEL)?;
    let restart_label = CString::new(TRAY_RESTART_LABEL)?;
    let quit_label = CString::new(TRAY_QUIT_LABEL)?;

    unsafe {
        let menu = gtk_sys::gtk_menu_new();
        let capture_item = gtk_sys::gtk_menu_item_new_with_label(capture_label.as_ptr());
        let separator = gtk_sys::gtk_separator_menu_item_new();
        let show_item = gtk_sys::gtk_menu_item_new_with_label(show_label.as_ptr());
        let restart_item = gtk_sys::gtk_menu_item_new_with_label(restart_label.as_ptr());
        let quit_item = gtk_sys::gtk_menu_item_new_with_label(quit_label.as_ptr());
        let icon = gtk_sys::gtk_status_icon_new_from_file(icon_path.as_ptr());
        if menu.is_null()
            || capture_item.is_null()
            || separator.is_null()
            || show_item.is_null()
            || restart_item.is_null()
            || quit_item.is_null()
            || icon.is_null()
        {
            return Err(Box::new(std::io::Error::other(
                "GTK failed to create the XEmbed tray icon",
            )));
        }

        gtk_sys::gtk_menu_shell_append(
            menu as *mut gtk_sys::GtkMenuShell,
            capture_item as *mut gtk_sys::GtkMenuItem,
        );
        gtk_sys::gtk_menu_shell_append(
            menu as *mut gtk_sys::GtkMenuShell,
            separator as *mut gtk_sys::GtkMenuItem,
        );
        gtk_sys::gtk_menu_shell_append(
            menu as *mut gtk_sys::GtkMenuShell,
            show_item as *mut gtk_sys::GtkMenuItem,
        );
        gtk_sys::gtk_menu_shell_append(
            menu as *mut gtk_sys::GtkMenuShell,
            restart_item as *mut gtk_sys::GtkMenuItem,
        );
        gtk_sys::gtk_menu_shell_append(
            menu as *mut gtk_sys::GtkMenuShell,
            quit_item as *mut gtk_sys::GtkMenuItem,
        );
        gtk_sys::gtk_widget_show_all(menu);
        gobject_sys::g_object_ref_sink(menu as *mut gobject_sys::GObject);

        gtk_sys::gtk_status_icon_set_name(icon, name.as_ptr());
        gtk_sys::gtk_status_icon_set_title(icon, title.as_ptr());
        gtk_sys::gtk_status_icon_set_tooltip_text(icon, tooltip.as_ptr());
        gtk_sys::gtk_status_icon_set_visible(icon, 1);

        let callbacks = Box::leak(Box::new(XEmbedTrayCallbacks {
            app: app.app_handle().clone(),
            menu,
        }));
        let callbacks = callbacks as *mut XEmbedTrayCallbacks as glib_sys::gpointer;

        connect_gtk_signal(
            icon as *mut gobject_sys::GObject,
            "activate",
            status_icon_activate_callback(),
            callbacks,
        )?;
        connect_gtk_signal(
            icon as *mut gobject_sys::GObject,
            "popup-menu",
            status_icon_popup_menu_callback(),
            callbacks,
        )?;
        connect_gtk_signal(
            capture_item as *mut gobject_sys::GObject,
            "activate",
            menu_item_capture_callback(),
            callbacks,
        )?;
        connect_gtk_signal(
            show_item as *mut gobject_sys::GObject,
            "activate",
            menu_item_show_callback(),
            callbacks,
        )?;
        connect_gtk_signal(
            restart_item as *mut gobject_sys::GObject,
            "activate",
            menu_item_restart_callback(),
            callbacks,
        )?;
        connect_gtk_signal(
            quit_item as *mut gobject_sys::GObject,
            "activate",
            menu_item_quit_callback(),
            callbacks,
        )?;
    }

    Ok(())
}

fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    match selected_tray_backend() {
        TrayBackend::Off => Ok(()),
        TrayBackend::StatusNotifier => setup_status_notifier_tray(app),
        TrayBackend::XEmbed => setup_xembed_tray(app),
        TrayBackend::Auto if should_prefer_xembed_tray() => match setup_xembed_tray(app) {
            Ok(()) => Ok(()),
            Err(err) => {
                eprintln!("XEmbed tray setup failed; falling back to StatusNotifier: {err}");
                setup_status_notifier_tray(app)
            }
        },
        TrayBackend::Auto => match setup_status_notifier_tray(app) {
            Ok(()) => Ok(()),
            Err(err) if is_x11_display() => {
                eprintln!("StatusNotifier tray setup failed; falling back to XEmbed: {err}");
                setup_xembed_tray(app)
            }
            Err(err) => Err(err),
        },
    }
}

pub fn run() {
    ensure_webkit_runtime_env();
    tauri::Builder::default()
        .manage(SidecarState::default())
        .manage(TrayState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            setup_close_to_tray(app);
            setup_tray(app)?;
            restore_main_window(app.app_handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_paths,
            check_environment,
            capture_region,
            render_pdf_preview,
            compile_latex_preview,
            start_sidecar,
            stop_sidecar,
            sidecar_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running TeXLens");
}

fn ensure_webkit_runtime_env() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}
