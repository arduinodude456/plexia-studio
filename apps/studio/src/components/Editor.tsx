import { useEffect, useRef, useState, type DragEvent, type FormEvent, type PointerEvent } from "react";
import { AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowLeft, ArrowUp, BarChart3, Bold, Circle, Copy, Eye, Image, Italic, Layers, LineChart, LoaderCircle, MessageCircle, MonitorPlay, MousePointer2, Plus, Redo2, Send, Settings2, Shapes, Sparkles, Table2, Trash2, Type, Undo2, Upload, Video, X } from "lucide-react";
import { createId, createSlide, createSnapshotScheduler, groqProxy, hasSupabaseConfig, listOwnOpenClassSessions, slideTypeLabels, updateClassSession, uploadPresentationMedia, validatePresentationTimeLimits, type OpenClassSession, type Presentation, type PlexiaSlide, type SlideElement, type SlideType } from "@plexia/shared";
import { SlideStage, type ResizeHandle } from "./SlideStage";
import { exportPresentation, loadPrivateQuizKeys, readPendingQuizEdits, writePendingQuizEdits, writeLocalPrivateQuizKeys, stripPrivateAnswerFields, quizKeyProblem, type PrivateQuizKey, type PendingQuizEdit } from "../lib/presentations";
import { editPresentationLocally, LOCAL_MODELS, loadLocalModel, localModelIsSupported, type LocalModelId } from "../lib/local-ai";
import "./Editor.css";

type QuizMap = Record<string, PrivateQuizKey>;
type EditorHistory = { doc: Presentation; keys: QuizMap };
type PresentationSettings = Presentation & { backgroundImage?: string; participation?: { avatarsEnabled?: boolean; nicknameGeneratorEnabled?: boolean } };
type WordFilter = { mode: "off" | "blacklist" | "whitelist"; match: "exact" | "contains"; terms: string[] };
interface Props { presentation: Presentation; onChange: (p: Presentation, keys: PrivateQuizKey[]) => void; onBack: () => void; onBackgroundWorkChange: (started: boolean) => void; onLive: (keys: PrivateQuizKey[]) => void; flushPresentation: () => Promise<boolean>; isCloud: boolean; saving: boolean; keyboardShortcutsEnabled: boolean; saveError?: boolean }
type ElementPatch = Partial<SlideElement>;
type Template = "cover" | "content" | "split" | "quote" | "aurora" | "tech" | "book";
const colors = ["#ffffff", "#5638bd", "#352376", "#ffc952", "#d79520"];
const inkColors = ["#352376", "#5638bd", "#d79520", "#ffc952", "#ffffff"];
const typeGroups: Array<{ label: string; items: Array<{ type: SlideType; description: string }> }> = [
  { label: "Präsentieren", items: [{type:"standard",description:"Deine Inhalte frei gestalten"},{type:"video",description:"Ein Video gemeinsam ansehen"},{type:"results",description:"Ergebnisse zeigen"}] },
  { label: "Wissen & Feedback", items: [{type:"multiple_choice",description:"Antworten auswählen"},{type:"poll",description:"Meinungen abfragen"},{type:"free_text",description:"Eine eigene Antwort schreiben"},{type:"worksheet",description:"Eine Aufgabe bearbeiten"},{type:"photo_task",description:"Ein Ergebnis als Foto abgeben"}] },
  { label: "Gemeinsam arbeiten", items: [{type:"brainstorm",description:"Ideen in der Klasse sammeln"},{type:"wordcloud",description:"Begriffe sichtbar machen"},{type:"mindmap",description:"Gedanken verknüpfen"},{type:"group_work",description:"In Gruppen zusammenarbeiten"}] },
];
const templates: Array<{ id: Template; title: string; detail: string }> = [
  {id:"cover",title:"Titelfolie",detail:"Ein starker Anfang"}, {id:"content",title:"Titel & Text",detail:"Für deine wichtigsten Ideen"},
  {id:"split",title:"Text & Bild",detail:"Inhalt mit Bildfläche"}, {id:"quote",title:"Zitat",detail:"Ein Gedanke im Mittelpunkt"},
  {id:"aurora",title:"Aurora",detail:"Leuchtend · weich · modern"}, {id:"tech",title:"Tech",detail:"Kontrastreich · präzise · digital"}, {id:"book",title:"Book",detail:"Editorial · ruhig · elegant"},
];
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
function newElement(kind: SlideElement["kind"], z: number): SlideElement {
  const common: SlideElement = {id:createId(), kind, x:kind==="text"?12:20, y:kind==="text"?24:30, width:kind==="text"?48:28, height:kind==="text"?19:24, rotation:0, zIndex:z, content:kind==="text"?"Dein Text":"", color:"#352376"};
  if (kind === "text") return {...common, fontSize:32, fontWeight:"bold", textAlign:"left"};
  if (kind === "shape") return {...common, background:"#5638bd", shape:"rectangle"};
  if (kind === "table") return {...common, rows:[["Begriff","Erklärung"],["Beispiel","Deine Notiz"]]};
  if (kind === "chart") return {...common, points:[{label:"A",value:6},{label:"B",value:9},{label:"C",value:4}]};
  return common;
}
function templateSlide(template: Template): PlexiaSlide {
  const slide = createSlide("standard");
  const text = (content: string, x: number, y: number, width: number, height: number, fontSize: number, extra: Partial<SlideElement> = {}): SlideElement => ({...newElement("text",2), content, x, y, width, height, fontSize, ...extra});
  if (template === "cover") {
    slide.title = "Dein großes Thema"; slide.background = "#ffffff";
    slide.elements = [
      {...newElement("shape",1),x:76,y:11,width:14,height:25,shape:"circle",background:"#ffc952"},
      text("Dein großes Thema",9,26,75,24,58),
      text("Eine gute Geschichte beginnt hier.",10,55,65,13,25,{fontWeight:"normal",color:"#352376"}),
    ];
  } else if (template === "content") {
    slide.title = "Das Wichtigste auf einen Blick"; slide.background = "#ffffff";
    slide.elements = [text("Das Wichtigste auf einen Blick",8,12,84,20,43), text("• Erste Idee\n• Zweite Idee\n• Das möchtest du dir merken",9,37,80,47,29,{fontWeight:"normal"})];
  } else if (template === "split") {
    slide.title = "Text & Bild"; slide.background = "#ffffff";
    slide.elements = [text("Deine Idee",8,19,42,19,45), text("Erkläre hier, was wichtig ist.",8,43,40,30,27,{fontWeight:"normal"}), {...newElement("image",2),x:55,y:15,width:36,height:70}];
  } else if (template === "quote") {
    slide.title = "Ein Gedanke"; slide.background = "#ffc952";
    slide.elements = [text("„Ein Gedanke kann alles verändern.“",12,30,76,34,46,{textAlign:"center"}),text("— Deine Quelle",25,70,50,12,22,{fontWeight:"normal",textAlign:"center",color:"#352376"})];
  } else if (template === "aurora") {
    slide.title = "Aurora"; slide.background = "#352376";
    slide.elements = [text("Ideen, die leuchten",9,23,72,23,54,{fontFamily:"display",color:"#ffffff"}),text("Ein weicher Start für große Gedanken.",10,55,62,14,25,{fontWeight:"normal",fontFamily:"sans",color:"#ffc952"}),{...newElement("shape",1),x:76,y:10,width:17,height:28,shape:"circle",background:"#d79520",opacity:1,borderRadius:50}];
  } else if (template === "tech") {
    slide.title = "System 01"; slide.background = "#352376";
    slide.elements = [text("SYSTEM 01",9,13,72,16,48,{fontFamily:"mono",color:"#ffc952"}),text("Build a better tomorrow.",10,38,78,22,40,{fontFamily:"display",color:"#ffffff"}),text("// PLEXIA · 2026",10,76,55,10,17,{fontFamily:"mono",fontWeight:"normal",color:"#ffffff"})];
  } else {
    slide.title = "Kapitel Eins"; slide.background = "#ffffff";
    slide.elements = [text("Kapitel Eins",10,17,78,20,48,{fontFamily:"serif",color:"#352376"}),text("Eine ruhige Bühne für Geschichten, Wissen und Details.",11,48,65,25,25,{fontFamily:"serif",fontWeight:"normal",color:"#5638bd"})];
  }
  return slide;
}
function Palette({ value, options, onChange, label }: { value: string; options: string[]; onChange: (color: string) => void; label: string }) {
  return <div className="editor-palette" role="group" aria-label={label}>{options.map(color => <button key={color} type="button" className={`editor-swatch ${value.toLowerCase()===color.toLowerCase()?"active":""}`} style={{background:color}} title={color} aria-label={`${label} ${color}`} aria-pressed={value.toLowerCase()===color.toLowerCase()} onClick={()=>onChange(color)}/>)}</div>;
}
function NumberField({label,value,min,max,onValue}: {label:string;value:number;min:number;max:number;onValue:(value:number)=>void}) {
  const [draft,setDraft]=useState(String(value));
  const focused=useRef(false);
  useEffect(()=>{if(!focused.current)setDraft(String(value));},[value]);
  return <label className="prop-label">{label}<input type="number" min={min} max={max} step="any" value={draft}
    onFocus={()=>{focused.current=true;}}
    onChange={e=>{const raw=e.target.value;setDraft(raw);const n=Number(raw);if(raw!==""&&Number.isFinite(n)&&n>=min&&n<=max)onValue(n);}}
    onBlur={()=>{focused.current=false;const n=clamp(Number(draft),min,max);setDraft(String(n));if(n!==value)onValue(n);}}/></label>;
}

