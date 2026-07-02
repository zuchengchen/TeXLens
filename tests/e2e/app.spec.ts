import { expect, type Page, type Route, test } from "@playwright/test";
import type { DocumentResult } from "../../src/types";

const sidecar = "http://127.0.0.1:8765";

test("loads TeXLens workbench", async ({ page }) => {
  await mockCommonSidecar(page);
  await page.goto("/");
  await expect(page.getByText("TeXLens")).toBeVisible();
  await expect(page.getByRole("button", { name: /截图/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /导入/ })).toBeVisible();
  await expect(page.locator(".notice")).toHaveCount(0);

  await page.getByRole("button", { name: /观测/ }).click();
  await expect(page.getByText("FastDeploy Log", { exact: true })).toBeVisible();
  await expect(page.getByText("Cache", { exact: true })).toBeVisible();
});

test("supports block selection, editing, repair diff, compile preview, and rerun", async ({ page }) => {
  const initial = sampleDocument("doc-ui", "Original paragraph", "table block");
  const rerun = sampleDocument("doc-ui", "Original paragraph", "rerun formula latex");
  await page.addInitScript((document) => {
    window.__TEXLENS_TEST__ = { initialDocument: document, savedLatexFiles: [], skipSidecar: true };
  }, initial);
  await mockCommonSidecar(page, {
    documents: [initial],
    onRequest: async (route, url) => {
      if (url.pathname === "/latex/repair") {
        await route.fulfill({
          json: {
            original: "edited table block",
            repaired: "repaired table block",
            changes: ["Repaired test LaTeX."],
            requires_confirmation: true,
          },
        });
        return true;
      }
      if (url.pathname === "/latex/compile") {
        await route.fulfill({
          json: { ok: true, returncode: 0, stdout: "compile ok", stderr: "", pdf_path: null },
        });
        return true;
      }
      if (url.pathname === "/ocr/rerun-block") {
        await route.fulfill({ json: rerun });
        return true;
      }
      return undefined;
    },
  });

  await page.goto("/");
  await expect(page.locator(".block-box")).toHaveCount(2);
  await page.locator(".block-box").nth(1).click();
  await expect(page.locator(".block-list button.active")).toContainText("table block");

  await page.locator(".monaco-editor").first().click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("edited table block");
  await expect(page.locator(".latex-preview")).toContainText("edited table block");

  await page.getByTitle("Repair").click();
  await expect(page.getByText("Repair Diff")).toBeVisible();
  await page.getByTitle("Apply repair").click();
  await expect(page.locator(".latex-preview")).toContainText("repaired table block");

  await page.getByTitle("Compile preview").click();
  await expect(page.getByText("Compile OK", { exact: true })).toBeVisible();

  await page.getByTitle("Rerun formula").click();
  await expect(page.locator(".latex-preview")).toContainText("rerun formula latex");
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
  await expect(page.locator(".latex-preview")).toContainText("merged after retry");
});

test("persists advanced runtime settings", async ({ page }) => {
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
  await expect(page.getByText("Prompts", { exact: true })).toBeVisible();
  await page.getByLabel("Hotkey").fill("Ctrl+Shift+M");
  await page.getByLabel("Cleanup").selectOption("manual_only");
  await page.locator(".prompt-grid textarea").nth(1).fill("Formula Recognition:\nReturn LaTeX only.");
  await page.locator(".settings-band.wide textarea").last().fill("TITLE={title}\n{body}\n");
  await page.getByRole("button", { name: "Save" }).click();

  await expect.poll(() => savedSettings).toBeTruthy();
  expect(savedSettings?.hotkey).toBe("Ctrl+Shift+M");
  expect(savedSettings?.cleanup_policy).toBe("manual_only");
  expect((savedSettings?.prompt_templates as Record<string, string>).formula).toContain("Return LaTeX only.");
  expect(savedSettings?.latex_template).toBe("TITLE={title}\n{body}\n");
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
  return {
    id,
    title: "sample",
    source_type: "image",
    source_path: "/tmp/sample.png",
    created_at: now,
    updated_at: now,
    status: "completed",
    pages: [
      {
        page: 1,
        image_path: "/tmp/sample.png",
        width: 800,
        height: 600,
        blocks: [
          {
            id: "b1",
            page: 1,
            block_type: "paragraph" as const,
            bbox: [0.08, 0.08, 0.78, 0.2] as [number, number, number, number],
            text: firstLatex,
            latex: firstLatex,
            raw: {},
          },
          {
            id: "b2",
            page: 1,
            block_type: "table" as const,
            bbox: [0.08, 0.34, 0.78, 0.52] as [number, number, number, number],
            text: secondLatex,
            latex: secondLatex,
            raw: {},
          },
        ],
      },
    ],
    latex: `${firstLatex}\n\n${secondLatex}`,
    raw: {},
    metrics: {},
  };
}

function pdfTask(overrides: Record<string, unknown>) {
  const now = new Date().toISOString();
  return {
    id: "task",
    source_path: "/tmp/sample.pdf",
    source_type: "pdf",
    mode: "auto",
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
    prompt_templates: {
      auto: "OCR:",
      formula: "Formula Recognition:",
      table: "Table Recognition:",
      text: "OCR:",
    },
    latex_template: [
      "\\documentclass[UTF8]{ctexart}",
      "\\title{{title}}",
      "\\begin{document}",
      "{body}",
      "\\end{document}",
      "",
    ].join("\n"),
    latex_engine: "xelatex",
  };
}
