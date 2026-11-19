import { useEffect, useRef, useState, type DragEvent, type FormEvent, type PointerEvent } from "react";
import { AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowLeft, ArrowUp, BarChart3, Bold, Circle, Copy, Eye, Image, Italic, Layers, LineChart, LoaderCircle, MessageCircle, MonitorPlay, MousePointer2, Plus, Redo2, Send, Settings2, Shapes, Sparkles, Table2, Trash2, Type, Undo2, Upload, Video, X } from "lucide-react";
import { createId, createSlide, groqProxy, hasSupabaseConfig, slideTypeLabels, uploadPresentationMedia, type Presentation, type PlexiaSlide, type SlideElement, type SlideType } from "@plexia/shared";
import { SlideStage } from "./SlideStage";
import { exportPresentation } from "../lib/presentations";
import { editPresentationLocally, LOCAL_MODELS, loadLocalModel, localModelIsSupported, type LocalModelId } from "../lib/local-ai";
import "./Editor.css";

interface Props { presentation: Presentation; onChange: (p: Presentation) => void; onBack: () => void; onLive: () => void; isCloud: boolean; saving: boolean; saveError?: boolean }
type ElementPatch = Partial<SlideElement>;
type Template = "cover" | "content" | "split" | "quote";
const colors = ["#ffffff", "#f1ebff", "#e1f7f0", "#fff2cf", "#ffe4e9", "#dff2ff", "#e5eaff", "#ffead7"];
const inkColors = ["#17233d", "#5b36c9", "#e34d69", "#087e77", "#d67016", "#ffffff"];
const typeGroups: Array<{ label: string; items: Array<{ type: SlideType; description: string }> }> = [
  { label: "Präsentieren", items: [{type:"standard",description:"Deine Inhalte frei gestalten"},{type:"video",description:"Ein Video gemeinsam ansehen"},{type:"results",description:"Ergebnisse zeigen"}] },
  { label: "Wissen & Feedback", items: [{type:"multiple_choice",description:"Antworten auswählen"},{type:"poll",description:"Meinungen abfragen"},{type:"free_text",description:"Eine eigene Antwort schreiben"},{type:"worksheet",description:"Eine Aufgabe bearbeiten"},{type:"photo_task",description:"Ein Ergebnis als Foto abgeben"}] },
  { label: "Gemeinsam arbeiten", items: [{type:"brainstorm",description:"Ideen in der Klasse sammeln"},{type:"wordcloud",description:"Begriffe sichtbar machen"},{type:"mindmap",description:"Gedanken verknüpfen"},{type:"group_work",description:"In Gruppen zusammenarbeiten"}] },
];
const templates: Array<{ id: Template; title: string; detail: string }> = [
  {id:"cover",title:"Titelfolie",detail:"Ein starker Anfang"}, {id:"content",title:"Titel & Text",detail:"Für deine wichtigsten Ideen"},
  {id:"split",title:"Text & Bild",detail:"Inhalt mit Bildfläche"}, {id:"quote",title:"Zitat",detail:"Ein Gedanke im Mittelpunkt"},
];
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
function newElement(kind: SlideElement["kind"], z: number): SlideElement {
  const common: SlideElement = {id:createId(), kind, x:kind==="text"?12:20, y:kind==="text"?24:30, width:kind==="text"?48:28, height:kind==="text"?19:24, rotation:0, zIndex:z, content:kind==="text"?"Dein Text":"", color:"#17233d"};
  if (kind === "text") return {...common, fontSize:32, fontWeight:"bold", textAlign:"left"};
  if (kind === "shape") return {...common, background:"#b9a6ff", shape:"rectangle"};
  if (kind === "table") return {...common, rows:[["Begriff","Erklärung"],["Beispiel","Deine Notiz"]]};
  if (kind === "chart") return {...common, points:[{label:"A",value:6},{label:"B",value:9},{label:"C",value:4}]};
  return common;
}
function templateSlide(template: Template): PlexiaSlide {
  const slide = createSlide("standard");
  const text = (content: string, x: number, y: number, width: number, height: number, fontSize: number, extra: Partial<SlideElement> = {}): SlideElement => ({...newElement("text",2), content, x, y, width, height, fontSize, ...extra});
  if (template === "cover") {
    slide.title = "Dein großes Thema"; slide.background = "#f1ebff";
    slide.elements = [
      {...newElement("shape",1),x:76,y:11,width:14,height:25,shape:"circle",background:"#ffc952"},
      text("Dein großes Thema",9,26,75,24,58),
      text("Eine gute Geschichte beginnt hier.",10,55,65,13,25,{fontWeight:"normal",color:"#575076"}),
    ];
  } else if (template === "content") {
    slide.title = "Das Wichtigste auf einen Blick"; slide.background = "#ffffff";
    slide.elements = [text("Das Wichtigste auf einen Blick",8,12,84,20,43), text("• Erste Idee\n• Zweite Idee\n• Das möchtest du dir merken",9,37,80,47,29,{fontWeight:"normal"})];
  } else if (template === "split") {
    slide.title = "Text & Bild"; slide.background = "#e1f7f0";
    slide.elements = [text("Deine Idee",8,19,42,19,45), text("Erkläre hier, was wichtig ist.",8,43,40,30,27,{fontWeight:"normal"}), {...newElement("image",2),x:55,y:15,width:36,height:70}];
  } else {
    slide.title = "Ein Gedanke"; slide.background = "#fff2cf";
    slide.elements = [text("„Ein Gedanke kann alles verändern.“",12,30,76,34,46,{textAlign:"center"}),text("— Deine Quelle",25,70,50,12,22,{fontWeight:"normal",textAlign:"center",color:"#6d5a3d"})];
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
export function Editor({presentation,onChange,onBack,onLive,isCloud,saving,saveError=false}: Props) {
  const [doc,setDoc]=useState(presentation);
  const [slideId,setSlideId]=useState(presentation.slides[0]?.id||"");
  const [selectedId,setSelectedId]=useState("");
  const [history,setHistory]=useState<Presentation[]>([presentation]);
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
  const [dragSlideId,setDragSlideId]=useState("");
  const stageRef=useRef<HTMLDivElement>(null);
  const mediaInputRef=useRef<HTMLInputElement>(null);
  const latestDoc=useRef(doc);
  latestDoc.current=doc;
  const latestCommit=useRef<(next: Presentation) => void>(()=>{});
  const drag=useRef<{id:string;slideId:string;startX:number;startY:number;x:number;y:number;width:number;height:number;rect:DOMRect;latest:Presentation;moved:boolean}|null>(null);
  const slide=doc.slides.find(s=>s.id===slideId)||doc.slides[0];
  const selected=slide?.elements.find(e=>e.id===selectedId);
  const slideIndex=doc.slides.findIndex(s=>s.id===slide?.id);
  const canUndo=historyIndex>0, canRedo=historyIndex<history.length-1;

  function commit(next: Presentation) {
    const updated={...next,updatedAt:new Date().toISOString()};
    setDoc(updated); onChange(updated);
    const truncated=history.slice(0,historyIndex+1);
    setHistory([...truncated,updated].slice(-50)); setHistoryIndex(Math.min(truncated.length,49));
  }
  latestCommit.current=commit;
  function restore(index: number) {
    if(index<0||index>=history.length)return;
    const restored=history[index]; setHistoryIndex(index); setDoc(restored); onChange(restored); setSelectedId("");
    if(!restored.slides.some(s=>s.id===slideId)) setSlideId(restored.slides[0]?.id||"");
  }
  function patchSlide(patch: Partial<PlexiaSlide>) { if(slide)commit({...doc,slides:doc.slides.map(s=>s.id===slide.id?{...s,...patch}:s)}); }
  function patchElement(id: string, patch: ElementPatch) { if(slide)patchSlide({elements:slide.elements.map(e=>e.id===id?{...e,...patch}:e)}); }
  function updateContent(key: string, value: unknown) { if(slide)patchSlide({content:{...slide.content,[key]:value}}); }
  function chooseSlide(id: string) { setSlideId(id); setSelectedId(""); }
  function addSlide(type: SlideType="standard", template?: Template) {
    const next=template?templateSlide(template):createSlide(type);
    if(!template && type==="standard") next.title="Neue Folie";
    const slides=[...doc.slides]; slides.splice(Math.max(0,slideIndex+1),0,next);
    commit({...doc,slides}); chooseSlide(next.id); setChooser(false);
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
    const copy={...slide,id:createId(),title:`${slide.title} (Kopie)`,createdAt:new Date().toISOString(),elements:slide.elements.map(e=>({...e,id:createId()}))};
    const slides=[...doc.slides]; slides.splice(slideIndex+1,0,copy); commit({...doc,slides}); chooseSlide(copy.id);
    if(slide.type==="multiple_choice") setNotice("Die Folie wurde kopiert. Ein separat gespeicherter privater Lösungsschlüssel wird nicht mitkopiert.");
  }
  function deleteSlide() {
    if(!slide)return;
    if(doc.slides.length===1){setNotice("Mindestens eine Folie muss erhalten bleiben.");return;}
    if(!window.confirm(`„${slide.title || "Diese Folie"}“ wirklich löschen? Du kannst die Aktion rückgängig machen.`))return;
    const slides=doc.slides.filter(s=>s.id!==slide.id); commit({...doc,slides}); chooseSlide(slides[Math.max(0,slideIndex-1)].id);
  }
  function changeType(type: SlideType) {
    if(!slide||slide.type===type)return;
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
    setAiInput(""); setAiError(""); setAiMessages(messages=>[...messages,{role:"user",text:instruction}]); setAiBusy(true);
    try {
      const result=aiProvider==="local"
        ? await editPresentationLocally(localModel,instruction,doc,progress=>{setLocalProgress(progress.progress===null?null:Math.round(progress.progress*100));setLocalProgressText(progress.text);})
        : await groqProxy<{presentation?:Presentation;summary?:string}>("edit_presentation",{instruction,presentation:doc,model:aiModel});
      if (!result.presentation?.slides?.length) throw new Error("Die KI hat keine gültige Präsentation zurückgegeben.");
      const next={...result.presentation,id:doc.id,ownerId:doc.ownerId,version:1 as const,updatedAt:new Date().toISOString()};
      commit(next); setAiMessages(messages=>[...messages,{role:"assistant",text:result.summary||"Die Präsentation wurde aktualisiert. Bitte prüfe die Änderungen auf der Arbeitsfläche."}]);
      setSelectedId(""); setSlideId(next.slides[Math.min(slideIndex,next.slides.length-1)]?.id||next.slides[0].id);
    } catch (error) { const rawMessage=error instanceof Error?error.message:"Die KI-Anfrage ist fehlgeschlagen."; const message=rawMessage.includes("Unbekannte KI-Aktion")?"Das KI-Backend ist noch nicht aktualisiert. Bitte den Supabase-Deploy für groq-proxy ausführen.":rawMessage; setAiError(message); setAiMessages(messages=>[...messages,{role:"assistant",text:`Fehler: ${message}`}]); }
    finally { setAiBusy(false); }
  }
  useEffect(()=>{
    function handleKey(e: KeyboardEvent) {
      const target=e.target as HTMLElement | null;
      const editing=Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
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
  function pointerMove(event: PointerEvent) {
    const d=drag.current; if(!d)return;
    const x=clamp(d.x+(event.clientX-d.startX)/d.rect.width*100,0,100-d.width), y=clamp(d.y+(event.clientY-d.startY)/d.rect.height*100,0,100-d.height);
    if(Math.abs(x-d.x)<0.1&&Math.abs(y-d.y)<0.1&&!d.moved)return;
    const current=latestDoc.current;
    d.moved=true; d.latest={...current,slides:current.slides.map(item=>item.id===d.slideId?{...item,elements:item.elements.map(el=>el.id===d.id?{...el,x:Math.round(x*10)/10,y:Math.round(y*10)/10}:el)}:item)}; setDoc(d.latest);
  }
  function pointerEnd(){const finished=drag.current;drag.current=null;if(finished?.moved)commit(finished.latest);}
  async function uploadMedia(file?: File) {
    if(!file||!selected||!slide)return; setUploadingMedia(true);setNotice("");
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
    catch(error){setNotice(error instanceof Error?error.message:"Das Medium konnte nicht hinzugefügt werden.");}finally{setUploadingMedia(false);}
  }
  const contentField=slide?.type==="multiple_choice"||slide?.type==="poll"?"question":slide?.type==="free_text"||["mindmap","brainstorm","wordcloud"].includes(slide?.type||"")?"prompt":slide?.type==="worksheet"||slide?.type==="photo_task"||slide?.type==="group_work"?"instructions":"body";
  const layerIndex=selected&&slide?[...slide.elements].sort((a,b)=>a.zIndex-b.zIndex).findIndex(e=>e.id===selected.id):-1;
  return <div className="editor-shell">
    <header className="editor-topbar">
      <button className="back-button" onClick={onBack}><ArrowLeft size={18}/><span>Alle Präsentationen</span></button>
      <div className="editor-doc"><input className="doc-title-input" value={doc.title} maxLength={160} onChange={e=>commit({...doc,title:e.target.value})} aria-label="Präsentationstitel"/><span className={`save-indicator ${saveError?"is-error":saving?"is-saving":"is-saved"}`}><i/> {saveError?"Nicht gespeichert":saving?"Wird gespeichert…":isCloud?"Cloud synchronisiert":"Lokal gespeichert"}</span></div>
      <div className="editor-top-actions"><button className={`button ai-toggle ${aiOpen?"is-active":""}`} onClick={()=>aiOpen?setAiOpen(false):void openAi()}><Sparkles size={16}/><span className="hide-small">KI-Assistent</span></button><button className="icon-button" title="Rückgängig (Strg+Z)" aria-label="Rückgängig" disabled={!canUndo} onClick={()=>restore(historyIndex-1)}><Undo2 size={17}/></button><button className="icon-button" title="Wiederholen (Strg+Y)" aria-label="Wiederholen" disabled={!canRedo} onClick={()=>restore(historyIndex+1)}><Redo2 size={17}/></button><button className="button secondary hide-small" onClick={()=>exportPresentation(doc)}>Exportieren</button><button className="button secondary" onClick={()=>setPreview(true)}><Eye size={16}/><span className="hide-small">Vorschau</span></button><button className="button primary" onClick={onLive}><MonitorPlay size={17}/><span className="hide-small">Live starten</span></button></div>
    </header>
    <div className={`editor-body ${aiOpen?"has-ai":""}`}>
      <aside className="slide-rail"><div className="rail-head"><div><strong>Deine Folien</strong><span>{doc.slides.length} {doc.slides.length===1?"Folie":"Folien"}</span></div><button className="icon-button mini-icon" onClick={()=>setChooser(true)} aria-label="Folie hinzufügen"><Plus size={18}/></button></div>
        <div className="slide-list">{doc.slides.map((s,i)=><button key={s.id} draggable className={`slide-thumb ${s.id===slide?.id?"active":""} ${s.id===dragSlideId?"is-dragging":""}`} onClick={()=>chooseSlide(s.id)} onDragStart={e=>{setDragSlideId(s.id);e.dataTransfer.setData("text/plain",s.id);e.dataTransfer.effectAllowed="move";}} onDragEnd={()=>setDragSlideId("")} onDragOver={e=>e.preventDefault()} onDrop={e=>dropSlide(e,s.id)} aria-current={s.id===slide?.id?"true":undefined} title="Zum Sortieren ziehen"><div className="thumb-canvas" style={{background:s.background}}><span className="thumb-title">{s.title||"Unbenannt"}</span><span className="thumb-sub">{String(s.content.question||s.content.prompt||s.content.body||s.content.instructions||slideTypeLabels[s.type])}</span><i className="thumb-accent"/></div><span className="thumb-name"><b>{String(i+1).padStart(2,"0")}</b> {s.title||"Unbenannt"}</span><span className="thumb-type">{slideTypeLabels[s.type]}</span></button>)}</div>
        <button className="add-slide-rail" onClick={()=>setChooser(true)}><Plus size={16}/> Neue Folie</button>
      </aside>
      <main className="canvas-workspace">
        <div className="workspace-top"><div className="breadcrumb"><span>{doc.title||"Unbenannte Präsentation"}</span><b>/</b><strong>{slide?.title||"Folie"}</strong></div><div className="slide-toolbar"><label className="type-select-label"><span>Typ</span><select aria-label="Folientyp" value={slide?.type||"standard"} onChange={e=>changeType(e.target.value as SlideType)}>{typeGroups.map(group=><optgroup key={group.label} label={group.label}>{group.items.map(item=><option key={item.type} value={item.type}>{slideTypeLabels[item.type]}</option>)}</optgroup>)}</select></label><span className="toolbar-separator"/><button className="icon-button" title="Folie nach oben (Alt+↑)" aria-label="Folie nach oben" disabled={slideIndex<=0} onClick={()=>moveSlide(-1)}><ArrowUp size={16}/></button><button className="icon-button" title="Folie nach unten (Alt+↓)" aria-label="Folie nach unten" disabled={slideIndex>=doc.slides.length-1} onClick={()=>moveSlide(1)}><ArrowDown size={16}/></button><button className="icon-button" title="Folie duplizieren" aria-label="Folie duplizieren" onClick={duplicateSlide}><Copy size={16}/></button><button className="icon-button danger-icon" title="Folie löschen" aria-label="Folie löschen" onClick={deleteSlide}><Trash2 size={16}/></button><button className="icon-button editor-inspector-toggle" title="Eigenschaften öffnen oder schließen" aria-label="Eigenschaften öffnen oder schließen" aria-expanded={inspectorOpen} onClick={()=>setInspectorOpen(!inspectorOpen)}><Settings2 size={17}/></button></div></div>
        <div className="stage-scroll"><div className="stage-shell" ref={stageRef} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onClick={()=>setSelectedId("")}>{slide&&<SlideStage slide={slide} selectedId={selectedId} onSelect={selectElement} onPointerDown={pointerStart}/>}</div></div>
        <div className="stage-caption"><span><MousePointer2 size={14}/> Elemente ziehen · mit Pfeiltasten verschieben</span><span>{String(slideIndex+1).padStart(2,"0")} / {String(doc.slides.length).padStart(2,"0")}</span></div>
        <div className="element-dock"><span>HINZUFÜGEN</span><button onClick={()=>add("text")} title="Text hinzufügen"><Type size={17}/> <span>Text</span></button><button onClick={()=>add("image")} title="Bild hinzufügen"><Image size={17}/> <span>Bild</span></button><button onClick={()=>add("video")} title="Video hinzufügen"><Video size={17}/> <span>Video</span></button><button onClick={()=>add("shape")} title="Form hinzufügen"><Shapes size={17}/> <span>Form</span></button><button onClick={()=>add("table")} title="Tabelle hinzufügen"><Table2 size={17}/> <span>Tabelle</span></button><button onClick={()=>add("chart")} title="Diagramm hinzufügen"><BarChart3 size={17}/> <span>Diagramm</span></button></div>
      </main>
      {aiOpen&&<aside className="ai-sidebar" aria-label="KI-Assistent"><div className="ai-sidebar-head"><div><span className="ai-eyebrow"><Sparkles size={12}/> PLEXIA AI</span><strong>Folien gemeinsam bauen</strong></div><button className="icon-button mini-icon" aria-label="KI-Assistent schließen" onClick={()=>setAiOpen(false)}><X size={16}/></button></div><div className="ai-sidebar-model"><div className="ai-provider-tabs" role="tablist" aria-label="KI-Modus"><button type="button" className={aiProvider==="groq"?"active":""} onClick={()=>setAiProvider("groq")} role="tab" aria-selected={aiProvider==="groq"}>Groq-Cloud</button><button type="button" className={aiProvider==="local"?"active":""} onClick={()=>setAiProvider("local")} role="tab" aria-selected={aiProvider==="local"}>Lokal</button></div>{aiProvider==="groq"?<><label>Groq-Modell<select value={aiModel} onChange={event=>setAiModel(event.target.value)} disabled={aiBusy}>{(aiModels.length?aiModels:[{id:"llama-3.3-70b-versatile"},{id:"llama-3.1-8b-instant"},{id:"openai/gpt-oss-20b"}]).map(model=><option key={model.id} value={model.id}>{model.id}</option>)}</select></label><small>Die Anfrage wird über dein konfiguriertes Groq-Backend verarbeitet.</small></>:<><label>Lokales Modell<select value={localModel} onChange={event=>{setLocalModel(event.target.value as LocalModelId);setLocalReady(false);setLocalProgress(null);}} disabled={aiBusy||localDownloading}>{LOCAL_MODELS.map(model=><option key={model.id} value={model.id}>{model.label}</option>)}</select></label><small>{LOCAL_MODELS.find(model=>model.id===localModel)?.detail}. Der erste Download kann mehrere Minuten dauern.</small><button type="button" className="button local-download" onClick={()=>void downloadLocalModel()} disabled={!localModelIsSupported()||localDownloading||localReady}>{localDownloading?<><LoaderCircle className="spin" size={14}/> Wird geladen …</>:localReady?"Lokal bereit":"Modell herunterladen"}</button>{!localModelIsSupported()&&<p className="ai-local-warning">WebGPU wird in diesem Browser nicht unterstützt. Nutze aktuelles Chrome oder Edge.</p>}{(localDownloading||localProgress!==null)&&<div className="ai-download-progress" aria-live="polite"><div className="ai-download-label"><span>{localProgressText||"Modell wird geladen …"}</span><b>{localProgress===null?"…":`${localProgress}%`}</b></div><div className="ai-progress-track"><i style={{width:localProgress===null?"35%":`${localProgress}%`}}/></div></div>}</>}</div><div className="ai-chat" aria-live="polite">{aiMessages.length===0?<div className="ai-empty"><MessageCircle size={22}/><strong>Was soll sich ändern?</strong><p>Zum Beispiel: „Erstelle eine 5-teilige Präsentation über Photosynthese für Klasse 7.“</p></div>:aiMessages.map((message,index)=><div className={`ai-message ${message.role}`} key={`${message.role}-${index}`}><span>{message.role==="user"?"Du":"KI"}</span><p>{message.text}</p></div>)}{aiBusy&&<div className="ai-thinking"><LoaderCircle className="spin" size={15}/> Folien werden erstellt …</div>}</div><form className="ai-compose" onSubmit={event=>void askAi(event)}><textarea value={aiInput} onChange={event=>setAiInput(event.target.value)} placeholder="Beschreibe deine Folienänderung …" rows={3} disabled={aiBusy||aiProvider==="local"&&!localReady}/><button className="button primary" disabled={aiBusy||!aiInput.trim()||(aiProvider==="local"&&!localReady)}><Send size={15}/> {aiBusy?"Wird erstellt…":"Anwenden"}</button></form>{aiError&&<p className="ai-error" role="alert">{aiError}</p>}<p className="ai-disclaimer">{aiProvider==="local"?"Lokal: Das Modell läuft nach dem Download im Browser und sendet keine Folien an einen Server.":"KI-Ergebnisse können Fehler enthalten. Bitte prüfe jede Folie vor dem Unterricht."}</p></aside>}
      <aside className={`inspector ${inspectorOpen?"is-open":""}`}><div className="inspector-heading"><div><small>{selected?"AUSGEWÄHLT":"AKTUELLE FOLIE"}</small><strong>{selected?"Element gestalten":"Folie gestalten"}</strong></div><button className="icon-button mini-icon inspector-close" aria-label="Eigenschaften schließen" onClick={()=>{if(selected)setSelectedId("");else setInspectorOpen(false);}}><X size={16}/></button></div>
        {selected?<div className="inspector-content">
          <div className="property-tag">{({text:"TEXT",image:"BILD",video:"VIDEO",shape:"FORM",table:"TABELLE",chart:"DIAGRAMM"} as const)[selected.kind]}</div>
          {selected.kind==="text"?<label className="prop-label">Textinhalt<textarea rows={4} value={selected.content} onChange={e=>patchElement(selected.id,{content:e.target.value})}/></label>:selected.kind==="image"||selected.kind==="video"?<label className="prop-label">{selected.kind==="image"?"Bild-URL":"Video-URL"}<input value={selected.content} onChange={e=>patchElement(selected.id,{content:e.target.value})} placeholder="https://…"/></label>:null}
          {(selected.kind==="image"||selected.kind==="video")&&<div className="media-upload-box"><input ref={mediaInputRef} type="file" accept={selected.kind==="image"?"image/png,image/jpeg,image/webp,image/gif":"video/mp4,video/webm"} hidden onChange={e=>{void uploadMedia(e.target.files?.[0]);e.target.value="";}}/><button className="button secondary full" onClick={()=>mediaInputRef.current?.click()} disabled={uploadingMedia}><Upload size={15}/>{uploadingMedia?"Wird hochgeladen…":hasSupabaseConfig?"Datei sicher hochladen":"Datei lokal auswählen"}</button><small>{hasSupabaseConfig?"Die Datei liegt im geschützten Präsentationsspeicher.":"Lokale Datei nur in dieser Browser-Sitzung verfügbar."}</small></div>}
          {selected.kind==="image"&&<><label className="prop-label">Bildbeschreibung<input value={selected.alt||""} onChange={e=>patchElement(selected.id,{alt:e.target.value})} placeholder="Was ist auf dem Bild zu sehen?"/></label><label className="prop-label">Bilddarstellung<select value={selected.objectFit||"cover"} onChange={e=>patchElement(selected.id,{objectFit:e.target.value as SlideElement["objectFit"]})}><option value="cover">Rahmen füllen</option><option value="contain">Ganzes Bild zeigen</option></select></label></>}
          {selected.kind==="text"&&<><div className="property-grid"><NumberField key={`${selected.id}-font`} label="Schriftgröße" min={10} max={120} value={selected.fontSize||32} onValue={fontSize=>patchElement(selected.id,{fontSize})}/><div className="prop-label">Schriftstil<div className="editor-segmented"><button title="Fett" aria-label="Fett" aria-pressed={(selected.fontWeight||"bold")==="bold"} onClick={()=>patchElement(selected.id,{fontWeight:(selected.fontWeight||"bold")==="bold"?"normal":"bold"})}><Bold size={16}/></button><button title="Kursiv" aria-label="Kursiv" aria-pressed={selected.fontStyle==="italic"} onClick={()=>patchElement(selected.id,{fontStyle:selected.fontStyle==="italic"?"normal":"italic"})}><Italic size={16}/></button></div></div></div><div className="prop-label">Ausrichtung<div className="editor-segmented"><button title="Linksbündig" aria-label="Linksbündig" aria-pressed={(selected.textAlign||"left")==="left"} onClick={()=>patchElement(selected.id,{textAlign:"left"})}><AlignLeft size={16}/></button><button title="Zentriert" aria-label="Zentriert" aria-pressed={selected.textAlign==="center"} onClick={()=>patchElement(selected.id,{textAlign:"center"})}><AlignCenter size={16}/></button><button title="Rechtsbündig" aria-label="Rechtsbündig" aria-pressed={selected.textAlign==="right"} onClick={()=>patchElement(selected.id,{textAlign:"right"})}><AlignRight size={16}/></button></div></div><div className="prop-label">Textfarbe<Palette value={selected.color||"#17233d"} options={inkColors} onChange={color=>patchElement(selected.id,{color})} label="Textfarbe"/><input type="color" aria-label="Eigene Textfarbe" value={/^#[\da-f]{6}$/i.test(selected.color||"")?selected.color:"#17233d"} onChange={e=>patchElement(selected.id,{color:e.target.value})}/></div></>}
          {selected.kind==="shape"&&<><label className="prop-label">Form<select value={selected.shape||"rectangle"} onChange={e=>patchElement(selected.id,{shape:e.target.value as SlideElement["shape"]})}><option value="rectangle">Rechteck</option><option value="circle">Kreis</option><option value="line">Linie</option></select></label><div className="prop-label">Füllfarbe<Palette value={selected.background||"#b9a6ff"} options={["#b9a6ff","#ffca55","#f27388","#64cfb3","#72bdf2","#17233d"]} onChange={background=>patchElement(selected.id,{background})} label="Füllfarbe"/><input type="color" aria-label="Eigene Füllfarbe" value={/^#[\da-f]{6}$/i.test(selected.background||"")?selected.background:"#b9a6ff"} onChange={e=>patchElement(selected.id,{background:e.target.value})}/></div></>}
          {selected.kind==="table"&&<label className="prop-label">Tabelle · Zellen mit | trennen<textarea rows={4} value={(selected.rows||[]).map(r=>r.join(" | ")).join("\n")} onChange={e=>patchElement(selected.id,{rows:e.target.value.split("\n").map(r=>r.split("|").map(c=>c.trim()))})}/></label>}
          {selected.kind==="chart"&&<label className="prop-label">Diagrammdaten · Name | Wert<textarea rows={4} value={(selected.points||[]).map(p=>`${p.label} | ${p.value}`).join("\n")} onChange={e=>patchElement(selected.id,{points:e.target.value.split("\n").map(r=>{const [label,value]=r.split("|");return{label:label?.trim()||"",value:Number(value)||0};})})}/></label>}
          <div className="inspector-divider"/><div className="editor-section-title">Position & Größe <small>in % der Folie</small></div><div className="property-grid"><NumberField key={`${selected.id}-width`} label="Breite" min={4} max={100} value={selected.width} onValue={width=>patchElement(selected.id,{width,x:Math.min(selected.x,100-width)})}/><NumberField key={`${selected.id}-height`} label="Höhe" min={4} max={100} value={selected.height} onValue={height=>patchElement(selected.id,{height,y:Math.min(selected.y,100-height)})}/><NumberField key={`${selected.id}-x`} label="X-Position" min={0} max={100-selected.width} value={Math.round(selected.x*10)/10} onValue={x=>patchElement(selected.id,{x})}/><NumberField key={`${selected.id}-y`} label="Y-Position" min={0} max={100-selected.height} value={Math.round(selected.y*10)/10} onValue={y=>patchElement(selected.id,{y})}/><NumberField key={`${selected.id}-rotation`} label="Drehung °" min={-180} max={180} value={selected.rotation} onValue={rotation=>patchElement(selected.id,{rotation})}/></div>
          <div className="editor-section-title"><Layers size={14}/> Ebenen</div><div className="editor-action-grid"><button disabled={layerIndex<=0} onClick={()=>moveLayer(-1)}><ArrowDown size={15}/> Nach hinten</button><button disabled={layerIndex>=slide.elements.length-1} onClick={()=>moveLayer(1)}><ArrowUp size={15}/> Nach vorne</button></div><div className="editor-action-grid"><button onClick={duplicateElement}><Copy size={15}/> Duplizieren</button><button className="editor-delete" onClick={removeSelected}><Trash2 size={15}/> Entfernen</button></div>
        </div>:<div className="inspector-content">
          <label className="prop-label">Folientitel<input value={slide?.title||""} onChange={e=>patchSlide({title:e.target.value})} placeholder="Dein Folientitel"/></label><div className="prop-label">Hintergrund<Palette value={slide?.background||"#ffffff"} options={colors} onChange={background=>patchSlide({background})} label="Hintergrund"/><label className="editor-custom-color">Eigene Farbe <input type="color" aria-label="Eigene Hintergrundfarbe" value={/^#[\da-f]{6}$/i.test(slide?.background||"")?slide.background:"#ffffff"} onChange={e=>patchSlide({background:e.target.value})}/></label></div>
          {slide&&<><div className="inspector-divider"/><div className="editor-section-title">{slideTypeLabels[slide.type]} <small>Inhalt</small></div><label className="prop-label">{contentField==="question"?"Frage":contentField==="prompt"?"Aufgabenstellung":contentField==="instructions"?"Arbeitsanweisung":"Zusatztext"}<textarea rows={4} value={String(slide.content[contentField]||"")} onChange={e=>updateContent(contentField,e.target.value)} placeholder="Inhalt für diese Folie…"/></label>{slide.type==="standard"&&slide.elements.length>0&&<small className="editor-hint">Texte auf der Folie anklicken, um sie direkt zu bearbeiten. Der Zusatztext erscheint auf Folien ohne Elemente.</small>}
            {(slide.type==="multiple_choice"||slide.type==="poll")&&<><label className="prop-label">Antwortmöglichkeiten · eine pro Zeile<textarea rows={4} value={(slide.content.options||[]).join("\n")} onChange={e=>updateContent("options",e.target.value.split("\n"))}/></label><label className="check-row"><input type="checkbox" checked={Boolean(slide.content.allowMultiple)} onChange={e=>updateContent("allowMultiple",e.target.checked)}/> Mehrere Antworten erlauben</label>{slide.type==="multiple_choice"&&<small className="editor-hint">Wenn ein privater Lösungsschlüssel existiert, nach Änderungen der Antwortreihenfolge die richtige Antwort prüfen.</small>}</>}
            {slide.type==="free_text"&&<><label className="prop-label">Bewertungskriterien<textarea rows={4} value={(slide.content.criteria||[]).join("\n")} onChange={e=>updateContent("criteria",e.target.value.split("\n"))}/></label><label className="prop-label">Maximalpunkte<input type="number" min="1" value={Number(slide.content.maxPoints)||4} onChange={e=>updateContent("maxPoints",Number(e.target.value))}/></label></>}
            {slide.type==="group_work"&&<label className="prop-label">Gruppengröße<input type="number" min="2" max="12" value={Number(slide.content.groupSize)||4} onChange={e=>updateContent("groupSize",Number(e.target.value))}/></label>}
            {slide.type==="video"&&<label className="prop-label">Video-URL<input placeholder="https://…" value={String(slide.content.videoUrl||"")} onChange={e=>updateContent("videoUrl",e.target.value)}/></label>}
            {slide.type==="photo_task"&&<label className="prop-label">Abgabekriterien<textarea rows={3} value={(slide.content.criteria||[]).join("\n")} onChange={e=>updateContent("criteria",e.target.value.split("\n"))} placeholder="Woran erkennt man ein gutes Ergebnis?"/></label>}</>}
          <div className="inspector-divider"/><div className="editor-section-title">Schnell hinzufügen</div><div className="quick-add-grid"><button onClick={()=>add("text")}><Type size={15}/> Textfeld</button><button onClick={()=>add("shape")}><Circle size={15}/> Form</button><button onClick={()=>add("table")}><Table2 size={15}/> Tabelle</button><button onClick={()=>add("chart")}><LineChart size={15}/> Diagramm</button></div>
        </div>}
      </aside>
    </div>
    {notice&&<div className="editor-notice" role="status">{notice}<button onClick={()=>setNotice("")}>Schließen</button></div>}
    {chooser&&<div className="editor-dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setChooser(false);}}><section className="editor-dialog" role="dialog" aria-modal="true" aria-labelledby="editor-dialog-title"><header><div><span className="editor-dialog-eyebrow">LOS GEHT’S</span><h2 id="editor-dialog-title">Was möchtest du erstellen?</h2><p>Wähle einen Startpunkt. Deine bestehenden Folien bleiben unverändert.</p></div><button className="icon-button" aria-label="Schließen" onClick={()=>setChooser(false)}><X size={20}/></button></header><div className="editor-dialog-content"><h3>Fertige Layouts <small>Für eine neue Folie</small></h3><div className="editor-template-grid">{templates.map(t=><button key={t.id} onClick={()=>addSlide("standard",t.id)}><span className={`editor-template-art template-${t.id}`}><i/><i/><i/></span><strong>{t.title}</strong><small>{t.detail}</small></button>)}</div><h3>Oder einen Folientyp wählen</h3>{typeGroups.map(group=><div className="editor-type-group" key={group.label}><h4>{group.label}</h4><div className="editor-type-grid">{group.items.map(item=><button key={item.type} onClick={()=>addSlide(item.type)}><strong>{slideTypeLabels[item.type]}</strong><small>{item.description}</small><Plus size={16}/></button>)}</div></div>)}</div></section></div>}
    {preview&&<div className="preview-overlay"><header><span><Eye size={17}/> Vorschau</span><button className="icon-button" aria-label="Vorschau schließen" onClick={()=>setPreview(false)}><X size={20}/></button></header><div className="preview-view"><div className="preview-main">{slide&&<SlideStage slide={slide} preview/>}<div className="preview-nav"><button className="button secondary" disabled={slideIndex===0} onClick={()=>navigate(-1)}>Zurück</button><span>{slideIndex+1} / {doc.slides.length}</span><button className="button primary" disabled={slideIndex===doc.slides.length-1} onClick={()=>navigate(1)}>Weiter</button></div><p className="preview-shortcuts">Mit ← und → navigieren · Esc zum Schließen</p></div></div></div>}
  </div>;
}
