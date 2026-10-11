# Installing the Rocky desktop app

The desktop app is a window around Rocky's local daemon (roadmap A1). It bundles everything
Rocky needs except [Ollama](https://ollama.com/download), which runs the local models. Developers
can still run from a checkout instead: see the README's Quickstart.

Download the installer for your system from the
[latest release](https://github.com/dhrma-tech/Rocky/releases):

| System | File | Built on |
| --- | --- | --- |
| Windows 10/11 (x64) | `Rocky-Setup-<version>.exe` | GitHub Actions `windows-latest` |
| macOS (Apple Silicon) | `Rocky-<version>-arm64.dmg` | GitHub Actions `macos-latest` |
| Linux (x64) | `Rocky-<version>-<arch>.AppImage` or the `.deb` beside it | GitHub Actions `ubuntu-latest` |

`SHA256SUMS.txt` in the release lists the checksum of each file. Check it before running the
installer: `certutil -hashfile Rocky-Setup-<version>.exe SHA256` (Windows) or
`shasum -a 256 <file>` (macOS, Linux).

## The installers are not signed yet

Code signing certificates cost money and Rocky has no budget, so the first launch shows a
warning. This is expected; it does not mean the file was changed. Check the checksum above, then:

- **Windows (SmartScreen):** "Windows protected your PC" → **More info** → **Run anyway**.
  Rocky installs for your user only (no admin prompt) into `%LOCALAPPDATA%\Programs\Rocky`, or a
  folder you choose.
- **macOS (Gatekeeper):** the first time, right-click (or Control-click) Rocky in Applications →
  **Open** → **Open**. If macOS says the app "is damaged", run
  `xattr -dr com.apple.quarantine /Applications/Rocky.app` in Terminal and open it again.
- **Linux:** for the AppImage, `chmod +x Rocky-*.AppImage` and run it. For the .deb,
  `sudo apt install ./Rocky-*.deb`.

Free code signing for open-source projects (for example SignPath's OSS program on Windows) is
being looked into; the README will say when installers are signed.

## What happens on first launch

1. The app starts Rocky's daemon on this computer (`127.0.0.1` only) and signs the window in.
2. Setup asks for a name and colour, then a model. Rocky checks this computer's memory and
   whether Ollama is running. If Ollama has no model that can answer, it offers to download one
   sized for this computer (`qwen3.5:4b` with 12 GB of memory or more, otherwise `qwen3.5:2b`),
   or you can use an API key instead.
3. Rocky turns on **start at sign-in**, so routines and syncs run while you work. Turn it off
   with `rocky daemon uninstall`, or uninstall the app.

Closing the window leaves the daemon running; opening the app again reconnects.

## Where things are

- **Your data:** `%APPDATA%\Rocky` (Windows), `~/Library/Application Support/Rocky` (macOS),
  `~/.local/share/Rocky` (Linux). Set `ROCKY_DATA_DIR` to put it elsewhere.
- **Keys and tokens:** the OS keychain (Windows Credential Manager, macOS Keychain, the Secret
  Service on Linux). Never in files.
- **Uninstalling** removes the app and the start-at-sign-in entry and keeps your data folder.
  Delete that folder too if you want everything gone, or use Settings > Privacy > Delete
  everything first.

## Known limits

- Only the Windows installer has been installed, run and uninstalled on a real machine
  (2026-10-11). The macOS and Linux builds are produced and checked by CI (the bundled CLI runs
  and loads SQLite and sqlite-vec) but have not been opened on those systems yet.
- macOS builds are for Apple Silicon only.
- No automatic updates yet: install the new version over the old one.
- Docker is not offered: Rocky keeps secrets only in the OS keychain, which a container does not
  have (docs/DECISIONS.md D-052).
