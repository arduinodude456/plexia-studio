# Supabase für PLEXIA

Beide Frontends müssen dieselbe Supabase-Instanz verwenden. Die SQL-Migrationen erstellen Auth-/Profilrollen, Präsentationen, Unterrichtssitzungen, pseudonyme Teilnehmer, Antworten, private Storage-Buckets, Realtime-Tabellen, strenge RLS-Policies, den KI-Rate-Limiter und einen nicht öffentlich freigegebenen Schlüssel-Vault. Große Bilder und Videos liegen ausschließlich im privaten Storage, nie als PostgreSQL-BLOB.

## Datenbank und Authentifizierung

Das bestätigte Projekt `plexia-server` ist in Organisation TBS, Region `eu-central-1` (Frankfurt) angelegt. Die bestätigten laufenden Projektkosten betragen 0 USD/Monat. Die elf live angewandten Migrationen (in Reihenfolge) sind:

1. `migrations/20261118201321_plexia_core.sql`
2. `migrations/20261118201334_ai_rate_limit.sql`
3. `migrations/20261118201343_groq_encryption_vault.sql`
4. `migrations/20261118201645_response_insert_guard.sql`
5. `migrations/20261118201830_auth_and_index_hardening.sql`
6. `migrations/20261118202248_rls_performance_hardening.sql`
7. `migrations/20261118203929_teacher_private_quiz_keys.sql`
8. `migrations/20261118204002_local_join_response_hardening.sql`
9. `migrations/20261118204155_presentations_results_realtime.sql`
10. `migrations/20261118205001_rls_helper_exposure_and_quiz_performance.sql`
11. `migrations/20261118210233_teacher_storage_delete_policies.sql`

Die Versionsnummern entsprechen Supabases Remote-Migrationsverlauf. Realtime ist für `class_sessions`, `student_responses` und `presentations` aktiv; letzteres überträgt ausschließlich von Lehrkräften ausdrücklich freigegebene, schlüsselfreie Ergebnisaggregate. RLS beschränkt Schüler auf aktive, beigetretene Sitzungen und eigene Antworten. Studentische Antwortkorrekturen bleiben auf erlaubte Antwortfelder begrenzt; Bewertungsfelder, Identität, aktuelle Folie und fremde Medienpfade sind geschützt.

Lehrkräfte verwenden E-Mail und Passwort. Schüler treten ohne E-Mail oder interaktives Passwort über **Anonymous Sign-Ins** bei. Dafür muss die Einstellung unter Supabase **Authentication → Sign In / Providers → Anonymous Sign-Ins** im Dashboard aktiviert werden. Sie ist im Projekt noch aus. Vor einer öffentlichen anonymen Anmeldung empfiehlt Supabase CAPTCHA oder Cloudflare Turnstile; die Auth-CAPTCHA-Einrichtung muss vor echtem Schuleinsatz konfiguriert und getestet werden.

## Private Medien und ausdrückliches Löschen

Studio listet beim Löschen einer Präsentation die Medien im privaten Ordner der Lehrkraft sowie die Fotos der zugehörigen Sitzungen auf und löscht sie mit der authentifizierten Supabase Storage API `.remove()`. Erst wenn die Storage API keinen Fehler meldet, löscht Studio die Datenbank-Präsentation und ihre Kaskaden. RLS erlaubt `DELETE` ausschließlich für die angemeldete Lehrkraft auf Medien im eigenen Präsentationspräfix beziehungsweise in eigenen Sitzungen. SQL löscht keine Zeilen aus `storage.objects`, weil das allein keine physische Blob-Löschung beim Storage-Provider garantiert.

Bei einem Storage-Fehler bleibt die Präsentation in der Datenbank. Ein Fehler nach einem bereits erfolgreich gelöschten Chunk kann trotzdem einen Teil der Dateien entfernt haben; der sichere Löschvorgang kann anschließend erneut gestartet werden. Das Beenden einer Unterrichtssitzung löscht keine Schülerdaten oder Medien automatisch. Aufbewahrung und Löschung sind an schulische Vorgaben anzupassen.

## Groq-Edge-Function

`functions/groq-proxy` ist mit `verify_jwt` aktiv deployed. Supabase stellt `SUPABASE_SERVICE_ROLE_KEY` ausschließlich der Function-Runtime bereit; dieser Schlüssel bleibt serverseitig.

Die Migration `20261118201343_groq_encryption_vault.sql` erzeugt einen zufälligen AES-256-Masterschlüssel in einem nicht exponierten privaten Schema. Nur die Edge Function kann ihn über eine für `service_role` freigegebene RPC beziehen. Lehrkräfte geben ihren persönlichen Groq-Key (`gsk_…`) in Studio ein; die Function prüft die Lehrerrolle, verschlüsselt den Key serverseitig per AES-GCM und speichert nur Ciphertext und IV. Sie gibt den Original-Key nie zurück. Der Proxy begrenzt KI-Aufrufe auf 20 pro Lehrkraft und Minute. Provider, Aufgaben und aktuelle Modellnamen stehen in [`../docs/groq-integration.md`](../docs/groq-integration.md).

`PLEXIA_ALLOWED_ORIGINS`, `PLEXIA_GROQ_TEXT_MODEL` und `PLEXIA_GROQ_VISION_MODEL` sind optionale Function-Variablen für strengere Origin-Filter beziehungsweise Modellwechsel. Eine abweichende Pages-Domain muss ausdrücklich zugelassen werden.

## GitHub Pages

In **beiden** öffentlichen Repositories unter **Settings → Pages → Build and deployment** die Quelle **GitHub Actions** wählen. Unter **Settings → Secrets and variables → Actions → Variables** jeweils `VITE_SUPABASE_URL` und `VITE_SUPABASE_ANON_KEY` anlegen. Der Workflow überspringt den Deploy, solange eine Variable fehlt. Die verbundene GitHub-Integration besitzt dafür keine Schreibrechte (HTTP 403), deshalb ist dieser Schritt manuell.

`VITE_SUPABASE_URL` ist `https://neffuqgumcefmmbvnofg.supabase.co`. Den `VITE_SUPABASE_ANON_KEY` als Publishable-Key im Supabase-Projekt unter **Project Settings → API Keys** kopieren. Dieser eine Client-Key ist absichtlich im Browser sichtbar und wird durch RLS begrenzt; er ist kein Service-Role- oder Groq-Schlüssel. Geheimnisse dürfen nicht in Pages-Variablen oder den öffentlichen GitHub-Code.

## Datenschutz und Betrieb

Schüler benötigen keine Klarnamen, E-Mail oder interaktives Passwort; der Nickname ist auf 24 Zeichen begrenzt und nur für die jeweilige Klasse sichtbar. Antworten sind an eine Sitzung und eine anonyme Auth-ID gebunden. Private Medien-URLs sind kurzlebig signiert. Der Security-Review in [`../docs/supabase-security-review.md`](../docs/supabase-security-review.md) beschreibt die verbleibenden Advisor-Hinweise.

Vor einem Schuleinsatz sind Rechtsgrundlage, Auftragsverarbeitung, regionale Datenverarbeitung, Einwilligung, Aufbewahrungsfrist und schulische Freigabe durch die verantwortliche Stelle zu prüfen. PLEXIA ersetzt keine Datenschutz- oder Rechtsprüfung.
