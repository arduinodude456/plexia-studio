import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Check,
  CirclePause,
  CirclePlay,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  LoaderCircle,
  Maximize2,
  Minimize2,
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
  listGroupAssignments,
  listSessionResponses,
  requestAiEvaluation,
  savePresentation,
  saveGroupAssignments,
  subscribeToSession,
  supabase,
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

interface PrivateQuizKey { slideId: string; correctIndex: number; explanation: string }
interface LiveParticipant { userId: string; nickname: string; joinedAt: string }
interface SharedSlideResult { slideId: string; title: string; responseCount: number; options?: Array<{ label: string; count: number }> }

const MAX_VISIBLE_RESPONSES = 80;
const publicConnectUrl = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env.VITE_CONNECT_URL;

function safeText(value: unknown, maxLength = 4000): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function stripPrivateAnswerFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPrivateAnswerFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !["correctIndex", "correct_index", "answerKey", "answer_key", "explanation"].includes(key))
    .map(([key, child]) => [key, stripPrivateAnswerFields(child)]));
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

function choicesFor(response: StudentResponse): string[] {
  const choices = response.answerJson?.choices;
  if (Array.isArray(choices)) return choices.filter((value): value is string => typeof value === "string");
  return response.answerText.split(",").map((value) => value.trim()).filter(Boolean);
}

function ideasFor(response: StudentResponse): string[] {
  const ideas = response.answerJson?.ideas;
  const source = Array.isArray(ideas) ? ideas : response.answerText.split(/[\n,]+/);
  return source.filter((value): value is string => typeof value === "string").map((value) => value.trim().slice(0, 180)).filter(Boolean);
}

