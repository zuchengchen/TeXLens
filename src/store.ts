import { create } from "zustand";
import type { DocumentResult, EnvironmentReport, OCRBlock, ObservabilitySnapshot, RecognitionMode } from "./types";

interface AppState {
  activeDocument?: DocumentResult;
  selectedBlockId?: string;
  environment?: EnvironmentReport;
  observability?: ObservabilitySnapshot;
  history: DocumentResult[];
  mode: RecognitionMode;
  busy: boolean;
  error?: string;
  setActiveDocument: (document: DocumentResult) => void;
  selectBlock: (blockId?: string) => void;
  updateSelectedBlockLatex: (latex: string) => void;
  setEnvironment: (environment: EnvironmentReport) => void;
  setObservability: (observability: ObservabilitySnapshot) => void;
  setHistory: (history: DocumentResult[]) => void;
  setMode: (mode: RecognitionMode) => void;
  setBusy: (busy: boolean) => void;
  setError: (error?: string) => void;
}

export function rebuildDocumentLatex(document: DocumentResult): string {
  const body = document.pages
    .flatMap((page) =>
      [...page.blocks]
        .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])
        .map((block) => block.latex || block.text),
    )
    .filter(Boolean)
    .join("\n\n");
  return [
    "\\documentclass[UTF8]{ctexart}",
    "\\usepackage{amsmath,amssymb,booktabs,longtable,graphicx}",
    "\\begin{document}",
    body,
    "\\end{document}",
    "",
  ].join("\n");
}

export const useAppStore = create<AppState>((set) => ({
  history: [],
  mode: "auto",
  busy: false,
  setActiveDocument: (document) =>
    set({
      activeDocument: document,
      selectedBlockId: document.pages[0]?.blocks[0]?.id,
      error: undefined,
    }),
  selectBlock: (blockId) => set({ selectedBlockId: blockId }),
  updateSelectedBlockLatex: (latex) =>
    set((state) => {
      if (!state.activeDocument || !state.selectedBlockId) return state;
      const document: DocumentResult = {
        ...state.activeDocument,
        pages: state.activeDocument.pages.map((page) => ({
          ...page,
          blocks: page.blocks.map((block): OCRBlock =>
            block.id === state.selectedBlockId ? { ...block, latex } : block,
          ),
        })),
      };
      return { activeDocument: { ...document, latex: rebuildDocumentLatex(document) } };
    }),
  setEnvironment: (environment) => set({ environment }),
  setObservability: (observability) => set({ observability }),
  setHistory: (history) => set({ history }),
  setMode: (mode) => set({ mode }),
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),
}));
