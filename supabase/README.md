# Supabase für PLEXIA

Beide Frontends müssen auf dieselbe Supabase-Instanz zeigen. Wende die versionierten Migrationen der Reihe nach an. Sie erstellen Auth-/Profilrollen, Präsentationen, Unterrichtssitzungen, pseudonyme Teilnehmer, Antworten, private Storage-Buckets, Realtime-Tabellen, RLS-Policies, den KI-Rate-Limiter und einen nicht öffentlich freigegebenen Schlüssel-Vault.

## Datenbank und Authentifizierung

1. Erstelle das Supabase-Projekt `plexia-server` in der gewünschten Organisation. Für Schülerinnen und Schüler, die kein interaktives Benutzerkonto anlegen, muss **Anonymous Sign-Ins** in Supabase unter Authentication → Sign In / Providers → Anonymous Sign-Ins aktiviert sein. Lehrkräfte verwenden E-Mail und Passwort.
2. Wende `migrations/20261118000100_plexia_core.sql`, `migrations/20261118000200_ai_rate_limit.sql` und `migrations/20261118000300_groq_encryption_vault.sql` der Reihe nach genau einmal an. Verwende Supabase Migrationen oder den SQL-Editor und prüfe vor jeder DDL-Ausführung das Zielprojekt.
3. Die erste Migration aktiviert Realtime für `class_sessions` und `student_responses` und richtet RLS sowie private Storage-Buckets mit Policies ein. Studentenbilder und Lehrermedien werden als Storage-Dateien gespeichert, nicht als Datenbank-BLOBs.
4. Setze für beide Apps `VITE_SUPABASE_URL` und den öffentlichen Supabase-Publishable-/Anon-Key als lokale Build-Umgebung bzw. GitHub-Pages-Repository-Variablen. Der Anon-Key ist clientseitig sichtbar. Deploye ihn nur zusammen mit geprüften RLS-Policies.

## Groq-Edge-Function

1. Deploye `functions/groq-proxy` als Supabase Edge Function und lasse `verify_jwt` aktiv. Die Supabase-Runtime liefert `SUPABASE_URL`, `SUPABASE_ANON_KEY` und `SUPABASE_SERVICE_ROLE_KEY` in die Funktionsumgebung; die Service-Role-Key-Variable bleibt ausschließlich serverseitig.
2. Migration `20261118000300_groq_encryption_vault.sql` erzeugt einen zufälligen AES-256-Masterschlüssel innerhalb des nicht exponierten Schemas `plexia_private`. Nur die Edge Function kann den Schlüssel über `get_plexia_groq_encryption_key()` abrufen; die RPC ist ausschließlich für `service_role` ausführbar. Kein Schlüsselwert liegt im Quelltext oder in GitHub.
3. Lehrkräfte geben ihren persönlichen `gsk_…`-Key in den Studio-Einstellungen ein. Die Funktion prüft die Lehrkraftrolle, verschlüsselt den Key serverseitig mit AES-GCM und speichert nur Ciphertext und IV. Sie gibt nie den Key zurück. Pro Lehrkraft sind höchstens 20 KI-Aufrufe je Minute zugelassen. Der Provider-Aufruf geht über `https://api.groq.com/openai/v1`; Standardmodelle sind in `docs/groq-integration.md` dokumentiert.
4. `PLEXIA_ALLOWED_ORIGINS`, `PLEXIA_GROQ_TEXT_MODEL` und `PLEXIA_GROQ_VISION_MODEL` sind optionale Function-Variablen für strengere Herkunftsfilter bzw. Modellwechsel; Standardwerte sind enthalten. Für eine abweichende Pages-Domain muss der Browser-Origin explizit zugelassen werden.

## Datenschutz und Betrieb

Schüler benötigen keinen Namen, keine E-Mail und kein interaktives Passwort; der Nickname ist auf 24 Zeichen begrenzt und nur für die Klasse sichtbar. Antworten sind an die Sitzung und eine anonyme Auth-ID gebunden. Schüler sehen nur aktive Präsentationen, für die sie sich angemeldet haben; Lehrkräfte lesen Antworten aus eigenen Sitzungen. Private Medien-URLs sind kurzlebig signiert. Antwort-, Konto- und Datei-Aufbewahrung muss an schulische Vorgaben angepasst werden.

Vor einem produktiven Schuleinsatz sind Rechtsgrundlage, Auftragsverarbeitung, regionale Datenverarbeitung, Einwilligung der Erziehungsberechtigten, Aufbewahrungsfrist und schulische Freigabe durch die verantwortliche Stelle zu prüfen. PLEXIA speichert keine großen Bilder/Videos als PostgreSQL-BLOB.
