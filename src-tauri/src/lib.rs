use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const IMPORT_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const TOOL_INSTALL_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Serialize)]
struct ImportedFilePayload {
    name: String,
    #[serde(rename = "type")]
    mime_type: String,
    last_modified: u64,
    data: String,
}

#[derive(Serialize)]
struct ToolStatus {
    name: String,
    installed: bool,
    path: Option<String>,
}

#[derive(Serialize)]
struct ImportToolsPayload {
    platform: String,
    tools: Vec<ToolStatus>,
    missing: Vec<String>,
    install_supported: bool,
    install_command: Option<String>,
    message: String,
}

#[derive(Debug, Default)]
struct ImportMetadata {
    title: Option<String>,
    artist: Option<String>,
}

#[tauri::command]
async fn download_audio_import(
    source_url: String,
    cue_name: Option<String>,
    event_name: Option<String>,
) -> Result<ImportedFilePayload, String> {
    if !is_valid_source_url(&source_url) {
        return Err("INVALID_SOURCE_URL".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        download_audio_import_blocking(source_url, cue_name, event_name)
    })
    .await
    .map_err(|error| format!("Import worker failed: {error}"))?
}

#[tauri::command]
async fn check_import_tools() -> Result<ImportToolsPayload, String> {
    tauri::async_runtime::spawn_blocking(check_import_tools_blocking)
        .await
        .map_err(|error| format!("Tool check worker failed: {error}"))?
}

#[tauri::command]
async fn install_import_tools() -> Result<ImportToolsPayload, String> {
    tauri::async_runtime::spawn_blocking(|| {
        install_import_tools_blocking()?;
        check_import_tools_blocking()
    })
    .await
    .map_err(|error| format!("Tool install worker failed: {error}"))?
}

#[tauri::command]
async fn open_release_url(url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_release_url_blocking(&url))
        .await
        .map_err(|error| format!("Open release worker failed: {error}"))?
}

fn download_audio_import_blocking(
    source_url: String,
    cue_name: Option<String>,
    event_name: Option<String>,
) -> Result<ImportedFilePayload, String> {
    let temp_dir = make_import_temp_dir()?;
    let result = (|| {
        run_yt_dlp_download(&temp_dir, &source_url)?;
        let downloaded_path = find_downloaded_file(&temp_dir)?;
        let metadata = read_import_metadata(&temp_dir);
        let bytes = fs::read(&downloaded_path)
            .map_err(|error| format!("Could not read imported audio: {error}"))?;
        let extension = downloaded_path
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("mp3");

        Ok(ImportedFilePayload {
            name: build_import_file_name(
                metadata.as_ref(),
                cue_name.as_deref(),
                event_name.as_deref(),
                &source_url,
                extension,
            ),
            mime_type: content_type_for_extension(extension).to_string(),
            last_modified: current_timestamp_millis(),
            data: BASE64.encode(bytes),
        })
    })();

    let _ = fs::remove_dir_all(&temp_dir);
    result
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            check_import_tools,
            download_audio_import,
            install_import_tools,
            open_release_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running VowCue");
}

fn open_release_url_blocking(url: &str) -> Result<(), String> {
    if !is_allowed_release_url(url) {
        return Err("Release URL is not allowed.".into());
    }

    let status = match std::env::consts::OS {
        "macos" => Command::new("open").arg(url).status(),
        "windows" => Command::new("cmd").args(["/C", "start", "", url]).status(),
        _ => Command::new("xdg-open").arg(url).status(),
    }
    .map_err(|error| format!("Could not open release page: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Could not open release page.".into())
    }
}

fn is_allowed_release_url(url: &str) -> bool {
    let trimmed = url.trim();
    trimmed.starts_with("https://github.com/johnconradmusic/vowcue/releases/")
        || trimmed.starts_with("https://github.com/johnconradmusic/vowcue/releases/tag/")
}

