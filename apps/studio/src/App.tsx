import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, CircleHelp, Cloud, LogOut, Moon, Settings as SettingsIcon, Sun, UserRound } from "lucide-react";
import { createId, createSlide, deletePresentationStorage, getCurrentUser, hasSupabaseConfig, listPresentations, savePresentation, signOut, supabase, type Presentation } from "@plexia/shared";
import { AuthGate } from "./components/AuthGate";
import { Dashboard } from "./components/Dashboard";
import { Editor } from "./components/Editor";
import { LivePanel, stripPrivateAnswerFields, type SharedSlideResult } from "./components/LivePanel";
import { Settings } from "./components/Settings";
import { importPresentation, readLocalPresentations, writeLocalPresentations } from "./lib/presentations";
import { LatestSaveQueue } from "./lib/saveQueue";

export default function App() {
  const [items, setItems] = useState<Presentation[]>(() => readLocalPresentations());
  const [active, setActive] = useState<Presentation | null>(null);
  const [view, setView] = useState<"dashboard" | "settings">("dashboard");
  const [theme, setTheme] = useState<"light" | "dark">(() => localStorage.getItem("plexia-studio-theme") === "dark" ? "dark" : "light");
  const [user, setUser] = useState<{ email?: string } | null>(null);
  const [authChecked, setAuthChecked] = useState(!hasSupabaseConfig);
  const [authError, setAuthError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [toast, setToast] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [live, setLive] = useState(false);
  const activeRef = useRef<Presentation | null>(null);
  const liveRef = useRef(false);
  const sharedInLive = useRef(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const editorVersionRef = useRef(0);
  const editorSnapshots = useRef(new Map<number, Presentation>());

  // One writer at a time: a slower earlier request must never overwrite a newer edit.
  // Keep the newest unsaved version per document until a write really succeeds.
  const saveQueue = useRef(new LatestSaveQueue<Presentation>(savePresentation));
  const saveTimer = useRef<number | null>(null);

  const flushSaves = useCallback(async (): Promise<boolean> => {
    if (!hasSupabaseConfig) return true;
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    try {
      await saveQueue.current.flush();
      setSaveError("");
      setSaving(saveQueue.current.busy);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cloudspeicherung fehlgeschlagen.";
      setSaveError(message);
      setSaving(false);
      setToast({ kind: "error", text: `${message} Deine Änderungen bleiben im Editor. Bitte erneut speichern.` });
      return false;
    }
  }, []);

  const queueSave = useCallback((presentation: Presentation) => {
    if (!hasSupabaseConfig) return;
    saveQueue.current.enqueue(presentation.id, presentation);
    setSaving(true);
    setSaveError("");
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void flushSaves(); }, 700);
  }, [flushSaves]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (saveQueue.current.busy) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const onOnline = () => {
      if (saveQueue.current.hasPending) {
        setSaving(true);
        void flushSaves();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("online", onOnline);
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [flushSaves]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("plexia-studio-theme", theme);
  }, [theme]);
  useEffect(() => {
    const onTransfer = (event: Event) => {
      const detail = (event as CustomEvent<{ phase: "progress" | "success" | "error"; message: string }>).detail;
      if (detail) setToast({ kind: detail.phase === "error" ? "error" : "success", text: detail.message });
    };
    window.addEventListener("plexia:file-transfer", onTransfer);
    return () => window.removeEventListener("plexia:file-transfer", onTransfer);
  }, []);

  const refresh = useCallback(async () => {
    if (!hasSupabaseConfig) { setItems(readLocalPresentations()); return; }
    try {
      const current = await getCurrentUser();
      setUser(current ? { email: current.email } : null);
      if (current) setItems(await listPresentations());
      else setAuthError("");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Anmeldung konnte nicht überprüft werden.");
    } finally { setAuthChecked(true); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const reloadCloud = useCallback(async () => {
    if (!hasSupabaseConfig) return;
    try { setItems(await listPresentations()); }
    catch (error) { setToast({ kind: "error", text: error instanceof Error ? error.message : "Präsentationen konnten nicht geladen werden." }); }
  }, []);

  function changed(presentation: Presentation) {
    const containsInlineMedia = hasSupabaseConfig && presentation.slides.some((slide) => slide.elements.some((element) => (element.kind === "image" || element.kind === "video") && element.content.startsWith("data:")));
    const safe = containsInlineMedia ? {
      ...presentation,
      slides: presentation.slides.map((slide) => ({ ...slide, elements: slide.elements.map((element) => (element.kind === "image" || element.kind === "video") && element.content.startsWith("data:") ? { ...element, content: "" } : element) })),
    } : presentation;
    if (containsInlineMedia) setToast({ kind: "error", text: "Eingebettete Bild-/Videodaten wurden vor dem Cloud-Speichern entfernt. Lade Medien über den sicheren Datei-Upload hoch." });
    activeRef.current = safe;
    setActive(safe);
    setItems((previous) => {
      const next = previous.some((item) => item.id === safe.id) ? previous.map((item) => item.id === safe.id ? safe : item) : [safe, ...previous];
      if (!hasSupabaseConfig) {
        try { writeLocalPresentations(next); }
        catch { setToast({ kind: "error", text: "Der lokale Speicher ist voll. Exportiere deine Präsentation als Sicherung." }); }
      }
      return next;
    });
    queueSave(safe);
  }

  function remountEditor() {
    editorVersionRef.current += 1;
    setEditorVersion(editorVersionRef.current);
  }

  function editorChanged(presentation: Presentation, version: number) {
    const previous = editorSnapshots.current.get(version);
    editorSnapshots.current.set(version, presentation);
    const current = activeRef.current;
    if (!current || current.id !== presentation.id) return;
    if (version !== editorVersionRef.current) {
      // An upload started by the old editor can finish after the remount. Apply
      // only its media delta, and only if the new editor has not changed it.
      if (!previous) return;
      let applied = false;
      let conflicted = false;
      const slides = current.slides.map((slide) => {
        const before = previous.slides.find((item) => item.id === slide.id);
        const after = presentation.slides.find((item) => item.id === slide.id);
        if (!before || !after) return slide;
        return { ...slide, elements: slide.elements.map((element) => {
          const oldElement = before.elements.find((item) => item.id === element.id);
          const newElement = after.elements.find((item) => item.id === element.id);
          if (!oldElement || !newElement || !["image", "video"].includes(element.kind) ||
              (oldElement.content === newElement.content && oldElement.alt === newElement.alt)) return element;
          if (element.content !== oldElement.content || element.alt !== oldElement.alt) { conflicted = true; return element; }
          applied = true;
          return { ...element, content: newElement.content, alt: newElement.alt };
        }) };
      });
      if (applied) {
        changed({ ...current, slides, updatedAt: new Date().toISOString() });
        remountEditor();
      }
      if (conflicted) setToast({ kind: "error", text: "Ein abgeschlossener Medien-Upload wurde nicht eingefügt, weil das Element inzwischen geändert wurde." });
      return;
    }
    if (liveRef.current && sharedInLive.current) {
      // The mounted editor still has its own pre-share doc. Preserve every
      // result slide already shared while accepting its other edits.
      presentation = stripPrivateAnswerFields({
        ...presentation,
        slides: presentation.slides.map((slide) => {
          const latest = current.slides.find((item) => item.id === slide.id && item.type === "results");
          return latest && Object.hasOwn(latest.content, "sharedResults")
            ? { ...slide, content: { ...slide.content, sharedResults: latest.content.sharedResults } }
            : slide;
        }),
      }) as Presentation;
    }
    changed(presentation);
  }

  async function shareResults(slideId: string, results: SharedSlideResult[]) {
    const current = activeRef.current;
    if (!current || !current.slides.some((slide) => slide.id === slideId && slide.type === "results")) {
      throw new Error("Die Ergebnisse-Folie ist nicht mehr vorhanden.");
    }
    const next = stripPrivateAnswerFields({
      ...current,
      slides: current.slides.map((slide) => slide.id === slideId
        ? { ...slide, content: { ...slide.content, sharedResults: results } }
        : slide),
      updatedAt: new Date().toISOString(),
    }) as Presentation;
    sharedInLive.current = true;
    changed(next);
    if (!(await flushSaves())) throw new Error("Die Ergebnisse bleiben im Editor vorgemerkt, konnten aber noch nicht synchronisiert werden. Bitte erneut speichern.");
  }

  function create() {
    const presentation: Presentation = { id: createId(), title: "Neue Präsentation", description: "", theme: "light", slides: [createSlide("standard", "Willkommen")], version: 1, updatedAt: new Date().toISOString() };
    changed(presentation);
  }

  async function leaveEditor(nextView: "dashboard" | "settings" = "dashboard") {
    if (!(await flushSaves())) return;
    activeRef.current = null;
    remountEditor();
    setActive(null);
    setView(nextView);
  }

  async function startLive() {
    if (await flushSaves()) {
      sharedInLive.current = false;
      liveRef.current = true;
      setLive(true);
    }
  }

  function closeLive() {
    liveRef.current = false;
    if (sharedInLive.current) remountEditor();
    sharedInLive.current = false;
    setLive(false);
  }

  async function remove(presentation: Presentation) {
    if (!window.confirm(`„${presentation.title}“ und alle zugehörigen privaten Medien sowie Schülerfotos unwiderruflich löschen?`)) return;
    if (!(await flushSaves())) return;
    try {
      if (hasSupabaseConfig) {
        if (!user || !supabase) throw new Error("Bitte melde dich an.");
        await deletePresentationStorage(presentation.id);
        const { error } = await supabase.from("presentations").delete().eq("id", presentation.id);
        if (error) throw error;
      }
      const next = items.filter((item) => item.id !== presentation.id);
      setItems(next);
      if (!hasSupabaseConfig) writeLocalPresentations(next);
      setToast({ kind: "success", text: "Präsentation und zugehörige private Medien gelöscht." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Löschen fehlgeschlagen.";
      setToast({ kind: "error", text: `${message} Die Präsentation blieb in deinem Konto erhalten; bereits entfernte Dateiteile lassen sich nicht wiederherstellen.` });
    }
  }

  async function onImport(file: File) {
    try {
      const imported = await importPresentation(file);
      const presentation = imported.presentation;
      if (hasSupabaseConfig) {
        setToast({ kind: "success", text: "Medien geprüft; Präsentation wird in deinem Lehrkraftkonto gespeichert…" });
        await savePresentation(presentation);
      }
      changed(presentation);
      if (imported.privateQuizKeys.length) {
        if (hasSupabaseConfig) {
          if (!supabase) throw new Error("Die privaten Lösungsschlüssel konnten nicht im Lehrkraftkonto gespeichert werden.");
          const { error } = await supabase.from("teacher_quiz_keys").upsert(imported.privateQuizKeys.map((key) => ({ presentation_id: presentation.id, slide_id: key.slideId, correct_index: key.correctIndex, explanation: key.explanation })), { onConflict: "presentation_id,slide_id" });
          if (error) throw new Error("Die Präsentation wurde importiert, aber ihre vertraulichen Lösungsschlüssel konnten nicht gespeichert werden. Prüfe die Lehrkraft-Anmeldung und die private Schlüssel-Migration.");
          setToast({ kind: "success", text: `„${presentation.title}“ wurde importiert; ${imported.privateQuizKeys.length} vertrauliche Lösungsschlüssel wurden getrennt im Lehrkraftkonto gespeichert.` });
        } else setToast({ kind: "success", text: `„${presentation.title}“ wurde lokal importiert. Die Datei enthielt vertrauliche Lösungsschlüssel; diese wurden ohne Lehrkraftkonto nicht lokal gespeichert. Importiere die Datei in einem angemeldeten Lehrkraftkonto, damit sie getrennt gespeichert werden.` });
      } else setToast({ kind: "success", text: `„${presentation.title}“ wurde importiert${hasSupabaseConfig ? " und im Lehrkraftkonto gespeichert" : ""}.` });
    } catch (error) { setToast({ kind: "error", text: error instanceof Error ? error.message : "Datei konnte nicht importiert werden." }); }
  }

  async function logout() {
    if (!(await flushSaves())) return;
    try { await signOut(); activeRef.current = null; remountEditor(); setUser(null); setActive(null); setItems([]); setAuthChecked(true); }
    catch (error) { setToast({ kind: "error", text: error instanceof Error ? error.message : "Abmelden fehlgeschlagen." }); }
  }

  if (active && !editorSnapshots.current.has(editorVersion)) editorSnapshots.current.set(editorVersion, active);
  if (hasSupabaseConfig && !authChecked) return <div className="loading-screen"><div className="loading-brand"><span className="brand-symbol">P</span> PLEXIA STUDIO</div><div className="spinner"/>Arbeitsbereich wird geladen…</div>;
  if (hasSupabaseConfig && !user) return <><AuthGate onAuthenticated={() => { setAuthError(""); void refresh().then(() => reloadCloud()); }}/>{authError && <div className="auth-error-float">{authError}</div>}</>;
  return <div className="app-frame">
    <header className="app-header">
      <button className="brand-lockup" onClick={() => void leaveEditor("dashboard")}><span className="brand-symbol">P</span><span className="brand-word">PLEXIA<small>STUDIO</small></span></button>
      <div className="app-nav"><button className={view === "dashboard" && !active ? "nav-link active" : "nav-link"} onClick={() => void leaveEditor("dashboard")}><BookOpen size={17}/> Präsentationen</button><button className={view === "settings" && !active ? "nav-link active" : "nav-link"} onClick={() => void leaveEditor("settings")}><SettingsIcon size={17}/> Einstellungen</button></div>
      <div className="header-right">
        {saveError ? <button className="workspace-status" onClick={() => { setSaving(true); void flushSaves(); }} title={saveError}>Nicht gespeichert · Erneut versuchen</button> : <span className="workspace-status"><i className={hasSupabaseConfig ? "dot green" : "dot"}/>{hasSupabaseConfig ? (saving ? "Speichert…" : "Cloud synchronisiert") : "Lokaler Arbeitsbereich"}</span>}
        <button className="icon-button theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} title={theme === "light" ? "Dunkles Design" : "Helles Design"} aria-label={theme === "light" ? "Dunkles Design" : "Helles Design"}>{theme === "light" ? <Moon size={17}/> : <Sun size={17}/>}</button>
        {user ? <div className="user-chip"><span className="user-avatar"><UserRound size={15}/></span><span>{user.email}</span><button className="icon-button" title="Abmelden" aria-label="Abmelden" onClick={() => void logout()}><LogOut size={16}/></button></div> : <div className="local-chip"><Cloud size={15}/> Nur auf diesem Gerät</div>}
      </div>
    </header>
    {active ? <Editor key={`${active.id}:${editorVersion}`} presentation={active} onChange={(presentation) => editorChanged(presentation, editorVersion)} onBack={() => void leaveEditor()} onLive={() => void startLive()} isCloud={hasSupabaseConfig} saving={saving} saveError={Boolean(saveError)}/> : view === "settings" ? <Settings/> : <Dashboard presentations={items} onCreate={create} onOpen={(presentation) => { activeRef.current = presentation; setActive(presentation); setView("dashboard"); }} onDelete={(presentation) => void remove(presentation)} onImport={(file) => void onImport(file)} isCloud={hasSupabaseConfig} saving={saving} teacherName={user?.email || ""}/>}
    <footer className="app-footer"><span>PLEXIA STUDIO <span className="footer-dot">·</span> Unterricht mit Ideen.</span><span><CircleHelp size={14}/> Mit Sorgfalt für den Unterricht gestaltet</span></footer>
    {live && active && <LivePanel presentation={active} onClose={closeLive} onShareResults={shareResults}/>}
    {toast && <div className={`toast ${toast.kind}`} role="status">{toast.text}<button aria-label="Hinweis schließen" onClick={() => setToast(null)}>×</button></div>}
  </div>;
}
