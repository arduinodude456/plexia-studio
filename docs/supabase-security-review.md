# Supabase Authentifizierung und Sicherheitsprüfung

Projekt: `plexia-server` (`neffuqgumcefmmbvnofg`), Region `eu-central-1`. Die live angewandten Migrationen sind mit den SQL-Dateinamen im Repository versioniert.

## Anonyme Teilnahme

Schüler melden sich mit `signInAnonymously()` an, ohne E-Mail oder Passwort. In Supabase muss **Authentication → Sign In / Providers → Anonymous Sign-Ins** aktiviert sein. Die verbundene Supabase-MCP-Schnittstelle bietet keine Auth-Konfigurationsänderung; diese eine Projekteinstellung muss daher im Dashboard aktiviert werden.

Supabase weist darauf hin, dass anonyme Nutzer für Postgres die Rolle `authenticated` verwenden. PLEXIA markiert anonyme Auth-Nutzer über `auth.users.is_anonymous` im Profil als `student`; RLS-Policies beschränken sie auf aktive, beigetretene Sitzungen und auf ihre eigenen Antworten. Sie können weder Bewertungen noch Feedback schreiben. Für öffentlich erreichbare anonyme Anmeldung empfiehlt Supabase CAPTCHA oder Cloudflare Turnstile, um Missbrauch und unnötige Auth-Nutzer zu begrenzen. Anonyme Konten werden nicht automatisch bereinigt; Aufbewahrung und Löschung sind vor Schuleinsatz festzulegen.

Offizielle Anleitung: [Supabase Anonymous Sign-Ins](https://supabase.com/docs/guides/auth/auth-anonymous).

## Supabase-Sicherheitsberater

Die Datenbank wurde nach dem Anlegen der Tabellen mit dem Supabase Security Advisor geprüft. Die folgenden Hinweise sind auf einem neuen, noch leeren Projekt sichtbar:

- **RLS enabled, no policy** auf `plexia_private.encryption_secrets`, `public.ai_rate_limits` und `public.user_ai_settings`: beabsichtigt. Alle direkten Rechte für `public`, `anon` und `authenticated` sind entzogen; die Tabellen enthalten Schlüsselmaterial, Rate-Limits oder verschlüsselte Groq-Konfiguration und sind nur für eng begrenzte Serverpfade gedacht.
- Die drei booleschen RLS-Helfer (`is_joined_presentation`, `is_session_owner`, `is_session_participant`) liegen nun im nicht für PostgREST freigegebenen Schema `plexia_internal`. Gleichnamige `public`-Wrapper verwenden `SECURITY INVOKER`; interne `SECURITY DEFINER`-Funktionen fixieren `search_path` und geben nur eigene Mitgliedschafts-/Besitzprüfungen zurück. `plexia_internal` darf nicht zur Liste der exponierten API-Schemas hinzugefügt werden.
- **SECURITY DEFINER, authenticated callable** auf `student_join_classroom` bleibt der eine erwartete Security-Advisor-Hinweis: Der Client muss diesen RPC verwenden, um einem Kurs ohne Lehrer-Account beizutreten. Er verlangt eine anonyme Schülerrolle, normalisiert Zugangscode/Nickname, gibt bei Codefehlern keine Sitzungsdetails preis, limitiert Joinversuche auf fünf pro Minute je Auth-ID und gibt keine Eigentümer-ID zurück. Der Funktionseintrag ist nur `authenticated` erlaubt; alle privilegierten Join-Daten bleiben auf das beigetretene Klassenzimmer begrenzt.
- **RLS enabled, no policy** auf `plexia_private.encryption_secrets`, `public.ai_rate_limits`, `public.student_join_attempt_limits` und `public.user_ai_settings` ist beabsichtigt: direkte Clientrechte sind entzogen; nur Vault-/Edge-Function-/SECURITY-DEFINER-Serverpfade verwenden diese Tabellen.
- Die Quizschlüssel-Policy verwendet `(select auth.uid())` und einen einmalig ausgewerteten Lehrerrollen-Check. Der Performance-Advisor meldet deshalb keinen Auth-RLS-InitPlan-Hinweis mehr.
- **Nicht verwendete Indizes** sind bei leeren Tabellen erwartbar. Fremdschlüsselindizes wurden ergänzt.
- **Mehrere permissive SELECT-Policies** bilden die beabsichtigte Kombination aus Lehrerzugriff auf eigene Sitzungen und Schülerzugriff auf beigetretene Sitzungen.

Die Storage-DELETE-Policies begrenzen Lehrkräfte auf `presentation-media` unter ihrer Auth-UID beziehungsweise auf `student-uploads` aus ihren eigenen Sitzungen. Studio löscht Objekte über die authentifizierte Supabase Storage API `.remove()`, die den physischen Provider-Pfad bedient. Es gibt keinen SQL-Trigger, der nur `storage.objects`-Metadaten entfernt. Ein Löschfehler verhindert den nachfolgenden Präsentations-DB-Cascade; ein API-Fehler nach erfolgreich entfernten Chunks kann trotzdem eine Teillöschung verursachen.

Advisory-Remediation: [SECURITY DEFINER Functions](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), [RLS ohne Policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), [Auth in RLS-Policies](https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select), [Unbenutzte Indizes](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index), [Mehrere permissive Policies](https://supabase.com/docs/guides/database/database-linter?lint=0006_multiple_permissive_policies).

Vor echtem Schuleinsatz zusätzlich Supabase CAPTCHA, Datenaufbewahrung, Kontolöschung, Einwilligung und schulische Freigabe konfigurieren und den Security Advisor nach ersten Auth-/Sitzungstests erneut prüfen. Siehe auch die [Supabase Production Checklist](https://supabase.com/docs/guides/deployment/going-into-prod).