fn check_import_tools_blocking() -> Result<ImportToolsPayload, String> {
    let tools = ["yt-dlp", "ffmpeg"]
        .iter()
        .map(|name| {
            let path = find_tool(name);
            ToolStatus {
                name: (*name).to_string(),
                installed: path.is_some(),
                path: path.map(|value| value.display().to_string()),
            }
        })
        .collect::<Vec<_>>();
    let missing = tools
        .iter()
        .filter(|tool| !tool.installed)
        .map(|tool| tool.name.clone())
        .collect::<Vec<_>>();
    let (install_supported, install_command, installer_message) = get_tool_install_plan(&missing);
    let message = if missing.is_empty() {
        "Import tools are installed.".to_string()
    } else if install_supported {
        format!(
            "Missing {}. VowCue can install them with {}.",
            missing.join(", "),
            installer_message
        )
    } else {
        format!("Missing {}. {}", missing.join(", "), installer_message)
    };

    Ok(ImportToolsPayload {
        platform: std::env::consts::OS.to_string(),
        tools,
        missing,
        install_supported,
        install_command,
        message,
    })
}

fn install_import_tools_blocking() -> Result<(), String> {
    let check = check_import_tools_blocking()?;
    if check.missing.is_empty() {
        return Ok(());
    }
    if !check.install_supported {
        return Err(check.message);
    }

    match std::env::consts::OS {
        "macos" => run_macos_tool_install(&check.missing),
        "windows" => run_windows_tool_install(&check.missing),
        _ => Err("Automatic import-tool installation is not supported on this platform.".into()),
    }
}

fn get_tool_install_plan(missing: &[String]) -> (bool, Option<String>, String) {
    if missing.is_empty() {
        return (false, None, "No installation needed".into());
    }

    match std::env::consts::OS {
        "macos" => {
            if find_tool("brew").is_some() {
                (
                    true,
                    Some(format!("brew install {}", missing.join(" "))),
                    "Homebrew".into(),
                )
            } else {
                (
                    false,
                    None,
                    "Homebrew is required for automatic install. Install Homebrew, then restart VowCue.".into(),
                )
            }
        }
        "windows" => {
            if find_tool("winget").is_some() {
                let packages = missing
                    .iter()
                    .filter_map(|tool| match tool.as_str() {
                        "yt-dlp" => Some("yt-dlp.yt-dlp"),
                        "ffmpeg" => Some("Gyan.FFmpeg"),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                (
                    !packages.is_empty(),
                    Some(format!(
                        "winget install {}",
                        packages.join(" and winget install ")
                    )),
                    "winget".into(),
                )
            } else {
                (
                    false,
                    None,
                    "winget is required for automatic install. Install yt-dlp and ffmpeg manually."
                        .into(),
                )
            }
        }
        _ => (
            false,
            None,
            "Automatic install is supported on macOS with Homebrew and Windows with winget.".into(),
        ),
    }
}

fn run_macos_tool_install(missing: &[String]) -> Result<(), String> {
    let brew = find_tool("brew")
        .ok_or_else(|| "Homebrew is required for automatic install.".to_string())?;
    let mut command = Command::new(brew);
    command.arg("install");
    for tool in missing {
        command.arg(tool);
    }
    run_install_command(&mut command, "Homebrew")
}

fn run_windows_tool_install(missing: &[String]) -> Result<(), String> {
    let winget = find_tool("winget")
        .ok_or_else(|| "winget is required for automatic install.".to_string())?;
    for tool in missing {
        let package = match tool.as_str() {
            "yt-dlp" => "yt-dlp.yt-dlp",
            "ffmpeg" => "Gyan.FFmpeg",
            _ => continue,
        };
        let mut command = Command::new(&winget);
        command.args([
            "install",
            "--id",
            package,
            "-e",
            "--source",
            "winget",
            "--accept-package-agreements",
            "--accept-source-agreements",
        ]);
        run_install_command(&mut command, "winget")?;
    }
    Ok(())
}

fn run_install_command(command: &mut Command, installer_name: &str) -> Result<(), String> {
    let output = run_command_with_timeout(command, TOOL_INSTALL_TIMEOUT)
        .map_err(|error| format!("Could not start {installer_name}: {error}"))?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    if detail.contains("VOWCUE_IMPORT_TIMEOUT") {
        Err(format!(
            "{installer_name} install timed out. Try installing yt-dlp and ffmpeg manually."
        ))
    } else if detail.is_empty() {
        Err(format!(
            "{installer_name} could not install the missing import tools."
        ))
    } else {
        Err(format!("{installer_name} failed: {detail}"))
    }
}

fn is_valid_source_url(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with("http://") || trimmed.starts_with("https://")
}

fn make_import_temp_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!(
        "vowcue-import-{}-{}",
        std::process::id(),
        current_timestamp_millis()
    ));
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create import temp directory: {error}"))?;
    Ok(dir)
}

