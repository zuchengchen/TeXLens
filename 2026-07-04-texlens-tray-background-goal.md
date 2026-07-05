# Goal: TeXLens Linux Tray Background Mode

## Goal Mode Objective

Follow the saved goal file at `/home/czc/projects/working/TeXLens/2026-07-04-texlens-tray-background-goal.md`; complete the task only when the verification section passes, and stop to ask if any listed stop condition occurs.

## Full Prompt

### Objective

Add Linux system tray support to TeXLens so that, while the Tauri app is running, the TeXLens icon appears in the desktop system tray; closing the main window hides it to the tray instead of exiting; left-clicking the tray icon restores and focuses the main window; and the tray context menu exposes `Show TeXLens` and `Quit`, where `Quit` truly exits the app.

### Context

TeXLens is a Tauri 2 + React desktop app in `/home/czc/projects/working/TeXLens`, currently targeting Linux/Manjaro AppImage first. `src-tauri/Cargo.toml` already enables the Tauri `tray-icon` feature, and `src-tauri/icons/icon.png` is an existing 512x512 app icon suitable as the tray icon. The app currently initializes in `src-tauri/src/lib.rs` and shows/focuses the main window during `.setup()`.

### Brainstorming Direction

Use a Rust desktop-shell implementation. The initial Tauri tray approach was expanded with user approval because Tauri's Linux tray click events are unsupported. Implement Linux tray behavior through a StatusNotifierItem/AppIndicator-compatible service so the tray icon can expose `Activate` for left-click restore/focus, provide a right-click menu with `Show TeXLens` and `Quit`, and intercept main-window close events so the app hides to tray rather than exiting. Keep startup behavior unchanged: the main window should still appear normally at launch.

### Discovery Summary

Confirmed decisions:
- Platform scope is Linux AppImage/current local Linux desktop only.
- Menu labels are English: `Show TeXLens` and `Quit`.
- Closing the main window hides it to tray.
- The sidecar and background tasks should continue running while the window is hidden.
- `Quit` is the intentional full-exit path.
- Documentation should mention the tray/background behavior.
- Verification must include `pnpm tauri:build` and manual tray behavior confirmation on the current local Linux desktop.
- If unrelated build failures block `pnpm tauri:build`, fixing those blockers is in scope, including editing currently modified files when needed.
- Approved scope expansion: replacing Tauri's tray event API with a Linux StatusNotifierItem implementation is allowed because left-click activation is part of the goal.

Assumptions:
- Prefer existing local dependency versions where possible, but Linux StatusNotifierItem support may use a focused Rust crate when Tauri's tray API cannot satisfy left-click activation.
- Manual verification is acceptable for tray behavior because system tray UI behavior is desktop-environment dependent.
- If the current desktop environment has no visible tray/AppIndicator area, document the limitation clearly and stop for user confirmation before relaxing the manual acceptance standard.

### Scope

Codex may inspect and edit:
- `src-tauri/src/lib.rs`
- `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` only if needed for tray/build support
- existing docs such as `docs/user-manual.md`, `README.md`, or `docs/developer-guide.md`
- build or test files only if required to pass verification

Codex may fix build blockers discovered by `pnpm tauri:build`, even when they involve existing uncommitted changes.

### Out Of Scope

Do not add Windows or macOS tray requirements. Do not change OCR model behavior, sidecar APIs, document recognition workflows, database/storage formats, or frontend product flows beyond what is necessary to respect tray/background behavior. Do not make startup hidden-to-tray by default.

### Verification

Required automated checks:
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `pnpm tauri:build`

Required manual check on the current local Linux desktop:
- Start TeXLens with `pnpm tauri:dev`.
- Confirm the TeXLens icon appears in the system tray while the app is running.
- Confirm right-clicking the tray icon shows `Show TeXLens` and `Quit`.
- Confirm closing the main window hides it to the tray instead of exiting.
- Confirm sidecar/background state is not intentionally stopped merely because the window is hidden.
- Confirm left-clicking the tray icon restores and focuses the main window.
- Confirm `Show TeXLens` restores and focuses the main window.
- Confirm `Quit` exits the app.

### Stop Conditions

Stop and ask the user before continuing if:
- The current Linux desktop environment appears not to support a visible tray/AppIndicator area, making the manual acceptance standard impossible.
- Passing `pnpm tauri:build` would require broad unrelated product changes rather than build fixes.
- The implementation would require changing OCR backend behavior, sidecar API contracts, or startup behavior to hidden-by-default.

## Notes

- Created for Codex Goal mode.
- Do not mark complete until the verification section passes or the user explicitly changes the completion standard.
