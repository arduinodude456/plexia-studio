import {
  hasSupabaseConfig,
  supabase,
  uploadPresentationMedia,
  validatePresentationTimeLimits,
  type Presentation,
  type PlexiaSlide,
  type SlideElement,
} from "@plexia/shared";

const STORAGE_KEY = "plexia.studio.presentations.v1";
const FORMAT = "plexia-presentation";
const FORMAT_VERSION = 1;
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_MEDIA_BYTES = 200 * 1024 * 1024;
const MAX_MEDIA_FILES = 250;
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;
const MAX_PRIVATE_KEYS_BYTES = 2 * 1024 * 1024;
const MAX_SLIDES = 500;
const MAX_ELEMENTS = 10_000;
const SIGNED_URL_SECONDS = 120;
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

type TransferPhase = "progress" | "success" | "error";
interface TransferEvent { phase: TransferPhase; message: string }

function announce(phase: TransferPhase, message: string): void {
  window.dispatchEvent(new CustomEvent<TransferEvent>("plexia:file-transfer", { detail: { phase, message } }));
}

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

function safeFilename(title: string): string {
  const stem = title.trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 80);
  return `${stem || "praesentation"}.plexia`;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipFile { name: string; bytes: Uint8Array }
function makeZip(files: ZipFile[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = textEncoder.encode(file.name);
    if (name.length > 0xffff || file.bytes.length > 0xffffffff || offset > 0xffffffff) throw new Error("Die Präsentation ist für das ZIP-Dateiformat zu groß.");
    const checksum = crc32(file.bytes);
    const local = new Uint8Array(30 + name.length + file.bytes.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true); view.setUint16(10, 0, true); view.setUint16(12, 0x21, true);
    view.setUint32(14, checksum, true); view.setUint32(18, file.bytes.length, true); view.setUint32(22, file.bytes.length, true);
    view.setUint16(26, name.length, true); view.setUint16(28, 0, true);
    local.set(name, 30); local.set(file.bytes, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true); centralView.setUint16(4, 20, true); centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true); centralView.setUint16(10, 0, true); centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0x21, true); centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, file.bytes.length, true); centralView.setUint32(24, file.bytes.length, true);
    centralView.setUint16(28, name.length, true); centralView.setUint16(30, 0, true); centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true); centralView.setUint16(36, 0, true); centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true); central.set(name, 46); centralParts.push(central);
    offset += local.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  if (files.length > 0xffff || offset + centralSize + 22 > MAX_ARCHIVE_BYTES) throw new Error("Der Export überschreitet die erlaubte Dateigröße von 250 MB.");
  const end = new Uint8Array(22); const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(4, 0, true); view.setUint16(6, 0, true);
  view.setUint16(8, files.length, true); view.setUint16(10, files.length, true);
  view.setUint32(12, centralSize, true); view.setUint32(16, offset, true); view.setUint16(20, 0, true);
  const output = new Uint8Array(offset + centralSize + end.length); let cursor = 0;
  for (const part of [...localParts, ...centralParts, end]) { output.set(part, cursor); cursor += part.length; }
  return output;
}

function isUuid(value: unknown): value is string { return typeof value === "string" && UUID_PATTERN.test(value); }
function newUuid(): string { return crypto.randomUUID(); }
function isSafeStoragePath(value: string): boolean {
  return value.length <= 512 && !value.startsWith("/") && !value.includes("\\") && !value.includes("..") &&
    !/%2f|%5c/i.test(value) && /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]{1,8}$/i.test(value);
}
function storagePathFromSignedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const marker = "/storage/v1/object/sign/presentation-media/";
    const index = url.pathname.indexOf(marker);
    if (index < 0) return null;
    return decodeURIComponent(url.pathname.slice(index + marker.length));
  } catch { return null; }
}

interface MediaLocation { mediaId: string; element?: SlideElement; slide?: PlexiaSlide; contentKey?: string; background?: boolean; source: string; kind: "storage" | "inline" }
interface MediaDescriptor { id: string; file: string; mimeType: string; size: number }
interface PresentationArchive {
  format: typeof FORMAT;
  version: typeof FORMAT_VERSION;
  presentation: Presentation;
  media: MediaDescriptor[];
}
export interface PrivateQuizKey { slideId: string; correctIndex: number; correctIndices: number[]; explanation: string }
export interface PendingQuizEdit { key: PrivateQuizKey; options: string[] }

export function validateCloudMediaReferences(presentation: Presentation): void {
  const check = (value: unknown, label: string) => {
    if (typeof value === "string" && /^(blob:|data:|plexia-media:)/i.test(value)) {
      throw new Error(`${label} ist nur lokal oder noch nicht hochgeladen. Bitte das Medium im Editor sicher hochladen, bevor du live startest.`);
    }
  };
  check(presentation.backgroundImage, "Das Hintergrundbild");
  presentation.slides.forEach((slide, index) => {
    check(slide.content.videoUrl, `Das Video auf Folie ${index + 1}`);
    for (const element of slide.elements) if (element.kind === "image" || element.kind === "video") check(element.content, `Ein Medium auf Folie ${index + 1}`);
  });
}