fn run_yt_dlp_download(temp_dir: &Path, source_url: &str) -> Result<(), String> {
    let yt_dlp = find_tool("yt-dlp").ok_or_else(|| "YT_DLP_MISSING".to_string())?;
    let ffmpeg = find_tool("ffmpeg");
    let output_template = temp_dir.join("download.%(ext)s");
    let mut command = Command::new(&yt_dlp);
    command.args([
        "--no-playlist",
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "0",
        "--write-info-json",
    ]);

    if let Some(ffmpeg) = ffmpeg {
        if let Some(ffmpeg_dir) = ffmpeg.parent() {
            command.arg("--ffmpeg-location").arg(ffmpeg_dir);
        }
    }

    command
        .arg("--output")
        .arg(&output_template)
        .arg(source_url);

    let output = run_command_with_timeout(&mut command, IMPORT_TIMEOUT).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "YT_DLP_MISSING".to_string()
        } else {
            format!("Could not start yt-dlp: {error}")
        }
    })?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    if detail.contains("VOWCUE_IMPORT_TIMEOUT") {
        return Err(
            "Import timed out. Try a different source or download the audio manually.".into(),
        );
    }
    if detail.is_empty() {
        Err("yt-dlp failed to import this source link.".into())
    } else {
        Err(format!("yt-dlp failed: {detail}"))
    }
}

fn run_command_with_timeout(command: &mut Command, timeout: Duration) -> std::io::Result<Output> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let started = Instant::now();

    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output();
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let mut output = child.wait_with_output()?;
            output.stderr.extend_from_slice(b"\nVOWCUE_IMPORT_TIMEOUT");
            return Ok(output);
        }
        thread::sleep(Duration::from_millis(250));
    }
}

fn find_tool(name: &str) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(name);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
            #[cfg(target_os = "windows")]
            {
                let exe_candidate = dir.join(format!("{name}.exe"));
                if is_executable_file(&exe_candidate) {
                    return Some(exe_candidate);
                }
            }
        }
    }

    let common_dirs = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/opt/local/bin",
        "C:\\Program Files\\yt-dlp",
        "C:\\Program Files\\ffmpeg\\bin",
        "C:\\Program Files\\Gyan\\FFmpeg\\bin",
        "C:\\Users\\Public\\scoop\\shims",
    ];

    common_dirs.iter().find_map(|dir| {
        let candidate = Path::new(dir).join(name);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
        #[cfg(target_os = "windows")]
        {
            let exe_candidate = Path::new(dir).join(format!("{name}.exe"));
            if is_executable_file(&exe_candidate) {
                return Some(exe_candidate);
            }
        }
        None
    })
}

fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn find_downloaded_file(temp_dir: &Path) -> Result<PathBuf, String> {
    let mut files = fs::read_dir(temp_dir)
        .map_err(|error| format!("Could not inspect imported files: {error}"))?
        .filter_map(|entry| entry.ok().map(|value| value.path()))
        .filter(|path| path.is_file() && is_supported_audio_path(path))
        .collect::<Vec<_>>();

    files.sort();
    files
        .into_iter()
        .next()
        .ok_or_else(|| "yt-dlp finished without producing an audio file.".into())
}

