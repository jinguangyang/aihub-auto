# aihub-auto desktop

Tauri 2 shell for the existing Bun router. The desktop layer owns native windowing, the bundled sidecar process, tray actions and signed updates; routing, authentication and the operations UI remain in `apps/router`.

## Runtime

- Production binds the sidecar to `127.0.0.1:8787`; debug builds use 8798 so the remote capability allowlist stays fixed and auditable.
- The main window is created only after the sidecar prints its startup marker and `/healthz` returns 200.
- Closing the window hides it. The tray can show the window, open the live log view, check for updates or exit and stop the sidecar.
- Startup failure opens the bundled local `dist/index.html` page with the failure reason, port, config directory and restart action.
- The authenticated router `POST /ctl/restart` returns before shutting down. The standalone router exits with code `75`, which must be handled by a supervisor; this desktop shell automatically respawns its sidecar on that code. Ordinary tray/app shutdown exits with code `0` and is not respawned.
- The remote capability is limited to the main window and local router origins on ports 8787/8798.

## Development

Install Bun, Rust stable and the platform prerequisites from the [Tauri documentation](https://v2.tauri.app/start/prerequisites/), then run from the repository root:

```bash
bun install --frozen-lockfile
bun run desktop:sidecar
bun run desktop:dev
```

Windows builds require MSVC plus a Windows SDK. Release bundles require the updater key:

```bash
TAURI_SIGNING_PRIVATE_KEY="..." bun run desktop:build
```

The private key is never committed. GitHub Actions reads `TAURI_SIGNING_PRIVATE_KEY` from the repository secret and publishes Windows NSIS plus a portable x64 desktop ZIP, Debian/Ubuntu x64 `.deb`, and macOS DMG artifacts. The portable ZIP contains `aihub-auto-desktop.exe` and its colocated `aihub-auto-router.exe` sidecar; extract both files and run the desktop executable without installing. It is a desktop shell, unlike the separately published `aihub-auto-headless-*` router ZIPs. `tauri-action` also publishes minisign-verified updater archives and `latest.json` for Windows and macOS; Linux `.deb` updates through the system package manager. The public verification key is stored in `src-tauri/tauri.conf.json`. This updater signature does not replace Windows Authenticode or macOS Developer ID signing/notarization, which remain unconfigured.

`beforeDevCommand` and `beforeBuildCommand` run `scripts/prepare-desktop-sidecar.ts`. The script maps each Rust target triple to the matching Bun compile target and rejects unsupported triples instead of accidentally bundling a host binary.
