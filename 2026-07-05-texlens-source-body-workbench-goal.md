# Goal: TeXLens Source-Body Workbench Refactor

## Goal Mode Objective

Follow the saved goal file at `/home/czc/projects/working/TeXLens/2026-07-05-texlens-source-body-workbench-goal.md`; complete the TeXLens source-body workbench refactor only when the verification section passes, and stop to ask if any listed stop condition occurs.

## Full Prompt

### Objective

Refactor TeXLens into a simplified document-level LaTeX body editing workflow: remove the middle Blocks column and block-level concepts end-to-end, keep the left source/compiled preview area, make the right side a single editable LaTeX body editor with Copy LaTeX, Save TeX, and Compile preview actions, and update frontend, sidecar, tests, and docs accordingly.

### Context

Repo: `/home/czc/projects/working/TeXLens`.

TeXLens is a Tauri 2 + React/TypeScript app with a Python FastAPI sidecar. The current workbench has a three-column layout: left source/compiled preview, middle block list, and right editor. The current data flow still exposes document pages/blocks, block rerun, repair, recognition modes, prompt templates, and an editable LaTeX template. The desired product direction is a simpler source-body workflow where recognition automatically produces editable document LaTeX body content.

Relevant files likely include:

- Frontend: `src/App.tsx`, `src/styles.css`, `src/store.ts`, `src/types.ts`, `src/api.ts`, `src/store.test.ts`, `tests/e2e/app.spec.ts`
- Sidecar: `sidecar/src/texlens_sidecar/models.py`, `ocr.py`, `fastdeploy.py`, `app.py`, `storage.py`, `config.py`, and `sidecar/tests/`
- Tauri files only if frontend commands, tray behavior, or build integration requires it.

Respect the dirty worktree. Do not revert unrelated existing changes, including prior tray/icon/restart work.

### Brainstorming Direction

Use the approved "complete source mode" direction:

- Delete block-level UI and APIs instead of merely hiding them.
- Final documents should be document-level, centered on LaTeX/body content and source path.
- Do not preserve old history compatibility; old records may fail and users can clear/re-recognize.
- Recognition is automatic; remove recognition mode selectors and prompt template configuration.
- Compile wraps the editable body with a fixed internal LaTeX template.
- The editor displays only the body, not the preamble or `\begin{document}` / `\end{document}`.

### Discovery Summary

Answered decisions:

- Remove the middle Blocks column.
- Right side has one editable LaTeX body editor only.
- Keep Copy LaTeX, Save TeX, and Compile preview buttons.
- Copy LaTeX copies body only.
- Save TeX saves a complete `.tex` file generated from the body plus fixed internal template.
- Compile preview compiles the body by wrapping it with the fixed internal template.
- Compile errors appear under the editor in the right-side source area.
- Remove Repair and block rerun behavior.
- Left side keeps original/import source preview: screenshots/images show the original image; PDFs show the full original PDF.
- Left lower area keeps compiled PDF preview on successful compile.
- Remove prompt templates and editable LaTeX template settings UI.
- Keep core settings for model/service/hotkey.
- Remove repair API/tests.
- Keep PDF OCR task page-count progress such as total/current/completed pages, but final documents should not expose pages/blocks.
- Update README, user manual, and developer guide.
- Full verification is required.

Assumptions and skipped areas:

- No migration path for old persisted documents.
- No feature flag or dual-mode rollout.
- Old clients may receive 404/422 for deleted APIs/fields.
- Backend may keep internal helper structures only if they are not exposed as product-facing document pages/blocks.

### Scope

Codex may change frontend, sidecar, tests, docs, and build-related integration needed for this refactor.

In scope:

- Replace the three-column workbench with a two-area source/body workflow.
- Remove block list UI, selected-block editing, block repair, and block rerun controls.
- Convert editor state to body-only editing.
- Add or centralize helpers to split/wrap full LaTeX into body/full-source forms.
- Update persistence/store/API/types to use document-level LaTeX/body data.
- Remove recognition mode and prompt template frontend/backend surfaces.
- Remove repair and rerun-block endpoints/client calls/tests.
- Keep PDF task progress while simplifying final document shape.
- Rewrite affected unit, sidecar, and e2e tests.
- Update docs to describe the new workflow.

### Out Of Scope

- Do not redesign unrelated tray/menu/icon behavior.
- Do not add a new rich text editor or visual LaTeX editor.
- Do not add old-data migration unless required to make the new app start cleanly.
- Do not preserve legacy block APIs for compatibility.
- Do not introduce cloud sync, accounts, or new OCR providers.
- Do not silently broaden the work into unrelated UI redesign.

### Verification

Run and require passing results for:

```bash
pnpm lint
pnpm test
pnpm e2e
uv run --project sidecar pytest sidecar/tests
cargo check --manifest-path src-tauri/Cargo.toml
pnpm tauri:build
```

Manual acceptance criteria:

- After recognition, the workbench has no middle Blocks column.
- Right side shows only editable LaTeX body content.
- The editor does not show the preamble or `\begin{document}` / `\end{document}`.
- Copy LaTeX copies body only.
- Save TeX writes complete LaTeX source with the internal template wrapper.
- Compile preview uses the edited body and shows compiled PDF preview or inline compile errors.
- Screenshot/image source preview shows the original image.
- PDF source preview shows the full original PDF.
- Settings no longer expose prompt templates or editable LaTeX templates.
- Repair/rerun block actions are gone from UI and API expectations.

### Stop Conditions

Stop and ask the user before continuing if:

- A required verification command cannot run because of missing system dependencies or environment setup.
- Removing block/page fields would require deleting unrelated user data outside TeXLens app storage.
- The existing sidecar OCR pipeline cannot produce document-level LaTeX/body without a larger model or prompt redesign.
- A change would require reverting unrelated dirty worktree changes.
- `pnpm tauri:build` exposes unrelated platform packaging failures that are not caused by this refactor.
- The implementation must choose between incompatible storage formats not covered by this prompt.

## Notes

Created for Codex Goal mode. Do not mark complete until the verification section passes or the user explicitly changes the completion standard.
