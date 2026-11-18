# PLEXIA Studio

Lehrer-Dashboard, Präsentationseditor, Präsentationsverwaltung, Live-Steuerung und KI-Einstellungen von PLEXIA.

## Lokaler Start

Voraussetzungen: Node.js 22 und pnpm 11.25.

```sh
pnpm install
pnpm dev:studio
```

Für Supabase lokal apps/studio/.env.local erstellen (Vorlage: .env.example) und VITE_SUPABASE_URL sowie VITE_SUPABASE_ANON_KEY setzen. Der Anon-Key ist öffentlich und nur mit den geprüften RLS-Policies sicher.

## GitHub Pages

Dieses Repository ist auf ausdrücklichen Wunsch öffentlich; auch der vollständige Quellcode ist einsehbar. Committe keine echten Schülerdaten, Groq-Keys oder Service-Role-Credentials.

Der Workflow in .github/workflows/pages.yml baut diese App zusammen mit einer Workspace-Kopie von packages/shared und veröffentlicht apps/studio/dist. In GitHub unter Settings → Pages die Bereitstellung über GitHub Actions aktivieren. Repository-Variablen VITE_SUPABASE_URL und VITE_SUPABASE_ANON_KEY setzen. Solange sie fehlen, überspringt der Pages-Workflow den Deploy; lokal ohne apps/studio/.env.local läuft die klar gekennzeichnete Demo.

## Supabase und Datenschutz

Portable `.plexia`-Dateien können lehrkraftinterne Quizlösungsschlüssel enthalten; ZIP-Dateien sind nicht verschlüsselt. Speichere und teile ein solches Archiv vertraulich.

Die SQL-Migrationen, Storage-Policies und die Groq-Edge-Function liegen in `supabase/`. Beide Apps müssen dieselbe Supabase-Instanz verwenden. Service-Role- und Groq-Keys gehören ausschließlich in die geschützte Supabase-Runtime bzw. den verschlüsselten Server-Vault und niemals in GitHub-Variablen des Browser-Builds, Frontend-Dateien oder Logs. Der AES-GCM-Masterschlüssel wird durch eine Migration im privaten Datenbankschema erzeugt. Siehe `supabase/README.md` und `docs/groq-integration.md`. Schüler geben nur einen Nickname an; Bilder liegen in privatem Supabase Storage und nicht als Datenbank-BLOB.
