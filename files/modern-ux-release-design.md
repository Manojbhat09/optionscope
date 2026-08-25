# OptionScope — Modern UX Refresh + One-Click Setup + Release Build

Status: **IMPLEMENTED** (this pass) · Research-backed: 2026 SaaS dashboard pattern surveys
(saasui.design, augerelabs, mediaplus UI-trends, bento-grid guides)

## 1. What users asked for

1. Kill the raw username/password textboxes → **one Setup button opening a centered
   form over a dimmed page** where EVERY setting lives (creds, AI keys, dates).
2. Make the app clone-and-run for non-technical users → GitHub releases.
3. Modernize dashboard look & UX using current best practices.

## 2. Research → what we adopt

| 2026 pattern | Adopted here as |
|---|---|
| Responsible glassmorphism (translucency ONLY on overlays/sticky bars) | Setup modal backdrop-blur, sticky translucent top bar |
| Bento/modular cards: 16px+ radii, soft shadows, generous gaps | MUI theme overrides (global radius/shadow/font tokens) |
| Settings treated as product | Tabbed Settings Center, not scattered inputs |
| Empty states that onboard | "No data yet" card = 3-step quest w/ CTA button |
| Skeletons/inline cues over spinners; layout stability | kept CircularProgress inline in fetch button (short wait), cards hold height |
| Micro-interactions with intent | hover lifts on buttons/cards, 150ms ease transitions |
| ⌘K command palette | documented as future work (needs nav registry first) |

Deliberately NOT adopted: heavy frosted blur everywhere, dark-first default (dashboard is
data-dense light today; assistant already has dark mode), 3D/spatial extras.

## 3. Settings Center

```
        click ⚙ Setup ──►  ┌────────────────────────────────────┐
                           │ ▒▒ dimmed + blurred page behind ▒▒ │
                           │   ┌──────────────────────────┐     │
                           │   │ OptionScope Settings  ✕ │     │
                           │   │ [Account] [AI] [About]   │     │  ← tabs
                           │   │                          │     │
                           │   │ Robinhood username       │     │
                           │   │ password · date range    │     │
                           │   │ … AI provider keys …     │     │
                           │   │        [Cancel] [Save]   │     │
                           │   └──────────────────────────┘     │
                           └────────────────────────────────────┘
Esc / ✕ / backdrop click = close · Save persists to localStorage & closes
```

- Same storage keys as before (`chat_key_*`, custom endpoint fields) so the
  assistant sidebar and Spot Replay keep working unchanged — one source of truth,
  three doors into it.
- Dashboard top bar shrinks to: title · date-range pickers · [Fetch Data]
  [⚙ Setup]. Username/password live only in the modal now.
- Status chip shows connection state (`Connected · N trades` / `Not connected`).

## 4. Release build ("git clone → click")

```
repo/
├─ backend/app.py         ← serves ../build if present (single-server prod mode)
├─ START_HERE.sh / .bat   ← venv → pip install → npm install → build → launch :5000
└─ .github/workflows/release.yml  ← on tag v*: npm build + zip → GitHub Release
```

User story: download release zip (or clone) → double-click START_HERE → browser
opens at localhost:5000. No .env editing required to boot; keys entered in-app
(browser localStorage); optional server keys still read from .env if present.

## 5. Files

| File | Change |
|---|---|
| `src/components/settings/SettingsCenter.js` **new** | modal above |
| `src/OptionsAnalysisApp.js` | top bar replaces login paper; theme overrides; onboarding empty state |
| `src/index.css` | design tokens, card/button polish, transitions |
| `backend/app.py` | serve production `build/`; port from env |
| `backend/requirements.txt` | add missing `statsmodels`, `scikit-learn` (Spot Replay needs them) |
| `START_HERE.sh` / `START_HERE.bat` **new** | one-double-click launcher |
| `.github/workflows/release.yml` **new** | tag → build → release zip |