/** Missing and explicit empty keys both mean no grading; only null/absent is legacy. */
export function quizKeyProblem(presentation: Presentation, keys: PrivateQuizKey[]): { slideId: string; message: string } | null {
  for (const [index, slide] of presentation.slides.entries()) {
    if (slide.type !== "multiple_choice") continue;
    const matches = keys.filter(key => key.slideId === slide.id);
    const indices = matches[0]?.correctIndices;
    const options = slide.content.options;
    if (matches.length !== 1 || !Array.isArray(indices) || !indices.length || !Array.isArray(options) ||
        indices.some(i => !Number.isInteger(i) || i < 0 || i >= options.length || typeof options[i] !== "string" || !options[i].trim()) ||
        new Set(indices).size !== indices.length || (indices.length > 1 && !slide.content.allowMultiple)) {
      return { slideId: slide.id, message: `Folie ${index + 1} („${slide.title || "Ohne Titel"}“) hat keinen gültigen vollständigen Lösungsschlüssel. Markiere im Editor mindestens eine nicht leere Antwort als richtig; bei mehreren richtigen Antworten muss Mehrfachauswahl aktiv sein.` };
    }
  }
  return null;
}
const localKey = (presentationId: string) => `plexia.private.quiz-keys.v1.${presentationId}`;
const pendingKey = (presentationId: string) => `plexia.private.quiz-pending.v1.${presentationId}`;

// These stores are teacher-device-only; never merge them into presentation JSON.
export function readPendingQuizEdits(presentationId: string): Record<string, PendingQuizEdit> {
  const raw = localStorage.getItem(pendingKey(presentationId));
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) throw new Error();
    return parsed as Record<string, PendingQuizEdit>;
  } catch { throw new Error("Der lokale Wiederherstellungsentwurf für Lösungsschlüssel ist beschädigt. Er wurde nicht überschrieben."); }
}
export function writePendingQuizEdits(presentationId: string, edits: Record<string, PendingQuizEdit>): void {
  if (Object.keys(edits).length) localStorage.setItem(pendingKey(presentationId), JSON.stringify(edits));
  else localStorage.removeItem(pendingKey(presentationId));
}
export function writeLocalPrivateQuizKeys(presentationId: string, keys: PrivateQuizKey[]): void {
  if (hasSupabaseConfig) throw new Error("Private Cloud-Schlüssel dürfen nur über den atomaren Veröffentlichungsweg gespeichert werden.");
  localStorage.setItem(localKey(presentationId), JSON.stringify(keys));
}
export function deleteLocalQuizKeys(presentationId: string): void {
  localStorage.removeItem(localKey(presentationId));
  localStorage.removeItem(pendingKey(presentationId));
}
export async function loadPrivateQuizKeys(presentationId: string): Promise<PrivateQuizKey[]> {
  if (!hasSupabaseConfig || !supabase) {
    const raw = localStorage.getItem(localKey(presentationId));
    if (!raw) return [];
    try {
      const keys: unknown = JSON.parse(raw);
      if (!Array.isArray(keys)) throw new Error();
      return keys as PrivateQuizKey[];
    } catch { throw new Error("Die lokalen Lösungsschlüssel sind beschädigt und wurden nicht überschrieben."); }
  }
  const { data, error } = await supabase.from("teacher_quiz_keys")
    .select("slide_id,correct_index,correct_indices,explanation").eq("presentation_id", presentationId);
  if (error) throw new Error(`Private Lösungsschlüssel konnten nicht geladen werden (Migration correct_indices und Anmeldung prüfen): ${error.message}`);
  return (data ?? []).map(row => {
    const correctIndex = Number(row.correct_index);
    const correctIndices = Array.isArray(row.correct_indices) ? row.correct_indices : [correctIndex];
    if (!correctIndices.every((value: unknown) => Number.isInteger(value) && Number(value) >= 0)) throw new Error("Ein gespeicherter privater Lösungsschlüssel ist ungültig; er wurde nicht verändert.");
    return { slideId: String(row.slide_id), correctIndex, correctIndices: correctIndices as number[], explanation: String(row.explanation ?? "") };
  });
}
export interface ImportedPresentation { presentation: Presentation; privateQuizKeys: PrivateQuizKey[]; uploadedPaths: string[] }

/** Only delete the exact objects just uploaded for a copy known not to be saved. */
export async function cleanupImportedMedia(paths: string[]): Promise<void> {
  if (!paths.length) return;
  if (!supabase || paths.some(path => !isSafeStoragePath(path))) throw new Error("Die hochgeladenen Medien konnten nicht sicher bereinigt werden.");
  const { error } = await supabase.storage.from("presentation-media").remove(paths);
  if (error) throw new Error(error.message);
}
const PRIVATE_KEYS_FILE = "private/quiz-keys.json";
const PRIVATE_KEYS_FORMAT = "plexia-private-quiz-keys";

