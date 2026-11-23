import { useEffect, useState, type PointerEvent } from "react";
import { createSignedPresentationUrl, hasSupabaseConfig, type PlexiaSlide, type SlideElement } from "@plexia/shared";

function usePresentationMediaUrl(path: string): string {
  const [signedUrl, setSignedUrl] = useState<{ path: string; url: string; expiresAt: number } | null>(null);
  const direct = !path || !hasSupabaseConfig || /^(https?:|blob:|data:)/i.test(path);
  useEffect(() => {
    if (direct) return;
    let active = true;
    let timer: number | undefined;
    const sign = async () => {
      try {
        const url = await createSignedPresentationUrl(path, 3600);
        if (!active) return;
        setSignedUrl({ path, url, expiresAt: Date.now() + 3600 * 1000 });
        // Renew before the one-hour URL expires, including in long lessons.
        timer = window.setTimeout(sign, 55 * 60 * 1000);
      } catch {
        if (!active) return;
        setSignedUrl(null);
        timer = window.setTimeout(sign, 30 * 1000);
      }
    };
    void sign();
    return () => { active = false; window.clearTimeout(timer); };
  }, [direct, path]);
  // Never briefly render the preceding path's URL while a new signature loads.
  return direct ? path : signedUrl?.path === path && signedUrl.expiresAt > Date.now() ? signedUrl.url : "";
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

function VideoContent({ source, alt, disableEmbeddedInteraction = false }: { source: string; alt?: string; disableEmbeddedInteraction?: boolean }) {
  const url = usePresentationMediaUrl(source);
  const isFile = /\.(mp4|webm)(?:$|\?)/i.test(source) || /\.(mp4|webm)$/i.test(alt || "") || /^blob:/i.test(source);
  if (!url) return <div className="element-placeholder">{source ? "Video wird geladen…" : "Video-URL hinzufügen"}</div>;
  return isFile
    ? <video src={url} title={alt || "Video"} controls playsInline/>
    : <iframe src={videoEmbedUrl(url)} title={alt || "Eingebettetes Video"} tabIndex={disableEmbeddedInteraction ? -1 : undefined} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen/>;
}

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const resizeHandles: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
function fontFamilyCss(value: SlideElement["fontFamily"]): string | undefined {
  return value === "serif" ? "Georgia, serif" : value === "mono" ? "ui-monospace, monospace" : value === "display" ? "Manrope, ui-sans-serif, sans-serif" : value === "rounded" ? "ui-rounded, 'Arial Rounded MT Bold', sans-serif" : value === "sans" ? "Inter, ui-sans-serif, sans-serif" : undefined;
}

function StageElement({ element, selected, onSelect, onPointerDown, onResizeStart, disableEmbeddedInteraction }: {
  element: SlideElement;
  selected: boolean;
  disableEmbeddedInteraction?: boolean;
  onSelect?: (id: string) => void;
  onPointerDown?: (event: PointerEvent<HTMLDivElement>, element: SlideElement) => void;
  onResizeStart?: (event: PointerEvent<HTMLButtonElement>, element: SlideElement, handle: ResizeHandle) => void;
}) {
  const mediaUrl = usePresentationMediaUrl(element.kind === "image" ? element.content : "");
  const editable = Boolean(onPointerDown);
  return <div
    className={`slide-element element-${element.kind} ${selected ? "is-selected" : ""}`}
    style={{
      left: `${element.x}%`, top: `${element.y}%`, width: `${element.width}%`, height: `${element.height}%`, zIndex: element.zIndex,
      background: element.kind === "shape" && element.shape !== "line" ? (element.background || "#5638bd") : undefined,
      color: element.color || "#352376", transform: `rotate(${element.rotation}deg)`,
      borderRadius: element.borderRadius !== undefined ? `${element.borderRadius}%` : element.kind === "shape" && element.shape === "circle" ? "50%" : undefined,
      fontSize: element.kind === "text" && element.fontSize ? `${element.fontSize / 10}cqw` : undefined,
      fontWeight: element.kind === "text" ? element.fontWeight : undefined,
      fontStyle: element.kind === "text" ? element.fontStyle : undefined,
      textAlign: element.kind === "text" ? element.textAlign : undefined,
      fontFamily: element.kind === "text" ? fontFamilyCss(element.fontFamily) : undefined,
      opacity: element.opacity ?? 1,
    }}
    tabIndex={editable ? 0 : undefined}
    role={editable ? "button" : undefined}
    aria-label={editable ? `${element.kind === "text" ? "Text" : element.kind}: ${element.content || "Element"} auswählen` : undefined}
    onFocus={() => onSelect?.(element.id)}
    onClick={(event) => { event.stopPropagation(); onSelect?.(element.id); }}
    onPointerDown={(event) => onPointerDown?.(event, element)}
  >
    {element.kind === "text" && <span>{element.content || "Text hier eingeben"}</span>}
    {element.kind === "image" && (mediaUrl
      ? <img src={mediaUrl} alt={element.alt || ""} draggable={false} style={{objectFit: element.objectFit || "cover", objectPosition: element.objectPosition || "50% 50%"}}/>
      : <div className="element-placeholder">{element.content ? "Bild wird geladen…" : "Bild-URL hinzufügen"}</div>)}
    {element.kind === "video" && <VideoContent source={element.content} alt={element.alt} disableEmbeddedInteraction={disableEmbeddedInteraction}/>}
    {element.kind === "shape" && element.shape === "line" && <div className="shape-line" style={{background: element.background || "#5638bd"}}/>}
    {element.kind === "table" && <table><tbody>{(element.rows || [["Überschrift A", "Überschrift B"], ["Inhalt", "Inhalt"]]).map((row, rowIndex) =>
      <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table>}
    {element.kind === "chart" && <div className="chart-bars">{(element.points || [{label:"A",value:6},{label:"B",value:9},{label:"C",value:4}]).map((point, index) =>
      <div className="chart-column" key={`${point.label}-${index}`}><i style={{height:`${Math.max(10,Math.min(100,point.value*8))}%`}}/><small>{point.label}</small></div>)}</div>}
    {selected && editable && <div className="resize-handles" aria-label="Element skalieren">{resizeHandles.map(handle => <button key={handle} type="button" className={`resize-handle resize-${handle}`} aria-label={`An Griff ${handle} skalieren`} onPointerDown={event => onResizeStart?.(event, element, handle)} />)}</div>}
  </div>;
}

function SlideContentPreview({ slide, disableEmbeddedInteraction }: { slide: PlexiaSlide; disableEmbeddedInteraction?: boolean }) {
  const content = slide.content;
  const options = Array.isArray(content.options) ? content.options.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
  const field = slide.type === "multiple_choice" || slide.type === "poll" ? content.question
    : ["free_text", "mindmap", "brainstorm", "wordcloud"].includes(slide.type) ? content.prompt : content.instructions;
  const prompt = typeof field === "string" ? field : "";
  if (slide.type === "standard" || slide.type === "video") return <>
    {content.body && <p className="slide-content-body">{content.body}</p>}
    {slide.type === "video" && typeof content.videoUrl === "string" && content.videoUrl && <div className="slide-content-video"><VideoContent source={content.videoUrl} disableEmbeddedInteraction={disableEmbeddedInteraction}/></div>}
  </>;
  return <div className={`slide-content-preview preview-${slide.type}`}>
    <span className="slide-content-type">{slide.type === "multiple_choice" ? "QUIZ" : slide.type === "poll" ? "UMFRAGE" : slide.type === "group_work" ? "GRUPPENARBEIT" : "AKTIVITÄT"}</span>
    {prompt && <p className="slide-content-prompt">{prompt}</p>}
    {(slide.type === "multiple_choice" || slide.type === "poll") && options.length > 0 && <div className={`slide-content-options ${slide.type === "multiple_choice" ? "kahoot-preview-options" : ""}`}>{options.map((option, index) => <div className={`slide-content-option ${slide.type === "multiple_choice" ? "kahoot-preview-option" : ""}`} key={`${option}-${index}`}><b>{String.fromCharCode(65 + index)}</b><span>{option}</span></div>)}</div>}
    {slide.type === "free_text" && <div className="slide-content-input-placeholder">Schülerantwort …</div>}
    {slide.type === "worksheet" && <div className="slide-content-input-placeholder">Arbeitsblatt-Antwort …</div>}
    {slide.type === "photo_task" && <div className="slide-content-input-placeholder">Foto oder Beschreibung abgeben …</div>}
    {slide.type === "group_work" && <div className="slide-content-input-placeholder">Gruppengröße: {Number(content.groupSize) || 4} · Gruppenarbeit</div>}
    {(slide.type === "mindmap" || slide.type === "brainstorm" || slide.type === "wordcloud") && <div className="slide-content-input-placeholder">Ideen werden hier gesammelt …</div>}
  </div>;
}

export function SlideStage({slide, preview=false, backgroundImage, selectedId, onSelect, onPointerDown, onResizeStart, disableEmbeddedInteraction=false}: {
  slide: PlexiaSlide;
  preview?: boolean;
  /** Keep keyboard focus in a CSS-only presentation fallback so Escape can exit. */
  disableEmbeddedInteraction?: boolean;
  /** Storage path (or already public URL) shared by the entire presentation. */
  backgroundImage?: string;
  selectedId?: string;
  onSelect?: (id: string) => void;
  onPointerDown?: (event: PointerEvent<HTMLDivElement>, element: SlideElement) => void;
  onResizeStart?: (event: PointerEvent<HTMLButtonElement>, element: SlideElement, handle: ResizeHandle) => void;
}) {
  const backgroundUrl = usePresentationMediaUrl(backgroundImage || "");
  // Activity and video content remain visible when decorative elements are added.
  // Existing standard slides with custom text retain their original appearance.
  const showContent = slide.elements.length === 0 || slide.type !== "standard";
  return <div className={`slide-stage ${preview ? "stage-preview" : ""}`} style={{backgroundColor: slide.background || "#fff", backgroundImage: backgroundUrl ? `url(${JSON.stringify(backgroundUrl)})` : undefined, backgroundSize: "cover", backgroundPosition: "center"}}>
    {showContent && <div className="stage-empty"><span className="stage-empty-mark">✦</span><strong>{slide.title||"Deine Folie"}</strong><SlideContentPreview slide={slide} disableEmbeddedInteraction={disableEmbeddedInteraction}/>{!preview && !slide.content.body && ["standard", "video"].includes(slide.type) && <small>Elemente hinzufügen, um deine Idee zum Leben zu erwecken.</small>}</div>}
    {slide.elements.map(element=><StageElement key={element.id} element={element} selected={selectedId===element.id} onSelect={onSelect} onPointerDown={onPointerDown} onResizeStart={onResizeStart} disableEmbeddedInteraction={disableEmbeddedInteraction}/>)}
  </div>;
}
