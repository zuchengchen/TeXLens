import type { DocumentResult } from "./types";

export interface TexLensTestBridge {
  capture?: { path: string; captured_at: string };
  importPath?: string | null;
  initialDocument?: DocumentResult;
  savedLatexFiles?: { defaultName: string; latex: string }[];
  skipSidecar?: boolean;
}

declare global {
  interface Window {
    __TEXLENS_TEST__?: TexLensTestBridge;
  }
}

export function testBridge(): TexLensTestBridge | undefined {
  return typeof window === "undefined" ? undefined : window.__TEXLENS_TEST__;
}