fn read_import_metadata(temp_dir: &Path) -> Option<ImportMetadata> {
    let mut metadata_files = fs::read_dir(temp_dir)
        .ok()?
        .filter_map(|entry| entry.ok().map(|value| value.path()))
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| name.ends_with(".info.json"))
        })
        .collect::<Vec<_>>();

    metadata_files.sort();
    let content = fs::read_to_string(metadata_files.first()?).ok()?;
    let value = serde_json::from_str::<Value>(&content).ok()?;
    let title = metadata_text(&value, &["track", "title"]);
    let artist = metadata_text(&value, &["artist", "album_artist", "creator", "uploader"]);

    if title.is_none() && artist.is_none() {
        None
    } else {
        Some(ImportMetadata { title, artist })
    }
}

fn metadata_text(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        let item = value.get(*key)?;
        if let Some(text) = item.as_str() {
            let trimmed = text.trim();
            return (!trimmed.is_empty()).then(|| trimmed.to_string());
        }
        if let Some(items) = item.as_array() {
            let joined = items
                .iter()
                .filter_map(|value| value.as_str().map(str::trim))
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join(", ");
            return (!joined.is_empty()).then_some(joined);
        }
        None
    })
}

fn is_supported_audio_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(content_type_for_extension)
        .is_some_and(|content_type| content_type.starts_with("audio/"))
}

fn build_import_file_name(
    metadata: Option<&ImportMetadata>,
    cue_name: Option<&str>,
    event_name: Option<&str>,
    source_url: &str,
    extension: &str,
) -> String {
    let extension = normalize_extension(extension);

    if let Some(file_name) = metadata_file_name(metadata, &extension) {
        return file_name;
    }

    let mut parts = Vec::new();

    if let Some(event_name) = event_name {
        let slug = slugify_label(event_name);
        if !slug.is_empty() {
            parts.push(slug);
        }
    }

    if let Some(cue_name) = cue_name {
        let slug = slugify_label(cue_name);
        if !slug.is_empty() {
            parts.push(slug);
        }
    }

    if !parts.is_empty() {
        return format!("{}.{}", parts.join("-"), extension);
    }

    if let Some(file_name) = file_name_from_url(source_url) {
        let sanitized = sanitize_file_stem(&file_name);
        if !sanitized.is_empty() {
            return format!("{}.{}", sanitized, extension);
        }
    }

    format!("imported-audio.{}", extension)
}

fn metadata_file_name(metadata: Option<&ImportMetadata>, extension: &str) -> Option<String> {
    let metadata = metadata?;
    let title = sanitize_human_file_part(metadata.title.as_deref()?)?;
    let artist = metadata
        .artist
        .as_deref()
        .and_then(sanitize_human_file_part);
    let stem = artist
        .filter(|value| !value.eq_ignore_ascii_case(&title))
        .map(|artist| format!("{artist} - {title}"))
        .unwrap_or(title);
    Some(format!("{stem}.{extension}"))
}

fn sanitize_human_file_part(value: &str) -> Option<String> {
    let mut output = String::new();
    let mut previous_space = false;

    for character in value.trim().chars() {
        let replacement = if character.is_control()
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) {
            ' '
        } else {
            character
        };

        if replacement.is_whitespace() {
            if !previous_space && !output.is_empty() {
                output.push(' ');
                previous_space = true;
            }
        } else {
            output.push(replacement);
            previous_space = false;
        }
    }

    let clean = output.trim().trim_matches('.').to_string();
    (!clean.is_empty()).then_some(clean)
}

fn slugify_label(value: &str) -> String {
    let mut output = String::new();
    let mut previous_dash = false;

    for character in value.trim().chars() {
        let normalized = character.to_ascii_lowercase();
        if normalized.is_ascii_alphanumeric() {
            output.push(normalized);
            previous_dash = false;
        } else if !previous_dash && !output.is_empty() {
            output.push('-');
            previous_dash = true;
        }
    }

    output.trim_matches('-').to_string()
}

