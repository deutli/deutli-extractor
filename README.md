# DEUTLI Extractor V2

**Free. Open Source. 100% Local PWA.**

A professional-grade metadata extraction utility for ComfyUI and Automatic1111 PNG outputs. Extracts hidden tEXt chunks, converts generation parameters and full node graphs into the open `.deut` sidecar format — without uploading a single byte to any server.

[ Launch Web Version ](https://extractor.deut.li) · [ Open .deut Standard ](https://deut.li)

---

## Features

* **Deep recursive parsing** of ComfyUI node graphs (terminal node detection)
* **Full Automatic1111 / Forge** metadata extraction
* **Web Worker architecture** — non-blocking, handles 1000+ files instantly
* **Sidecar philosophy** — originals are never modified
* **Structured metadata header** included in sidecar files for traceability
* **Offline-capable PWA** (installable, no internet required after first load)
* **File System Access API** — direct folder processing, zero uploads

---

## Usage (Web)

Open `extractor.deut.li` in Chrome, Edge, or Arc and click **Select Folder**.

> **Tip:** Install as a PWA for the best experience. In Chrome/Edge, click the install icon (⊕) in the address bar or go to Menu → Install DEUTLI Extractor. Once installed, the app works fully offline — no internet connection required.

---

## Portable Versions & Security (Air-Gapped Usage)

Pre-compiled portable desktop builds are available on the [Releases](../../releases) page. These binaries are **unsigned** (no paid code-signing certificate). Your OS will display a security warning — this is expected. No installation is required.

### Windows (Portable .exe)
Microsoft Defender SmartScreen will block the launch of unsigned executables.
* **To bypass:** Click `More info` → `Run anyway`.
* **Alternatively:** Right-click the `.exe` → `Properties` → check `Unblock` → `OK`, then run normally.

### macOS (.app / .dmg)
Apple Gatekeeper will flag the app as an "unverified developer".
* **Option 1 (GUI):** Right-click the app → `Open` → confirm in the dialog.
* **Option 2 (Terminal):** Remove the quarantine flag entirely:
  `xattr -cr /path/to/DEUTLI\ Extractor.app`

### Linux (.AppImage)
The AppImage must be made executable before the first run.
* **Option 1 (GUI):** Right-click the file → `Properties` → `Permissions` → enable "Allow executing file as program".
* **Option 2 (Terminal):**
  `chmod +x DEUTLI_Extractor_x86_64.AppImage`
  `./DEUTLI_Extractor_x86_64.AppImage`

---

## Development

### Prerequisites
* Node.js 20+
* Rust (stable)
* [Tauri CLI prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites) for your OS

### Running locally (Web PWA)
Open `src/index.html` directly in Chrome/Edge or serve with any static server. No bundler required.

### Running locally (Desktop)
`npm install`
`npx tauri dev`

### Building Desktop Binaries
`npm run build`

Outputs are placed in `src-tauri/target/release/bundle/`.

### CI/CD
Pushing a tag matching `v*` triggers the GitHub Actions release matrix (`.github/workflows/release.yml`), which compiles binaries for Windows, macOS, and Linux simultaneously and uploads them to the GitHub Release draft.

---

**License**
MIT © DEUTLI
