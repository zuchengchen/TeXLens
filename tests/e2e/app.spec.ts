import { expect, type Page, type Route, test } from "@playwright/test";
import type { DocumentResult } from "../../src/types";

const sidecar = "http://127.0.0.1:8765";

test("loads TeXLens workbench", async ({ page }) => {
  await mockCommonSidecar(page);
  await page.goto("/");
  await expect(page.getByText("TeXLens")).toBeVisible();
  await expect(page.getByRole("button", { name: /截图/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /导入/ })).toBeVisible();
  await expect(page.locator(".status-strip")).toContainText("1024/8192 MiB");
  await expect(page.locator(".notice")).toHaveCount(0);

  await page.getByRole("button", { name: /观测/ }).click();
  await expect(page.getByText("FastDeploy Log", { exact: true })).toBeVisible();
  await expect(page.getByText("Cache", { exact: true })).toBeVisible();
});

test("falls back to the latest recorded GPU metric when live collection is empty", async ({ page }) => {
  const snapshot = {
    ...observability(),
    gpu: [],
    cache: {
      tasks: [],
      metrics: [
        { duration_ms: 120, gpu: [] },
        {
          duration_ms: 95,
          gpu: [
            {
              timestamp: new Date().toISOString(),
              name: "NVIDIA GeForce RTX 3060 Laptop GPU",
              memory_used_mib: 2819,
              memory_total_mib: 6144,
              utilization_percent: 86,
            },
          ],
        },
      ],
    },
  };
  await mockCommonSidecar(page, {
    onRequest: async (route, url) => {
      if (url.pathname === "/observability") {
        await route.fulfill({ json: snapshot });
        return true;
      }
      return undefined;
    },
  });

  await page.goto("/");
  await expect(page.locator(".status-strip")).toContainText("最近 2819/6144 MiB");
  await page.getByRole("button", { name: /观测/ }).click();
  await expect(page.locator(".metric").filter({ hasText: "VRAM" })).toContainText("最近 2819/6144 MiB");
});

test("supports body editing, full-source save, compile preview, and compile errors", async ({ page }) => {
  const initial = sampleDocument("doc-ui", "Original paragraph", "table body");
  let compileRequests = 0;
  let forceCompileFailure = false;
  const compiledLatex: string[] = [];
  await page.addInitScript((document) => {
    window.__TEXLENS_TEST__ = { initialDocument: document, savedLatexFiles: [], skipSidecar: true };
  }, initial);
  await mockCommonSidecar(page, {
    documents: [initial],
    onRequest: async (route, url) => {
      if (url.pathname === "/latex/compile") {
        compileRequests += 1;
        compiledLatex.push((route.request().postDataJSON() as { latex: string }).latex);
        if (forceCompileFailure) {
          await route.fulfill({
            json: {
              ok: false,
              returncode: 1,
              stdout: "! Undefined control sequence.",
              stderr: "",
              error_summary: "! Undefined control sequence.",
              pdf_path: null,
              preview_image_paths: [],
            },
          });
          return true;
        }
        await route.fulfill({
          json: {
            ok: true,
            returncode: 0,
            stdout: "compile ok",
            stderr: "",
            pdf_path: `/tmp/preview-${compileRequests}.pdf`,
            preview_image_paths: [`/tmp/preview-${compileRequests}-1.png`, `/tmp/preview-${compileRequests}-2.png`],
          },
        });
        return true;
      }
      return undefined;
    },
  });

  await page.goto("/");
  await expect(page.locator(".compiled-preview-panel")).toContainText("编译成功");
  await expect(page.locator(".compiled-preview-panel iframe")).toHaveCount(1);
  const initialCompileRequests = compileRequests;

  await expect(page.locator(".block-list")).toHaveCount(0);
  await expect(page.locator(".source-stage img")).toHaveCount(1);
  await expect(page.locator(".monaco-editor").first()).toContainText("Original paragraph");

  await page.locator(".monaco-editor").first().click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("edited body source");
  await expect.poll(() => compileRequests).toBeGreaterThan(initialCompileRequests);
  expect(compiledLatex.at(-1)).toContain("edited body source");
  expect(compiledLatex.at(-1)).toContain("\\begin{document}");
  expect(compiledLatex.at(-1)).toContain("\\end{document}");

  await page.getByTitle("Save TeX").click();
  const saved = await page.evaluate(
    () =>
      (window as Window & { __TEXLENS_TEST__?: { savedLatexFiles?: { latex: string }[] } }).__TEXLENS_TEST__
        ?.savedLatexFiles ?? [],
  );
  expect(saved.at(-1)?.latex).toContain("edited body source");
  expect(saved.at(-1)?.latex).toContain("\\documentclass[UTF8]{ctexart}");

  await page.getByTitle("Compile preview").click();
  await expect(page.locator(".compiled-preview-panel")).toContainText("编译成功");

  forceCompileFailure = true;
  await page.locator(".monaco-editor").first().click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("\\broken");
  await expect(page.locator(".compiled-preview-panel")).toContainText("编译失败");
  await expect(page.locator(".editor-error")).toContainText("Undefined control sequence");
  await expect(page.locator(".compiled-preview-panel img")).toHaveCount(0);
});