fn file_name_from_url(source_url: &str) -> Option<String> {
    let without_fragment = source_url.split('#').next().unwrap_or(source_url);
    let without_query = without_fragment
        .split('?')
        .next()
        .unwrap_or(without_fragment);
    without_query
        .rsplit('/')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn sanitize_file_stem(file_name: &str) -> String {
    let stem = file_name
        .rsplit_once('.')
        .map(|(value, _)| value)
        .unwrap_or(file_name);
    slugify_label(stem)
}

fn normalize_extension(extension: &str) -> String {
    let clean = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    if clean.is_empty() {
        "mp3".into()
    } else {
        clean
    }
}

fn content_type_for_extension(extension: &str) -> &'static str {
    match normalize_extension(extension).as_str() {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "aif" | "aiff" => "audio/aiff",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}

fn current_timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{
        build_import_file_name, content_type_for_extension, find_tool, is_allowed_release_url,
        metadata_file_name, slugify_label, ImportMetadata,
    };

    #[test]
    fn slugify_label_normalizes_cue_names() {
        assert_eq!(slugify_label("Grand Entrance"), "grand-entrance");
        assert_eq!(slugify_label("Father/Daughter"), "father-daughter");
        assert_eq!(slugify_label("  Last   Dance  "), "last-dance");
    }

    #[test]
    fn import_file_name_prefers_event_and_cue_names() {
        assert_eq!(
            build_import_file_name(
                None,
                Some("Grand Entrance"),
                Some("Smith Wedding"),
                "https://cdn.example.com/audio/source-file.mp3",
                "mp3",
            ),
            "smith-wedding-grand-entrance.mp3"
        );
    }

    #[test]
    fn import_file_name_falls_back_to_url_name_when_labels_are_missing() {
        assert_eq!(
            build_import_file_name(
                None,
                None,
                None,
                "https://cdn.example.com/audio/party-starter.wav?dl=1",
                "wav",
            ),
            "party-starter.wav"
        );
    }

    #[test]
    fn metadata_file_name_prefers_artist_and_title_when_available() {
        let metadata = ImportMetadata {
            title: Some("September".into()),
            artist: Some("Earth, Wind & Fire".into()),
        };

        assert_eq!(
            metadata_file_name(Some(&metadata), "mp3"),
            Some("Earth, Wind & Fire - September.mp3".into())
        );
    }

    #[test]
    fn import_file_name_prefers_metadata_over_cue_labels() {
        let metadata = ImportMetadata {
            title: Some("At Last".into()),
            artist: Some("Etta James".into()),
        };

        assert_eq!(
            build_import_file_name(
                Some(&metadata),
                Some("First Dance"),
                Some("Smith Wedding"),
                "https://example.com/watch?v=abc",
                "mp3",
            ),
            "Etta James - At Last.mp3"
        );
    }

    #[test]
    fn content_type_for_extension_maps_known_audio_extensions() {
        assert_eq!(content_type_for_extension("mp3"), "audio/mpeg");
        assert_eq!(content_type_for_extension("m4a"), "audio/mp4");
        assert_eq!(content_type_for_extension("wav"), "audio/wav");
        assert_eq!(
            content_type_for_extension("bin"),
            "application/octet-stream"
        );
    }

    #[test]
    fn find_tool_rejects_missing_tools() {
        assert!(find_tool("definitely-not-a-vowcue-tool").is_none());
    }

    #[test]
    fn release_url_allowlist_accepts_only_vowcue_releases() {
        assert!(is_allowed_release_url(
            "https://github.com/johnconradmusic/vowcue/releases/tag/v0.1.9"
        ));
        assert!(!is_allowed_release_url(
            "https://github.com/example/not-vowcue/releases/tag/v9"
        ));
    }
}
