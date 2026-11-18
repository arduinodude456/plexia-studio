import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Check,
  CirclePause,
  CirclePlay,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  LoaderCircle,
  QrCode,
  Radio,
  ScanText,
  Sparkles,
  Square,
  Users,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
  createClassSession,
  createSignedStudentPhotoUrl,
  groqProxy,
  hasSupabaseConfig,
  listSessionResponses,
  requestAiEvaluation,
  subscribeToSession,
  updateClassSession,
  updateTeacherReview,
  type ClassSession,
  type Presentation,
  type StudentResponse,
} from "@plexia/shared";
import { SlideStage } from "./SlideStage";
import "./LivePanel.css";

interface Props {
  presentation: Presentation;
  onClose: () => void;
}

interface ResponseSummary {
  summary: string;
  themes: string[];
  openQuestions: string[];
}

interface HandwritingReading {
  text: string;
  unclearParts: string[];
  confidence?: number;
}

const MAX_VISIBLE_RESPONSES = 80;
const publicConnectUrl = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env.VITE_CONNECT_URL;

function safeText(value: unknown, maxLength = 4000): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function safeTextList(value: unknown, maxItems = 30): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxItems)
    .map((item) => safeText(item, 500).trim())
    .filter(Boolean);
}

function responseText(response: StudentResponse): string {
  if (response.answerText) return response.answerText;
  try {
    return JSON.stringify(response.answerJson) || "Antwort übermittelt";
  } catch {
    return "Antwort übermittelt";
  }
}