function mediaSource(value: string): "storage" | "inline" | "external" | "empty" {
  if (!value) return "empty";
  if (value.startsWith("blob:") || value.startsWith("data:")) return "inline";
  if (storagePathFromSignedUrl(value)) return "storage";
  if (/^https?:\/\//i.test(value)) return "external";
  return "storage";
}

async function fetchMediaSource(value: string, source: "storage" | "inline", label: string): Promise<{ blob: Blob; mimeType: string }> {
  let url = value;
  if (source === "storage") {
    if (!hasSupabaseConfig || !supabase) throw new Error(`„${label}“ liegt im privaten Speicher. Zum Export bitte anmelden und Supabase konfigurieren.`);
    const path = storagePathFromSignedUrl(value) ?? value;
    if (!isSafeStoragePath(path)) throw new Error(`Der private Medienpfad von „${label}“ ist ungültig.`);
    const { data, error } = await supabase.storage.from("presentation-media").createSignedUrl(path, SIGNED_URL_SECONDS);
    if (error) throw new Error(`Ein privates Medium konnte nicht für den Export freigegeben werden: ${error.message}`);
    url = data.signedUrl;
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Medium „${label}“ konnte nicht geladen werden (HTTP ${response.status}).`);
    const announcedSize = Number(response.headers.get("content-length") || 0);
    if (announcedSize > MAX_MEDIA_BYTES) throw new Error(`„${label}“ ist größer als 50 MB.`);
    const blob = await response.blob();
    if (blob.size > MAX_MEDIA_BYTES) throw new Error(`„${label}“ ist größer als 50 MB.`);
    const mimeType = blob.type.split(";")[0].trim().toLowerCase();
    if (!MIME_EXTENSIONS[mimeType]) throw new Error(`Der Dateityp von „${label}“ wird nicht unterstützt (${mimeType || "unbekannt"}).`);
    return { blob, mimeType };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error(`Zeitüberschreitung beim Laden von „${label}“ (45 Sekunden).`);
    throw error;
  } finally { window.clearTimeout(timer); }
}

function makeDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.style.display = "none"; document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export type ExportResult = { status: "exported" | "cancelled" | "error"; message: string; keyCount?: number };
export async function exportPresentation(presentation: Presentation): Promise<ExportResult> {
  announce("progress", "Präsentation und Medien werden für den Export vorbereitet…");
  try {
    if (!presentation || !Array.isArray(presentation.slides)) throw new Error("Die Präsentation ist unvollständig.");
    if (Object.keys(readPendingQuizEdits(presentation.id)).length) throw new Error("Es gibt noch nicht synchronisierte private Lösungsschlüssel. Öffne die Präsentation und synchronisiere sie vor dem Export.");
    const slideIds = new Set(presentation.slides.filter(slide => slide.type === "multiple_choice").map(slide => slide.id));
    let privateQuizKeys = (await loadPrivateQuizKeys(presentation.id)).filter(key => slideIds.has(key.slideId));
    privateQuizKeys = validatePrivateQuizKeys(privateQuizKeys, presentation);
    if (privateQuizKeys.length && !window.confirm(`Diese .plexia-Datei enthält ${privateQuizKeys.length} vertrauliche Lösungsschlüssel und Erklärungen. Bewahre die Datei geschützt auf und teile sie nur mit berechtigten Lehrkräften. Trotzdem exportieren?`)) {
      const message = "Export abgebrochen; kein Download wurde gestartet.";
      announce("success", message);
      return { status: "cancelled", message };
    }
    const copy = stripPrivateAnswerFields(JSON.parse(JSON.stringify(presentation))) as Presentation;
    const files: ZipFile[] = [];
    const media: MediaDescriptor[] = [];
    const locations: MediaLocation[] = [];
    const backgroundImage = (copy as Presentation & { backgroundImage?: string }).backgroundImage;
    if (backgroundImage) {
      const source = mediaSource(backgroundImage);
      if (source === "storage" || source === "inline") locations.push({ mediaId: newUuid(), background: true, source: backgroundImage, kind: source });
    }
    for (const slide of copy.slides) {
      for (const element of slide.elements ?? []) {
        if (element.kind === "image" || element.kind === "video") {
          const source = mediaSource(element.content || "");
          if (source === "storage" || source === "inline") locations.push({ mediaId: newUuid(), element, source: element.content, kind: source === "inline" ? "inline" : "storage" });
        }
      }
      const video = slide.content?.videoUrl;
      if (typeof video === "string") {
        const source = mediaSource(video);
        if (source === "storage" || source === "inline") locations.push({ mediaId: newUuid(), slide, contentKey: "videoUrl", source: video, kind: source === "inline" ? "inline" : "storage" });
      }
    }
    if (locations.length > MAX_MEDIA_FILES) throw new Error(`Eine Präsentation darf höchstens ${MAX_MEDIA_FILES} Medien enthalten.`);
    let totalBytes = 0;
    for (let index = 0; index < locations.length; index += 1) {
      const location = locations[index];
      announce("progress", `Medien werden vorbereitet (${index + 1}/${locations.length})…`);
      const label = location.element?.alt || `Medium ${index + 1}`;
      const result = await fetchMediaSource(location.source, location.kind, label);
      totalBytes += result.blob.size;
      if (totalBytes > MAX_TOTAL_MEDIA_BYTES) throw new Error("Die Medien der Präsentation überschreiten zusammen 200 MB.");
      const extension = MIME_EXTENSIONS[result.mimeType];
      const filename = `media/${location.mediaId}.${extension}`;
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      files.push({ name: filename, bytes });
      media.push({ id: location.mediaId, file: filename, mimeType: result.mimeType, size: bytes.byteLength });
      const token = `plexia-media:${location.mediaId}`;
      if (location.background) (copy as Presentation & { backgroundImage?: string }).backgroundImage = token;
      else if (location.element) location.element.content = token;
      else if (location.contentKey && location.slide) location.slide.content[location.contentKey] = token;
    }
    const manifest: PresentationArchive = { format: FORMAT, version: FORMAT_VERSION, presentation: copy, media };
    const manifestBytes = textEncoder.encode(JSON.stringify(manifest));
    if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error("Die Präsentationsdaten überschreiten die erlaubten 10 MB.");
    const entries: ZipFile[] = [{ name: "manifest.json", bytes: manifestBytes }, ...files];
    if (privateQuizKeys.length) {
      const privateBytes = textEncoder.encode(JSON.stringify({ format: PRIVATE_KEYS_FORMAT, version: 1, keys: privateQuizKeys }));
      if (privateBytes.length > MAX_PRIVATE_KEYS_BYTES) throw new Error("Die privaten Quiz-Schlüssel überschreiten die erlaubte Dateigröße.");
      entries.push({ name: PRIVATE_KEYS_FILE, bytes: privateBytes });
    }
    const archive = makeZip(entries);
    makeDownload(new Blob([archive.buffer as ArrayBuffer], { type: "application/zip" }), safeFilename(presentation.title));
    const message = `Download von „${presentation.title || "Präsentation"}“ als .plexia-Datei gestartet${media.length ? ` (${media.length} Medien)` : ""}${privateQuizKeys.length ? `, inklusive ${privateQuizKeys.length} vertraulicher Lösungsschlüssel` : ""}.`;
    announce("success", message);
    return { status: "exported", message, keyCount: privateQuizKeys.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Präsentationsexport fehlgeschlagen.";
    announce("error", message);
    return { status: "error", message };
  }
}

interface ParsedZipEntry { name: string; bytes: Uint8Array }
function readZip(bytes: Uint8Array): ParsedZipEntry[] {
  if (bytes.length < 22 || bytes.length > MAX_ARCHIVE_BYTES) throw new Error("Die ZIP-Datei fehlt, ist unvollständig oder größer als 250 MB.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, bytes.length - 65_557); let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i -= 1) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Die .plexia-Datei enthält kein gültiges ZIP-Endverzeichnis.");
  const disk = view.getUint16(eocd + 4, true); const centralDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true); const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true); const centralOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (disk || centralDisk || diskEntries !== entryCount || entryCount < 1 || entryCount > MAX_MEDIA_FILES + 2 || eocd + 22 + commentLength !== bytes.length) throw new Error("Mehrteilige oder ungewöhnliche ZIP-Archive werden nicht unterstützt.");
  if (centralOffset + centralSize !== eocd) throw new Error("Das ZIP-Verzeichnis ist ungültig.");
  const entries: ParsedZipEntry[] = []; const names = new Set<string>(); let cursor = centralOffset; let total = 0;
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== 0x02014b50) throw new Error("Ein ZIP-Verzeichniseintrag ist ungültig.");
    const flags = view.getUint16(cursor + 8, true); const method = view.getUint16(cursor + 10, true);
    const checksum = view.getUint32(cursor + 16, true); const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true); const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true); const entryCommentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true); const end = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (end > eocd || flags & 1 || flags & 8 || method !== 0 || compressedSize !== uncompressedSize || uncompressedSize > MAX_MEDIA_BYTES + MAX_MANIFEST_BYTES) throw new Error("Verschlüsselte, komprimierte oder übergroße ZIP-Einträge werden nicht unterstützt.");
    const name = textDecoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").some(part => part === "" || part === "." || part === "..") || name.length > 255 || names.has(name)) throw new Error("Unsicherer oder doppelter ZIP-Dateiname erkannt.");
    names.add(name); total += uncompressedSize;
    if (total > MAX_TOTAL_MEDIA_BYTES + MAX_MANIFEST_BYTES + MAX_PRIVATE_KEYS_BYTES) throw new Error("Der entpackte Inhalt überschreitet 212 MB.");
    if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("Der lokale ZIP-Eintrag ist ungültig.");
    const localNameLength = view.getUint16(localOffset + 26, true); const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength; const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset || dataEnd < dataStart) throw new Error("Ein ZIP-Eintrag zeigt außerhalb des Archivs.");
    const localName = textDecoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    if (localName !== name) throw new Error("ZIP-Verzeichnis und lokale Dateinamen stimmen nicht überein.");
    const data = bytes.slice(dataStart, dataEnd);
    if (crc32(data) !== checksum) throw new Error(`Die Prüfsumme des ZIP-Eintrags „${name}“ stimmt nicht.`);
    entries.push({ name, bytes: data }); cursor = end;
  }
  if (cursor !== centralOffset + centralSize) throw new Error("Das ZIP-Verzeichnis enthält unerwartete zusätzliche Daten.");
  return entries;
}

function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function hasUnsupportedPrivateAnswerFields(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnsupportedPrivateAnswerFields);
  if (!isObject(value)) return false;
  const unsupported = new Set(["correctAnswer", "correct_answer", "correctAnswers", "correct_answers", "isCorrect", "is_correct", "answerKey", "answer_key"]);
  return Object.entries(value).some(([key, child]) => unsupported.has(key) || hasUnsupportedPrivateAnswerFields(child));
}
export function stripPrivateAnswerFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPrivateAnswerFields);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["correctIndex", "correct_index", "correctIndices", "correct_indices", "correctAnswer", "correct_answer", "correctAnswers", "correct_answers", "isCorrect", "is_correct", "answerKey", "answer_key", "explanation"].includes(key))
    .map(([key, child]) => [key, stripPrivateAnswerFields(child)]));
}
function normalizePresentation(value: unknown): { presentation: Presentation; repairedIds: number; slideIdRemap: Map<string, string[]>; legacyQuizKeys: PrivateQuizKey[] } {
  if (!isObject(value) || value.version !== 1 || typeof value.title !== "string" || !Array.isArray(value.slides) || value.slides.length < 1 || value.slides.length > MAX_SLIDES) {
    throw new Error(`Keine gültige PLEXIA-Präsentation (Version 1, 1–${MAX_SLIDES} Folien erwartet).`);
  }
  if (hasUnsupportedPrivateAnswerFields(value)) {
    throw new Error("Die Datei enthält ein nicht unterstütztes Format für private Quizlösungen. Der Import wurde abgebrochen, damit keine Lösungen verloren gehen.");
  }
  const raw = value as Record<string, unknown>;
  let repairedIds = 0; const ids = new Set<string>();
  const takeId = (candidate: unknown): string => {
    if (isUuid(candidate) && !ids.has(candidate.toLowerCase())) { ids.add(candidate.toLowerCase()); return candidate; }
    repairedIds += 1;
    let id = newUuid(); while (ids.has(id.toLowerCase())) id = newUuid();
    ids.add(id.toLowerCase()); return id;
  };
  const slidesRaw = raw.slides as unknown[];
  const slideIdRemap = new Map<string, string[]>();
  const legacyQuizKeys: PrivateQuizKey[] = [];
  const presentationTitle = raw.title as string;
  const safeSlides: PlexiaSlide[] = slidesRaw.map((rawSlide: unknown, slideIndex: number) => {
    if (!isObject(rawSlide) || !Array.isArray(rawSlide.elements) || !isObject(rawSlide.content)) throw new Error(`Folie ${slideIndex + 1} ist fehlerhaft.`);
    const slide = rawSlide as Record<string, unknown>;
    const allowedTypes = new Set(["standard", "video", "multiple_choice", "free_text", "worksheet", "photo_task", "mindmap", "brainstorm", "wordcloud", "poll", "group_work", "results"]);
    if (typeof slide.title !== "string" || typeof slide.background !== "string" || typeof slide.createdAt !== "string" || typeof slide.type !== "string" || !allowedTypes.has(slide.type)) throw new Error(`Folie ${slideIndex + 1} hat ungültige Pflichtfelder.`);
    const elements = slide.elements as unknown[];
    if (elements.length > MAX_ELEMENTS) throw new Error("Eine Folie enthält zu viele Elemente.");
    const safeElements: SlideElement[] = elements.map((rawElement, elementIndex) => {
      if (!isObject(rawElement) || typeof rawElement.kind !== "string" || !["text", "image", "video", "shape", "table", "chart"].includes(rawElement.kind)) throw new Error(`Element ${elementIndex + 1} auf Folie ${slideIndex + 1} hat einen ungültigen Typ.`);
      const element = rawElement as unknown as SlideElement;
      if (typeof element.content !== "string" || ![element.x, element.y, element.width, element.height, element.rotation, element.zIndex].every(Number.isFinite)) throw new Error(`Element ${elementIndex + 1} auf Folie ${slideIndex + 1} hat ungültige Werte.`);
      const safeElement = stripPrivateAnswerFields(element) as SlideElement;
      return { ...safeElement, id: takeId(element.id) };
    });
    const originalId = slide.id;
    const normalizedId = takeId(originalId);
    if (isUuid(originalId)) {
      const originalKey = originalId.toLowerCase();
      slideIdRemap.set(originalKey, [...(slideIdRemap.get(originalKey) ?? []), normalizedId]);
    }
    const content = slide.content as Record<string, unknown>;
    if (slide.type === "multiple_choice") {
      const single=content.correctIndex ?? content.correct_index;
      const multiple=content.correctIndices ?? content.correct_indices;
      if (single === undefined && multiple === undefined && content.explanation !== undefined) {
        throw new Error(`Folie ${slideIndex + 1} enthält eine Erklärung ohne zugehörigen Lösungsschlüssel. Der Import wurde zum Schutz der Daten abgebrochen.`);
      }
      if(single !== undefined || multiple !== undefined) {
        if ((single !== undefined && (!Number.isInteger(single) || Number(single)<0)) ||
            (multiple !== undefined && (!Array.isArray(multiple) || !multiple.every(index=>Number.isInteger(index) && index>=0))) ||
            (content.explanation !== undefined && typeof content.explanation !== "string")) {
          throw new Error(`Eingebetteter privater Lösungsschlüssel auf Folie ${slideIndex+1} ist ungültig. Der Import wurde zum Schutz der Daten abgebrochen.`);
        }
        const indices = multiple === undefined ? [single as number] : multiple as number[];
        legacyQuizKeys.push({slideId:normalizedId,correctIndex:indices[0] ?? (single as number | undefined) ?? 0,correctIndices:indices,explanation:(content.explanation as string | undefined) ?? ""});
      }
    }
    const safeContent = stripPrivateAnswerFields(slide.content) as PlexiaSlide["content"];
    const safeSlide = stripPrivateAnswerFields(slide) as Record<string, unknown>;
    return { ...safeSlide, id: normalizedId, content: safeContent, elements: safeElements } as unknown as PlexiaSlide;
  });
  const theme = ["light", "dark", "ocean", "violet"].includes(String(raw.theme)) ? raw.theme as Presentation["theme"] : "light";
  // Import creates a new copy rather than silently upserting over an existing deck.
  // Generate the ID before uploading media so the storage paths match the copy.
  let importedId = newUuid();
  while (ids.has(importedId.toLowerCase())) importedId = newUuid();
  const presentation: Presentation = {
    id: importedId, title: presentationTitle.slice(0, 160), description: typeof raw.description === "string" ? raw.description.slice(0, 20_000) : "",
    theme, slides: safeSlides, version: 1, updatedAt: new Date().toISOString(),
    ...(typeof raw.backgroundImage === "string" ? { backgroundImage: raw.backgroundImage } : {}),
    ...(isObject(raw.participation) ? { participation: {
      avatarsEnabled: raw.participation.avatarsEnabled === true,
      nicknameGeneratorEnabled: raw.participation.nicknameGeneratorEnabled === true,
    } } : {}),
  };
  validatePresentationTimeLimits(presentation);
  return { presentation, repairedIds, slideIdRemap, legacyQuizKeys: validatePrivateQuizKeys(legacyQuizKeys,presentation) };
}

function validatePrivateQuizKeys(keys: PrivateQuizKey[], presentation: Presentation): PrivateQuizKey[] {
  const slides = new Map(presentation.slides.map((slide) => [slide.id.toLowerCase(), slide]));
  const seen = new Set<string>();
  return keys.map((key) => {
    const indices = Array.isArray(key.correctIndices) ? key.correctIndices : [key.correctIndex];
    if (!isUuid(key.slideId) || !Number.isInteger(key.correctIndex) || key.correctIndex < 0 ||
      !indices.every(index => Number.isInteger(index) && index >= 0) || new Set(indices).size !== indices.length ||
      typeof key.explanation !== "string" || key.explanation.length > 2000) {
      throw new Error("Ein privater Quiz-Schlüssel hat ein ungültiges Format.");
    }
    const slideId = key.slideId.toLowerCase();
    const slide = slides.get(slideId);
    if (!slide || slide.type !== "multiple_choice" || !Array.isArray(slide.content.options) ||
      indices.some(index => index >= slide.content.options!.length) || seen.has(slideId)) {
      throw new Error("Ein privater Quiz-Schlüssel passt nicht eindeutig zu einer Multiple-Choice-Folie.");
    }
    seen.add(slideId);
    return { slideId: slide.id, correctIndex: indices[0] ?? key.correctIndex, correctIndices: [...indices].sort((a,b) => a-b), explanation: key.explanation };
  });
}

function parsePrivateQuizKeys(bytes: Uint8Array): PrivateQuizKey[] {
  if (bytes.length > MAX_PRIVATE_KEYS_BYTES) throw new Error("Die privaten Quiz-Schlüssel überschreiten 2 MB.");
  let value: unknown;
  try { value = JSON.parse(textDecoder.decode(bytes)); } catch { throw new Error("Der private Quiz-Schlüsselbestandteil enthält kein gültiges UTF-8-JSON."); }
  if (!isObject(value) || value.format !== PRIVATE_KEYS_FORMAT || value.version !== 1 || !Array.isArray(value.keys) || value.keys.length > MAX_SLIDES) {
    throw new Error("Der private Quiz-Schlüsselbestandteil ist ungültig oder wird nicht unterstützt.");
  }
  return value.keys.map((item) => {
    if (!isObject(item) || !isUuid(item.slideId) || !Number.isInteger(item.correctIndex) ||
      (item.correctIndices !== undefined && (!Array.isArray(item.correctIndices) || !item.correctIndices.every(index => Number.isInteger(index)))) ||
      typeof item.explanation !== "string" || item.explanation.length > 2000) {
      throw new Error("Ein privater Quiz-Schlüssel hat ein ungültiges Format.");
    }
    return { slideId: item.slideId, correctIndex: item.correctIndex as number,
      correctIndices: item.correctIndices === undefined ? [item.correctIndex as number] : item.correctIndices as number[], explanation: item.explanation };
  });
}

function parseManifest(bytes: Uint8Array): PresentationArchive {
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error("Das Manifest überschreitet 10 MB.");
  let value: unknown;
  try { value = JSON.parse(textDecoder.decode(bytes)); } catch { throw new Error("Das Präsentationsmanifest enthält kein gültiges UTF-8-JSON."); }
  if (!isObject(value) || value.format !== FORMAT || value.version !== FORMAT_VERSION || !Array.isArray(value.media)) throw new Error("Unbekanntes .plexia-Format oder nicht unterstützte Version.");
  if (value.media.length > MAX_MEDIA_FILES) throw new Error(`Höchstens ${MAX_MEDIA_FILES} Medien pro Präsentation sind erlaubt.`);
  return value as unknown as PresentationArchive;
}

function validateAndMapPackage(entries: ParsedZipEntry[]): { presentation: Presentation; repairedIds: number; media: Array<{ descriptor: MediaDescriptor; bytes: Uint8Array }>; privateQuizKeys: PrivateQuizKey[] } {
  const byName = new Map(entries.map(entry => [entry.name, entry])); const manifestEntry = byName.get("manifest.json");
  if (!manifestEntry) throw new Error("In der .plexia-Datei fehlt manifest.json.");
  const privateKeysEntry = byName.get(PRIVATE_KEYS_FILE);
  const manifest = parseManifest(manifestEntry.bytes); const normalized = normalizePresentation(manifest.presentation);
  const descriptors = new Map<string, MediaDescriptor>(); let total = 0;
  for (const descriptor of manifest.media) {
    if (!isObject(descriptor) || !isUuid(descriptor.id) || typeof descriptor.file !== "string" || typeof descriptor.mimeType !== "string" || !Number.isSafeInteger(descriptor.size)) throw new Error("Ein Medieneintrag im Manifest ist ungültig.");
    const extension = MIME_EXTENSIONS[descriptor.mimeType];
    if (!extension || descriptor.file !== `media/${descriptor.id}.${extension}` || descriptor.size < 0 || descriptor.size > MAX_MEDIA_BYTES || descriptors.has(descriptor.id)) throw new Error("Ein Medieneintrag hat einen nicht erlaubten Dateinamen, Typ oder Umfang.");
    const entry = byName.get(descriptor.file);
    if (!entry || entry.bytes.byteLength !== descriptor.size) throw new Error(`Die Mediendatei „${descriptor.file}“ fehlt oder hat eine falsche Größe.`);
    total += descriptor.size; if (total > MAX_TOTAL_MEDIA_BYTES) throw new Error("Medien überschreiten zusammen 200 MB.");
    descriptors.set(descriptor.id, descriptor);
  }
  if (byName.size !== descriptors.size + 1 + Number(Boolean(privateKeysEntry))) throw new Error("Das ZIP enthält nicht referenzierte oder unbekannte Dateien.");
  const referenced = new Set<string>();
  const mapValue = (value: string): string => {
    if (!value.startsWith("plexia-media:")) return value;
    const id = value.slice("plexia-media:".length); const descriptor = descriptors.get(id);
    if (!descriptor) throw new Error("Eine Folie verweist auf ein nicht vorhandenes Medium.");
    referenced.add(id); return value;
  };
  const presentationWithBackground = normalized.presentation as Presentation & { backgroundImage?: string };
  if (presentationWithBackground.backgroundImage) presentationWithBackground.backgroundImage = mapValue(presentationWithBackground.backgroundImage);
  for (const slide of normalized.presentation.slides) {
    for (const element of slide.elements) if (element.kind === "image" || element.kind === "video") element.content = mapValue(element.content);
    if (typeof slide.content.videoUrl === "string") slide.content.videoUrl = mapValue(slide.content.videoUrl);
  }
  if (referenced.size !== descriptors.size) throw new Error("Das Archiv enthält Medien, auf die keine Folie verweist.");
  let privateQuizKeys: PrivateQuizKey[] = [];
  if (privateKeysEntry) {
    const originalKeys = parsePrivateQuizKeys(privateKeysEntry.bytes);
    privateQuizKeys = originalKeys.map((key) => {
      const targets = normalized.slideIdRemap.get(key.slideId.toLowerCase());
      if (!targets || targets.length !== 1) throw new Error("Ein privater Quiz-Schlüssel kann keiner eindeutigen Folien-ID zugeordnet werden.");
      return { ...key, slideId: targets[0] };
    });
    privateQuizKeys = validatePrivateQuizKeys(privateQuizKeys, normalized.presentation);
  }
  for (const legacy of normalized.legacyQuizKeys) {
    const existing=privateQuizKeys.find(key=>key.slideId===legacy.slideId);
    if(existing && (JSON.stringify(existing.correctIndices)!==JSON.stringify(legacy.correctIndices) || existing.explanation!==legacy.explanation))
      throw new Error("Das Archiv enthält widersprüchliche private Quiz-Schlüssel. Der Import wurde zum Schutz der Daten abgebrochen.");
    if(!existing) privateQuizKeys.push(legacy);
  }
  return { presentation: normalized.presentation, repairedIds: normalized.repairedIds, media: [...descriptors.values()].map(descriptor => ({ descriptor, bytes: byName.get(descriptor.file)!.bytes })), privateQuizKeys };
}

async function importPlexia(file: File): Promise<ImportedPresentation> {
  const archive = new Uint8Array(await file.arrayBuffer());
  const parsed = validateAndMapPackage(readZip(archive));
  if (parsed.media.length && (!hasSupabaseConfig || !supabase)) throw new Error("Diese .plexia-Datei enthält Medien. Melde dich mit einem Lehrkraftkonto an und konfiguriere den privaten Supabase-Speicher, um sie zu importieren.");
  const uploadedPaths: string[] = [];
  try {
    for (let index = 0; index < parsed.media.length; index += 1) {
      const item = parsed.media[index]; announce("progress", `Privater Medienimport (${index + 1}/${parsed.media.length})…`);
      const blob = new Blob([item.bytes.buffer as ArrayBuffer], { type: item.descriptor.mimeType });
      const fileName = item.descriptor.file.split("/").pop() || "medium";
      const mediaFile = new File([blob], fileName, { type: item.descriptor.mimeType });
      const path = await uploadPresentationMedia(parsed.presentation.id, mediaFile);
      uploadedPaths.push(path);
      const marker = `plexia-media:${item.descriptor.id}`;
      const presentationWithBackground = parsed.presentation as Presentation & { backgroundImage?: string };
      if (presentationWithBackground.backgroundImage === marker) presentationWithBackground.backgroundImage = path;
      for (const slide of parsed.presentation.slides) {
        for (const element of slide.elements) if ((element.kind === "image" || element.kind === "video") && element.content === marker) element.content = path;
        if (slide.content.videoUrl === marker) slide.content.videoUrl = path;
      }
    }
  } catch (error) {
    try { await cleanupImportedMedia(uploadedPaths); }
    catch {
      throw new Error(`Der Medienimport ist fehlgeschlagen und die Bereinigung wurde nicht bestätigt. Prüfe im privaten Supabase-Storage den Ordner für Präsentations-ID ${parsed.presentation.id} und entferne dort die importierten Dateien manuell. Quelldatei aufbewahren. ${error instanceof Error ? error.message : ""}`);
    }
    throw error;
  }
  announce("progress", `„${parsed.presentation.title}“ geprüft${parsed.media.length ? `; ${parsed.media.length} Medien hochgeladen` : ""}${parsed.privateQuizKeys.length ? `; ${parsed.privateQuizKeys.length} vertrauliche Lösungsschlüssel erkannt` : ""}${parsed.repairedIds ? `; ${parsed.repairedIds} IDs erneuert` : ""}; Präsentation wird gespeichert…`);
  return { presentation: parsed.presentation, privateQuizKeys: parsed.privateQuizKeys, uploadedPaths };
}

export async function importPresentation(file: File): Promise<ImportedPresentation> {
  announce("progress", "Datei und Präsentations-IDs werden geprüft…");
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error("Die Datei überschreitet die erlaubte Größe von 250 MB.");
  const prefix = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (prefix[0] === 0x50 && prefix[1] === 0x4b) return importPlexia(file);
  if (file.size > MAX_MANIFEST_BYTES) throw new Error("JSON-Importe dürfen höchstens 10 MB groß sein.");
  let parsed: unknown;
  try { parsed = JSON.parse(await file.text()); } catch { throw new Error("Die Datei ist weder ein gültiges .plexia-Archiv noch eine JSON-Präsentation."); }
  const normalized = normalizePresentation(parsed);
  announce("progress", `„${normalized.presentation.title}“ als JSON geprüft; Präsentation wird gespeichert…`);
  return { presentation: normalized.presentation, privateQuizKeys: normalized.legacyQuizKeys, uploadedPaths: [] };
}
