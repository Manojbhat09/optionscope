# Desktop App Packaging — Decision & Plan

Status: **IMPLEMENTED** — `desktop/` shell + 3-OS release matrix live; sidecar
freeze verified locally (177MB one-file binary serves API+UI, see §6)

## 0. Terminology fix

What you described — *"independent from the browser, not staying on a browser
tab, works across Windows/Mac/Linux, ships as a downloadable"* — is a
**desktop application**. A "web app" is by definition browser-hosted.
Good news below: we do NOT need a different codebase for it.

## 1. What we already have (reusable as-is)

```
OptionScope (today)                      Desktop target (same repo!)
├─ src/ React UI      → npm run build ──► same build/ bundled INTO the app window
├─ backend/ Flask API ───────────────────► runs as a hidden sidecar process
└─ START_HERE scripts ───────────────────► replaced by double-click installer
```

The Electron/Tauri wrapper is a thin shell around exactly what you run now:
it opens a native window pointing at the local server instead of Chrome.

## 2. Options considered

| Approach | Install size | Toolchain | Verdict |
|---|---|---|---|
| **Electron + Python sidecar** | ~150–250 MB | Node only (we have it) | ✅ **Recommended** — most mature; electron-builder emits .exe/.dmg/.AppImage/.deb from CI matrix |
| Tauri v2 + sidecar | 5–20 MB ⭐ | Rust + system webviews | Fastest/smallest, but Rust toolchain + webview quirks = more failure modes for our stack |
| PyInstaller + pywebview | ~80–150 MB single binary | Python only | Native feel, but freezing pandas+sklearn+statsmodels is slow and fragile per-OS |
| PWA (installable site) | ~2 MB | none | Installs to its own window (no tab!), but still Chromium-managed — closest "free" option, not fully independent |

## 3. Recommended architecture (Electron)

```
┌──────────────── OptionScope.exe / .app / AppImage ───────────────┐
│                                                                  │
│  Electron main process                                           │
│   ├─ spawn: frozen backend (PyInstaller one-file, per-OS)        │
│   │          backend serves API + build/ on 127.0.0.1:<free>     │
│   ├─ wait for /api/health → create BrowserWindow                 │
│   │    width 1440 height 900, native title bar, dark bg flash    │
│   ├─ app quit ⇒ kill sidecar tree                                │
│   └─ tray icon (optional later): close-to-tray, quick open       │
│                                                                  │
│  Window content = today's exact React UI                         │
└──────────────────────────────────────────────────────────────────┘
```

Why the frozen-backend route: end users install NOTHING (no Python, no npm).
CI builds the sidecar once per OS with PyInstaller, electron-builder wraps it.

## 4. Release pipeline (extends existing release.yml)

```
tag v1.2.3 ──► GitHub Actions matrix
                ├─ windows-latest: PyInstaller backend.exe → electron-builder nsis zip
                ├─ macos-latest:   PyInstaller backend     → electron-builder dmg zip
                ├─ ubuntu-latest:  PyInstaller backend     → electron-builder AppImage/deb zip
                ▼
        GitHub Release page: 4 artifacts + portable source zip (current behavior)
```

## 5. Honest costs

- Repo gains `desktop/` (~150 lines of main.js + builder config) — no changes
  to app code except reading the dynamic port from a global injected by the shell.
- CI minutes: each release builds 3 OSes (~15–25 min).
- Code signing (no scary "unknown publisher" warnings) needs certificates
  ($$ on macOS/Windows) — fine to skip for personal releases initially.
- localStorage/chat JSONL keep working; data dir moves under the OS user-data
  folder (Electron provides the path — small migration helper).

## 6. Suggested order

1. ✅ Day/night theme
2. ✅ `/api/health` + `OPTIONSCOPE_BUILD_DIR` env + frozen-friendly data dir
3. ✅ `desktop/` Electron shell (`main.js` + electron-builder config) — sidecar freeze verified locally: `dist/optionscope-backend` serves health/providers/UI/bundle on a free port; dev fallback spawns source backend
4. ✅ `release.yml` 3-OS matrix (win nsis+zip / mac dmg x64+arm64 / linux AppImage+deb) → artifacts attached to the GitHub Release alongside the portable source zip
5. Later experiment: Tauri spike if size matters

First real end-to-end installer test happens in CI (or locally via
`cd desktop && npm install && npm start` with `BACKEND_DIR=../backend`).