// Match the DB's protected MC fields, including slide position and absent values.
function quizProjection(doc: Presentation): string {
  return JSON.stringify(doc.slides.flatMap((slide,index)=>slide.type==="multiple_choice" ? [{
    index, id:slide.id, type:slide.type,
    hasQuestion:Object.hasOwn(slide.content,"question"), question:slide.content.question,
    hasOptions:Object.hasOwn(slide.content,"options"), options:slide.content.options,
    hasMultiple:Object.hasOwn(slide.content,"allowMultiple"), allowMultiple:slide.content.allowMultiple,
  }] : []));
}
function privateKeySnapshot(doc: Presentation, keys: QuizMap): PrivateQuizKey[] {
  return doc.slides.filter(slide=>slide.type==="multiple_choice").flatMap(slide=>keys[slide.id]?[keys[slide.id]]:[]);
}
function sessionTime(value: string): string {
  const timestamp=Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Zeit unbekannt";
  const formatted=new Intl.DateTimeFormat("de-DE",{dateStyle:"short",timeStyle:"short"}).format(timestamp);
  const elapsed=Date.now()-timestamp;
  if (elapsed < 0) return `${formatted} (Geräteuhr prüfen)`;
  const minutes=Math.floor(elapsed/60_000);
  const age=minutes<1?"unter 1 Minute":minutes<60?`${minutes} Min.`:minutes<1440?`${Math.floor(minutes/60)} Std.`:`${Math.floor(minutes/1440)} Tage`;
  return `${formatted} · vor ca. ${age}`;
}
function errorMessage(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : fallback;
}
export function Editor({presentation,onChange,onBack,onBackgroundWorkChange,onLive,flushPresentation,isCloud,saving,keyboardShortcutsEnabled,saveError=false}: Props) {
  // The editor stays mounted under LivePanel. A ref closes the interval between
  // a render and effect cleanup, when the old listener can still be installed.
  const keyboardEnabledRef=useRef(keyboardShortcutsEnabled);
  keyboardEnabledRef.current=keyboardShortcutsEnabled;
  const [doc,setDoc]=useState(presentation);
  const [slideId,setSlideId]=useState(presentation.slides[0]?.id||"");
  const [selectedId,setSelectedId]=useState("");
  const [history,setHistory]=useState<EditorHistory[]>([{doc:presentation,keys:{}}]);
  const [historyIndex,setHistoryIndex]=useState(0);
  const [preview,setPreview]=useState(false);
  const [chooser,setChooser]=useState(false);
  const [inspectorOpen,setInspectorOpen]=useState(false);
  const [aiOpen,setAiOpen]=useState(false);
  const [aiInput,setAiInput]=useState("");
  const [aiBusy,setAiBusy]=useState(false);
  const [aiError,setAiError]=useState("");
  const [aiModel,setAiModel]=useState("llama-3.3-70b-versatile");
  const [aiModels,setAiModels]=useState<Array<{id:string;contextWindow?:number}>>([]);
  const [aiMessages,setAiMessages]=useState<Array<{role:"user"|"assistant";text:string}>>([]);
  const [aiProvider,setAiProvider]=useState<"groq"|"local">("groq");
  const [localModel,setLocalModel]=useState<LocalModelId>(LOCAL_MODELS[0].id);
  const [localReady,setLocalReady]=useState(false);
  const [localDownloading,setLocalDownloading]=useState(false);
  const [localProgress,setLocalProgress]=useState<number|null>(null);
  const [localProgressText,setLocalProgressText]=useState("");
  const [notice,setNotice]=useState("");
  const [uploadingMedia,setUploadingMedia]=useState(false);
  const uploadInFlight=useRef(false);
  const [timeDrafts,setTimeDrafts]=useState<Record<string,string>>({});
  const [dragSlideId,setDragSlideId]=useState("");
  const [quizKeys,setQuizKeys]=useState<QuizMap>({});
  const quizKeysRef=useRef<QuizMap>({});
  const pendingQuizRef=useRef<Record<string, PendingQuizEdit>>({});
  const quizSyncRef=useRef(false);
  const [quizReady,setQuizReady]=useState(false);
  const [quizRetry,setQuizRetry]=useState(0);
  const [quizStatus,setQuizStatus]=useState("");
  const [quizPending,setQuizPending]=useState(false);
  const [quizConflict,setQuizConflict]=useState("");
  const [sessions,setSessions]=useState<OpenClassSession[]>([]);
  const [sessionState,setSessionState]=useState<"loading"|"ready"|"error">("loading");
  const [sessionError,setSessionError]=useState("");
  const [sessionActionError,setSessionActionError]=useState("");
  const [sessionNotice,setSessionNotice]=useState("");
  const [sessionPanel,setSessionPanel]=useState(false);
  const [endingSession,setEndingSession]=useState("");
  const [retryingSave,setRetryingSave]=useState(false);
  const endingSessionRef=useRef(false);
  const refreshSessionsRef=useRef<(invalidate?: boolean)=>void>(()=>{});
  const sessionsAvailable=isCloud && hasSupabaseConfig;
  const quizLocked=sessionsAvailable && (sessionState!=="ready" || sessions.length>0);
  const quizLockedRef=useRef(quizLocked);
  quizLockedRef.current=quizLocked;
  const backgroundInputRef=useRef<HTMLInputElement>(null);
  const settingsDoc=doc as PresentationSettings;
  const stageRef=useRef<HTMLDivElement>(null);
  const mediaInputRef=useRef<HTMLInputElement>(null);
  const latestDoc=useRef(doc);
  latestDoc.current=doc;
  const latestCommit=useRef<(next: Presentation) => void>(()=>{});
  const drag=useRef<{id:string;slideId:string;startX:number;startY:number;x:number;y:number;width:number;height:number;rect:DOMRect;latest:Presentation;moved:boolean}|null>(null);
  const resize=useRef<{id:string;slideId:string;handle:ResizeHandle;startX:number;startY:number;x:number;y:number;width:number;height:number;rect:DOMRect;latest:Presentation;moved:boolean}|null>(null);
  const slide=doc.slides.find(s=>s.id===slideId)||doc.slides[0];
  const selected=slide?.elements.find(e=>e.id===selectedId);
  const slideIndex=doc.slides.findIndex(s=>s.id===slide?.id);
  const canUndo=historyIndex>0, canRedo=historyIndex<history.length-1;

  useEffect(()=>{
    if (!sessionsAvailable) return;
    const scheduler=createSnapshotScheduler(async isCurrent=>{
      try {
        const current=await listOwnOpenClassSessions(presentation.id);
        if (!isCurrent()) return;
        setSessions(current); setSessionError(""); setSessionState("ready");
      } catch(error) {
        if (!isCurrent()) return;
        setSessionError(errorMessage(error,"Die offenen Sitzungen konnten nicht geladen werden.")); setSessionState("error");
      }
    });
    refreshSessionsRef.current=(invalidate=true)=>scheduler.request(invalidate);
    scheduler.request();
    const timer=window.setInterval(()=>scheduler.request(false),30_000);
    const onFocus=()=>scheduler.request();
    window.addEventListener("focus",onFocus);
    return ()=>{scheduler.close();window.clearInterval(timer);window.removeEventListener("focus",onFocus);refreshSessionsRef.current=()=>{};};
  },[presentation.id,sessionsAvailable]);
  useEffect(()=>{
    if (sessionsAvailable && (saveError || quizPending)) refreshSessionsRef.current();
  },[sessionsAvailable,saveError,quizPending]);

  async function endOpenSession(session: OpenClassSession) {
    if (endingSessionRef.current || sessionState!=="ready") return;
    if (!window.confirm(`Sitzung mit Code ${session.joinCode || "unbekannt"} wirklich beenden? Teilnehmende können danach keine Antworten mehr senden. Andere Sitzungen bleiben geöffnet.`)) return;
    endingSessionRef.current=true; setEndingSession(session.id); setSessionActionError(""); setSessionNotice("");
    onBackgroundWorkChange(true);
    // Invalidate any snapshot started before the user command.
    refreshSessionsRef.current();
    try {
      await updateClassSession(session.id,{status:"ended",activityStatus:"ended"},session.syncUpdatedAt);
      setSessionNotice(`Sitzung ${session.joinCode || "ohne Code"} wurde beendet. Prüfe die verbleibenden Sitzungen und speichere offene Änderungen erneut.`);
    } catch(error) {
      setSessionActionError(`Beenden nicht bestätigt: ${errorMessage(error,"Die Sitzung konnte nicht beendet werden.")} Bitte den aktuellen Status prüfen.`);
    } finally {
      endingSessionRef.current=false; setEndingSession(""); onBackgroundWorkChange(false); refreshSessionsRef.current();
    }
  }
  async function retryEditorSave() {
    if (retryingSave || quizSyncRef.current) return;
    setRetryingSave(true);
    try {
      if (!(await flushPresentation())) return;
      if (Object.keys(pendingQuizRef.current).length) await syncQuizKeys();
      if (!Object.keys(pendingQuizRef.current).length) setNotice("Speicherung erneut ausgeführt. Prüfe den Speicherstatus im Editor.");
    } finally { setRetryingSave(false); }
  }
  function quizChangeBlocked(next: Presentation, changedKeys: PrivateQuizKey[]): boolean {
    if (!quizLockedRef.current || (!changedKeys.length && quizProjection(next)===quizProjection(latestDoc.current))) return false;
    setNotice("Quizänderung nicht angewendet: Bitte den Sitzungsstatus prüfen und alle offenen Sitzungen dieser Präsentation beenden. Bereits vorhandene Entwürfe bleiben erhalten.");
    return true;
  }

  // A durable journal is written before changing a key or its option indices.
  // Writes are serialized; an older response must not erase a newer draft.
  async function syncQuizKeys() {
    if (quizSyncRef.current) return;
    quizSyncRef.current=true;
    try {
      while (Object.keys(pendingQuizRef.current).length) {
        const [id, draft]=Object.entries(pendingQuizRef.current)[0];
        const target=latestDoc.current.slides.find(item=>item.id===id);
        if (target && JSON.stringify(target.content.options ?? [])!==JSON.stringify(draft.options)) {
          setQuizConflict(id); setQuizStatus("Die gespeicherten Antworten unterscheiden sich vom privaten Wiederherstellungsentwurf. Stelle die Antworten aus dem Entwurf wieder her, bevor du synchronisierst."); return;
        }
        setQuizStatus("Private Lösungsschlüssel werden gespeichert …");
        const result = { ...quizKeysRef.current, [id]: draft.key };
        const completeKeys = privateKeySnapshot(latestDoc.current, result);
        if (!hasSupabaseConfig) {
          writeLocalPrivateQuizKeys(presentation.id, completeKeys);
        } else {
          if (!(await flushPresentation())) throw new Error("Die Präsentation konnte noch nicht gespeichert werden.");
          onChange(latestDoc.current, completeKeys);
          if (!(await flushPresentation())) throw new Error("Die Präsentation und privaten Lösungsschlüssel konnten nicht atomar gespeichert werden.");
        }
        if (JSON.stringify(pendingQuizRef.current[id])===JSON.stringify(draft)) {
          const remaining={...pendingQuizRef.current}; delete remaining[id];
          writePendingQuizEdits(presentation.id,remaining); pendingQuizRef.current=remaining;
        }
      }
      setQuizConflict(""); setQuizPending(false); setQuizStatus("");
    } catch(error) {
      setQuizPending(true);
      setQuizStatus(`Privater Schlüssel NICHT synchronisiert. Der Entwurf bleibt auf diesem Gerät erhalten. ${error instanceof Error?error.message:"Bitte erneut versuchen."}`);
    } finally { quizSyncRef.current=false; }
  }
  function stageQuizEdits(changedKeys: PrivateQuizKey[], next: Presentation): boolean {
    if (!changedKeys.length) return true;
    try {
      const pending={...pendingQuizRef.current};
      changedKeys.forEach(key=>{ const target=next.slides.find(item=>item.id===key.slideId); pending[key.slideId]={key,options:[...(target?.content.options ?? pending[key.slideId]?.options ?? [])]}; });
      writePendingQuizEdits(presentation.id,pending); pendingQuizRef.current=pending; setQuizPending(true);
      return true;
    } catch { setQuizStatus("Der private Wiederherstellungsentwurf konnte nicht auf diesem Gerät gespeichert werden. Die Änderung wurde nicht angewendet."); return false; }
  }
  useEffect(()=>{
    let active=true;
    void (async()=>{
      try {
        const [keys,pending]=await Promise.all([loadPrivateQuizKeys(presentation.id),Promise.resolve(readPendingQuizEdits(presentation.id))]);
        if(!active)return;
        const map:QuizMap=Object.fromEntries(keys.map(key=>[key.slideId,key]));
        for(const [id,draft] of Object.entries(pending)) map[id]=draft.key;
        quizKeysRef.current=map; pendingQuizRef.current=pending; setQuizKeys(map);
        setHistory(items=>items.map(item=>({...item,keys:map})));
        setQuizReady(true); setQuizPending(Object.keys(pending).length>0);
        if(Object.keys(pending).length) void syncQuizKeys();
      } catch(error) { if(active)setQuizStatus(error instanceof Error?error.message:"Private Schlüssel konnten nicht geladen werden."); }
    })();
    return ()=>{active=false;};
  },[presentation.id,quizRetry]);
  useEffect(()=>{
    const warn=(event:BeforeUnloadEvent)=>{if(Object.keys(pendingQuizRef.current).length){event.preventDefault();event.returnValue="";}};
    window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn);
  },[]);
  function commit(next: Presentation, nextKeys: QuizMap = quizKeysRef.current): boolean {
    next=stripPrivateAnswerFields(next) as Presentation;
    const changedKeys=Object.values(nextKeys).filter(key=>JSON.stringify(key)!==JSON.stringify(quizKeysRef.current[key.slideId]));
    if (quizChangeBlocked(next,changedKeys)) return false;
    if (!stageQuizEdits(changedKeys,next)) return false;
    // Keep the options in an outstanding recovery record current while editing text.
    if (Object.keys(pendingQuizRef.current).length) {
      const pending={...pendingQuizRef.current};
      for(const [id,draft] of Object.entries(pending)) {
        const target=next.slides.find(item=>item.id===id);
        if(target && id!==quizConflict) pending[id]={...draft,options:[...(target.content.options??[])]};
      }
      try {writePendingQuizEdits(presentation.id,pending);pendingQuizRef.current=pending;}
      catch {setQuizStatus("Der private Entwurf konnte nicht aktualisiert werden. Die Änderung wurde nicht angewendet.");return false;}
    }
    const updated={...next,updatedAt:new Date().toISOString()};
    latestDoc.current=updated; quizKeysRef.current=nextKeys; setQuizKeys(nextKeys);
    setDoc(updated); onChange(updated, privateKeySnapshot(updated, nextKeys));
    const truncated=history.slice(0,historyIndex+1);
    setHistory([...truncated,{doc:updated,keys:nextKeys}].slice(-50)); setHistoryIndex(Math.min(truncated.length,49));
    if(Object.keys(pendingQuizRef.current).length) void syncQuizKeys();
    return true;
  }
  latestCommit.current=commit;
  function restore(index: number) {
    if(index<0||index>=history.length)return;
    const snapshot=history[index];
    // Keep orphaned keys for deleted/undone slides: redo must not lose them.
    const restoredKeys={...quizKeysRef.current,...snapshot.keys};
    for(const [id,key] of Object.entries(restoredKeys)) {
      if(!snapshot.keys[id] && snapshot.doc.slides.some(item=>item.id===id)) restoredKeys[id]={...key,correctIndices:[]};
    }
    const changedKeys=Object.values(restoredKeys).filter(key=>JSON.stringify(key)!==JSON.stringify(quizKeysRef.current[key.slideId]));
    if (quizChangeBlocked(snapshot.doc,changedKeys)) return;
    if(!stageQuizEdits(changedKeys,snapshot.doc))return;
    if(Object.keys(pendingQuizRef.current).length) {
      const pending={...pendingQuizRef.current};
      for(const [id,draft] of Object.entries(pending)){const target=snapshot.doc.slides.find(item=>item.id===id);if(target&&id!==quizConflict)pending[id]={...draft,options:[...(target.content.options??[])]};}
      try{writePendingQuizEdits(presentation.id,pending);pendingQuizRef.current=pending;}catch{setQuizStatus("Der private Entwurf konnte nicht aktualisiert werden. Rückgängig wurde nicht angewendet.");return;}
    }
    latestDoc.current=snapshot.doc; quizKeysRef.current=restoredKeys; setQuizKeys(restoredKeys);
    setHistoryIndex(index); setDoc(snapshot.doc); onChange(snapshot.doc, privateKeySnapshot(snapshot.doc, restoredKeys)); setSelectedId("");
    if(!snapshot.doc.slides.some(s=>s.id===slideId)) setSlideId(snapshot.doc.slides[0]?.id||"");
    if(Object.keys(pendingQuizRef.current).length)void syncQuizKeys();
  }
  function patchSlide(patch: Partial<PlexiaSlide>) { if(slide)commit({...doc,slides:doc.slides.map(s=>s.id===slide.id?{...s,...patch}:s)}); }
  function patchElement(id: string, patch: ElementPatch) { if(slide)patchSlide({elements:slide.elements.map(e=>e.id===id?{...e,...patch}:e)}); }
  function updateContent(key: string, value: unknown) { if(slide)patchSlide({content:{...slide.content,[key]:value}}); }
  function chooseSlide(id: string) { setSlideId(id); setSelectedId(""); }
  function addSlide(type: SlideType="standard", template?: Template) {
    const next=template?templateSlide(template):createSlide(type);
    if(!template && type==="standard") next.title="Neue Folie";
    const slides=[...doc.slides]; slides.splice(Math.max(0,slideIndex+1),0,next);
    if(commit({...doc,slides})) { chooseSlide(next.id); setChooser(false); }
  }
  function addTemplateDeck(template: Extract<Template,"aurora"|"tech"|"book">) {
    const deck=[templateSlide(template),templateSlide(template),templateSlide(template)];
    const labels=template==="aurora"?["01 · Auftakt","02 · Idee","03 · Nächster Schritt"]:template==="tech"?["SYSTEM 01","SYSTEM 02","SYSTEM 03"]:["Kapitel Eins","Kapitel Zwei","Kapitel Drei"];
    deck.forEach((item,index)=>{item.title=labels[index]; if(index===1)item.elements=item.elements.map(element=>element.kind==="text"?{...element,content:template==="tech"?"Signal / Struktur":"Die wichtigste Idee",y:26}:element); if(index===2)item.elements=item.elements.map(element=>element.kind==="text"?{...element,content:template==="aurora"?"Bereit zum Abheben":"Dein Fazit",y:31}:element);});
    const slides=[...doc.slides]; slides.splice(Math.max(0,slideIndex+1),0,...deck); if(commit({...doc,slides})){chooseSlide(deck[0].id);setChooser(false);setNotice(`${template[0].toUpperCase()+template.slice(1)}-Deck mit 3 Folien hinzugefügt.`);}
  }
  function moveSlide(delta: number) {
    const j=slideIndex+delta; if(slideIndex<0||j<0||j>=doc.slides.length)return;
    const list=[...doc.slides]; [list[slideIndex],list[j]]=[list[j],list[slideIndex]]; commit({...doc,slides:list});
  }
  function dropSlide(event: DragEvent, targetId: string) {
    event.preventDefault(); const source=event.dataTransfer.getData("text/plain")||dragSlideId; setDragSlideId("");
    if(!source||source===targetId)return;
    const slides=[...doc.slides]; const from=slides.findIndex(s=>s.id===source), to=slides.findIndex(s=>s.id===targetId);
    if(from<0||to<0)return; const [moved]=slides.splice(from,1); slides.splice(to,0,moved); commit({...doc,slides});
  }
  function duplicateSlide() {
    if(!slide)return;
    if(slide.type==="multiple_choice"&&!quizReady){setNotice("Bitte zuerst die privaten Lösungsschlüssel laden.");return;}
    const copy={...slide,id:createId(),title:`${slide.title} (Kopie)`,createdAt:new Date().toISOString(),elements:slide.elements.map(e=>({...e,id:createId()}))};
    const slides=[...doc.slides]; slides.splice(slideIndex+1,0,copy);
    const sourceKey=quizKeysRef.current[slide.id];
    const keys=slide.type==="multiple_choice"&&sourceKey?{...quizKeysRef.current,[copy.id]:{...sourceKey,slideId:copy.id}}:quizKeysRef.current;
    if(!commit({...doc,slides},keys))return; chooseSlide(copy.id);
    if(slide.type==="multiple_choice"&&!quizReady) setNotice("Private Schlüssel sind noch nicht geladen; die Kopie enthält keinen Lösungsschlüssel.");
  }
  function deleteSlide() {
    if(!slide)return;
    if(doc.slides.length===1){setNotice("Mindestens eine Folie muss erhalten bleiben.");return;}
    if(!window.confirm(`„${slide.title || "Diese Folie"}“ wirklich löschen? Du kannst die Aktion rückgängig machen.`))return;
    const slides=doc.slides.filter(s=>s.id!==slide.id); if(commit({...doc,slides}))chooseSlide(slides[Math.max(0,slideIndex-1)].id);
  }
  function changeType(type: SlideType) {
    if(!slide||slide.type===type)return;
    if(quizLockedRef.current&&(slide.type==="multiple_choice"||type==="multiple_choice")){setNotice("Der Quiz-Folientyp ist während offener Sitzungen gesperrt.");return;}
    const defaults=createSlide(type).content;
    patchSlide({type,content:{...defaults,...slide.content}});
    setNotice("Der Folientyp wurde geändert. Vorhandene Inhalte bleiben erhalten – prüfe die Einstellungen der Aktivität.");
  }
  function selectElement(id: string) { setSelectedId(id); setInspectorOpen(true); }
  function add(kind: SlideElement["kind"]) {
    if(!slide)return;
    const item=newElement(kind,Math.max(0,...slide.elements.map(e=>e.zIndex))+1);
    patchSlide({elements:[...slide.elements,item]}); selectElement(item.id);
  }
  function duplicateElement() {
    if(!slide||!selected)return;
    const item={...selected,id:createId(),x:Math.min(100-selected.width,selected.x+3),y:Math.min(100-selected.height,selected.y+3),zIndex:Math.max(0,...slide.elements.map(e=>e.zIndex))+1};
    patchSlide({elements:[...slide.elements,item]}); selectElement(item.id);
  }
  function removeSelected() { if(!slide||!selected)return; patchSlide({elements:slide.elements.filter(e=>e.id!==selected.id)}); setSelectedId(""); }
  function moveLayer(direction: -1|1) {
    if(!slide||!selected)return;
    const sorted=[...slide.elements].sort((a,b)=>a.zIndex-b.zIndex); const index=sorted.findIndex(e=>e.id===selected.id), target=index+direction;
    if(index<0||target<0||target>=sorted.length)return;
    [sorted[index],sorted[target]]=[sorted[target],sorted[index]];
    const order=new Map(sorted.map((element,i)=>[element.id,i+1]));
    patchSlide({elements:slide.elements.map(element=>({...element,zIndex:order.get(element.id)??element.zIndex}))});
  }
  function navigate(delta: number) { const next=doc.slides[slideIndex+delta]; if(next)chooseSlide(next.id); }
  async function openAi() {
    setAiOpen(true); setAiError("");
    if (!hasSupabaseConfig || aiModels.length > 0) return;
    try {
      const result = await groqProxy<{models?: Array<{id?: unknown;contextWindow?: unknown}>}>("list_models", {});
      const models=(result.models??[]).filter((model): model is {id:string;contextWindow?:number} => typeof model.id === "string");
      setAiModels(models); if (models.length && !models.some(model=>model.id===aiModel)) setAiModel(models[0].id);
    } catch (error) { const message=error instanceof Error?error.message:"Modelle konnten nicht geladen werden."; setAiError(message.includes("Unbekannte KI-Aktion")?"Das KI-Backend ist noch nicht aktualisiert. Bitte den Supabase-Deploy für groq-proxy ausführen.":message); }
  }
  async function downloadLocalModel() {
    if (localDownloading || localReady) return;
    setAiError(""); setLocalDownloading(true); setLocalProgress(0); setLocalProgressText("Download wird vorbereitet …");
    try {
      await loadLocalModel(localModel, progress => { setLocalProgress(progress.progress===null?null:Math.round(progress.progress*100)); setLocalProgressText(progress.text); });
      setLocalReady(true); setLocalProgress(100); setLocalProgressText("Lokal bereit – das Modell bleibt im Browser gespeichert.");
    } catch (error) { setAiError(error instanceof Error?error.message:"Das lokale Modell konnte nicht geladen werden."); setLocalProgress(null); }
    finally { setLocalDownloading(false); }
  }
  async function askAi(event?: FormEvent) {
    event?.preventDefault(); const instruction=aiInput.trim();
    if (!instruction || aiBusy || (aiProvider==="local"&&!localReady)) return;
    if (!quizReady) { setAiError("Private Lösungsschlüssel müssen vor KI-Änderungen geladen werden."); return; }
    setAiInput(""); setAiError(""); setAiMessages(messages=>[...messages,{role:"user",text:instruction}]); setAiBusy(true); onBackgroundWorkChange(true);
    try {
      const result=aiProvider==="local"
        ? await editPresentationLocally(localModel,instruction,doc,progress=>{setLocalProgress(progress.progress===null?null:Math.round(progress.progress*100));setLocalProgressText(progress.text);})
        : await groqProxy<{presentation?:Presentation;summary?:string}>("edit_presentation",{instruction,presentation:doc,model:aiModel});
      if (!result.presentation?.slides?.length) throw new Error("Die KI hat keine gültige Präsentation zurückgegeben.");
      for(const original of doc.slides) {
        if(!quizKeysRef.current[original.id] || original.type!=="multiple_choice")continue;
        const changed=result.presentation.slides.find(item=>item.id===original.id);
        if(!changed || changed.type!==original.type || JSON.stringify(changed.content.options)!==JSON.stringify(original.content.options))
          throw new Error("Die KI wollte eine Quizfolie mit privatem Lösungsschlüssel ändern oder entfernen. Bitte ändere deren Antworten im Editor, damit die Zuordnung erhalten bleibt.");
      }
      const next={...result.presentation,participation:(doc as PresentationSettings).participation,backgroundImage:(doc as PresentationSettings).backgroundImage,id:doc.id,ownerId:doc.ownerId,version:1 as const,updatedAt:new Date().toISOString()};
      if(!commit(next)) throw new Error("Die KI-Änderung wurde nicht angewendet. Prüfe offene Sitzungen und den Status des privaten Entwurfs.");
      setAiMessages(messages=>[...messages,{role:"assistant",text:result.summary||"Die Präsentation wurde aktualisiert. Bitte prüfe die Änderungen auf der Arbeitsfläche."}]);
      setSelectedId(""); setSlideId(next.slides[Math.min(slideIndex,next.slides.length-1)]?.id||next.slides[0].id);
    } catch (error) { const rawMessage=error instanceof Error?error.message:"Die KI-Anfrage ist fehlgeschlagen."; const message=rawMessage.includes("Unbekannte KI-Aktion")?"Das KI-Backend ist noch nicht aktualisiert. Bitte den Supabase-Deploy für groq-proxy ausführen.":rawMessage; setAiError(message); setAiMessages(messages=>[...messages,{role:"assistant",text:`Fehler: ${message}`}]); }
    finally { onBackgroundWorkChange(false); setAiBusy(false); }
  }
  useEffect(()=>{
    function handleKey(e: KeyboardEvent) {
      // Do not consume *any* keyboard event when the live view owns focus.
      if(!keyboardEnabledRef.current)return;
      const target=e.target as HTMLElement | null;
      const editing=Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
      if(sessionPanel) { if(e.key==="Escape"&&!endingSession)setSessionPanel(false); return; }
      if(e.key==="Escape") { if(chooser)setChooser(false); else if(preview)setPreview(false); else setSelectedId(""); return; }
      if(preview) { if(e.key==="ArrowRight"||e.key==="ArrowLeft"){e.preventDefault();navigate(e.key==="ArrowRight"?1:-1);} return; }
      if(chooser)return;
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="z"){e.preventDefault();restore(e.shiftKey?historyIndex+1:historyIndex-1);return;}
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="y"){e.preventDefault();restore(historyIndex+1);return;}
      if(editing)return;
      if(e.altKey&&(e.key==="ArrowUp"||e.key==="ArrowDown")){e.preventDefault();moveSlide(e.key==="ArrowUp"?-1:1);return;}
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="d"&&selected){e.preventDefault();duplicateElement();return;}
      if((e.key==="Delete"||e.key==="Backspace")&&selected){e.preventDefault();removeSelected();return;}
      if(selected&&["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)){
        e.preventDefault(); const step=e.shiftKey?5:1;
        const dx=e.key==="ArrowLeft"?-step:e.key==="ArrowRight"?step:0, dy=e.key==="ArrowUp"?-step:e.key==="ArrowDown"?step:0;
        patchElement(selected.id,{x:clamp(selected.x+dx,0,100-selected.width),y:clamp(selected.y+dy,0,100-selected.height)});
      }
    }
    window.addEventListener("keydown",handleKey); return()=>window.removeEventListener("keydown",handleKey);
  });
  function pointerStart(event: PointerEvent<HTMLDivElement>,el: SlideElement) {
    if(preview||!slide)return; event.preventDefault(); event.stopPropagation(); selectElement(el.id);
    event.currentTarget.focus({preventScroll:true});
    const rect=stageRef.current?.getBoundingClientRect(); if(!rect)return;
    drag.current={id:el.id,slideId:slide.id,startX:event.clientX,startY:event.clientY,x:el.x,y:el.y,width:el.width,height:el.height,rect,latest:doc,moved:false};
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function resizeStart(event: PointerEvent<HTMLButtonElement>,el: SlideElement,handle: ResizeHandle) {
    if(preview||!slide)return; event.preventDefault(); event.stopPropagation(); selectElement(el.id);
    const rect=stageRef.current?.getBoundingClientRect(); if(!rect)return;
    resize.current={id:el.id,slideId:slide.id,handle,startX:event.clientX,startY:event.clientY,x:el.x,y:el.y,width:el.width,height:el.height,rect,latest:doc,moved:false};
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: PointerEvent) {
    const r=resize.current;
    if(r){
      const dx=(event.clientX-r.startX)/r.rect.width*100, dy=(event.clientY-r.startY)/r.rect.height*100;
      let left=r.x, top=r.y, right=r.x+r.width, bottom=r.y+r.height;
      if(r.handle.includes("w")) left=clamp(r.x+dx,0,right-4);
      if(r.handle.includes("e")) right=clamp(r.x+r.width+dx,left+4,100);
      if(r.handle.includes("n")) top=clamp(r.y+dy,0,bottom-4);
      if(r.handle.includes("s")) bottom=clamp(r.y+r.height+dy,top+4,100);
      if(!r.moved&&Math.abs(dx)+Math.abs(dy)<.2)return;
      const next={x:Math.round(left*10)/10,y:Math.round(top*10)/10,width:Math.round((right-left)*10)/10,height:Math.round((bottom-top)*10)/10};
      const current=latestDoc.current; r.moved=true;
      r.latest={...current,slides:current.slides.map(item=>item.id===r.slideId?{...item,elements:item.elements.map(element=>element.id===r.id?{...element,...next}:element)}:item)};
      setDoc(r.latest); return;
    }
    const d=drag.current; if(!d)return;
    const x=clamp(d.x+(event.clientX-d.startX)/d.rect.width*100,0,100-d.width), y=clamp(d.y+(event.clientY-d.startY)/d.rect.height*100,0,100-d.height);
    if(Math.abs(x-d.x)<0.1&&Math.abs(y-d.y)<0.1&&!d.moved)return;
    const current=latestDoc.current;
    d.moved=true; d.latest={...current,slides:current.slides.map(item=>item.id===d.slideId?{...item,elements:item.elements.map(el=>el.id===d.id?{...el,x:Math.round(x*10)/10,y:Math.round(y*10)/10}:el)}:item)}; setDoc(d.latest);
  }
  function pointerEnd(){const finished=drag.current;drag.current=null;const resized=resize.current;resize.current=null;if(finished?.moved)commit(finished.latest);if(resized?.moved)commit(resized.latest);}
  async function uploadMedia(file?: File) {
    if(!file||!selected||!slide||uploadInFlight.current)return; uploadInFlight.current=true; onBackgroundWorkChange(true); setUploadingMedia(true);setNotice("");
    const targetSlideId=slide.id, targetElementId=selected.id;
    try {
      const content=hasSupabaseConfig?await uploadPresentationMedia(doc.id,file):URL.createObjectURL(file);
      const current=latestDoc.current;
      if(!current.slides.some(s=>s.id===targetSlideId&&s.elements.some(e=>e.id===targetElementId))) {
        if(!hasSupabaseConfig)URL.revokeObjectURL(content);
        setNotice("Das Element wurde während des Uploads entfernt; das Medium wurde nicht eingefügt.");
        return;
      }
      latestCommit.current({...current,slides:current.slides.map(s=>s.id===targetSlideId?{...s,elements:s.elements.map(e=>e.id===targetElementId?{...e,content,alt:file.name}:e)}:s)});
      setNotice(hasSupabaseConfig?"Medium sicher hochgeladen; der Storage-Pfad wurde gespeichert.":"Lokale Datei hinzugefügt. Sie ist nur in dieser Browser-Sitzung verfügbar.");
    }
    catch(error){setNotice(error instanceof Error?error.message:"Das Medium konnte nicht hinzugefügt werden.");}finally{uploadInFlight.current=false;onBackgroundWorkChange(false);setUploadingMedia(false);}
  }
  async function uploadBackground(file?: File) {
    if(!file||uploadInFlight.current)return;
    uploadInFlight.current=true; onBackgroundWorkChange(true); setUploadingMedia(true); setNotice("");
    const before=(latestDoc.current as PresentationSettings).backgroundImage;
    try {
      const backgroundImage=hasSupabaseConfig?await uploadPresentationMedia(presentation.id,file):URL.createObjectURL(file);
      const current=latestDoc.current as PresentationSettings;
      if(current.backgroundImage!==before){ if(!hasSupabaseConfig)URL.revokeObjectURL(backgroundImage); setNotice("Das Hintergrundbild wurde inzwischen geändert; der Upload wurde nicht eingefügt."); return; }
      latestCommit.current({...current,backgroundImage} as PresentationSettings);
      setNotice(hasSupabaseConfig?"Hintergrundbild einmalig im privaten Speicher hochgeladen.":"Demo-Hintergrundbild ist nur in dieser Browser-Sitzung verfügbar. Exportiere es vor dem Schließen; für den späteren Import mit Medien sind Cloud-Konfiguration und Lehrkraftkonto erforderlich.");
    } catch(error){setNotice(error instanceof Error?error.message:"Das Hintergrundbild konnte nicht hochgeladen werden.");}
    finally{uploadInFlight.current=false;onBackgroundWorkChange(false);setUploadingMedia(false);}
  }
  function updateQuizOptions(options:string[], indices?:number[]) {
    if(!slide)return;
    const next={...doc,slides:doc.slides.map(item=>item.id===slide.id?{...item,content:{...item.content,options}}:item)};
    const key=quizKeysRef.current[slide.id];
    if(key && indices) commit(next,{...quizKeysRef.current,[slide.id]:{...key,correctIndices:indices,correctIndex:indices[0]??key.correctIndex}});
    else commit(next);
  }
  function toggleCorrect(index:number, checked:boolean) {
    if(!slide || !quizReady || quizConflict)return;
    const old=quizKeysRef.current[slide.id]??{slideId:slide.id,correctIndex:0,correctIndices:[],explanation:""};
    const indices=(checked?[...old.correctIndices,index]:old.correctIndices.filter(item=>item!==index)).sort((a,b)=>a-b);
    const next={...doc,slides:doc.slides.map(item=>item.id===slide.id?{...item,content:{...item.content,...(indices.length>1?{allowMultiple:true}:{})}}:item)};
    commit(next,{...quizKeysRef.current,[slide.id]:{...old,correctIndex:indices[0]??old.correctIndex,correctIndices:indices}});
  }
  function removeOption(index:number) {
    if(!slide)return;
    const options=slide.content.options??[]; const key=quizKeysRef.current[slide.id];
    if(key?.correctIndices.includes(index)&&!window.confirm("Diese Antwort ist als richtig markiert. Beim Entfernen wird auch ihre Markierung gelöscht. Fortfahren?"))return;
    updateQuizOptions(options.filter((_,i)=>i!==index),key?.correctIndices.filter(i=>i!==index).map(i=>i>index?i-1:i));
  }
  function moveOption(index:number,delta:number) {
    if(!slide)return;const options=[...(slide.content.options??[])];const target=index+delta;
    if(target<0||target>=options.length)return;
    [options[index],options[target]]=[options[target],options[index]];
    const key=quizKeysRef.current[slide.id];
    updateQuizOptions(options,key?.correctIndices.map(i=>i===index?target:i===target?index:i).sort((a,b)=>a-b));
  }
  const currentKey=slide?quizKeys[slide.id]:undefined;
  const quizProblem=quizKeyProblem(doc,Object.values(quizKeys));
  const invalidDraft=Object.entries(timeDrafts).find(([id,value])=>doc.slides.some(item=>item.id===id) && value!=="" && (!/^\d+$/.test(value) || Number(value)<1 || Number(value)>86400));
  let timeProblem="";
  try { validatePresentationTimeLimits(doc); } catch(error) { timeProblem=error instanceof Error?error.message:"Ungültiges Zeitlimit."; }
  function openLive() {
    if(uploadInFlight.current||aiBusy){setNotice("Bitte warte, bis Medien-Uploads und KI-Änderungen abgeschlossen und gespeichert sind.");return;}
    if(quizSyncRef.current || Object.keys(pendingQuizRef.current).length || !quizReady){setNotice("Bitte warte auf die vollständige Synchronisation der privaten Lösungsschlüssel.");return;}
    if(quizProblem){chooseSlide(quizProblem.slideId);setInspectorOpen(true);setNotice(quizProblem.message);return;}
    if(invalidDraft || timeProblem){if(invalidDraft)chooseSlide(invalidDraft[0]);setInspectorOpen(true);setNotice(timeProblem||"Das Zeitlimit muss leer oder eine ganze Zahl zwischen 1 und 86400 Sekunden sein.");return;}
    onLive(Object.values(quizKeysRef.current));
  }
  const wordFilter = (slide?.content.wordFilter as WordFilter | undefined) ?? {mode:"off",match:"exact",terms:[]};
  const updateWordFilter=(patch:Partial<WordFilter>)=>updateContent("wordFilter",{...wordFilter,...patch});
  const contentField=slide?.type==="multiple_choice"||slide?.type==="poll"?"question":slide?.type==="free_text"||["mindmap","brainstorm","wordcloud"].includes(slide?.type||"")?"prompt":slide?.type==="worksheet"||slide?.type==="photo_task"||slide?.type==="group_work"?"instructions":"body";
  const layerIndex=selected&&slide?[...slide.elements].sort((a,b)=>a.zIndex-b.zIndex).findIndex(e=>e.id===selected.id):-1;
  return <div className="editor-shell">
    <header className="editor-topbar">
      <button className="back-button" onClick={onBack}><ArrowLeft size={18}/><span>Alle Präsentationen</span></button>
      <div className="editor-doc"><input className="doc-title-input" value={doc.title} maxLength={160} onChange={e=>commit({...doc,title:e.target.value})} aria-label="Präsentationstitel"/><span className={`save-indicator ${saveError||quizPending?"is-error":saving?"is-saving":"is-saved"}`}><i/> {saveError?"Nicht gespeichert":quizPending?"Quiz noch nicht synchronisiert":saving?"Wird gespeichert…":isCloud?"Cloud synchronisiert":"Lokal gespeichert"}</span></div>
      <div className="editor-top-actions">{sessionsAvailable&&<button type="button" className={`button secondary session-top-button ${sessions.length?"has-open":""}`} onClick={()=>{setSessionPanel(true);refreshSessionsRef.current();}} aria-label="Offene Sitzungen dieser Präsentation anzeigen" title="Offene Sitzungen anzeigen"><MonitorPlay size={16}/><span className="hide-small">Sitzungen</span>{sessionState==="ready"&&sessions.length>0&&<b>{sessions.length}</b>}</button>}<button className={`button ai-toggle ${aiOpen?"is-active":""}`} onClick={()=>aiOpen?setAiOpen(false):void openAi()}><Sparkles size={16}/><span className="hide-small">KI-Assistent</span></button><button className="icon-button" title="Rückgängig (Strg+Z)" aria-label="Rückgängig" disabled={!canUndo} onClick={()=>restore(historyIndex-1)}><Undo2 size={17}/></button><button className="icon-button" title="Wiederholen (Strg+Y)" aria-label="Wiederholen" disabled={!canRedo} onClick={()=>restore(historyIndex+1)}><Redo2 size={17}/></button><button className="button secondary hide-small" onClick={()=>void exportPresentation(doc)} disabled={quizPending||!quizReady||uploadingMedia}>Exportieren</button><button className="button secondary" onClick={()=>setPreview(true)}><Eye size={16}/><span className="hide-small">Vorschau</span></button><button className="button primary" onClick={openLive} disabled={quizPending||!quizReady||uploadingMedia||aiBusy} title={uploadingMedia?"Bitte den Medien-Upload abwarten.":undefined}><MonitorPlay size={17}/><span className="hide-small">Live starten</span></button></div>
    </header>
    {sessionsAvailable&&(quizLocked||saveError||quizPending)&&<div className="session-warning" role="status"><div><strong>{sessionState==="loading"?"Sitzungen werden geprüft …":sessionState==="error"?"Sitzungsstatus nicht verfügbar":sessions.length?`${sessions.length} offene ${sessions.length===1?"Sitzung":"Sitzungen"}`:"Änderungen noch nicht vollständig gespeichert"}</strong><span>{sessions.length&&sessionState==="ready"?"Multiple-Choice-Fragen und Lösungen sind bis zum Ende aller offenen Sitzungen gesperrt – auch ohne Antworten.":sessionState!=="ready"?"Quizänderungen sind vorsorglich gesperrt, bis der Sitzungsstatus geladen ist.":"Bitte versuche die Speicherung erneut."} {saveError||quizPending?"Vorhandene Änderungen sind möglicherweise nicht gespeichert. Editor nicht neu laden oder schließen, bis die Speicherung bestätigt ist; private Schlüsselentwürfe bleiben auf diesem Gerät.":""}</span></div><div className="session-warning-actions"><button type="button" onClick={()=>{setSessionPanel(true);refreshSessionsRef.current();}}>Sitzungen ansehen</button>{(saveError||quizPending)&&!quizLocked&&<button type="button" disabled={retryingSave} onClick={()=>void retryEditorSave()}>{retryingSave?"Speichert …":"Speichern erneut versuchen"}</button>}</div></div>}
    <div className={`editor-body ${aiOpen?"has-ai":""}`}>
      <aside className="slide-rail"><div className="rail-head"><div><strong>Deine Folien</strong><span>{doc.slides.length} {doc.slides.length===1?"Folie":"Folien"}</span></div><button className="icon-button mini-icon" onClick={()=>setChooser(true)} aria-label="Folie hinzufügen"><Plus size={18}/></button></div>
        <div className="slide-list">{doc.slides.map((s,i)=><button key={s.id} draggable className={`slide-thumb ${s.id===slide?.id?"active":""} ${s.id===dragSlideId?"is-dragging":""}`} onClick={()=>chooseSlide(s.id)} onDragStart={e=>{setDragSlideId(s.id);e.dataTransfer.setData("text/plain",s.id);e.dataTransfer.effectAllowed="move";}} onDragEnd={()=>setDragSlideId("")} onDragOver={e=>e.preventDefault()} onDrop={e=>dropSlide(e,s.id)} aria-current={s.id===slide?.id?"true":undefined} title="Zum Sortieren ziehen"><div className="thumb-canvas" style={{background:s.background}}><span className="thumb-title">{s.title||"Unbenannt"}</span><span className="thumb-sub">{String(s.content.question||s.content.prompt||s.content.body||s.content.instructions||slideTypeLabels[s.type])}</span><i className="thumb-accent"/></div><span className="thumb-name"><b>{String(i+1).padStart(2,"0")}</b> {s.title||"Unbenannt"}</span><span className="thumb-type">{slideTypeLabels[s.type]}</span></button>)}</div>
        <button className="add-slide-rail" onClick={()=>setChooser(true)}><Plus size={16}/> Neue Folie</button>
      </aside>
      <main className="canvas-workspace">
        <div className="workspace-top"><div className="breadcrumb"><span>{doc.title||"Unbenannte Präsentation"}</span><b>/</b><strong>{slide?.title||"Folie"}</strong></div><div className="slide-toolbar"><label className="type-select-label"><span>Typ</span><select aria-label="Folientyp" value={slide?.type||"standard"} onChange={e=>changeType(e.target.value as SlideType)}>{typeGroups.map(group=><optgroup key={group.label} label={group.label}>{group.items.map(item=><option key={item.type} value={item.type}>{slideTypeLabels[item.type]}</option>)}</optgroup>)}</select></label><span className="toolbar-separator"/><button className="icon-button" title="Folie nach oben (Alt+↑)" aria-label="Folie nach oben" disabled={slideIndex<=0} onClick={()=>moveSlide(-1)}><ArrowUp size={16}/></button><button className="icon-button" title="Folie nach unten (Alt+↓)" aria-label="Folie nach unten" disabled={slideIndex>=doc.slides.length-1} onClick={()=>moveSlide(1)}><ArrowDown size={16}/></button><button className="icon-button" title="Folie duplizieren" aria-label="Folie duplizieren" onClick={duplicateSlide}><Copy size={16}/></button><button className="icon-button danger-icon" title="Folie löschen" aria-label="Folie löschen" onClick={deleteSlide}><Trash2 size={16}/></button><button className="icon-button editor-inspector-toggle" title="Eigenschaften öffnen oder schließen" aria-label="Eigenschaften öffnen oder schließen" aria-expanded={inspectorOpen} onClick={()=>setInspectorOpen(!inspectorOpen)}><Settings2 size={17}/></button></div></div>
        <div className="stage-scroll"><div className="stage-shell" ref={stageRef} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onClick={()=>setSelectedId("")}>{slide&&<SlideStage slide={slide} backgroundImage={settingsDoc.backgroundImage} selectedId={selectedId} onSelect={selectElement} onPointerDown={pointerStart} onResizeStart={resizeStart}/>}</div></div>
        <div className="stage-caption"><span><MousePointer2 size={14}/> Elemente ziehen · mit Pfeiltasten verschieben</span><span>{String(slideIndex+1).padStart(2,"0")} / {String(doc.slides.length).padStart(2,"0")}</span></div>
        <div className="element-dock"><span>HINZUFÜGEN</span><button onClick={()=>add("text")} title="Text hinzufügen"><Type size={17}/> <span>Text</span></button><button onClick={()=>add("image")} title="Bild hinzufügen"><Image size={17}/> <span>Bild</span></button><button onClick={()=>add("video")} title="Video hinzufügen"><Video size={17}/> <span>Video</span></button><button onClick={()=>add("shape")} title="Form hinzufügen"><Shapes size={17}/> <span>Form</span></button><button onClick={()=>add("table")} title="Tabelle hinzufügen"><Table2 size={17}/> <span>Tabelle</span></button><button onClick={()=>add("chart")} title="Diagramm hinzufügen"><BarChart3 size={17}/> <span>Diagramm</span></button></div>
      </main>
      {aiOpen&&<aside className="ai-sidebar" aria-label="KI-Assistent"><div className="ai-sidebar-head"><div><span className="ai-eyebrow"><Sparkles size={12}/> PLEXIA AI</span><strong>Folien gemeinsam bauen</strong></div><button className="icon-button mini-icon" aria-label="KI-Assistent schließen" onClick={()=>setAiOpen(false)}><X size={16}/></button></div><div className="ai-sidebar-model"><div className="ai-provider-tabs" role="tablist" aria-label="KI-Modus"><button type="button" className={aiProvider==="groq"?"active":""} onClick={()=>setAiProvider("groq")} role="tab" aria-selected={aiProvider==="groq"}>Groq-Cloud</button><button type="button" className={aiProvider==="local"?"active":""} onClick={()=>setAiProvider("local")} role="tab" aria-selected={aiProvider==="local"}>Lokal</button></div>{aiProvider==="groq"?<><label>Groq-Modell<select value={aiModel} onChange={event=>setAiModel(event.target.value)} disabled={aiBusy}>{(aiModels.length?aiModels:[{id:"llama-3.3-70b-versatile"},{id:"llama-3.1-8b-instant"},{id:"openai/gpt-oss-20b"}]).map(model=><option key={model.id} value={model.id}>{model.id}</option>)}</select></label><small>Die Anfrage wird über dein konfiguriertes Groq-Backend verarbeitet.</small></>:<><label>Lokales Modell<select value={localModel} onChange={event=>{setLocalModel(event.target.value as LocalModelId);setLocalReady(false);setLocalProgress(null);}} disabled={aiBusy||localDownloading}>{LOCAL_MODELS.map(model=><option key={model.id} value={model.id}>{model.label}</option>)}</select></label><small>{LOCAL_MODELS.find(model=>model.id===localModel)?.detail}. Der erste Download kann mehrere Minuten dauern.</small><button type="button" className="button local-download" onClick={()=>void downloadLocalModel()} disabled={!localModelIsSupported()||localDownloading||localReady}>{localDownloading?<><LoaderCircle className="spin" size={14}/> Wird geladen …</>:localReady?"Lokal bereit":"Modell herunterladen"}</button>{!localModelIsSupported()&&<p className="ai-local-warning">WebGPU wird in diesem Browser nicht unterstützt. Nutze aktuelles Chrome oder Edge.</p>}{(localDownloading||localProgress!==null)&&<div className="ai-download-progress" aria-live="polite"><div className="ai-download-label"><span>{localProgressText||"Modell wird geladen …"}</span><b>{localProgress===null?"…":`${localProgress}%`}</b></div><div className="ai-progress-track"><i style={{width:localProgress===null?"35%":`${localProgress}%`}}/></div></div>}</>}</div><div className="ai-chat" aria-live="polite">{aiMessages.length===0?<div className="ai-empty"><MessageCircle size={22}/><strong>Was soll sich ändern?</strong><p>Zum Beispiel: „Erstelle eine 5-teilige Präsentation über Photosynthese für Klasse 7.“</p></div>:aiMessages.map((message,index)=><div className={`ai-message ${message.role}`} key={`${message.role}-${index}`}><span>{message.role==="user"?"Du":"KI"}</span><p>{message.text}</p></div>)}{aiBusy&&<div className="ai-thinking"><LoaderCircle className="spin" size={15}/> Folien werden erstellt …</div>}</div><form className="ai-compose" onSubmit={event=>void askAi(event)}><textarea value={aiInput} onChange={event=>setAiInput(event.target.value)} placeholder="Beschreibe deine Folienänderung …" rows={3} disabled={aiBusy||aiProvider==="local"&&!localReady}/><button className="button primary" disabled={aiBusy||!aiInput.trim()||(aiProvider==="local"&&!localReady)}><Send size={15}/> {aiBusy?"Wird erstellt…":"Anwenden"}</button></form>{aiError&&<p className="ai-error" role="alert">{aiError}</p>}<p className="ai-disclaimer">{aiProvider==="local"?"Lokal: Das Modell läuft nach dem Download im Browser und sendet keine Folien an einen Server.":"KI-Ergebnisse können Fehler enthalten. Bitte prüfe jede Folie vor dem Unterricht."}</p></aside>}
      <aside className={`inspector ${inspectorOpen?"is-open":""}`}><div className="inspector-heading"><div><small>{selected?"AUSGEWÄHLT":"AKTUELLE FOLIE"}</small><strong>{selected?"Element gestalten":"Folie gestalten"}</strong></div><button className="icon-button mini-icon inspector-close" aria-label="Eigenschaften schließen" onClick={()=>{if(selected)setSelectedId("");else setInspectorOpen(false);}}><X size={16}/></button></div>
        {selected?<div className="inspector-content">
          <div className="property-tag">{({text:"TEXT",image:"BILD",video:"VIDEO",shape:"FORM",table:"TABELLE",chart:"DIAGRAMM"} as const)[selected.kind]}</div>
          {selected.kind==="text"?<label className="prop-label">Textinhalt<textarea rows={4} value={selected.content} onChange={e=>patchElement(selected.id,{content:e.target.value})}/></label>:selected.kind==="image"||selected.kind==="video"?<label className="prop-label">{selected.kind==="image"?"Bild-URL":"Video-URL"}<input value={selected.content} onChange={e=>patchElement(selected.id,{content:e.target.value})} placeholder="https://…"/></label>:null}
          {(selected.kind==="image"||selected.kind==="video")&&<div className="media-upload-box"><input ref={mediaInputRef} type="file" accept={selected.kind==="image"?"image/png,image/jpeg,image/webp,image/gif":"video/mp4,video/webm"} hidden onChange={e=>{void uploadMedia(e.target.files?.[0]);e.target.value="";}}/><button className="button secondary full" onClick={()=>mediaInputRef.current?.click()} disabled={uploadingMedia}><Upload size={15}/>{uploadingMedia?"Wird hochgeladen…":hasSupabaseConfig?"Datei sicher hochladen":"Datei lokal auswählen"}</button><small>{hasSupabaseConfig?"Die Datei liegt im geschützten Präsentationsspeicher.":"Lokale Datei nur in dieser Browser-Sitzung verfügbar."}</small></div>}
          {selected.kind==="image"&&<><label className="prop-label">Bildbeschreibung<input value={selected.alt||""} onChange={e=>patchElement(selected.id,{alt:e.target.value})} placeholder="Was ist auf dem Bild zu sehen?"/></label><div className="property-grid"><label className="prop-label">Darstellung<select value={selected.objectFit||"cover"} onChange={e=>patchElement(selected.id,{objectFit:e.target.value as SlideElement["objectFit"]})}><option value="cover">Rahmen füllen</option><option value="contain">Ganzes Bild zeigen</option></select></label><label className="prop-label">Fokus<select value={selected.objectPosition||"50% 50%"} onChange={e=>patchElement(selected.id,{objectPosition:e.target.value})}><option value="50% 50%">Mitte</option><option value="50% 0%">Oben</option><option value="50% 100%">Unten</option><option value="0% 50%">Links</option><option value="100% 50%">Rechts</option></select></label></div><div className="property-grid"><NumberField key={`${selected.id}-opacity`} label="Deckkraft %" min={10} max={100} value={Math.round((selected.opacity??1)*100)} onValue={opacity=>patchElement(selected.id,{opacity:opacity/100})}/><NumberField key={`${selected.id}-radius`} label="Eckenradius %" min={0} max={50} value={selected.borderRadius||0} onValue={borderRadius=>patchElement(selected.id,{borderRadius})}/></div></>}
          {selected.kind==="text"&&<><div className="property-grid"><NumberField key={`${selected.id}-font`} label="Schriftgröße" min={10} max={120} value={selected.fontSize||32} onValue={fontSize=>patchElement(selected.id,{fontSize})}/><label className="prop-label">Schriftart<select value={selected.fontFamily||"sans"} onChange={e=>patchElement(selected.id,{fontFamily:e.target.value as SlideElement["fontFamily"]})}><option value="sans">Inter · Klar</option><option value="display">Manrope · Modern</option><option value="rounded">Rounded · Freundlich</option><option value="serif">Georgia · Editorial</option><option value="mono">Mono · Tech</option></select></label></div><div className="prop-label">Schriftstil<div className="editor-segmented"><button title="Fett" aria-label="Fett" aria-pressed={(selected.fontWeight||"bold")==="bold"} onClick={()=>patchElement(selected.id,{fontWeight:(selected.fontWeight||"bold")==="bold"?"normal":"bold"})}><Bold size={16}/></button><button title="Kursiv" aria-label="Kursiv" aria-pressed={selected.fontStyle==="italic"} onClick={()=>patchElement(selected.id,{fontStyle:selected.fontStyle==="italic"?"normal":"italic"})}><Italic size={16}/></button></div></div><div className="prop-label">Ausrichtung<div className="editor-segmented"><button title="Linksbündig" aria-label="Linksbündig" aria-pressed={(selected.textAlign||"left")==="left"} onClick={()=>patchElement(selected.id,{textAlign:"left"})}><AlignLeft size={16}/></button><button title="Zentriert" aria-label="Zentriert" aria-pressed={selected.textAlign==="center"} onClick={()=>patchElement(selected.id,{textAlign:"center"})}><AlignCenter size={16}/></button><button title="Rechtsbündig" aria-label="Rechtsbündig" aria-pressed={selected.textAlign==="right"} onClick={()=>patchElement(selected.id,{textAlign:"right"})}><AlignRight size={16}/></button></div></div><div className="prop-label">Textfarbe<Palette value={selected.color||"#352376"} options={inkColors} onChange={color=>patchElement(selected.id,{color})} label="Textfarbe"/><input type="color" aria-label="Eigene Textfarbe" value={/^#[\da-f]{6}$/i.test(selected.color||"")?selected.color:"#352376"} onChange={e=>patchElement(selected.id,{color:e.target.value})}/></div></>}
          {selected.kind==="shape"&&<><label className="prop-label">Form<select value={selected.shape||"rectangle"} onChange={e=>patchElement(selected.id,{shape:e.target.value as SlideElement["shape"]})}><option value="rectangle">Rechteck</option><option value="circle">Kreis</option><option value="line">Linie</option></select></label><div className="prop-label">Füllfarbe<Palette value={selected.background||"#5638bd"} options={["#5638bd","#352376","#ffc952","#d79520","#ffffff"]} onChange={background=>patchElement(selected.id,{background})} label="Füllfarbe"/><input type="color" aria-label="Eigene Füllfarbe" value={/^#[\da-f]{6}$/i.test(selected.background||"")?selected.background:"#5638bd"} onChange={e=>patchElement(selected.id,{background:e.target.value})}/></div></>}
          {selected.kind==="table"&&<label className="prop-label">Tabelle · Zellen mit | trennen<textarea rows={4} value={(selected.rows||[]).map(r=>r.join(" | ")).join("\n")} onChange={e=>patchElement(selected.id,{rows:e.target.value.split("\n").map(r=>r.split("|").map(c=>c.trim()))})}/></label>}
          {selected.kind==="chart"&&<label className="prop-label">Diagrammdaten · Name | Wert<textarea rows={4} value={(selected.points||[]).map(p=>`${p.label} | ${p.value}`).join("\n")} onChange={e=>patchElement(selected.id,{points:e.target.value.split("\n").map(r=>{const [label,value]=r.split("|");return{label:label?.trim()||"",value:Number(value)||0};})})}/></label>}
          <div className="inspector-divider"/><div className="editor-section-title">Position & Größe <small>in % der Folie</small></div><div className="property-grid"><NumberField key={`${selected.id}-width`} label="Breite" min={4} max={100} value={selected.width} onValue={width=>patchElement(selected.id,{width,x:Math.min(selected.x,100-width)})}/><NumberField key={`${selected.id}-height`} label="Höhe" min={4} max={100} value={selected.height} onValue={height=>patchElement(selected.id,{height,y:Math.min(selected.y,100-height)})}/><NumberField key={`${selected.id}-x`} label="X-Position" min={0} max={100-selected.width} value={Math.round(selected.x*10)/10} onValue={x=>patchElement(selected.id,{x})}/><NumberField key={`${selected.id}-y`} label="Y-Position" min={0} max={100-selected.height} value={Math.round(selected.y*10)/10} onValue={y=>patchElement(selected.id,{y})}/><NumberField key={`${selected.id}-rotation`} label="Drehung °" min={-180} max={180} value={selected.rotation} onValue={rotation=>patchElement(selected.id,{rotation})}/></div>
          <div className="editor-section-title"><Layers size={14}/> Ebenen</div><div className="editor-action-grid"><button disabled={layerIndex<=0} onClick={()=>moveLayer(-1)}><ArrowDown size={15}/> Nach hinten</button><button disabled={layerIndex>=slide.elements.length-1} onClick={()=>moveLayer(1)}><ArrowUp size={15}/> Nach vorne</button></div><div className="editor-action-grid"><button onClick={duplicateElement}><Copy size={15}/> Duplizieren</button><button className="editor-delete" onClick={removeSelected}><Trash2 size={15}/> Entfernen</button></div>
        </div>:<div className="inspector-content">
          <label className="prop-label">Folientitel<input value={slide?.title||""} onChange={e=>patchSlide({title:e.target.value})} placeholder="Dein Folientitel"/></label><div className="prop-label">Hintergrund<Palette value={slide?.background||"#ffffff"} options={colors} onChange={background=>patchSlide({background})} label="Hintergrund"/><label className="editor-custom-color">Eigene Farbe <input type="color" aria-label="Eigene Hintergrundfarbe" value={/^#[\da-f]{6}$/i.test(slide?.background||"")?slide.background:"#ffffff"} onChange={e=>patchSlide({background:e.target.value})}/></label></div>
          {slide&&<><div className="inspector-divider"/><div className="editor-section-title">{slideTypeLabels[slide.type]} <small>Inhalt</small></div><label className="prop-label">{contentField==="question"?"Frage":contentField==="prompt"?"Aufgabenstellung":contentField==="instructions"?"Arbeitsanweisung":"Zusatztext"}<textarea rows={4} disabled={slide.type==="multiple_choice"&&quizLocked} value={String(slide.content[contentField]||"")} onChange={e=>updateContent(contentField,e.target.value)} placeholder="Inhalt für diese Folie…"/></label>{slide.type==="standard"&&slide.elements.length>0&&<small className="editor-hint">Texte auf der Folie anklicken, um sie direkt zu bearbeiten. Der Zusatztext erscheint auf Folien ohne Elemente.</small>}
            {slide.type==="poll"&&<><label className="prop-label">Antwortmöglichkeiten · eine pro Zeile<textarea rows={4} value={(slide.content.options||[]).join("\n")} onChange={e=>updateContent("options",e.target.value.split("\n"))}/></label><label className="check-row"><input type="checkbox" checked={Boolean(slide.content.allowMultiple)} onChange={e=>updateContent("allowMultiple",e.target.checked)}/> Mehrere Antworten erlauben</label></>}
            {slide.type==="multiple_choice"&&<><fieldset className="quiz-options" disabled={!quizReady||Boolean(quizConflict)||quizLocked}><legend>Antwortmöglichkeiten und richtige Lösungen</legend><small className="editor-hint">Alle richtigen Antworten markieren. Die Markierungen sind nur für Lehrkräfte sichtbar.</small>{(slide.content.options??[]).map((option,index)=><div className="quiz-option-row" key={index}><label className="quiz-correct"><input type="checkbox" checked={currentKey?.correctIndices.includes(index)??false} onChange={e=>toggleCorrect(index,e.target.checked)} aria-label={`Antwort ${index+1} ist richtig`}/><span>Richtig</span></label><input className="quiz-option-text" aria-label={`Antwort ${index+1}`} value={option} onChange={e=>updateQuizOptions((slide.content.options??[]).map((value,i)=>i===index?e.target.value:value))}/><div className="quiz-option-actions"><button type="button" aria-label={`Antwort ${index+1} nach oben`} disabled={index===0} onClick={()=>moveOption(index,-1)}><ArrowUp size={14}/></button><button type="button" aria-label={`Antwort ${index+1} nach unten`} disabled={index===(slide.content.options??[]).length-1} onClick={()=>moveOption(index,1)}><ArrowDown size={14}/></button><button type="button" aria-label={`Antwort ${index+1} entfernen`} onClick={()=>removeOption(index)}><Trash2 size={14}/></button></div></div>)}<button type="button" className="button secondary full" onClick={()=>updateQuizOptions([...(slide.content.options??[]),""])}><Plus size={14}/> Antwort hinzufügen</button><label className="check-row"><input type="checkbox" checked={Boolean(slide.content.allowMultiple)} disabled={(currentKey?.correctIndices.length??0)>1} onChange={e=>updateContent("allowMultiple",e.target.checked)}/> Mehrere Antworten erlauben</label>{(currentKey?.correctIndices.length??0)>1&&<small className="editor-hint">Mehrfachauswahl ist aktiv, weil mehrere Antworten richtig sind.</small>}</fieldset><label className="prop-label">Zeitlimit in Sekunden (optional)<input type="text" inputMode="numeric" placeholder="Ohne Zeitlimit" aria-invalid={Boolean(timeDrafts[slide.id] && (!/^\d+$/.test(timeDrafts[slide.id]) || Number(timeDrafts[slide.id])<1 || Number(timeDrafts[slide.id])>86400))} value={timeDrafts[slide.id]??(typeof slide.content.timeLimitSeconds==="number"?String(slide.content.timeLimitSeconds):"")} onChange={e=>{const value=e.target.value;setTimeDrafts(previous=>({...previous,[slide.id]:value}));if(value==="")updateContent("timeLimitSeconds",undefined);else if(/^\d+$/.test(value)&&Number(value)>=1&&Number(value)<=86400)updateContent("timeLimitSeconds",Number(value));}}/><small className="editor-hint">Leer lassen oder eine ganze Zahl von 1 bis 86400 Sekunden eingeben.</small>{timeDrafts[slide.id] && (!/^\d+$/.test(timeDrafts[slide.id]) || Number(timeDrafts[slide.id])<1 || Number(timeDrafts[slide.id])>86400) && <small role="alert">Ungültiges Zeitlimit. Bitte eine ganze Zahl von 1 bis 86400 eingeben oder das Feld leeren; der vorherige Wert bleibt gespeichert.</small>}</label></>}
            {slide.type==="wordcloud"&&<fieldset className="quiz-options"><legend>Wortfilter</legend><label className="prop-label">Filtermodus<select value={wordFilter.mode} onChange={e=>updateWordFilter({mode:e.target.value as WordFilter["mode"]})}><option value="off">Aus</option><option value="blacklist">Blockliste: Begriffe ablehnen</option><option value="whitelist">Erlaubnisliste: Nur Begriffe zulassen</option></select></label><label className="prop-label">Vergleich<select value={wordFilter.match} onChange={e=>updateWordFilter({match:e.target.value as WordFilter["match"]})}><option value="exact">Genaues Wort</option><option value="contains">Enthält Begriff</option></select></label><label className="prop-label">Begriffe · ein Begriff pro Zeile<textarea rows={4} value={wordFilter.terms.join("\n")} onChange={e=>updateWordFilter({terms:e.target.value.split("\n")})}/></label></fieldset>}
            {slide.type==="free_text"&&<><label className="prop-label">Bewertungskriterien<textarea rows={4} value={(slide.content.criteria||[]).join("\n")} onChange={e=>updateContent("criteria",e.target.value.split("\n"))}/></label><label className="prop-label">Maximalpunkte<input type="number" min="1" value={Number(slide.content.maxPoints)||4} onChange={e=>updateContent("maxPoints",Number(e.target.value))}/></label></>}
            {slide.type==="group_work"&&<label className="prop-label">Gruppengröße<input type="number" min="2" max="12" value={Number(slide.content.groupSize)||4} onChange={e=>updateContent("groupSize",Number(e.target.value))}/></label>}
            {slide.type==="video"&&<label className="prop-label">Video-URL<input placeholder="https://…" value={String(slide.content.videoUrl||"")} onChange={e=>updateContent("videoUrl",e.target.value)}/></label>}
            {slide.type==="photo_task"&&<label className="prop-label">Abgabekriterien<textarea rows={3} value={(slide.content.criteria||[]).join("\n")} onChange={e=>updateContent("criteria",e.target.value.split("\n"))} placeholder="Woran erkennt man ein gutes Ergebnis?"/></label>}</>}
          <div className="inspector-divider"/><div className="editor-section-title">Präsentationseinstellungen</div><label className="check-row"><input type="checkbox" checked={settingsDoc.participation?.avatarsEnabled===true} onChange={e=>commit({...doc,participation:{...settingsDoc.participation,avatarsEnabled:e.target.checked}} as PresentationSettings)}/> Avatare erlauben</label><label className="check-row"><input type="checkbox" checked={settingsDoc.participation?.nicknameGeneratorEnabled===true} onChange={e=>commit({...doc,participation:{...settingsDoc.participation,nicknameGeneratorEnabled:e.target.checked}} as PresentationSettings)}/> Namensgenerator erlauben</label><div className="media-upload-box"><strong>Globales Hintergrundbild</strong><small>Ein Bild für die gesamte Präsentation; Folien behalten ihre eigene Hintergrundfarbe.</small><input ref={backgroundInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={e=>{void uploadBackground(e.target.files?.[0]);e.target.value="";}}/><button type="button" className="button secondary full" disabled={uploadingMedia} onClick={()=>backgroundInputRef.current?.click()}><Upload size={15}/>{uploadingMedia?"Wird hochgeladen…":settingsDoc.backgroundImage?"Hintergrundbild ersetzen":"Hintergrundbild hochladen"}</button>{settingsDoc.backgroundImage&&<button type="button" className="button secondary full" onClick={()=>commit({...doc,backgroundImage:undefined} as PresentationSettings)}><Trash2 size={15}/> Hintergrundbild entfernen</button>}<small>{hasSupabaseConfig?"Das Bild wird einmal im privaten Präsentationsspeicher abgelegt.":"Im Demo-Modus nur während dieser Browser-Sitzung verfügbar. Ein Export mit Medien lässt sich nur mit Cloud-Konfiguration und Lehrkraftkonto wieder importieren."}</small></div>
          <div className="inspector-divider"/><div className="editor-section-title">Schnell hinzufügen</div><div className="quick-add-grid"><button onClick={()=>add("text")}><Type size={15}/> Textfeld</button><button onClick={()=>add("shape")}><Circle size={15}/> Form</button><button onClick={()=>add("table")}><Table2 size={15}/> Tabelle</button><button onClick={()=>add("chart")}><LineChart size={15}/> Diagramm</button></div>
        </div>}
      </aside>
    </div>
    {sessionsAvailable&&sessionPanel&&<div className="editor-dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!endingSession)setSessionPanel(false);}}><section className="editor-dialog session-dialog" role="dialog" aria-modal="true" aria-labelledby="session-dialog-title"><header><div><span className="editor-dialog-eyebrow">DIESE PRÄSENTATION</span><h2 id="session-dialog-title">Offene Sitzungen</h2><p>Hier siehst du deine laufenden und pausierten Sitzungen – keine Teilnehmenden oder Antworten.</p></div><button type="button" className="icon-button" aria-label="Sitzungsübersicht schließen" disabled={Boolean(endingSession)} autoFocus onClick={()=>setSessionPanel(false)}><X size={20}/></button></header><div className="editor-dialog-content"><p className="session-dialog-info">Solange mindestens eine Sitzung offen ist, sind Multiple-Choice-Fragen und Lösungsschlüssel gesperrt – auch vor der ersten Antwort. Beende nur Sitzungen, die du wirklich schließen möchtest. Es werden keine Sitzungen automatisch beendet.</p><div className="session-dialog-toolbar"><strong>Deine Sitzungen</strong><button type="button" onClick={()=>refreshSessionsRef.current()} disabled={Boolean(endingSession)}>Aktualisieren</button></div>{sessionState==="loading"&&<p role="status">Sitzungen werden geladen …</p>}{sessionState==="error"&&<p className="session-dialog-error" role="alert">{sessionError} Der letzte Stand kann veraltet sein. Bitte erneut aktualisieren.</p>}{sessionActionError&&<p className="session-dialog-error" role="alert">{sessionActionError}</p>}{sessionNotice&&<p className="session-dialog-success" role="status">{sessionNotice}</p>}{sessionState==="ready"&&sessions.length===0&&<p className="session-empty">Keine offenen Sitzungen gefunden. Falls Änderungen noch nicht gespeichert sind, versuche die Speicherung erneut.</p>}{sessions.length>0&&<ul className="session-list">{sessions.map(session=><li key={session.id}><div><div className="session-list-title"><strong>Code {session.joinCode || "unbekannt"}</strong><span>{session.status==="live"?"Live":"Pausiert"}</span></div><p>Gestartet: {sessionTime(session.createdAt)}</p><p>Zuletzt geändert: {sessionTime(session.syncUpdatedAt)}</p></div><button type="button" disabled={sessionState!=="ready"||Boolean(endingSession)} onClick={()=>void endOpenSession(session)}>{endingSession===session.id?"Wird beendet …":"Sitzung beenden"}</button></li>)}</ul>}<p className="session-time-hint">Zeiten in deiner Zeitzone; die Angabe „vor ca.“ ist eine Schätzung anhand der Geräteuhr. „Zuletzt geändert“ sagt nicht, ob jemand gerade teilnimmt. Die Liste wird regelmäßig und beim Zurückkehren aktualisiert; die Datenbank prüft die Sperre immer erneut.</p></div></section></div>}
    {quizReady&&quizProblem&&!quizStatus&&<div className="editor-quiz-status" role="status">{quizProblem.message} Ohne Schlüssel ist keine zuverlässige Bewertung möglich. <button type="button" onClick={()=>{chooseSlide(quizProblem.slideId);setSelectedId("");setInspectorOpen(true);}}>Richtige Antwort setzen</button></div>}
    {(invalidDraft||timeProblem)&&<div className="editor-quiz-status" role="alert">{timeProblem||"Ein Zeitlimit ist ungültig. Bitte eine ganze Zahl von 1 bis 86400 Sekunden eingeben oder das Feld leeren."}{invalidDraft&&<button type="button" onClick={()=>{chooseSlide(invalidDraft[0]);setSelectedId("");setInspectorOpen(true);}}>Zeitlimit korrigieren</button>}</div>}
    {quizStatus&&<div className="editor-quiz-status" role="alert">{quizStatus}{!quizReady&&<button type="button" onClick={()=>setQuizRetry(value=>value+1)}>Lösungsschlüssel erneut laden</button>}{quizPending&&!quizConflict&&<button type="button" onClick={()=>void syncQuizKeys()}>Erneut synchronisieren</button>}{quizConflict&&<button type="button" disabled={quizLocked} onClick={()=>{const draft=pendingQuizRef.current[quizConflict];if(!draft)return;const target=latestDoc.current.slides.find(item=>item.id===quizConflict);if(!target){setQuizConflict("");void syncQuizKeys();return;}if(!window.confirm("Antworten dieser Folie durch den privaten Wiederherstellungsentwurf ersetzen?"))return;const next={...latestDoc.current,slides:latestDoc.current.slides.map(item=>item.id===quizConflict?{...item,content:{...item.content,options:draft.options}}:item)};if(commit(next)){setQuizConflict("");void syncQuizKeys();}}}>Antworten aus Entwurf wiederherstellen</button>}</div>}
    {notice&&<div className="editor-notice" role="status">{notice}<button onClick={()=>setNotice("")}>Schließen</button></div>}
    {chooser&&<div className="editor-dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setChooser(false);}}><section className="editor-dialog" role="dialog" aria-modal="true" aria-labelledby="editor-dialog-title"><header><div><span className="editor-dialog-eyebrow">LOS GEHT’S</span><h2 id="editor-dialog-title">Was möchtest du erstellen?</h2><p>Wähle einen Startpunkt. Deine bestehenden Folien bleiben unverändert.</p></div><button className="icon-button" aria-label="Schließen" onClick={()=>setChooser(false)}><X size={20}/></button></header><div className="editor-dialog-content"><h3>Komplette Decks <small>3 zusammenpassende Folien</small></h3><div className="editor-deck-grid"><button className="editor-deck-card deck-aurora" onClick={()=>addTemplateDeck("aurora")}><strong>Aurora</strong><span>Leuchten, weich, modern</span><b>Deck hinzufügen →</b></button><button className="editor-deck-card deck-tech" onClick={()=>addTemplateDeck("tech")}><strong>Tech</strong><span>Kontrast, Code, Klarheit</span><b>Deck hinzufügen →</b></button><button className="editor-deck-card deck-book" onClick={()=>addTemplateDeck("book")}><strong>Book</strong><span>Editorial und elegant</span><b>Deck hinzufügen →</b></button></div><h3>Fertige Layouts <small>Für eine neue Folie</small></h3><div className="editor-template-grid">{templates.map(t=><button key={t.id} onClick={()=>addSlide("standard",t.id)}><span className={`editor-template-art template-${t.id}`}><i/><i/><i/></span><strong>{t.title}</strong><small>{t.detail}</small></button>)}</div><h3>Oder einen Folientyp wählen</h3>{typeGroups.map(group=><div className="editor-type-group" key={group.label}><h4>{group.label}</h4><div className="editor-type-grid">{group.items.map(item=><button key={item.type} onClick={()=>addSlide(item.type)}><strong>{slideTypeLabels[item.type]}</strong><small>{item.description}</small><Plus size={16}/></button>)}</div></div>)}</div></section></div>}
    {preview&&<div className="preview-overlay"><header><span><Eye size={17}/> Vorschau</span><button className="icon-button" aria-label="Vorschau schließen" onClick={()=>setPreview(false)}><X size={20}/></button></header><div className="preview-view"><div className="preview-main">{slide&&<SlideStage slide={slide} backgroundImage={settingsDoc.backgroundImage} preview/>}<div className="preview-nav"><button className="button secondary" disabled={slideIndex===0} onClick={()=>navigate(-1)}>Zurück</button><span>{slideIndex+1} / {doc.slides.length}</span><button className="button primary" disabled={slideIndex===doc.slides.length-1} onClick={()=>navigate(1)}>Weiter</button></div><p className="preview-shortcuts">Mit ← und → navigieren · Esc zum Schließen</p></div></div></div>}
  </div>;
}
