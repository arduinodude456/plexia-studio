import { useEffect, useState, type FormEvent } from "react";
import { Check, KeyRound, LockKeyhole, RefreshCw, ShieldCheck } from "lucide-react";
import { getGroqKeyStatus, hasSupabaseConfig, saveGroqKey } from "@plexia/shared";
import { QuizGenerator } from "./QuizGenerator";

export function Settings() {
  const [key, setKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [updatedAt, setUpdatedAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const status = await getGroqKeyStatus();
      setConfigured(status.configured);
      setUpdatedAt(status.updatedAt ?? "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Der Schlüsselstatus konnte nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (hasSupabaseConfig) void refresh();
    else setLoading(false);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedKey = key;
    setKey("");
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await saveGroqKey(submittedKey);
      setSuccess("Dein Groq-Key wurde sicher gespeichert.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Speichern fehlgeschlagen.");
    } finally {
      setKey("");
      setBusy(false);
    }
  }

  return (
    <section className="settings-page">
      <div className="page-heading">
        <p className="eyebrow">PERSÖNLICH &amp; SICHER</p>
        <h1>Einstellungen</h1>
        <p className="muted">Verbinde KI-Funktionen über eine geschützte Backend-Verbindung.</p>
      </div>
      <article className="settings-card">
        <div className="settings-card-head">
          <div className="settings-symbol"><KeyRound size={20} /></div>
          <div>
            <h2>Groq API-Key</h2>
            <p className="muted">Für KI-gestützte Rückmeldungen zu offenen Antworten und die Quiz-Erstellung.</p>
          </div>
          <span className={`status-pill ${configured ? "is-ready" : ""}`}>
            <i /> {loading ? "Prüfe Status…" : configured ? "Verbunden" : "Nicht eingerichtet"}
          </span>
        </div>
        {!hasSupabaseConfig ? (
          <div className="notice warning">
            <LockKeyhole size={17} />
            <div>
              <strong>Sicheres Backend noch nicht konfiguriert</strong>
              <p>Trage <code>VITE_SUPABASE_URL</code> und <code>VITE_SUPABASE_ANON_KEY</code> in die Studio-Umgebung ein und richte die Supabase Edge Function <code>groq-proxy</code> ein. Der Key wird nicht lokal gespeichert.</p>
            </div>
          </div>
        ) : <>
          <div className="security-note">
            <ShieldCheck size={17} />
            <span>Dein persönlicher Key wird ausschließlich über HTTPS an das geschützte Backend gesendet und dort verwahrt. Er erscheint weder in der lokalen Speicherung noch in Protokollen.</span>
          </div>
          <form onSubmit={(event) => void submit(event)} className="key-form">
            <label htmlFor="groq-key">Groq API-Key</label>
            <div className="key-input-row">
              <input
                id="groq-key"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder={configured ? "Neuen Key eingeben, um ihn zu ersetzen" : "gsk_…"}
              />
              <button className="button primary" disabled={busy || !key.trim()}>
                {busy ? "Wird gespeichert…" : configured ? "Key aktualisieren" : "Sicher speichern"}
              </button>
            </div>
            <small>Das Passwortfeld wird nach dem Absenden geleert. Der Key wird nicht lokal gespeichert oder protokolliert.</small>
          </form>
          <button className="text-button refresh-status" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={14} /> Status aktualisieren
          </button>
          {configured && updatedAt && <p className="key-last-updated"><Check size={14} /> Zuletzt aktualisiert am {new Date(updatedAt).toLocaleString("de-DE")}</p>}
        </>}
        {error && <p className="notice error">{error}</p>}
        {success && <p className="notice success">{success}</p>}
      </article>
      <QuizGenerator keyConfigured={configured} keyStatusLoading={loading} />
      <p className="settings-footnote">PLEXIA fragt deinen persönlichen Schlüssel nicht direkt im Browser ab. KI-generierte Inhalte und Lösungshinweise müssen vor dem Unterricht von der Lehrkraft geprüft werden.</p>
    </section>
  );
}
