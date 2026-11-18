import type { Presentation } from "@plexia/shared";

const STORAGE_KEY = "plexia.studio.presentations.v1";

export function readLocalPresentations(): Presentation[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? (value as Presentation[]) : [];
  } catch {
    return [];
  }
}

export function writeLocalPresentations(items: Presentation[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

export function exportPresentation(presentation: Presentation): void {
  const blob = new Blob([JSON.stringify(presentation, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${presentation.title.trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "praesentation"}.plexia.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function importPresentation(file: File): Promise<Presentation> {
  const parsed: unknown = JSON.parse(await file.text());
  if (!parsed || typeof parsed !== "object") throw new Error("Die Datei enthält keine gültige Präsentation.");
  const candidate = parsed as Partial<Presentation>;
  if (candidate.version !== 1 || !Array.isArray(candidate.slides) || typeof candidate.title !== "string") {
    throw new Error("Diese Datei ist keine gültige PLEXIA-Präsentation (Version 1 erwartet).");
  }
  return { ...candidate, id: crypto.randomUUID(), updatedAt: new Date().toISOString() } as Presentation;
}