test("renders the full compiled preview as scrollable pages", async ({ page }) => {
  const initial = sampleDocument("doc-full-preview", "Page one", "Page two");
  const previewPages = Array.from({ length: 24 }, (_, index) => `/tmp/full-preview-${index + 1}.png`);
  await page.addInitScript((document) => {
    window.__TEXLENS_TEST__ = { initialDocument: document, skipSidecar: true };
  }, initial);
  await mockCommonSidecar(page, {
    onRequest: async (route, url) => {
      if (url.pathname === "/latex/compile") {
        await route.fulfill({
          json: {
            ok: true,
            returncode: 0,
            stdout: "compile ok",
            stderr: "",
            pdf_path: "/tmp/full-preview.pdf",
            preview_image_paths: previewPages,
          },
        });
        return true;
      }
      return undefined;
    },
  });

  await page.goto("/");
  await expect(page.locator(".compiled-preview-panel")).toContainText("编译成功 · 完整 PDF · 已生成 24 页图");
  await expect(page.locator(".compiled-preview-panel iframe")).toHaveCount(1);
  const previewStage = page.locator(".compiled-preview-stage");
  await expect.poll(async () => previewStage.evaluate((element) => element.clientHeight > 0)).toBe(true);
  await expect(page.locator(".compiled-preview-stage.pdf-viewer")).toHaveCount(1);
  await page.getByTitle("页图").click();
  await expect(page.locator(".compiled-preview-stage.pdf-viewer")).toHaveCount(0);
  await expect(page.locator(".compiled-preview-panel img")).toHaveCount(24);
  await expect
    .poll(async () =>
      previewStage.evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true);
  await previewStage.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(async () => previewStage.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test("opens a history document into the workbench and auto compiles it", async ({ page }) => {
  const historyDocument = {
    ...sampleDocument("doc-history", "History paragraph", "History formula"),
    title: "History Preview Sample",
  };
  let compileRequests = 0;
  await mockCommonSidecar(page, {
    documents: [historyDocument],
    onRequest: async (route, url) => {
      if (url.pathname === "/latex/compile") {
        compileRequests += 1;
        await route.fulfill({
          json: {
            ok: true,
            returncode: 0,
            stdout: "compile ok",
            stderr: "",
            pdf_path: "/tmp/history-preview.pdf",
            preview_image_paths: ["/tmp/history-preview-1.png", "/tmp/history-preview-2.png", "/tmp/history-preview-3.png"],
          },
        });
        return true;
      }
      return undefined;
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: /历史/ }).click();
  await page.getByRole("button", { name: /History Preview Sample/ }).click();
  await expect(page.locator(".workspace")).toBeVisible();
  await expect(page.locator(".original-preview-panel")).toContainText("原始预览");
  await expect.poll(() => compileRequests).toBeGreaterThan(0);
  await expect(page.locator(".compiled-preview-panel")).toContainText("编译成功 · 完整 PDF · 已生成 3 页图");
  await expect(page.locator(".compiled-preview-panel iframe")).toHaveCount(1);
});

test("auto compiles each capture and refreshes reused preview paths", async ({ page }) => {
  await page.addInitScript(() => {
    window.__TEXLENS_TEST__ = {
      capture: { path: "/tmp/capture.png", captured_at: new Date().toISOString() },
      skipSidecar: true,
    };
  });

  const firstCapture = sampleDocument("doc-capture-1", "First capture paragraph", "first formula");
  const secondCapture = sampleDocument("doc-capture-2", "Second capture paragraph", "second formula");
  const captures = [firstCapture, secondCapture];
  let recognitionRequests = 0;
  let compileRequests = 0;

  await mockCommonSidecar(page, {
    documents: captures,
    onRequest: async (route, url) => {
      if (url.pathname === "/ocr/recognize") {
        const document = captures[Math.min(recognitionRequests, captures.length - 1)];
        recognitionRequests += 1;
        await route.fulfill({ json: document });
        return true;
      }
      if (url.pathname === "/latex/compile") {
        compileRequests += 1;
        await route.fulfill({
          json: {
            ok: true,
            returncode: 0,
            stdout: "compile ok",
            stderr: "",
            pdf_path: "/tmp/shared-preview.pdf",
            preview_image_paths: ["/tmp/shared-preview-1.png"],
          },
        });
        return true;
      }
      return undefined;
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: /截图/ }).click();
  await expect(page.locator(".monaco-editor").first()).toContainText("First capture paragraph");
  await expect.poll(() => compileRequests).toBeGreaterThan(0);
  await expect(page.locator(".compiled-preview-panel iframe")).toHaveAttribute("src", /texlensPreview=/);
  const firstCompileRequests = compileRequests;
  const firstPreviewSrc = await page.locator(".compiled-preview-panel iframe").getAttribute("src");

  await page.getByRole("button", { name: /截图/ }).click();
  await expect(page.locator(".monaco-editor").first()).toContainText("Second capture paragraph");
  await expect.poll(() => compileRequests).toBeGreaterThan(firstCompileRequests);
  await expect(page.locator(".compiled-preview-panel iframe")).toHaveAttribute("src", /texlensPreview=/);
  const secondPreviewSrc = await page.locator(".compiled-preview-panel iframe").getAttribute("src");

  expect(recognitionRequests).toBe(2);
  expect(secondPreviewSrc).not.toBe(firstPreviewSrc);
});

test("shows PDF task progress and cancellation", async ({ page }) => {
  await page.addInitScript(() => {
    window.__TEXLENS_TEST__ = { importPath: "/tmp/cancel.pdf", skipSidecar: true };
  });

  let cancelled = false;
  const runningTask = pdfTask({
    id: "task-cancel",
    status: "running",
    current_page: 1,
    completed_pages: 0,
    pages: [
      { page: 1, status: "running" },
      { page: 2, status: "pending" },
    ],
  });
  const cancelledTask = pdfTask({
    id: "task-cancel",
    status: "cancelled",
    completed_pages: 0,
    pages: [
      { page: 1, status: "running" },
      { page: 2, status: "pending" },
    ],
    cancel_requested: true,
  });
  await mockCommonSidecar(page, {
    onRequest: async (route, url) => {
      if (url.pathname === "/ocr/tasks/pdf") {
        await route.fulfill({ json: runningTask });
        return true;
      }
      if (url.pathname === "/ocr/tasks/task-cancel/cancel") {
        cancelled = true;
        await route.fulfill({ json: cancelledTask });
        return true;
      }
      if (url.pathname === "/ocr/tasks/task-cancel") {
        await route.fulfill({ json: cancelled ? cancelledTask : runningTask });
        return true;
      }
      return undefined;
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: /导入/ }).click();
  await expect(page.locator(".task-panel")).toContainText("running");
  await expect(page.locator(".task-panel")).toContainText("1:running");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".task-panel")).toContainText("cancelled");
});

test("retries failed PDF pages and loads the merged document", async ({ page }) => {
  await page.addInitScript(() => {
    window.__TEXLENS_TEST__ = { importPath: "/tmp/retry.pdf", skipSidecar: true };
  });

  const failed = pdfTask({
    id: "task-retry",
    status: "completed_with_errors",
    completed_pages: 1,
    pages: [
      { page: 1, status: "completed" },
      { page: 2, status: "failed", error: "boom" },
    ],
    failed_pages: [{ page: 2, status: "failed", error: "boom" }],
    document: sampleDocument("doc-failed", "ok page", "failed page"),
  });
  const retrying = { ...failed, status: "retrying", current_page: 2, cancel_requested: false };
  const completedDocument = sampleDocument("doc-retry", "ok page", "merged after retry");
  const completed = pdfTask({
    id: "task-retry",
    status: "completed",
    completed_pages: 2,
    pages: [
      { page: 1, status: "completed" },
      { page: 2, status: "completed" },
    ],
    failed_pages: [],
    document: completedDocument,
  });
  let retryRequested = false;
  await mockCommonSidecar(page, {
    onRequest: async (route, url) => {
      if (url.pathname === "/ocr/tasks/pdf") {
        await route.fulfill({ json: failed });
        return true;
      }
      if (url.pathname === "/ocr/tasks/task-retry/retry-failed") {
        retryRequested = true;
        await route.fulfill({ json: retrying });
        return true;
      }
      if (url.pathname === "/ocr/tasks/task-retry") {
        await route.fulfill({ json: retryRequested ? completed : failed });
        return true;
      }
      return undefined;
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: /导入/ }).click();
  await expect(page.locator(".task-panel")).toContainText("completed_with_errors");
  await expect(page.locator(".task-panel")).toContainText("Page 2: boom");
  await page.getByRole("button", { name: "Retry failed" }).click();
  await expect(page.locator(".task-panel")).toContainText("completed");
  await expect(page.locator(".monaco-editor").first()).toContainText("merged after retry");
});

test("persists core runtime settings", async ({ page }) => {
  let savedSettings: Record<string, unknown> | undefined;
  await mockCommonSidecar(page, {
    onRequest: async (route, url) => {
      if (url.pathname === "/settings" && route.request().method() === "PUT") {
        savedSettings = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({ json: { ...runtimeSettings(), ...savedSettings } });
        return true;
      }
      return undefined;
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: /设置/ }).click();
  await expect(page.getByText("Prompts", { exact: true })).toHaveCount(0);
  await expect(page.getByText("LaTeX Template", { exact: true })).toHaveCount(0);
  await page.getByLabel("Hotkey").fill("Ctrl+Shift+M");
  await page.getByLabel("Cleanup").selectOption("manual_only");
  await page.getByRole("button", { name: "Save" }).click();

  await expect.poll(() => savedSettings).toBeTruthy();
  expect(savedSettings?.hotkey).toBe("Ctrl+Shift+M");
  expect(savedSettings?.cleanup_policy).toBe("manual_only");
  expect(savedSettings).not.toHaveProperty("prompt_templates");
  expect(savedSettings).not.toHaveProperty("latex_template");
});

async function mockCommonSidecar(
  page: Page,
  options: {
    documents?: unknown[];
    onRequest?: (route: Route, url: URL) => Promise<boolean | undefined>;
  } = {},
) {
  await page.route(`${sidecar}/**`, async (route) => {
    const url = new URL(route.request().url());
    const handled = await options.onRequest?.(route, url);
    if (handled !== undefined) return;
    if (url.pathname === "/observability") return route.fulfill({ json: observability() });
    if (url.pathname === "/history") return route.fulfill({ json: options.documents ?? [] });
    if (url.pathname === "/models/check") return route.fulfill({ json: { exists: true } });
    if (url.pathname === "/settings") return route.fulfill({ json: runtimeSettings() });
    if (url.pathname === "/fastdeploy/logs") return route.fulfill({ json: { log: "test log" } });
    if (url.pathname === "/fastdeploy/status") {
      return route.fulfill({ json: observability().service });
    }
    return route.fulfill({ status: 404, json: { detail: url.pathname } });
  });
}

function sampleDocument(id: string, firstLatex: string, secondLatex: string): DocumentResult {
  const now = new Date().toISOString();
  const body = `${firstLatex}\n\n${secondLatex}`;
  return {
    id,
    title: "sample",
    source_type: "image",
    source_path: "/tmp/sample.png",
    created_at: now,
    updated_at: now,
    status: "completed",
    body,
    latex: fullLatex(body),
    raw: {},
    original_copy_path: "/tmp/sample.png",
    metrics: {},
  };
}

function pdfTask(overrides: Record<string, unknown>) {
  const now = new Date().toISOString();
  return {
    id: "task",
    source_path: "/tmp/sample.pdf",
    source_type: "pdf",
    title: "sample.pdf",
    status: "pending",
    current_page: null,
    total_pages: 2,
    completed_pages: 0,
    pages: [],
    failed_pages: [],
    cancel_requested: false,
    document_id: null,
    document: null,
    error: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function observability() {
  return {
    service: {
      running: true,
      pid: 1234,
      endpoint: "http://127.0.0.1:8185",
      healthy: true,
      raw_status: { ok: true },
    },
    gpu: [{ timestamp: new Date().toISOString(), name: "GPU", memory_used_mib: 1024, memory_total_mib: 8192 }],
    queue_depth: 0,
    cache: { tasks: [] },
    recent_errors: [],
    request_durations_ms: [1200],
  };
}

function runtimeSettings() {
  return {
    model_dir: "/tmp/model",
    fastdeploy_python: "python",
    fastdeploy_args: ["--gpu-memory-utilization", "0.6"],
    history_days: 30,
    cleanup_policy: "history_ttl",
    hotkey: "Ctrl+Alt+M",
    latex_engine: "xelatex",
  };
}

function fullLatex(body: string): string {
  return [
    "\\documentclass[UTF8]{ctexart}",
    "\\usepackage{amsmath,amssymb}",
    "\\usepackage{booktabs,longtable,array,graphicx}",
    "\\usepackage[margin=2.5cm]{geometry}",
    "\\title{sample}",
    "\\date{}",
    "\\begin{document}",
    "\\maketitle",
    "",
    body,
    "",
    "\\end{document}",
    "",
  ].join("\n");
}
