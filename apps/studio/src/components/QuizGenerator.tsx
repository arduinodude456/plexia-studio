import { useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, Download, LoaderCircle, Sparkles } from "lucide-react";
import { createId, createSlide, groqProxy, hasSupabaseConfig, type Presentation } from "@plexia/shared";
import { exportPresentation } from "../lib/presentations";
import "./QuizGenerator.css";

interface QuizQuestion {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

interface QuizResponse {
  questions: QuizQuestion[];
}

interface QuizGeneratorProps {
  keyConfigured: boolean;
  keyStatusLoading: boolean;
}

function isQuizResponse(value: unknown): value is QuizResponse {
  if (!value || typeof value !== "object" || !Array.isArray((value as QuizResponse).questions)) return false;
  return (value as QuizResponse).questions.every((item) =>
    item && typeof item.question === "string" && item.question.trim().length > 0 &&
    Array.isArray(item.options) && item.options.length >= 2 && item.options.every((option) => typeof option === "string") &&
    Number.isInteger(item.correctIndex) && item.correctIndex >= 0 && item.correctIndex < item.options.length &&
    typeof item.explanation === "string",
  );
}

export function QuizGenerator({ keyConfigured, keyStatusLoading }: QuizGeneratorProps) {
  const [topic, setTopic] = useState("");
  const [count, setCount] = useState(5);
  const [questions, setQuestions] = useState<QuizQuestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanTopic = topic.trim();
    if (!cleanTopic) {
      setError("Bitte gib ein Thema oder Lernziel ein.");
      return;
    }
    setBusy(true);
    setError("");
    setQuestions(null);
    try {
      const response: unknown = await groqProxy<unknown>("generate_quiz", { topic: cleanTopic, count });
      if (!isQuizResponse(response)) throw new Error("Die KI-Antwort hatte nicht das erwartete Quiz-Format. Bitte versuche es erneut.");
      setQuestions(response.questions);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Das Quiz konnte nicht erstellt werden.");
    } finally {
      setBusy(false);
    }
  }

  function downloadPresentation() {
    if (!questions?.length) return;
    const safeSlides = questions.map((item, index) => {
      const slide = createSlide("multiple_choice", `Frage ${index + 1}`);
      slide.title = item.question.trim();
      // Intentionally copy only student-safe fields. Never include correctIndex or explanation.
      slide.content = {
        question: item.question.trim(),
        options: item.options.map((option) => option.trim()),
        allowMultiple: false,
      };
      return slide;
    });
    const presentation: Presentation = {
      id: createId(),
      title: `${topic.trim()} – Quiz`,
      description: `Multiple-Choice-Quiz mit ${safeSlides.length} ${safeSlides.length === 1 ? "Frage" : "Fragen"}.`,
      theme: "light",
      slides: safeSlides,
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    exportPresentation(presentation);
  }

  return (
    <article className="settings-card quiz-generator-card">
      <div className="settings-card-head">
        <div className="settings-symbol quiz-generator-symbol"><Sparkles size={20} /></div>
        <div>
          <h2>Quiz mit KI erstellen</h2>
          <p className="muted">Erzeuge Multiple-Choice-Fragen und exportiere sie als Präsentation.</p>
        </div>
      </div>

      <form className="quiz-generator-form" onSubmit={(event) => void generate(event)}>
        <label className="quiz-field" htmlFor="quiz-topic">
          Thema oder Lernziel
          <textarea
            id="quiz-topic"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            maxLength={1200}
            rows={3}
            placeholder="z. B. Bruchrechnung: Brüche gleichnamig machen und addieren"
            disabled={busy}
          />
        </label>
        <div className="quiz-form-actions">
          <label className="quiz-field quiz-count-field" htmlFor="quiz-count">
            Anzahl Fragen
            <select id="quiz-count" value={count} onChange={(event) => setCount(Number(event.target.value))} disabled={busy}>
              {Array.from({ length: 10 }, (_, index) => index + 1).map((number) => (
                <option key={number} value={number}>{number}</option>
              ))}
            </select>
          </label>
          <button className="button primary" type="submit" disabled={busy || !topic.trim() || !hasSupabaseConfig || !keyConfigured}>
            {busy ? <LoaderCircle className="quiz-spin" size={17} /> : <Sparkles size={16} />}
            {busy ? "Quiz wird erstellt…" : "Quiz erstellen"}
          </button>
        </div>
      </form>

      {!hasSupabaseConfig ? (
        <p className="quiz-generator-hint">Für die Quiz-Erstellung muss zuerst das sichere Supabase-Backend eingerichtet werden.</p>
      ) : keyStatusLoading ? (
        <p className="quiz-generator-hint">Groq-Key-Status wird geprüft…</p>
      ) : !keyConfigured ? (
        <p className="quiz-generator-hint">Speichere zuerst oben deinen Groq API-Key, um Fragen zu erstellen.</p>
      ) : null}

      {error && <p className="notice error quiz-message" role="alert"><AlertCircle size={16} />{error}</p>}

      {questions === null && !busy && !error && (
        <div className="quiz-empty-state">
          <Sparkles size={18} />
          <span>Gib ein Thema ein, um passende Multiple-Choice-Fragen für deinen Unterricht zu erstellen.</span>
        </div>
      )}
      {questions?.length === 0 && !busy && !error && (
        <div className="quiz-empty-state"><AlertCircle size={18} /><span>Die KI hat keine Fragen zurückgegeben. Bitte passe das Thema an und versuche es erneut.</span></div>
      )}

      {questions && questions.length > 0 && !busy && (
        <section className="quiz-results" aria-live="polite">
          <div className="quiz-results-heading">
            <div><h3>Erzeugte Fragen</h3><span>{questions.length} {questions.length === 1 ? "Frage" : "Fragen"} · Lösungen nur für dich sichtbar</span></div>
            <button className="button secondary quiz-download-button" type="button" onClick={downloadPresentation}>
              <Download size={16} /> Präsentation herunterladen
            </button>
          </div>
          {questions.map((item, questionIndex) => (
            <article className="quiz-question-card" key={`${questionIndex}-${item.question}`}>
              <h4><span>{questionIndex + 1}</span>{item.question}</h4>
              <ol className="quiz-options">
                {item.options.map((option, optionIndex) => {
                  const correct = optionIndex === item.correctIndex;
                  return (
                    <li className={correct ? "is-correct" : ""} key={`${optionIndex}-${option}`}>
                      <span className="quiz-option-letter">{String.fromCharCode(65 + optionIndex)}</span>
                      <span>{option}</span>
                      {correct && <span className="quiz-correct-label"><CheckCircle2 size={14} />Richtig</span>}
                    </li>
                  );
                })}
              </ol>
              <p className="quiz-explanation"><strong>Erklärung:</strong> {item.explanation || "Keine zusätzliche Erklärung angegeben."}</p>
            </article>
          ))}
          <p className="quiz-ai-review-note">KI-Inhalte können Fehler enthalten. Bitte prüfe alle Fragen und Lösungen vor dem Unterricht.</p>
        </section>
      )}
    </article>
  );
}
