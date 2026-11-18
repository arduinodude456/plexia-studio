import { useState, type FormEvent } from "react";
import { ArrowRight, LockKeyhole, Sparkles } from "lucide-react";
import { signInTeacher, signUpTeacher } from "@plexia/shared";

export function AuthGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [isSignup, setIsSignup] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      if (isSignup) {
        const result = await signUpTeacher(email, password);
        if (!result.user) throw new Error("Das Konto konnte nicht erstellt werden.");
        if (!result.session) { setMessage("Konto erstellt. Bitte bestätige deine E-Mail und melde dich danach an."); setIsSignup(false); }
        else onAuthenticated();
      } else { await signInTeacher(email, password); onAuthenticated(); }
    } catch (err) { setError(err instanceof Error ? err.message : "Anmeldung fehlgeschlagen."); }
    finally { setBusy(false); }
  }

  return <main className="auth-screen"><div className="auth-card"><div className="brand-mark"><span className="brand-symbol">P</span><span>PLEXIA<span className="brand-light"> STUDIO</span></span></div>
    <div className="auth-icon"><LockKeyhole size={22}/></div><p className="eyebrow">LEHRERBEREICH</p><h1>{isSignup ? "Konto erstellen" : "Schön, dass du da bist."}</h1><p className="muted">Melde dich an, um deine Unterrichtsmaterialien sicher zu verwalten.</p>
    <form onSubmit={submit} className="auth-form"><label>E-Mail-Adresse<input autoComplete="email" type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="name@schule.de"/></label><label>Passwort<input autoComplete={isSignup?"new-password":"current-password"} type="password" minLength={8} required value={password} onChange={e=>setPassword(e.target.value)} placeholder="Mindestens 8 Zeichen"/></label>
      {error && <p className="notice error">{error}</p>}{message && <p className="notice success">{message}</p>}<button className="button primary full" disabled={busy}>{busy?"Einen Moment…":isSignup?"Konto erstellen":"Sicher anmelden"}<ArrowRight size={17}/></button></form>
    <button className="text-button auth-switch" onClick={()=>{setIsSignup(!isSignup);setError("");setMessage("");}}>{isSignup?"Schon ein Konto? Anmelden":"Neu bei PLEXIA? Konto erstellen"}</button>
    <div className="auth-foot"><Sparkles size={14}/> Deine Unterrichtsideen. Klar strukturiert. Interaktiv.</div>
  </div></main>;
}