export function LivePanel({ presentation, onClose }: Props) {
  const [session, setSession] = useState<ClassSession | null>(null);
  const [responses, setResponses] = useState<StudentResponse[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState("");
  const [evaluating, setEvaluating] = useState("");
  const [score, setScore] = useState("");
  const [feedback, setFeedback] = useState("");
  const [evaluation, setEvaluation] = useState<{
    score: number;
    maxPoints: number;
    feedback: string;
    criteria: Array<{ name: string; points: number; rationale: string }>;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [connectBase, setConnectBase] = useState(
    () => localStorage.getItem("plexia.connect-url") || publicConnectUrl || (location.hostname === "localhost" ? "http://localhost:3001/" : `${location.origin}/`),
  );

  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState("");
  const [summary, setSummary] = useState<ResponseSummary | null>(null);
  const [signingPhoto, setSigningPhoto] = useState("");
  const [signedPhoto, setSignedPhoto] = useState<{ responseId: string; url: string } | null>(null);
  const [photoError, setPhotoError] = useState("");
  const [readingHandwriting, setReadingHandwriting] = useState("");
  const [handwritingError, setHandwritingError] = useState("");
  const [handwriting, setHandwriting] = useState<{ responseId: string; result: HandwritingReading } | null>(null);

  const update = (response: StudentResponse) =>
    setResponses((prev) => (prev.some((item) => item.id === response.id)
      ? prev.map((item) => (item.id === response.id ? response : item))
      : [...prev, response]));

  useEffect(() => {
    if (!session || !hasSupabaseConfig) return;
    let active = true;
    void listSessionResponses(session.id)
      .then((items) => {
        if (active) setResponses(items);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : "Antworten konnten nicht geladen werden.");
      });
    const channel = subscribeToSession(
      session.id,
      (next) => {
        if (active) setSession(next);
      },
      (response) => {
        if (active) update(response);
      },
    );
    return () => {
      active = false;
      void channel.unsubscribe();
    };
  }, [session?.id]);

  const start = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const created = await createClassSession(presentation);
      setSession(created);
      setNotice("Sitzung gestartet. Teile den Code mit deiner Klasse.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Die Sitzung konnte nicht gestartet werden.");
    } finally {
      setBusy(false);
    }
  }, [presentation]);

  async function patch(p: Partial<Pick<ClassSession, "status" | "currentSlideIndex" | "activityStatus">>) {
    if (!session) return;
    try {
      await updateClassSession(session.id, p);
      setSession({ ...session, ...p });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Die Sitzung konnte nicht aktualisiert werden.");
    }
  }

  async function evaluate(response: StudentResponse) {
    setEvaluating(response.id);
    setError("");
    setEvaluation(null);
    try {
      const slide = presentation.slides.find((item) => item.id === response.slideId);
      const result = await requestAiEvaluation({
        answer: response.answerText || JSON.stringify(response.answerJson),
        question: slide?.content.prompt || slide?.content.question || slide?.title || "Aufgabe",
        criteria: slide?.content.criteria || ["Fachliche Richtigkeit", "Begründung"],
        maxPoints: slide?.content.maxPoints || 4,
      });
      setEvaluation(result.evaluation);
      setScore(String(result.evaluation.score));
      setFeedback(result.evaluation.feedback);
      setSelected(response.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Die KI-Bewertung ist fehlgeschlagen.");
    } finally {
      setEvaluating("");
    }
  }

  async function saveReview() {
    const response = responses.find((item) => item.id === selected);
    if (!response) return;
    try {
      await updateTeacherReview(response.id, Number(score) || 0, feedback);
      update({ ...response, score: Number(score) || 0, feedback, reviewed: true });
      setNotice("Lehrerkorrektur gespeichert.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Korrektur konnte nicht gespeichert werden.");
    }
  }

  async function copyCode() {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(session.joinCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Der Code konnte nicht kopiert werden.");
    }
  }

  const visibleResponses = responses.slice(-MAX_VISIBLE_RESPONSES);
  const currentSelectedResponse = responses.find((item) => item.id === selected);

  async function summarizeResponses() {
    if (visibleResponses.length === 0) return;
    setSummarizing(true);
    setSummaryError("");
    setSummary(null);
    const payload = visibleResponses.map((response, index) => ({
      nickname: safeText(response.nickname, 24).trim() || `Teilnehmer ${index + 1}`,
      answer: safeText(responseText(response), 1200),
    }));
    try {
      const result = await groqProxy<{
        summary?: unknown;
        themes?: unknown;
        openQuestions?: unknown;
      }>("summarize", { responses: payload });
      setSummary({
        summary: safeText(result?.summary, 4000),
        themes: safeTextList(result?.themes),
        openQuestions: safeTextList(result?.openQuestions),
      });
    } catch (e) {
      setSummaryError(e instanceof Error ? e.message : "Die Zusammenfassung ist fehlgeschlagen.");
    } finally {
      setSummarizing(false);
    }
  }

  async function showStudentPhoto(response: StudentResponse) {
    if (!response.mediaPath) return;
    setSigningPhoto(response.id);
    setSignedPhoto(null);
    setHandwriting(null);
    setPhotoError("");
    setHandwritingError("");
    try {
      const url = await createSignedStudentPhotoUrl(response.mediaPath, 300);
      setSignedPhoto({ responseId: response.id, url });
    } catch (e) {
      setPhotoError(e instanceof Error ? e.message : "Das Antwortbild konnte nicht geladen werden.");
    } finally {
      setSigningPhoto("");
    }
  }

  async function readHandwriting(response: StudentResponse, imageUrl: string) {
    setReadingHandwriting(response.id);
    setHandwriting(null);
    setHandwritingError("");
    try {
      const result = await groqProxy<{
        text?: unknown;
        confidence?: unknown;
        unclearParts?: unknown;
      }>("read_handwriting", { imageUrl });
      const confidence = typeof result?.confidence === "number" && Number.isFinite(result.confidence)
        ? Math.max(0, Math.min(1, result.confidence))
        : undefined;
      setHandwriting({
        responseId: response.id,
        result: {
          text: safeText(result?.text),
          unclearParts: safeTextList(result?.unclearParts),
          confidence,
        },
      });
    } catch (e) {
      setHandwritingError(e instanceof Error ? e.message : "Die Handschrift konnte nicht gelesen werden.");
    } finally {
      setReadingHandwriting("");
    }
  }

  const currentIndex = session?.currentSlideIndex ?? 0;
  const current = presentation.slides[currentIndex];
  const joinUrl = (() => {
    try {
      const url = new URL(connectBase, location.origin);
      url.searchParams.set("code", session?.joinCode ?? "");
      return url.toString();
    } catch {
      return `${location.origin}/?code=${session?.joinCode ?? ""}`;
    }
  })();

  return (
    <div className="live-overlay">
      <header className="live-top">
        <button className="live-brand" onClick={onClose}>
          <span className="brand-symbol small">P</span> PLEXIA <span className="brand-light">LIVE</span>
        </button>
        <div className="live-status">
          <i className={session?.status === "live" ? "dot green" : "dot"} />
          {session ? session.status === "live" ? "Sitzung live" : session.status === "paused" ? "Sitzung pausiert" : "Sitzung beendet" : "Nicht gestartet"}
        </div>
        <button className="icon-button live-close" onClick={onClose} aria-label="Live-Ansicht schließen"><X size={20} /></button>
      </header>

      {!hasSupabaseConfig ? (
        <main className="live-unconfigured">
          <div className="live-setup-icon"><Radio size={26} /></div>
          <p className="eyebrow">LIVE-UNTERRICHT</p>
          <h1>Deine Klasse ist nur einen Code entfernt.</h1>
          <p>Für echte Live-Sitzungen brauchst du eine Supabase-Konfiguration. Ohne Backend werden keine Sitzungen, QR-Codes oder Schülerantworten vorgetäuscht.</p>
          <div className="notice warning"><strong>Einrichtung erforderlich</strong><span>Setze <code>VITE_SUPABASE_URL</code> und <code>VITE_SUPABASE_ANON_KEY</code>, melde dich an und konfiguriere die PLEXIA-Datenbank sowie Realtime.</span></div>
          <button className="button secondary" onClick={onClose}>Zurück zum Editor</button>
        </main>
      ) : !session ? (
        <main className="live-launch">
          <div className="live-preview-card">
            <div className="live-preview-top"><span><i className="dot green" /> BEREIT ZUM TEILEN</span><span>{presentation.slides.length} Folien</span></div>
            <div className="live-preview-canvas">{current && <SlideStage slide={current} preview />}</div>
            <h2>{presentation.title}</h2>
            <p>{presentation.description || "Interaktive Präsentation für deine Klasse."}</p>
            <button className="button primary large" onClick={() => void start()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={19} /> : <Radio size={19} />} Live-Sitzung starten</button>
            <small><Users size={14} /> Deine Klasse tritt über QR-Code oder Beitrittscode bei.</small>
          </div>
          <button className="text-button" onClick={onClose}>Abbrechen</button>
        </main>
      ) : (
        <main className="live-content">
          <section className="live-stage-column">
            <div className="live-toolbar">
              <div><span className="live-chip"><i className="dot green" /> LIVE</span><strong>{presentation.title}</strong></div>
              <div className="live-session-controls">
                {session.status !== "ended" && <button className="button secondary small-button" onClick={() => void patch({ status: session.status === "paused" ? "live" : "paused" })}>{session.status === "paused" ? <CirclePlay size={16} /> : <CirclePause size={16} />} {session.status === "paused" ? "Fortsetzen" : "Pausieren"}</button>}
                {session.status !== "ended" && <button className="button danger-button small-button" onClick={() => void patch({ status: "ended", activityStatus: "ended" })}><Square size={14} /> Sitzung beenden</button>}
              </div>
            </div>
            <div className="live-slide-frame">{current && <SlideStage slide={current} preview />}</div>
            <div className="live-slide-nav">
              <button className="button secondary" disabled={currentIndex <= 0} onClick={() => void patch({ currentSlideIndex: currentIndex - 1 })}>← Zurück</button>
              <span>Folie <b>{currentIndex + 1}</b> / {presentation.slides.length}</span>
              <button className="button primary" disabled={currentIndex >= presentation.slides.length - 1} onClick={() => void patch({ currentSlideIndex: currentIndex + 1 })}>Weiter →</button>
            </div>
            <div className="activity-control">
              <div className="activity-title"><Activity size={18} /><div><strong>Interaktion</strong><small>{session.activityStatus === "running" ? "Aktivität läuft" : "Aktivität pausiert oder wartet"}</small></div></div>
              <button className={`button ${session.activityStatus === "running" ? "secondary" : "mint-button"}`} disabled={session.status === "ended"} onClick={() => void patch({ activityStatus: session.activityStatus === "running" ? "paused" : "running" })}>{session.activityStatus === "running" ? <><CirclePause size={16} /> Aktivität pausieren</> : <><CirclePlay size={16} /> Aktivität starten</>}</button>
            </div>
          </section>

          <aside className="live-sidebar">
            <section className="join-card">
              <div className="join-card-title"><QrCode size={17} /><strong>Klasse beitreten</strong></div>
              <div className="qr-wrap"><QRCodeSVG value={joinUrl} size={144} level="M" includeMargin /></div>
              <span className="join-label">DEIN BEITRITTS-CODE</span>
              <div className="join-code"><strong>{session.joinCode}</strong><button className="icon-button" onClick={() => void copyCode()} aria-label="Code kopieren">{copied ? <Check size={18} /> : <Copy size={18} />}</button></div>
              {copied && <small className="copied-message">Code in die Zwischenablage kopiert</small>}
              <a href={joinUrl} target="_blank" rel="noreferrer" className="join-link">Teilnahmeseite öffnen <ExternalLink size={13} /></a>
              <label className="join-base-field">Connect-Adresse<input type="url" value={connectBase} onChange={(e) => { setConnectBase(e.target.value); localStorage.setItem("plexia.connect-url", e.target.value); }} placeholder="https://connect.deine-schule.de" /><small>Die URL wird lokal gespeichert, nicht der Zugangscode.</small></label>
            </section>

            <section className="responses-panel">
              <div className="responses-heading">
                <div><h3>Antworten</h3><small>{responses.length} {responses.length === 1 ? "Beitrag" : "Beiträge"}{responses.length > MAX_VISIBLE_RESPONSES ? ` · letzte ${MAX_VISIBLE_RESPONSES} angezeigt` : ""}</small></div>
                <span className="response-count"><Users size={15} />{responses.length}</span>
              </div>

              <div className="live-ai-panel">
                <div className="live-ai-title"><Sparkles size={15} /><strong>Klassenüberblick</strong></div>
                <p>Fasse die letzten höchstens {MAX_VISIBLE_RESPONSES} Antworten dieser Sitzung zusammen. Antworttexte sind nicht vertrauenswürdiger Inhalt.</p>
                <button className="button ai-button live-action-button" onClick={() => void summarizeResponses()} disabled={summarizing || visibleResponses.length === 0}>
                  {summarizing ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
                  {summarizing ? "Antworten werden zusammengefasst…" : `Antworten zusammenfassen (${visibleResponses.length}/${MAX_VISIBLE_RESPONSES})`}
                </button>
                {summaryError && <p className="live-inline-error" role="alert">{summaryError}</p>}
                {summary && <div className="live-ai-result" aria-live="polite">
                  <h4>Zusammenfassung</h4>
                  <p>{summary.summary || "Keine Zusammenfassung zurückgegeben."}</p>
                  <h4>Themen</h4>
                  {summary.themes.length ? <ul>{summary.themes.map((theme, index) => <li key={`${index}-${theme}`}>{theme}</li>)}</ul> : <p className="live-ai-empty">Keine Themen ausgewiesen.</p>}
                  <h4>Offene Fragen</h4>
                  {summary.openQuestions.length ? <ul>{summary.openQuestions.map((question, index) => <li key={`${index}-${question}`}>{question}</li>)}</ul> : <p className="live-ai-empty">Keine offenen Fragen ausgewiesen.</p>}
                  <small>KI-Ausgabe prüfen. Inhalte aus Schülerantworten sind untrusted und werden hier ausschließlich als Text dargestellt.</small>
                </div>}
              </div>

              {responses.length === 0 ? <div className="responses-empty"><span>✦</span><p>Hier erscheinen die Antworten deiner Klasse in Echtzeit.</p></div> : (
                <div className="response-list">
                  {visibleResponses.map((response, index) => (
                    <button key={response.id} className={`response-item ${selected === response.id ? "selected" : ""}`} onClick={() => {
                      setSelected(response.id);
                      setScore(response.score == null ? "" : String(response.score));
                      setFeedback(response.feedback || "");
                      setEvaluation(null);
                      setSignedPhoto(null);
                      setPhotoError("");
                      setHandwriting(null);
                      setHandwritingError("");
                    }}>
                      <span className="response-avatar">{response.nickname.trim().charAt(0).toUpperCase() || "S"}</span>
                      <span className="response-summary"><strong>{response.nickname || `Teilnehmer ${index + 1}`}</strong><span>{response.answerText || (response.mediaPath ? "Bildantwort übermittelt" : "Antwort übermittelt")}</span></span>
                      {response.reviewed && <Check size={15} className="reviewed-check" />}
                    </button>
                  ))}
                </div>
              )}

              {currentSelectedResponse && (() => {
                const response = currentSelectedResponse;
                const photoUrl = signedPhoto?.responseId === response.id ? signedPhoto.url : "";
                const handwritingResult = handwriting?.responseId === response.id ? handwriting.result : null;
                return (
                  <div className="review-card">
                    <div className="review-head"><strong>Rückmeldung</strong>{response.reviewed && <span className="reviewed-label">Korrigiert</span>}</div>
                    <blockquote>{responseText(response)}</blockquote>
                    {response.mediaPath && <div className="student-photo-panel">
                      <div className="live-ai-title"><ImageIcon size={15} /><strong>Antwortbild</strong></div>
                      <p>Das private Bild wird erst nach Klick über einen kurzlebigen, signierten Link (5 Minuten) geladen.</p>
                      {!photoUrl ? <button className="button secondary live-action-button" onClick={() => void showStudentPhoto(response)} disabled={signingPhoto === response.id}>
                        {signingPhoto === response.id ? <LoaderCircle className="spin" size={15} /> : <ImageIcon size={15} />}
                        {signingPhoto === response.id ? "Sicherer Bildlink wird erstellt…" : "Antwortbild sicher anzeigen"}
                      </button> : <>
                        <img className="student-photo" src={photoUrl} alt="Antwortbild der ausgewählten Schülerantwort" referrerPolicy="no-referrer" onError={() => setPhotoError("Das signierte Bild konnte nicht angezeigt werden. Erstelle bei Bedarf einen neuen Link.")} />
                        <small className="photo-expiry-note">Signierter Bildlink, gültig für 5 Minuten. Der Link wird nicht gespeichert.</small>
                        <button className="button ai-button live-action-button" onClick={() => void readHandwriting(response, photoUrl)} disabled={readingHandwriting === response.id}>
                          {readingHandwriting === response.id ? <LoaderCircle className="spin" size={15} /> : <ScanText size={15} />}
                          {readingHandwriting === response.id ? "Handschrift wird gelesen…" : "Handschrift mit KI lesen"}
                        </button>
                      </>}
                      {photoError && <p className="live-inline-error" role="alert">{photoError}</p>}
                      {handwritingError && <p className="live-inline-error" role="alert">{handwritingError}</p>}
                      {handwritingResult && <div className="handwriting-result" aria-live="polite">
                        <h4>Erkannter Text <span>KI-Vorschlag</span></h4>
                        <p className="handwriting-text">{handwritingResult.text || "Kein Text erkannt."}</p>
                        {handwritingResult.confidence !== undefined && <small>Konfidenz: {Math.round(handwritingResult.confidence * 100)} %</small>}
                        <h4>Unleserliche Stellen</h4>
                        {handwritingResult.unclearParts.length ? <ul>{handwritingResult.unclearParts.map((part, index) => <li key={`${index}-${part}`}>{part}</li>)}</ul> : <p className="live-ai-empty">Keine unleserlichen Stellen ausgewiesen.</p>}
                        <small>OCR ist nur ein Vorschlag. Bitte prüfen und manuell übernehmen; es wird keine Note oder Rückmeldung automatisch gespeichert.</small>
                      </div>}
                    </div>}
                    {evaluation && <div className="ai-evaluation"><div className="ai-score">KI-Vorschlag <strong>{evaluation.score}/{evaluation.maxPoints}</strong></div><p>{evaluation.feedback}</p><ul>{evaluation.criteria.map((criterion) => <li key={criterion.name}><b>{criterion.name}</b> · {criterion.points} Pkt. — {criterion.rationale}</li>)}</ul><small>KI-Vorschlag bitte prüfen und anpassen.</small></div>}
                    <button className="button ai-button" onClick={() => void evaluate(response)} disabled={evaluating === response.id}>{evaluating === response.id ? <LoaderCircle className="spin" size={15} /> : <Activity size={15} />} KI-Bewertung anfordern</button>
                    <label className="review-field">Lehrer-Korrektur<div className="score-input"><input type="number" min="0" max={presentation.slides.find((item) => item.id === response.slideId)?.content.maxPoints || 100} value={score} onChange={(e) => setScore(e.target.value)} placeholder="Punkte" /><span>Punkte</span></div><textarea rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Individuelle Rückmeldung…" /></label>
                    <button className="button primary full" onClick={() => void saveReview()}>Korrektur speichern</button>
                  </div>
                );
              })()}
            </section>
          </aside>
        </main>
      )}

      {error && <div className="live-toast error">{error}<button onClick={() => setError("")}><X size={14} /></button></div>}
      {notice && <div className="live-toast success">{notice}<button onClick={() => setNotice("")}><X size={14} /></button></div>}
    </div>
  );
}
