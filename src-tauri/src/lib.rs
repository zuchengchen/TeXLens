use chrono::Utc;
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Default)]
struct SidecarState {
    child: Mutex<Option<Child>>,
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
    let mut preview_image = None;

    if pdf_path.exists() {
        let export_dir = PathBuf::from(app_paths()?.data_dir).join("exports");
        std::fs::create_dir_all(&export_dir)
            .map_err(|err| format!("Unable to create {}: {err}", export_dir.display()))?;
        let target = export_dir.join("preview.pdf");
        std::fs::copy(&pdf_path, &target)
            .map_err(|err| format!("Unable to copy preview PDF to {}: {err}", target.display()))?;
        preview_image = render_pdf_preview_file(&target)
            .ok()
            .map(|path| path.display().to_string());
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
        preview_image_path: preview_image,
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

    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|err| err.to_string())?.is_none() {
            let host = options
                .as_ref()
                .and_then(|item| item.host.clone())
                .unwrap_or_else(|| "127.0.0.1".to_string());
            let port = options.as_ref().and_then(|item| item.port).unwrap_or(8765);
            return Ok(SidecarStatus {
                running: true,
                pid: Some(child.id()),
                endpoint: format!("http://{host}:{port}"),
            });
        }
    }

    let sidecar_dir = sidecar_project_dir(&app)?;
    let sidecar_env_dir = PathBuf::from(app_paths()?.cache_dir).join("sidecar-venv");
    let sidecar_log_path = PathBuf::from(app_paths()?.cache_dir).join("sidecar.log");
    let root = sidecar_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| sidecar_dir.clone());
    let host = options
        .as_ref()
        .and_then(|item| item.host.clone())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port = options.as_ref().and_then(|item| item.port).unwrap_or(8765);
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
        endpoint: format!("http://{host}:{port}"),
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

    Ok(SidecarStatus {
        running: false,
        pid: None,
        endpoint: "http://127.0.0.1:8765".to_string(),
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
                endpoint: "http://127.0.0.1:8765".to_string(),
            });
        }
    }

    *guard = None;
    Ok(SidecarStatus {
        running: false,
        pid: None,
        endpoint: "http://127.0.0.1:8765".to_string(),
    })
}

pub fn run() {
    ensure_webkit_runtime_env();
    tauri::Builder::default()
        .manage(SidecarState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
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
