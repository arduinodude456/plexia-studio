import { useEffect, useState, type PointerEvent } from "react";
import { createSignedPresentationUrl, hasSupabaseConfig, type PlexiaSlide, type SlideElement } from "@plexia/shared";

function usePresentationMediaUrl(path: string): string {
  const [url, setUrl] = useState(path);
  useEffect(() => {
    if (!path || !hasSupabaseConfig || /^(https?:|blob:|data:)/i.test(path)) {
      setUrl(path);
      return;
    }
    let active = true;
    setUrl("");
    void createSignedPresentationUrl(path).then((signed) => {
      if (active) setUrl(signed);
    }).catch(() => {
      if (active) setUrl("");
    });
    return () => { active = false; };
  }, [path]);
  return url;
}

function videoEmbedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "youtu.be") return `https://www.youtube.com/embed/${parsed.pathname.slice(1)}`;
    if (parsed.hostname.endsWith("youtube.com") && parsed.pathname === "/watch") {
      const id = parsed.searchParams.get("v");
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
    return url;
  } catch {
    return url;
  }
}

function StageElement({ element, selected, onSelect, onPointerDown }: {
  element: SlideElement;
  selected: boolean;
  onSelect?: (id: string) => void;
  onPointerDown?: (event: PointerEvent<HTMLDivElement>, element: SlideElement) => void;
}) {
  const mediaUrl = usePresentationMediaUrl(element.content);
  const isVideoFile = /\.(mp4|webm)(?:$|\?)/i.test(element.content);
  return <div
    className={`slide-element element-${element.kind} ${selected ? "is-selected" : ""}`}
    style={{ left: `${element.x}%`, top: `${element.y}%`, width: `${element.width}%`, height: `${element.height}%`, zIndex: element.zIndex,
      background: element.kind === "shape" ? (element.background || "#dfe7ff") : undefined,
      color: element.color || "#17233d", transform: `rotate(${element.rotation}deg)`,
      borderRadius: element.kind === "shape" && element.shape === "circle" ? "50%" : undefined }}
    onClick={(event) => { event.stopPropagation(); onSelect?.(element.id); }}
    onPointerDown={(event) => onPointerDown?.(event, element)}
  >
    {element.kind === "text" && <span>{element.content || "Text hier eingeben"}</span>}
    {element.kind === "image" && (mediaUrl
      ? <img src={mediaUrl} alt={element.alt || ""} draggable={false}/>
      : <div className="element-placeholder">{element.content ? "Bild wird geladen…" : "Bild-URL hinzufügen"}</div>)}
    {element.kind === "video" && (mediaUrl
      ? isVideoFile
        ? <video src={mediaUrl} title={element.alt || "Video"} controls playsInline/>
        : <iframe src={videoEmbedUrl(mediaUrl)} title={element.alt || "Eingebettetes Video"} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen/>
      : <div className="element-placeholder">{element.content ? "Video wird geladen…" : "Video-URL hinzufügen"}</div>)}
    {element.kind === "shape" && element.shape === "line" && <div className="shape-line"/>}
    {element.kind === "shape" && element.shape !== "line" && <span className="sr-only">Form</span>}
    {element.kind === "table" && <table><tbody>{(element.rows || [["Überschrift A", "Überschrift B"], ["Inhalt", "Inhalt"]]).map((row, rowIndex) =>
      <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table>}
    {element.kind === "chart" && <div className="chart-bars">{(element.points || [{label:"A",value:6},{label:"B",value:9},{label:"C",value:4}]).map(point =>
      <div className="chart-column" key={point.label}><i style={{height:`${Math.max(10,Math.min(100,point.value*8))}%`}}/><small>{point.label}</small></div>)}</div>}
  </div>;
}

function SlideContentPreview({ slide }: { slide: PlexiaSlide }) {
  const content = slide.content;
  const options = Array.isArray(content.options) ? content.options.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
  const prompt = [content.question, content.prompt, content.instructions, content.body]
    .find((value): value is string => typeof value === "string" && Boolean(value.trim())) || "";
  if (slide.type === "standard" || slide.type === "video") return content.body ? <p className="slide-content-body">{content.body}</p> : null;
  return <div className={`slide-content-preview preview-${slide.type}`}>
    <span className="slide-content-type">{slide.type === "multiple_choice" ? "QUIZ" : slide.type === "poll" ? "UMFRAGE" : slide.type === "group_work" ? "GRUPPENARBEIT" : "AKTIVITÄT"}</span>
    {prompt && <p className="slide-content-prompt">{prompt}</p>}
    {(slide.type === "multiple_choice" || slide.type === "poll") && options.length > 0 && <div className="slide-content-options">{options.map((option, index) => <div className="slide-content-option" key={`${option}-${index}`}><b>{String.fromCharCode(65 + index)}</b><span>{option}</span></div>)}</div>}
    {slide.type === "free_text" && <div className="slide-content-input-placeholder">Schülerantwort …</div>}
    {slide.type === "worksheet" && <div className="slide-content-input-placeholder">Arbeitsblatt-Antwort …</div>}
    {slide.type === "photo_task" && <div className="slide-content-input-placeholder">Foto oder Beschreibung abgeben …</div>}
    {slide.type === "group_work" && <div className="slide-content-input-placeholder">Gruppengröße: {Number(content.groupSize) || 4} · Gruppenarbeit</div>}
    {(slide.type === "mindmap" || slide.type === "brainstorm" || slide.type === "wordcloud") && <div className="slide-content-input-placeholder">Ideen werden hier gesammelt …</div>}
  </div>;
}

export function SlideStage({slide, preview=false, selectedId, onSelect, onPointerDown}: {
  slide: PlexiaSlide;
  preview?: boolean;
  selectedId?: string;
  onSelect?: (id: string) => void;
  onPointerDown?: (event: PointerEvent<HTMLDivElement>, element: SlideElement) => void;
}) {
  return <div className={`slide-stage ${preview ? "stage-preview" : ""}`} style={{background:slide.background||"#fff"}}>
    {slide.elements.length===0&&<div className="stage-empty"><span className="stage-empty-mark">✦</span><strong>{slide.title||"Deine Folie"}</strong><SlideContentPreview slide={slide}/>{!slide.content.body && ["standard", "video"].includes(slide.type) && <small>Elemente hinzufügen, um deine Idee zum Leben zu erwecken.</small>}{!slide.content.body && !["standard", "video"].includes(slide.type) && <small>Aktivität konfigurieren und anschließend live starten.</small>}</div>}
    {slide.elements.map(element=><StageElement key={element.id} element={element} selected={selectedId===element.id} onSelect={onSelect} onPointerDown={onPointerDown}/ >)}
  </div>;
}