function wordFrequencies(responses: StudentResponse[]): Array<{ word: string; count: number }> {
  const stop = new Set("aber alle als also am an andere auch auf aus bei beim bin bis bist da dadurch daher damit dann das dass dein deine dem den der des die dies doch dort du durch ein eine einem einen einer eines er es etwas für gegen gewesen hat hatte haben hier hinter ich im in ist ja jede jeder jedes kann kein keine mit nach nicht noch nun oder sein seine sich sie sind so über um und uns unter vom von vor war waren was weg weil weiter welche wenn werde werden wie wieder wir wo zu zum zur".split(" "));
  const counts = new Map<string, number>();
  for (const response of responses) for (const idea of ideasFor(response)) {
    for (const word of idea.toLocaleLowerCase("de").normalize("NFKC").match(/[\p{L}\p{N}-]{3,}/gu) ?? []) {
      if (!stop.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts].map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count || a.word.localeCompare(b.word, "de")).slice(0, 40);
}

function mergeResponseLists(existing: StudentResponse[], incoming: StudentResponse[]): StudentResponse[] {
  const merged = new Map(existing.map((response) => [response.id, response]));
  for (const response of incoming) merged.set(response.id, response);
  return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function mergeParticipantLists(existing: LiveParticipant[], incoming: LiveParticipant[]): LiveParticipant[] {
  const merged = new Map(existing.map((participant) => [participant.userId, participant]));
  for (const participant of incoming) merged.set(participant.userId, participant);
  return [...merged.values()].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

function buildGroupAssignment(sessionId: string, slideId: string, participants: LiveParticipant[], groupSize: number): Record<string, number> {
  const numberOfGroups = Math.max(1, Math.ceil(participants.length / groupSize));
  const shuffled = [...participants].sort((a, b) => stableHash(`${sessionId}:${slideId}:${a.userId}`) - stableHash(`${sessionId}:${slideId}:${b.userId}`));
  return Object.fromEntries(shuffled.map((participant, index) => [participant.userId, (index % numberOfGroups) + 1]));
}

export function LivePanel({ presentation, onClose }: Props) {
  const [session, setSession] = useState<ClassSession | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState("CONNECTING");
  const [responses, setResponses] = useState<StudentResponse[]>([]);
  const [dataSyncError, setDataSyncError] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [updatingSession, setUpdatingSession] = useState(false);
  const sessionUpdateLock = useRef(false);
  const [ending, setEnding] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
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
  const [privateQuizKeys, setPrivateQuizKeys] = useState<PrivateQuizKey[]>([]);
  const [quizKeyNotice, setQuizKeyNotice] = useState("");
  const [participants, setParticipants] = useState<LiveParticipant[]>([]);
  const [groupSize, setGroupSize] = useState(4);
  const [groupAssignments, setGroupAssignments] = useState<Record<string, Record<string, number>>>({});
  const [groupsForSlide, setGroupsForSlide] = useState("");
  const [sharingResults, setSharingResults] = useState(false);
  const [shareNotice, setShareNotice] = useState("");

  const update = (response: StudentResponse) =>
    setResponses((prev) => (prev.some((item) => item.id === response.id)
      ? prev.map((item) => (item.id === response.id ? response : item))
      : [...prev, response]));

  useEffect(() => {
    if (!session || !hasSupabaseConfig) return;
    let active = true;
    let snapshotInFlight = false;

    const refreshSnapshot = async () => {
      if (!supabase || snapshotInFlight) return;
      snapshotInFlight = true;
      try {
        const [participantsResult, responsesResult] = await Promise.allSettled([
          supabase.from("session_participants")
            .select("user_id,nickname,joined_at")
            .eq("session_id", session.id)
            .order("joined_at", { ascending: true }),
          listSessionResponses(session.id),
        ]);
        if (!active) return;

        const syncErrors: string[] = [];
        if (participantsResult.status === "fulfilled" && !participantsResult.value.error) {
          const participantsFromServer = (participantsResult.value.data ?? []).map((row) => ({
            userId: String(row.user_id),
            nickname: String(row.nickname || "Teilnehmer"),
            joinedAt: String(row.joined_at || ""),
          }));
          setParticipants((previous) => mergeParticipantLists(previous, participantsFromServer));
        } else {
          syncErrors.push("Teilnehmendenliste");
        }

        if (responsesResult.status === "fulfilled") {
          setResponses((previous) => mergeResponseLists(previous, responsesResult.value));
        } else {
          syncErrors.push("Antworten");
        }

        setDataSyncError(syncErrors.length ? `${syncErrors.join(" und ")} konnten nicht abgeglichen werden.` : "");
        if (!syncErrors.length) setLastSyncedAt(Date.now());
      } finally {
        snapshotInFlight = false;
      }
    };

    setRealtimeStatus("CONNECTING");
    void refreshSnapshot();
    const pollTimer = session.status === "ended"
      ? undefined
      : window.setInterval(() => void refreshSnapshot(), 3500);

    void listGroupAssignments(session.id).then((items) => {
      if (!active) return;
      const next: Record<string, Record<string, number>> = {};
      for (const item of items) (next[item.slideId] ??= {})[item.userId] = item.groupNumber;
      setGroupAssignments(next);
    }).catch((e: unknown) => {
      if (active) setError(e instanceof Error ? e.message : "Gruppenzuteilungen konnten nicht geladen werden.");
    });
    if (supabase) {
      void supabase.from("teacher_quiz_keys").select("slide_id,correct_index,explanation")
        .eq("presentation_id", session.presentationId)
        .then(({ data, error: keyError }) => {
          if (!active) return;
          if (keyError) {
            setQuizKeyNotice("Private Quiz-Schlüssel nicht verfügbar. Wende die neue Lehrer-Schlüssel-Migration an und prüfe die Lehrkraft-RLS.");
            return;
          }
          setPrivateQuizKeys((data ?? []).map((row) => ({
            slideId: String(row.slide_id), correctIndex: Number(row.correct_index), explanation: String(row.explanation ?? ""),
          })).filter((row) => Number.isInteger(row.correctIndex) && row.correctIndex >= 0));
          setQuizKeyNotice("");
        });
    }
    const channel = subscribeToSession(
      session.id,
      (next) => {
        if (active) setSession(next);
      },
      (response) => {
        if (active) {
          update(response);
          void refreshSnapshot();
        }
      },
      (status) => {
        if (!active) return;
        setRealtimeStatus(status);
        if (status === "SUBSCRIBED") void refreshSnapshot();
      },
    );
    return () => {
      active = false;
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      void channel.unsubscribe();
    };
  }, [session?.id, session?.presentationId, session?.status]);

  const start = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const studentSafePresentation = stripPrivateAnswerFields(presentation) as Presentation;
      const created = await createClassSession(studentSafePresentation);
      setSession(created);
      setNotice("Sitzung gestartet. Teile den Code mit deiner Klasse.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Die Sitzung konnte nicht gestartet werden.");
    } finally {
      setBusy(false);
    }
  }, [presentation]);

  async function patch(p: Partial<Pick<ClassSession, "status" | "currentSlideIndex" | "activityStatus">>) {
    if (!session || sessionUpdateLock.current || ending) return;
    sessionUpdateLock.current = true;
    setUpdatingSession(true);
    setError("");
    try {
      const updated = await updateClassSession(session.id, p);
      setSession(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Die Sitzung konnte nicht aktualisiert werden.");
    } finally {
      sessionUpdateLock.current = false;
      setUpdatingSession(false);
    }
  }

  async function endSession() {
    if (!session || session.status === "ended" || ending || sessionUpdateLock.current) return;
    if (!window.confirm("Sitzung jetzt wirklich beenden? Teilnehmende können danach keine Antworten mehr senden.")) return;
    setEnding(true);
    setError("");
    try {
      const updated = await updateClassSession(session.id, { status: "ended", activityStatus: "ended" });
      setSession(updated);
      setNotice("Die Live-Sitzung wurde beendet.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Die Sitzung konnte nicht beendet werden.");
    } finally {
      setEnding(false);
    }
  }

  function closeLive() {
    if (session && session.status !== "ended" && !window.confirm("Deine Klasse bleibt in der laufenden Sitzung, wenn du zum Editor zurückkehrst. Wirklich verlassen?")) return;
    onClose();
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else throw new Error("Der Vollbildmodus wird von diesem Browser nicht unterstützt.");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Vollbild konnte nicht aktiviert werden.");
    }
  }

  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

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

  const currentIndex = session?.currentSlideIndex ?? 0;
  const current = presentation.slides[currentIndex];
  const visibleResponses = responses.slice(-MAX_VISIBLE_RESPONSES);
  const currentSelectedResponse = responses.find((item) => item.id === selected);
  const currentSlideResponses = current ? responses.filter((response) => response.slideId === current.id) : [];
  const currentSlideIsInteractive = Boolean(current && ["multiple_choice", "poll", "free_text", "worksheet", "photo_task", "group_work", "mindmap", "brainstorm", "wordcloud"].includes(current.type));
  const currentQuizKey = current ? privateQuizKeys.find((item) => item.slideId === current.id) : undefined;
  const currentOptions = Array.isArray(current?.content.options) ? current.content.options.filter((item): item is string => typeof item === "string") : [];
  const optionCounts = currentOptions.map((label, index) => ({
    label,
    count: currentSlideResponses.filter((response) => choicesFor(response).includes(label)).length,
    correct: currentQuizKey?.correctIndex === index,
  }));
  const ideasByResponse = currentSlideResponses.flatMap((response) => ideasFor(response).map((idea) => ({ idea, nickname: safeText(response.nickname, 24).trim() || "Teilnehmer" })));
  const frequencyWords = wordFrequencies(currentSlideResponses);
  const assignment = current ? groupAssignments[current.id] : undefined;
  const assignedGroups = assignment ? [...new Set(Object.values(assignment))].sort((a, b) => a - b) : [];
  const realtimeDisconnected = ["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(realtimeStatus);

  useEffect(() => {
    if (!session || session.status === "ended") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "ArrowLeft" && currentIndex > 0) {
        event.preventDefault();
        void patch({ currentSlideIndex: currentIndex - 1 });
      } else if (event.key === "ArrowRight" && currentIndex < presentation.slides.length - 1) {
        event.preventDefault();
        void patch({ currentSlideIndex: currentIndex + 1 });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [session?.id, session?.status, currentIndex, presentation.slides.length]);

  async function assignGroups() {
    if (!session || !current || !supabase) return;
    const size = Math.max(2, Math.min(12, Math.trunc(groupSize) || 4));
    setGroupSize(size);
    const { data, error: rosterError } = await supabase.from("session_participants")
      .select("user_id,nickname,joined_at").eq("session_id", session.id).order("joined_at", { ascending: true });
    if (rosterError) {
      setError(rosterError.message || "Die Teilnehmerliste konnte nicht aktualisiert werden.");
      return;
    }
    const roster = (data ?? []).map((row) => ({ userId: String(row.user_id), nickname: String(row.nickname || "Teilnehmer"), joinedAt: String(row.joined_at || "") }));
    setParticipants(roster);
    const nextAssignment = buildGroupAssignment(session.id, current.id, roster, size);
    try {
      await saveGroupAssignments(session.id, current.id, nextAssignment);
      setGroupAssignments((previous) => ({ ...previous, [current.id]: nextAssignment }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Die Gruppenzuteilung konnte nicht gespeichert werden.");
      return;
    }
    setGroupsForSlide(current.id);
  }

  async function shareAggregatedResults() {
    const resultsSlide = current?.type === "results" ? current : presentation.slides.find((slide) => slide.type === "results");
    if (!resultsSlide) {
      setShareNotice("Füge der Präsentation zuerst eine Ergebnisse-Folie hinzu.");
      return;
    }
    setSharingResults(true);
    setShareNotice("");
    try {
      const safeResults: SharedSlideResult[] = presentation.slides
        .filter((slide) => ["multiple_choice", "poll", "mindmap", "brainstorm", "wordcloud", "group_work", "free_text", "worksheet", "photo_task"].includes(slide.type))
        .map((slide) => {
          const slideResponses = responses.filter((response) => response.slideId === slide.id);
          if (slide.type === "multiple_choice" || slide.type === "poll") {
            const options = Array.isArray(slide.content.options) ? slide.content.options.filter((option): option is string => typeof option === "string") : [];
            return { slideId: slide.id, title: safeText(slide.title, 160), responseCount: slideResponses.length, options: options.map((label) => ({ label: safeText(label, 200), count: slideResponses.filter((response) => choicesFor(response).includes(label)).length })) };
          }
          return { slideId: slide.id, title: safeText(slide.title, 160), responseCount: slideResponses.length };
        });
      const safePresentation = stripPrivateAnswerFields({
        ...presentation,
        slides: presentation.slides.map((slide) => slide.id === resultsSlide.id
          ? { ...slide, content: { ...slide.content, sharedResults: safeResults } }
          : slide),
        updatedAt: new Date().toISOString(),
      }) as Presentation;
      await savePresentation(safePresentation);
      setShareNotice("Aggregierte, lösungsschlüsselfreie Resultate wurden in der Ergebnisse-Folie gespeichert und mit verbundenen Connect-Geräten synchronisiert.");
    } catch (e) {
      setShareNotice(e instanceof Error ? e.message : "Die aggregierten Resultate konnten nicht geteilt werden.");
    } finally {
      setSharingResults(false);
    }
  }

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
        <button className="live-brand" onClick={closeLive}>
          <span className="brand-symbol small">P</span> PLEXIA <span className="brand-light">LIVE</span>
        </button>
        <div className="live-status">
          <i className={session?.status === "live" ? "dot green" : "dot"} />
          {session ? session.status === "live" ? "Sitzung live" : session.status === "paused" ? "Sitzung pausiert" : "Sitzung beendet" : "Nicht gestartet"}
        </div>
        {session && <div className={`live-realtime ${realtimeStatus === "SUBSCRIBED" ? "connected" : realtimeDisconnected ? "disconnected" : ""}`} title={realtimeDisconnected ? "Live-Push pausiert; Teilnehmende und Antworten werden zusätzlich regelmäßig abgeglichen." : undefined}><i />{realtimeStatus === "SUBSCRIBED" ? "Live-Push verbunden" : realtimeDisconnected ? "Auto-Sync aktiv" : "Verbinde…"}</div>}
        {session && <button className="icon-button live-fullscreen" onClick={() => void toggleFullscreen()} aria-label={isFullscreen ? "Vollbild verlassen" : "Vollbild"} title={isFullscreen ? "Vollbild verlassen" : "Vollbild"}>{isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>}
        <button className="icon-button live-close" onClick={closeLive} aria-label="Live-Ansicht schließen"><X size={20} /></button>
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
          <button className="text-button" onClick={closeLive}>Abbrechen</button>
        </main>
      ) : (
        <main className="live-content">
          <section className="live-stage-column">
            <div className="live-toolbar">
              <div className="live-heading"><span className={`live-chip ${session.status}`}><i className="dot" /> {session.status === "live" ? "LIVE" : session.status === "paused" ? "PAUSIERT" : "BEENDET"}</span><strong>{presentation.title}</strong><span className="live-audience"><Users size={15} /> {participants.length} beigetreten · {currentSlideResponses.length} Antworten</span></div>
              <div className="live-session-controls">
                {session.status !== "ended" && <button className="button secondary small-button" onClick={() => void patch({ status: session.status === "paused" ? "live" : "paused" })} disabled={updatingSession || ending}>{session.status === "paused" ? <CirclePlay size={16} /> : <CirclePause size={16} />} {session.status === "paused" ? "Fortsetzen" : "Pausieren"}</button>}
                {session.status !== "ended" && <button className="button danger-button small-button" onClick={() => void endSession()} disabled={ending || updatingSession}>{ending ? <LoaderCircle className="spin" size={14} /> : <Square size={14} />} {ending ? "Wird beendet…" : "Sitzung beenden"}</button>}
              </div>
            </div>
            <div className="live-slide-frame">{current && <SlideStage slide={current} preview />}</div>
            <div className="live-slide-nav">
              <button className="button secondary" disabled={currentIndex <= 0 || session.status === "ended" || updatingSession} onClick={() => void patch({ currentSlideIndex: currentIndex - 1 })}>← Zurück</button>
              <span>Folie <b>{currentIndex + 1}</b> / {presentation.slides.length}</span>
              <button className="button primary" disabled={currentIndex >= presentation.slides.length - 1 || session.status === "ended" || updatingSession} onClick={() => void patch({ currentSlideIndex: currentIndex + 1 })}>Weiter →</button>
            </div>
            <div className="activity-control">
              <div className="activity-title"><Activity size={18} /><div><strong>Interaktion</strong><small>{session.activityStatus === "running" ? "Aktivität läuft" : "Aktivität pausiert oder wartet"}</small></div></div>
              <button className={`button ${session.activityStatus === "running" ? "secondary" : "mint-button"}`} disabled={session.status === "ended" || updatingSession || ending} onClick={() => void patch({ activityStatus: session.activityStatus === "running" ? "paused" : "running" })}>{session.activityStatus === "running" ? <><CirclePause size={16} /> Aktivität pausieren</> : <><CirclePlay size={16} /> Aktivität starten</>}</button>
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
                <div><h3>Antworten & Beiträge</h3><small>{currentSlideResponses.length} auf dieser Folie · {responses.length} insgesamt</small></div>
                <div className="live-response-meta">
                  <span className={`live-sync-pill ${dataSyncError ? "error" : ""}`} title={dataSyncError || (lastSyncedAt ? `Letzter Abgleich ${new Date(lastSyncedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "Datenabgleich läuft") }><i />{dataSyncError ? "Sync prüfen" : lastSyncedAt ? "Auto-Sync" : "Verbinde…"}</span>
                  <span className="response-count"><Users size={15} />{currentSlideResponses.length}</span>
                </div>
              </div>

              <section className="live-roster" aria-label="Teilnehmendenliste">
                <div className="live-roster-heading"><strong>Deine Klasse</strong><span>{participants.length} beigetreten</span></div>
                {!participants.length ? <div className="live-roster-empty"><Users size={17} /><span>Noch niemand beigetreten. Die Liste aktualisiert sich automatisch.</span></div> : (
                  <ul className="live-roster-list">
                    {participants.map((participant, index) => {
                      const hasAnswered = currentSlideResponses.some((response) => response.participantId === participant.userId);
                      const nickname = safeText(participant.nickname, 24).trim() || `Teilnehmer ${index + 1}`;
                      const joined = new Date(participant.joinedAt);
                      const joinedText = Number.isNaN(joined.getTime()) ? "" : `seit ${joined.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`;
                      return <li key={participant.userId} className="live-roster-person">
                        <span className={`roster-avatar avatar-${index % 6}`}>{nickname.charAt(0).toLocaleUpperCase("de-DE")}</span>
                        <span className="roster-person-name"><strong>{nickname}</strong><small>{joinedText || "Teilnahme bestätigt"}</small></span>
                        <span className={`roster-answer ${hasAnswered ? "answered" : currentSlideIsInteractive ? "waiting" : "joined"}`}>
                          {hasAnswered ? <><Check size={13} /> Antwort da</> : currentSlideIsInteractive ? "Noch offen" : "Dabei"}
                        </span>
                      </li>;
                    })}
                  </ul>
                )}
                <small className="live-roster-note">Zeigt Beitritte zur Sitzung; die Antwortmarkierung bezieht sich auf die aktuelle Folie.</small>
              </section>

              {current && (current.type === "multiple_choice" || current.type === "poll") && <section className="live-ai-panel" aria-live="polite">
                <div className="live-ai-title"><Activity size={15} /><strong>{current.type === "multiple_choice" ? "Live-Quiz-Auswertung" : "Live-Umfrage"}</strong></div>
                <p>{currentSlideResponses.length} Antworten zu „{current.title}“. Nur für die Lehrkraft sichtbar.</p>
                {optionCounts.length ? optionCounts.map((option) => <div key={option.label} style={{ margin: "9px 0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
                    <strong>{option.label}{option.correct ? " · richtig (Lehrkraft)" : ""}</strong><span>{option.count} · {currentSlideResponses.length ? Math.round(option.count / currentSlideResponses.length * 100) : 0}%</span>
                  </div>
                  <div style={{ height: 8, borderRadius: 8, background: "var(--line)", overflow: "hidden", marginTop: 4 }}>
                    <div style={{ height: "100%", width: `${currentSlideResponses.length ? option.count / currentSlideResponses.length * 100 : 0}%`, background: option.correct ? "#37ad8a" : "#7d6de2", transition: "width .25s ease" }} />
                  </div>
                </div>) : <p>Für diese Folie sind keine Auswahloptionen hinterlegt.</p>}
                {current.type === "multiple_choice" && currentQuizKey
                  ? <p><strong>Auswertung:</strong> {currentSlideResponses.filter((response) => choicesFor(response).includes(currentOptions[currentQuizKey.correctIndex] ?? "")).length} von {currentSlideResponses.length} richtig.{currentQuizKey.explanation && <> <strong>Erklärung:</strong> {currentQuizKey.explanation}</>}</p>
                  : current.type === "multiple_choice" && <p className="live-ai-empty">Kein privater Lösungsschlüssel verfügbar; die Verteilung wird ohne Richtig/Falsch-Auswertung angezeigt.{quizKeyNotice && <> {quizKeyNotice}</>}</p>}
              </section>}

              {current && ["mindmap", "brainstorm", "wordcloud"].includes(current.type) && <section className="live-ai-panel" aria-live="polite">
                <div className="live-ai-title"><Sparkles size={15} /><strong>{current.type === "mindmap" ? "Gemeinsame Mindmap" : current.type === "wordcloud" ? "Live-Wortwolke" : "Ideen aus der Klasse"}</strong></div>
                <p>{currentSlideResponses.length} Teilnehmende · {ideasByResponse.length} Ideen — aktualisiert sich mit Antworten.</p>
                {current.type === "wordcloud"
                  ? frequencyWords.length ? <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flexWrap: "wrap", gap: 9, minHeight: 115, padding: 12, borderRadius: 10, background: "var(--surface)" }}>{frequencyWords.map(({ word, count }) => <span key={word} title={`${count}× genannt`} style={{ color: count > 1 ? "#6655c8" : "var(--ink)", fontWeight: 700, fontSize: `${Math.min(28, 12 + count * 4)}px`, padding: "3px 7px" }}>{word}<small style={{ fontSize: 10, marginLeft: 3 }}>×{count}</small></span>)}</div> : <p className="live-ai-empty">Noch keine verwertbaren Wörter.</p>
                  : current.type === "mindmap" ? <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flexWrap: "wrap", gap: 8, minHeight: 110, padding: 12, borderRadius: 10, background: "var(--surface)" }}><strong style={{ borderRadius: 24, padding: "10px 14px", background: "#ece9ff", color: "#4c3eb0" }}>{safeText(current.content.prompt || current.title, 150)}</strong>{ideasByResponse.map(({ idea, nickname }, index) => <span key={`${index}-${idea}`} title={nickname} style={{ borderRadius: 20, padding: "7px 11px", background: index % 2 ? "#e3f7f2" : "#e7f4fb", color: "#30445f", fontSize: 12 }}>{idea}</span>)}</div>
                  : ideasByResponse.length ? <ol style={{ paddingLeft: 24 }}>{ideasByResponse.map(({ idea, nickname }, index) => <li key={`${index}-${idea}`} style={{ margin: "7px 0", overflowWrap: "anywhere" }}><span>{idea}</span><small style={{ display: "block", color: "var(--muted)" }}>{nickname}</small></li>)}</ol> : <p className="live-ai-empty">Noch keine Ideen eingegangen.</p>}
              </section>}

              {current?.type === "group_work" && <section className="live-ai-panel">
                <div className="live-ai-title"><Users size={15} /><strong>Gruppen zuteilen</strong></div>
                <p>{participants.length} pseudonyme Teilnehmende in dieser Sitzung. Zuteilung ist ausgewogen und bleibt fest, bis du sie erneut ausführst.</p>
                <label className="review-field">Zielgröße je Gruppe <select value={groupSize} onChange={(event) => setGroupSize(Number(event.target.value))} style={{ display: "block", width: "100%", padding: 8, borderRadius: 7, border: "1px solid var(--line)", background: "var(--surface)", color: "var(--ink)" }}>{Array.from({ length: 11 }, (_, index) => index + 2).map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
                <button className="button secondary live-action-button" onClick={assignGroups} disabled={participants.length === 0}><Users size={15} />{groupsForSlide === current.id ? "Gruppen neu zuteilen" : "Teilnehmende zufällig zuteilen"}</button>
                {participants.length === 0 && <p className="live-ai-empty">Noch keine angemeldeten Teilnehmenden gefunden.</p>}
                {assignment && groupsForSlide === current.id && assignedGroups.map((group) => <div key={group} style={{ marginTop: 10, padding: 10, borderRadius: 8, background: "var(--surface)" }}><strong>Gruppe {group}</strong><ul style={{ marginBottom: 0 }}>{participants.filter((participant) => assignment[participant.userId] === group).map((participant, index) => <li key={participant.userId}>{safeText(participant.nickname, 24) || `Teilnehmer ${index + 1}`}</li>)}</ul></div>)}
              </section>}

              {current?.type === "results" && <section className="live-ai-panel" aria-live="polite">
                <div className="live-ai-title"><Activity size={15} /><strong>Resultate dieser Stunde</strong></div>
                <p>Live-Zusammenfassung eingegangener Antworten aus der gesamten Präsentation. Lösungsschlüssel bleiben privat.</p>
                {presentation.slides.filter((slide) => ["multiple_choice", "poll", "mindmap", "brainstorm", "wordcloud", "group_work", "free_text", "worksheet", "photo_task"].includes(slide.type)).map((slide) => {
                  const slideResponses = responses.filter((response) => response.slideId === slide.id);
                  const options = Array.isArray(slide.content.options) ? slide.content.options.filter((value): value is string => typeof value === "string") : [];
                  return <div key={slide.id} style={{ margin: "10px 0", padding: 10, borderRadius: 8, background: "var(--surface)" }}><strong>{safeText(slide.title, 160)}</strong><div>{slideResponses.length} Antworten</div>{options.length > 0 && <ul>{options.map((option) => <li key={option}>{option}: {slideResponses.filter((response) => choicesFor(response).includes(option)).length}</li>)}</ul>}</div>;
                })}
                {shareNotice && <p role="status">{shareNotice}</p>}
                <button className="button primary live-action-button" onClick={() => void shareAggregatedResults()} disabled={sharingResults || responses.length === 0}>{sharingResults ? <LoaderCircle className="spin" size={15} /> : <ExternalLink size={15} />}{sharingResults ? "Aggregat wird geteilt…" : "Aggregierte Resultate explizit teilen"}</button>
                <small>Geteilt werden ausschließlich schlüsselfreie Aggregate. Connect zeigt nur freigegebene Zahlen, keine Namen oder individuellen Antworten.</small>
              </section>}

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
