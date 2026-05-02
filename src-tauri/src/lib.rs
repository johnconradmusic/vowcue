use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
struct ImportedFilePayload {
    name: String,
    #[serde(rename = "type")]
    mime_type: String,
    last_modified: u64,
    data: String,
}

#[tauri::command]
fn download_audio_import(
    source_url: String,
    cue_name: Option<String>,
    event_name: Option<String>,
) -> Result<ImportedFilePayload, String> {
    if !is_valid_source_url(&source_url) {
        return Err("INVALID_SOURCE_URL".into());
    }

    let temp_dir = make_import_temp_dir()?;
    let result = (|| {
        run_yt_dlp_download(&temp_dir, &source_url)?;
        let downloaded_path = find_downloaded_file(&temp_dir)?;
        let bytes = fs::read(&downloaded_path)
            .map_err(|error| format!("Could not read imported audio: {error}"))?;
        let extension = downloaded_path
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("mp3");

        Ok(ImportedFilePayload {
            name: build_import_file_name(
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
        .invoke_handler(tauri::generate_handler![download_audio_import])
        .run(tauri::generate_context!())
        .expect("error while running VowCue");
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
    fs::create_dir_all(&dir).map_err(|error| format!("Could not create import temp directory: {error}"))?;
    Ok(dir)
}

fn run_yt_dlp_download(temp_dir: &Path, source_url: &str) -> Result<(), String> {
    let output_template = temp_dir.join("download.%(ext)s");
    let output = Command::new("yt-dlp")
        .args([
            "--no-playlist",
            "--extract-audio",
            "--audio-format",
            "mp3",
            "--audio-quality",
            "0",
            "--output",
        ])
        .arg(&output_template)
        .arg(source_url)
        .output()
        .map_err(|error| {
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
    if detail.is_empty() {
        Err("yt-dlp failed to import this source link.".into())
    } else {
        Err(format!("yt-dlp failed: {detail}"))
    }
}

fn find_downloaded_file(temp_dir: &Path) -> Result<PathBuf, String> {
    let mut files = fs::read_dir(temp_dir)
        .map_err(|error| format!("Could not inspect imported files: {error}"))?
        .filter_map(|entry| entry.ok().map(|value| value.path()))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();

    files.sort();
    files.into_iter().next().ok_or_else(|| "yt-dlp finished without producing an audio file.".into())
}

fn build_import_file_name(
    cue_name: Option<&str>,
    event_name: Option<&str>,
    source_url: &str,
    extension: &str,
) -> String {
    let extension = normalize_extension(extension);
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
    let without_query = without_fragment.split('?').next().unwrap_or(without_fragment);
    without_query
        .rsplit('/')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn sanitize_file_stem(file_name: &str) -> String {
    let stem = file_name.rsplit_once('.').map(|(value, _)| value).unwrap_or(file_name);
    slugify_label(stem)
}

fn normalize_extension(extension: &str) -> String {
    let clean = extension.trim().trim_start_matches('.').to_ascii_lowercase();
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
    use super::{build_import_file_name, content_type_for_extension, slugify_label};

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
                "https://cdn.example.com/audio/party-starter.wav?dl=1",
                "wav",
            ),
            "party-starter.wav"
        );
    }

    #[test]
    fn content_type_for_extension_maps_known_audio_extensions() {
        assert_eq!(content_type_for_extension("mp3"), "audio/mpeg");
        assert_eq!(content_type_for_extension("m4a"), "audio/mp4");
        assert_eq!(content_type_for_extension("wav"), "audio/wav");
        assert_eq!(content_type_for_extension("bin"), "application/octet-stream");
    }
}
