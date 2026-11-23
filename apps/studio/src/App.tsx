import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, CircleHelp, Cloud, LogOut, Moon, Settings as SettingsIcon, Sun, UserRound } from "lucide-react";
import { createId, createSlide, deletePresentationStorage, getCurrentUser, hasSupabaseConfig, listPresentations, savePresentation, signOut, supabase, validatePresentationTimeLimits, type Presentation } from "@plexia/shared";
import { AuthGate } from "./components/AuthGate";
import { Dashboard } from "./components/Dashboard";
import { Editor } from "./components/Editor";
import { LivePanel, type SharedSlideResult } from "./components/LivePanel";
import { Settings } from "./components/Settings";
import { importPresentation, readLocalPresentations, writeLocalPresentations, stripPrivateAnswerFields, readPendingQuizEdits, writePendingQuizEdits, writeLocalPrivateQuizKeys, deleteLocalQuizKeys, loadPrivateQuizKeys, quizKeyProblem, validateCloudMediaReferences, cleanupImportedMedia, type PrivateQuizKey, type ImportedPresentation, type PendingQuizEdit } from "./lib/presentations";
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
  const [liveDoc, setLiveDoc] = useState<Presentation | null>(null);
  const activeRef = useRef<Presentation | null>(null);
  const liveRef = useRef(false);
  const sharedInLive = useRef(false);
  const liveKeysRef = useRef<PrivateQuizKey[]>([]);
  const liveStartLock = useRef(false);
  const pendingEditorWork = useRef(0);
  const [editorVersion, setEditorVersion] = useState(0);
  const editorVersionRef = useRef(0);
  const editorSnapshots = useRef(new Map<number, Presentation>());

  // One writer at a time: a slower earlier request must never overwrite a newer edit.
  // Keep the newest unsaved version per document until a write really succeeds.
  const saveQueue = useRef(new LatestSaveQueue<{ presentation: Presentation; keys: PrivateQuizKey[] }>(({ presentation, keys }) => savePresentation(presentation, keys)));
  const keySnapshots = useRef(new Map<string, PrivateQuizKey[]>());
  const saveTimer = useRef<number | null>(null);

  const flushSaves = useCallback(async (): Promise<boolean> => {
    if (!hasSupabaseConfig) {
      try {
        const current=activeRef.current;
        if(current) {const items=readLocalPresentations();writeLocalPresentations(items.some(item=>item.id===current.id)?items.map(item=>item.id===current.id?current:item):[current,...items]);}
        return true;
      } catch {setToast({kind:"error",text:"Lokaler Speicher ist voll. Bitte Speicher freigeben und erneut versuchen."});return false;}
    }
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
      setToast({ kind: "error", text: `${message} Deine Änderungen bleiben ungespeichert im Editor. Falls eine Live-Sitzung läuft, beende sie vor Änderungen an Quizantworten oder Lösungsschlüsseln und speichere erneut.` });
      return false;
    }
  }, []);

  const queueSave = useCallback((presentation: Presentation, keys: PrivateQuizKey[] = []) => {
    if (!hasSupabaseConfig) return;
    saveQueue.current.enqueue(presentation.id, { presentation, keys });
    setSaving(true);
    setSaveError("");
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void flushSaves(); }, 700);
  }, [flushSaves]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (saveQueue.current.busy || pendingEditorWork.current > 0) {
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

  function changed(presentation: Presentation, keys: PrivateQuizKey[] = keySnapshots.current.get(presentation.id) ?? []) {
    presentation = stripPrivateAnswerFields(presentation) as Presentation;
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
    keySnapshots.current.set(safe.id, keys);
    if (!hasSupabaseConfig) {
      try { localStorage.setItem(`plexia.private.quiz-keys.v1.${safe.id}`, JSON.stringify(keys)); }
      catch { setToast({ kind: "error", text: "Private Lösungsschlüssel konnten lokal nicht gespeichert werden." }); }
    }
    queueSave(safe, keys);
  }

  function remountEditor() {
    editorVersionRef.current += 1;
    setEditorVersion(editorVersionRef.current);
  }

  function editorChanged(presentation: Presentation, keys: PrivateQuizKey[], version: number) {
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
      let backgroundImage=current.backgroundImage;
      if (previous.backgroundImage !== presentation.backgroundImage) {
        if (current.backgroundImage !== previous.backgroundImage) conflicted=true;
        else { backgroundImage=presentation.backgroundImage; applied=true; }
      }
      if (applied) {
        changed({ ...current, slides, backgroundImage, updatedAt: new Date().toISOString() });
        remountEditor();
      }
      if (conflicted) setToast({ kind: "error", text: "Ein abgeschlossener Medien-Upload wurde nicht eingefügt, weil das Ziel inzwischen geändert wurde." });
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
    changed(presentation, keys);
  }

  async function shareResults(slideId: string, results: SharedSlideResult[]) {
    if (!(await flushSaves())) throw new Error("Die Ergebnisse wurden nicht geteilt, weil vorherige Änderungen nicht gespeichert sind. Bitte speichere erneut.");
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
    // Do not install optimistic results in the live view: the database may reject
    // a write while a session has frozen quiz material, or the request may fail.
    try {
      if (hasSupabaseConfig) await savePresentation(next, keySnapshots.current.get(next.id) ?? liveKeysRef.current);
      else writeLocalPresentations([next, ...readLocalPresentations().filter(item => item.id !== next.id)]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unbekannter Speicherfehler.";
      throw new Error(`Teilen nicht bestätigt; die Live-Ansicht zeigt weiterhin den vorherigen Stand. ${message} Falls die aktive Sitzung Änderungen blockiert, beende sie und versuche es erneut.`);
    }
    if (activeRef.current !== current) throw new Error("Die Präsentation hat sich während des Teilens geändert. Bitte den Cloudstand neu laden und prüfen, bevor du erneut teilst.");
    sharedInLive.current = true;
    activeRef.current = next;
    setActive(next);
    setLiveDoc(next);
    setItems(previous => previous.some(item => item.id === next.id) ? previous.map(item => item.id === next.id ? next : item) : [next, ...previous]);
  }

  function create() {
    const presentation: Presentation = { id: createId(), title: "Neue Präsentation", description: "", theme: "light", slides: [createSlide("standard", "Willkommen")], version: 1, updatedAt: new Date().toISOString() };
    changed(presentation);
  }

  function hasPendingPrivateEdits(): boolean {
    try {
      if(activeRef.current && Object.keys(readPendingQuizEdits(activeRef.current.id)).length) {
        setToast({kind:"error",text:"Private Lösungsschlüssel sind noch nicht gespeichert. Bitte im Editor synchronisieren, bevor du fortfährst."}); return true;
      }
      return false;
    } catch {setToast({kind:"error",text:"Der private Wiederherstellungsentwurf kann nicht gelesen werden. Bitte diese Präsentation nicht verlassen."});return true;}
  }
  async function leaveEditor(nextView: "dashboard" | "settings" = "dashboard") {
    if (pendingEditorWork.current) { setToast({kind:"error",text:"Bitte warte, bis alle Medien-Uploads und KI-Änderungen abgeschlossen sind."}); return; }
    if (hasPendingPrivateEdits() || !(await flushSaves())) return;
    activeRef.current = null;
    remountEditor();
    setActive(null);
    setView(nextView);
  }

  // JSONB can reorder keys. Ignore the server-generated updatedAt but compare
  // every other saved field, including media paths and slide/option order.
  function comparable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(comparable);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "updatedAt").sort(([a],[b]) => a.localeCompare(b)).map(([key, child]) => [key, comparable(child)]));
    return value;
  }
  async function checkLiveReady(expected: PrivateQuizKey[]): Promise<Presentation> {
    if (pendingEditorWork.current) throw new Error("Bitte warte, bis alle Medien-Uploads und KI-Änderungen abgeschlossen sind.");
    if (hasPendingPrivateEdits()) throw new Error("Private Lösungsschlüssel sind noch nicht vollständig synchronisiert.");
    if (!(await flushSaves())) throw new Error("Die Präsentation konnte nicht vollständig gespeichert werden.");
    if (hasPendingPrivateEdits()) throw new Error("Private Lösungsschlüssel werden noch synchronisiert.");
    const current = activeRef.current;
    if (!current) throw new Error("Die Präsentation ist nicht mehr geöffnet.");
    validatePresentationTimeLimits(current);
    const expectedProblem = quizKeyProblem(current, expected);
    if (expectedProblem) throw new Error(expectedProblem.message);
    if (!hasSupabaseConfig || !supabase) return current;
    validateCloudMediaReferences(current);
    const [keys, saved] = await Promise.all([
      loadPrivateQuizKeys(current.id),
      supabase.from("presentations").select("data").eq("id", current.id).maybeSingle(),
    ]);
    if (saved.error) throw new Error(`Der Cloudstand konnte nicht geprüft werden: ${saved.error.message}`);
    if (!saved.data || JSON.stringify(comparable(saved.data.data)) !== JSON.stringify(comparable(JSON.parse(JSON.stringify(current))))) {
      throw new Error("Die Präsentation oder ihre Medien sind nicht vollständig mit der Cloud synchronisiert oder wurden anderswo geändert. Bitte im Editor prüfen und erneut speichern.");
    }
    const problem = quizKeyProblem(current, keys);
    if (problem) throw new Error(problem.message);
    for (const slide of current.slides.filter(item => item.type === "multiple_choice")) {
      const before = expected.find(key => key.slideId === slide.id)!;
      const actual = keys.find(key => key.slideId === slide.id)!;
      if (JSON.stringify([...before.correctIndices].sort((a,b)=>a-b)) !== JSON.stringify([...actual.correctIndices].sort((a,b)=>a-b)) || before.explanation !== actual.explanation) {
        throw new Error(`Der private Lösungsschlüssel für „${slide.title || "Quizfolie"}“ stimmt nicht mit dem Editor überein. Bitte den Editor erneut öffnen und den Schlüssel prüfen.`);
      }
    }
    if (activeRef.current !== current || hasPendingPrivateEdits() || saveQueue.current.busy || pendingEditorWork.current) throw new Error("Während der Prüfung gab es weitere Änderungen. Bitte warte auf die Synchronisation und versuche es erneut.");
    return current;
  }
  async function startLive(keys: PrivateQuizKey[]) {
    if (liveStartLock.current) return;
    liveStartLock.current = true;
    try {
      const checked = await checkLiveReady(keys);
      liveKeysRef.current = keys;
      sharedInLive.current = false;
      liveRef.current = true;
      setLiveDoc(checked);
      setLive(true);
    } catch (error) { setToast({kind:"error",text:error instanceof Error ? error.message : "Live-Prüfung fehlgeschlagen."}); }
    finally { liveStartLock.current = false; }
  }

  function closeLive() {
    liveRef.current = false;
    if (sharedInLive.current) remountEditor();
    sharedInLive.current = false;
    setLive(false);
    setLiveDoc(null);
  }

  async function remove(presentation: Presentation) {
    if (!window.confirm(`„${presentation.title}“ und alle zugehörigen privaten Lösungsschlüssel, Medien sowie Schülerfotos unwiderruflich löschen?`)) return;
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
      deleteLocalQuizKeys(presentation.id);
      setToast({ kind: "success", text: "Präsentation und zugehörige private Medien und Lösungsschlüssel gelöscht." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Löschen fehlgeschlagen.";
      setToast({ kind: "error", text: `${message} Die Präsentation blieb in deinem Konto erhalten; bereits entfernte Dateiteile lassen sich nicht wiederherstellen.` });
    }
  }

  async function onImport(file: File) {
    let imported: ImportedPresentation | null = null;
    let persistence: "not-started" | "attempted" | "saved" = "not-started";
    try {
      imported = await importPresentation(file);
      const presentation = imported.presentation;
      const pending: Record<string, PendingQuizEdit> = {};
      for (const key of imported.privateQuizKeys) {
        const slide=presentation.slides.find(item=>item.id===key.slideId);
        pending[key.slideId]={key,options:[...(slide?.content.options??[])]};
      }
      if(Object.keys(pending).length) writePendingQuizEdits(presentation.id,pending);
      if (hasSupabaseConfig) {
        setToast({ kind: "success", text: "Medien geprüft; Präsentation wird in deinem Lehrkraftkonto gespeichert…" });
        persistence = "attempted";
        await savePresentation(presentation, imported.privateQuizKeys);
      } else {
        const existing=readLocalPresentations();
        persistence = "attempted";
        writeLocalPresentations([presentation,...existing.filter(item=>item.id!==presentation.id)]);
        writeLocalPrivateQuizKeys(presentation.id, imported.privateQuizKeys);
      }
      persistence = "saved";
      try {
        keySnapshots.current.set(presentation.id, imported.privateQuizKeys);
        if (hasSupabaseConfig) deleteLocalQuizKeys(presentation.id);
        else writePendingQuizEdits(presentation.id, {});
        changed(presentation, imported.privateQuizKeys);
        setToast({kind:"success",text:`„${presentation.title}“ importiert${imported.privateQuizKeys.length?`; ${imported.privateQuizKeys.length} vertrauliche Lösungsschlüssel atomar gespeichert`:""}.`});
      } catch(error) {
        changed(presentation);
        setToast({kind:"error",text:`Präsentation importiert, aber private Lösungsschlüssel noch nicht vollständig gespeichert. Der Wiederherstellungsentwurf bleibt auf diesem Gerät; öffne den Editor und synchronisiere ihn. Quelldatei aufbewahren. ${error instanceof Error?error.message:""}`});
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Datei konnte nicht importiert werden.";
      if (!imported || persistence === "saved") { setToast({kind:"error",text:`${message} Die Quelldatei bleibt unverändert.`}); return; }
      // A timed-out write may still commit after even a fresh read says absent.
      // Only clean up automatically before a cloud write has been attempted.
      let mayDelete = persistence === "not-started";
      if (persistence === "attempted" && !hasSupabaseConfig) mayDelete = !readLocalPresentations().some(item=>item.id===imported!.presentation.id);
      if (!mayDelete) {
        try { localStorage.setItem(`plexia.import-recovery.v1.${imported.presentation.id}`, JSON.stringify({presentationId:imported.presentation.id,uploadedPaths:imported.uploadedPaths,createdAt:new Date().toISOString()})); } catch { /* The ID is also shown below. */ }
        setToast({kind:"error",text:`${message} Die Speicherung ist nicht bestätigt und könnte noch abgeschlossen werden; Medien bleiben daher erhalten. Prüfe später im Konto die Präsentations-ID ${imported.presentation.id}. Nur wenn dort keine Präsentation existiert und der Schreibvorgang abgeschlossen ist, entferne ihre Dateien im privaten presentation-media-Storage manuell. Quelldatei und lokalen Schlüsselentwurf aufbewahren.`});
        void reloadCloud();
        return;
      }
      try {
        await cleanupImportedMedia(imported.uploadedPaths);
        deleteLocalQuizKeys(imported.presentation.id);
        setToast({kind:"error",text:`${message} Bereits hochgeladene Medien wurden bereinigt; die Quelldatei bleibt unverändert.`});
      } catch {
        try { localStorage.setItem(`plexia.import-recovery.v1.${imported.presentation.id}`, JSON.stringify({presentationId:imported.presentation.id,uploadedPaths:imported.uploadedPaths,createdAt:new Date().toISOString()})); } catch { /* The ID is also shown below. */ }
        setToast({kind:"error",text:`${message} Die Medienbereinigung wurde nicht bestätigt. Prüfe im privaten Supabase-Storage den Ordner zur Präsentations-ID ${imported.presentation.id} und entferne dort gegebenenfalls die Dateien manuell. Quelldatei aufbewahren.`});
      }
    }
  }

  async function logout() {
    if (pendingEditorWork.current) { setToast({kind:"error",text:"Bitte warte, bis alle Medien-Uploads und KI-Änderungen abgeschlossen sind."}); return; }
    if (hasPendingPrivateEdits() || !(await flushSaves())) return;
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
    {active ? <Editor key={`${active.id}:${editorVersion}`} presentation={active} onChange={(presentation, keys) => editorChanged(presentation, keys, editorVersion)} onBack={() => void leaveEditor()} onBackgroundWorkChange={(started) => { pendingEditorWork.current = Math.max(0, pendingEditorWork.current + (started ? 1 : -1)); }} onLive={(keys) => void startLive(keys)} flushPresentation={flushSaves} isCloud={hasSupabaseConfig} saving={saving} keyboardShortcutsEnabled={!live} saveError={Boolean(saveError)}/> : view === "settings" ? <Settings/> : <Dashboard presentations={items} onCreate={create} onOpen={(presentation) => { const safe=stripPrivateAnswerFields(presentation) as Presentation; activeRef.current = safe; setActive(safe); setView("dashboard"); }} onDelete={(presentation) => void remove(presentation)} onImport={(file) => void onImport(file)} isCloud={hasSupabaseConfig} saving={saving} teacherName={user?.email || ""}/>}
    <footer className="app-footer"><span>PLEXIA STUDIO <span className="footer-dot">·</span> Unterricht mit Ideen.</span><span><CircleHelp size={14}/> Mit Sorgfalt für den Unterricht gestaltet</span></footer>
    {live && liveDoc && <LivePanel presentation={liveDoc} onClose={closeLive} onShareResults={shareResults} saveError={saveError} onPrepareStart={async () => { const checked = await checkLiveReady(liveKeysRef.current); setLiveDoc(checked); return checked; }}/>}
    {toast && <div className={`toast ${toast.kind}`} role="status">{toast.text}<button aria-label="Hinweis schließen" onClick={() => setToast(null)}>×</button></div>}
  </div>;
}
