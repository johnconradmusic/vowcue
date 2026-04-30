# VowCue

VowCue is a focused desktop app for wedding reception cue playback. It has six fixed cues:

- Grand Entrance
- First Dance
- Father/Daughter
- Mother/Son
- Cake Cutting
- Last Dance

Each cue accepts one local audio file, an optional planned fade-out time, and a fade duration. Playback always starts from the top and uses the operating system's default audio output.

## Key Features

- One discrete audio file per cue
- Press-and-hold start and stop controls
- Inline fade and stop controls while a cue is playing
- Planned fade-out times with countdown through fade completion
- Large time remaining display
- High-resolution waveform progress view
- Event naming and portable `.wed` event files
- `.wed` export/import with embedded cue audio files
- Local persistence through IndexedDB in the web build
- Tauri desktop packaging for macOS and Windows

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
- Cue settings
- Planned fade settings
- Embedded audio file payloads

Use `Save .wed` to move an event between machines and `Open .wed` to restore it.
