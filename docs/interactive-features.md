# Interaktive Funktionen

## Unterricht

Im Livebereich öffnet die Vollbild-Schaltfläche die aktuelle Folie mit den beiden Navigationsschaltflächen. Die Pfeiltasten wechseln ebenfalls die Folie; Escape verlässt den Vollbildmodus.

Auf Multiple-Choice-Folien markiert die Lehrkraft im Editor mindestens eine richtige Antwort. Bei mehreren richtigen Antworten müssen alle und nur diese ausgewählt werden. Nach der Abgabe zeigt Connect „richtig“ oder „falsch“. Die Bewertung erfolgt auf dem Server; die Antwort ist danach endgültig. Ergebnisfolien zeigen eine Rangliste anhand der Anzahl richtiger Quizantworten. Sichtbar sind nur Nicknames und – falls aktiviert – Avatare.

Während eine Sitzung zur Präsentation läuft oder pausiert, sind Quizfragen, Antwortoptionen und Lösungsschlüssel gegen Änderungen geschützt, damit alle Teilnehmenden dieselbe Auswertung erhalten. Die Sitzung muss beendet werden, bevor diese Inhalte geändert werden können. Andere Folieninhalte bleiben bearbeitbar.

## Optionale Einstellungen

Im Editor lassen sich Emojis als Avatare und ein Nickname-Generator pro Präsentation aktivieren. Ein Zeitlimit kann pro Multiple-Choice-Folie festgelegt werden. Der Server bestimmt die Frist; eine Pause hält die verbleibende Zeit an. Beginnt eine Stunde mit einer zeitbegrenzten Frage, startet deren Zeit erst, wenn die Lehrkraft die Aktivität startet.

Für Wortwolken kann die Lehrkraft einzelne Begriffe oder vollständige Phrasen über eine Black- oder Whitelist zulassen beziehungsweise ausschließen. Die Regeln unterstützen exakte Übereinstimmung und „enthält“ und werden ohne Berücksichtigung der Groß-/Kleinschreibung angewandt.

Ein globales Hintergrundbild wird einmal pro Präsentation im privaten Präsentationsspeicher abgelegt und auf den Folien verwendet. In der lokalen Demo sind ausgewählte Dateien nur für die laufende Browsersitzung verfügbar; der Import eines Archivs mit Medien benötigt den Cloudspeicher.

## Datenschutz und Betrieb

Lösungsschlüssel werden getrennt von den für Teilnehmende lesbaren Präsentationsdaten gespeichert. `.plexia`-Exporte können vertrauliche Lösungsschlüssel enthalten und sind nicht verschlüsselt; die Exportwarnung beachten und Dateien nur berechtigten Lehrkräften zugänglich machen. Die Migration unter `supabase/migrations/` ist für beide Apps erforderlich und sollte vor dem Aktualisieren der Anwendungen installiert werden. Bestehende Daten mit eingebetteten privaten Schlüsseln werden nicht automatisch gelöscht; die Migration bricht in diesem Fall sicher ab.
