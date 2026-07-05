# Goal: LaTeX 编译结果自动预览

## Goal Mode Objective

Follow the saved goal file at `/home/czc/projects/working/TeXLens/2026-07-03-latex-compile-preview-goal.md`; complete the LaTeX compiled-output preview feature only when the verification section passes, and stop to ask if any listed stop condition occurs.

## Full Prompt

### Objective

在 TeXLens 工作台左侧原始图片预览区下方增加 LaTeX 编译结果预览区，使用户可以上下对比原始 OCR 图片和编译后的视觉结果；识别、导入、打开历史文档后自动编译整篇 `activeDocument.latex`，编辑停止 1.5 秒后自动刷新预览。

### Context

项目位于 `/home/czc/projects/working/TeXLens`。当前已有 LaTeX 编译相关能力：

- 前端 `src/App.tsx` 已有 `compileCurrentLatex()`、`Compile preview` 按钮和 `compileResult` 状态。
- Tauri 命令 `src-tauri/src/lib.rs` 已有 `compile_latex_preview`，目前主要返回单页 `preview_image_path`。
- sidecar `/latex/compile` 也有浏览器 fallback，但本目标只要求 Tauri 桌面端真实体验。
- 左侧当前主要显示 OCR 原始图片；右侧显示编辑器、修复 diff、源码预览等。

### Brainstorming Direction

采用“左侧原图下方固定编译预览区”的方案。自动和手动编译都刷新同一个左侧预览区，用户能直接对比原图与编译结果；右侧保留源码预览，但要明确命名或视觉区分，避免和编译预览混淆。

### Discovery Summary

已确认：

- 编译范围：整篇文档 `activeDocument.latex`。
- 自动触发：识别/导入/打开历史文档后自动编译；编辑停止 1.5 秒后自动编译。
- 失败行为：清空编译预览，只显示最新错误摘要。
- 页面范围：渲染多页预览，自动预览最多前 20 页。
- 加载状态：预览区显示加载遮罩。
- 手动按钮：保留 `Compile preview`，作为立即刷新入口。
- 平台范围：只要求 Tauri 桌面端；浏览器 fallback 不作为必须支持项。
- 接口方向：扩展 `compile_latex_preview`，一次编译返回多页图片路径。
- 文档：更新用户手册。
- 验收：自动检查加桌面端手动验收。

默认和假设：

- 继续使用现有 `latexmk` / `xelatex`，不新增 LaTeX 引擎。
- 不做逐字实时编译，只做 1.5 秒 debounce。
- 自动预览最多 20 页；不额外实现“渲染全部”按钮。
- 不需要数据库迁移或持久化新的预览状态。

### Scope

可以修改：

- `src/App.tsx`
- `src/styles.css`
- `src/types.ts`
- `src/api.ts`
- `src-tauri/src/lib.rs`
- 相关前端/e2e/单元测试
- `docs/user-manual.md`

需要实现：

- 左侧原始图片预览下方新增编译结果预览区。
- 自动编译整篇文档，并使用 1.5 秒 debounce。
- 防止过期编译结果覆盖新结果。
- 编译中显示加载遮罩。
- 编译失败时清空预览并显示错误摘要。
- Tauri `compile_latex_preview` 返回多页预览图片路径，最多 20 页。
- 手动 `Compile preview` 复用同一个左侧预览区。
- 右侧源码预览保留但更清晰命名/区分。
- 更新用户手册说明自动预览、手动刷新、失败提示和页数限制。

### Out Of Scope

- 不要求浏览器 fallback 支持多页预览。
- 不实现实时逐字编译。
- 不新增云服务或外部 API。
- 不新增 LaTeX 引擎。
- 不做超过 20 页的自动预览。
- 不重构无关 OCR、FastDeploy、历史存储或截图逻辑。

### Verification

必须运行并通过：

```bash
cargo check --manifest-path src-tauri/Cargo.toml
pnpm test
```

如修改了 e2e 或关键 UI 流程，还要运行：

```bash
pnpm exec playwright test
```

如修改了 sidecar 相关代码，还要运行：

```bash
uv run --project sidecar pytest
```

必须进行桌面端手动验收：

1. 启动 TeXLens：`pnpm tauri:dev`。
2. 导入或识别一张样例图片/PDF。
3. 确认左侧上方显示原始图片，下方显示编译后的 LaTeX 预览。
4. 修改右侧 LaTeX 内容，停止输入约 1.5 秒后，确认左侧编译预览自动刷新。
5. 构造错误 LaTeX，确认预览被清空并显示错误摘要。
6. 使用可生成多页 PDF 的 LaTeX，确认左侧预览可以滚动查看多页，最多渲染前 20 页。
7. 点击手动 `Compile preview`，确认刷新的是左侧同一个编译预览区。

### Stop Conditions

停止并询问用户，而不是猜测：

- 本机缺少 `pdftoppm`、`latexmk` 或 `xelatex`，导致无法真实生成预览。
- Tauri asset protocol 无法加载生成的多页预览图片，需要扩大权限或改变输出目录。
- 自动编译明显卡顿，需要调整 debounce、取消策略或页数限制。
- 现有 `compile_latex_preview` 结构无法兼容多页返回且会破坏其他功能。
- 实现需要大幅重构工作台布局或引入新依赖。
- 验证命令失败且不是本次改动能安全修复的问题。

## Notes

- Created for Codex Goal mode.
- Do not mark complete until the verification section passes or the user explicitly changes the completion standard.
