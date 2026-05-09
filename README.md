# VowCue

VowCue is a focused desktop app for wedding playback. It has Reception and Ceremony pages with fixed cues.

Reception cues:

- Grand Entrance
- First Dance
- Father/Daughter
- Mother/Son
- Cake Cutting
- Last Dance

Ceremony cues:

- Prelude
- Family Seating
- Wedding Party Processional
- Partner Processional
- Main Entrance
- Ceremony Interlude
- Unity Ceremony
- Recessional
- Postlude

Each cue accepts one local audio file, an optional song title, optional operator notes, an optional planned fade-in start point, and an optional planned fade-out time. Fade duration is controlled by one app-wide setting. Playback uses the operating system's default audio output.

## Key Features

- One discrete audio file per cue
- Optional song title and operator notes per cue
- Press-and-hold start and stop controls
- Inline fade and stop controls while a cue is playing
- Planned fade-ins where the fade-in time is also the playback start point
- Planned fade-out times with countdown through fade completion
- One app-wide fade duration setting
- Large time remaining display
- High-resolution waveform progress view
- Event naming and portable `.wed` event files
- `.wed` export/import with embedded cue audio files
- Per-cue source link storage with desktop yt-dlp import and direct-link web fallback
- Local persistence through IndexedDB in the web build
- Tauri desktop packaging for macOS and Windows
- Reception and Ceremony page tabs
- Show Mode to hide setup controls and leave only performance-safe actions
- Preflight status for playback state, page readiness, and cue issues
- Output meter for confirming that VowCue is sending audio to the OS output graph
- Automatic update checks against GitHub Releases with a user-confirmed update prompt

## Audio Support

Recommended formats:

- `.wav`
- `.mp3`
- `.m4a`
- `.aac`

Best-effort formats, depending on platform codec support:

- `.aif`
- `.aiff`
- `.flac`

VowCue checks decode/readability when a file is loaded or played. If a format cannot be decoded on that machine, the cue is rejected or skipped instead of crashing the app.

## Operator Workflow

Before doors:

1. Load every required cue file.
2. Confirm each cue reads `Ready`.
3. Check the preflight panel for `0` items needing attention.
4. Play a short test cue and confirm the waveform, timer, and output meter move.
5. Enter a valid event name and save a `.wed` backup for the event.
6. Turn on Show Mode.

Show Mode hides setup, import, removal, event reset, and fade-duration controls. Playback, fade, stop, tabs, countdown, waveform, and output meter remain available.

The output meter confirms VowCue is producing post-fader audio into the operating system's default output path. It cannot detect problems downstream of the OS mixer, such as a muted interface, disconnected cable, or external console issue.

## Development

Install dependencies:

```sh
npm ci
```

Run the browser build locally:

```sh
python3 -m http.server 4173
```

Then open:

```text
http://localhost:4173
```

Build the self-contained HTML version:

```sh
npm run build
```

This writes:

```text
dist/VowCue.html
dist/index.html
```

## Desktop Builds

Desktop source-link import uses `yt-dlp` and audio extraction uses `ffmpeg`. Install both on the machine running the desktop app if you want link import to work.

On macOS with Homebrew:

```sh
brew install yt-dlp ffmpeg
```

Finder-launched macOS apps often do not inherit the same `PATH` as Terminal. VowCue handles that by checking the normal `PATH` first, then these common tool directories:

```text
/opt/homebrew/bin
/usr/local/bin
/opt/local/bin
```

If import fails on a new machine, confirm the tools are installed in one of those directories or are available on the app's `PATH`.

Imports run on a background worker and have a 15-minute timeout so a bad source cannot leave VowCue waiting forever. During import, the cue shows an active progress bar and setup controls for that cue are locked.

On launch, the desktop app checks whether `yt-dlp` and `ffmpeg` are installed. If either tool is missing, VowCue shows an import-tool status and an `Install Import Tools` button in the Event panel when automatic install is supported.

Automatic install uses:

- macOS: Homebrew, via `brew install yt-dlp ffmpeg`
- Windows: winget, via packages for `yt-dlp` and `ffmpeg`

VowCue asks for confirmation before running the install. It does not silently install software in the background.

## Updates

On launch, VowCue checks the latest GitHub Release for `johnconradmusic/vowcue`. If a newer version is available, VowCue asks whether to open the release page and also shows a `View Update` action in the Event panel.

VowCue does not silently download or install app updates. The operator must choose to open the release page and install the new build.

Run the Tauri dev app:

```sh
npm run desktop:dev
```

Build for the current platform:

```sh
npm run desktop:build
```

Build a universal macOS app for Apple Silicon and Intel Macs:

```sh
rustup target add x86_64-apple-darwin aarch64-apple-darwin
npm run desktop:build:mac-universal
```

Build Intel-only macOS:

```sh
npm run desktop:build:mac-intel
```

## Signing

Local builds are unsigned by default. Public distribution without operating system security warnings requires:

- Apple Developer ID signing and notarization for macOS
- Authenticode code signing for Windows

## Event Files

`.wed` files are JSON event packages containing:

- Event name
- App-wide fade duration
- Cue settings
- Per-cue song title and notes
- Planned fade-in start point and fade-out times
- Embedded audio file payloads

Use `Save .wed` to move an event between machines and `Open .wed` to restore it.
