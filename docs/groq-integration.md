# Groq-Integration: Modell- und Request-Verträge

Für den anfänglichen Textmodus nutzt die Edge Function `llama-3.3-70b-versatile` als konfigurierbaren Standard. Das offizielle Groq-Beispiel für Chat Completions verwendet diese Modell-ID [1]. Für OCR/Vision nutzt sie `qwen/qwen3.8-27b`; die offizielle Vision-Seite nennt dieses Modell als unterstütztes multimodales Modell und zeigt `image_url`-Nachrichten sowie JSON-Modus [2].

Die Function liest `PLEXIA_GROQ_TEXT_MODEL` und `PLEXIA_GROQ_VISION_MODEL` aus den Supabase-Function-Secrets, damit Betreiber auf ein anderes für ihr Konto freigeschaltetes Modell wechseln können. Chat-Completions verwenden `max_completion_tokens`; `max_tokens` ist in der API-Referenz als veraltet markiert [1]. Für Vision begrenzt Groq URL-Bildanfragen auf 20 MB [2]; PLEXIA akzeptiert nur einen signierten HTTPS-Link aus dem eigenen privaten Supabase-Storage und setzt zusätzlich eine konservative Edge-Request-Größe.

**Geprüft am 18. November 2026.** Vor einem Deployment mit einem persönlichen Groq-Konto Modellzugriff und Kontingente im Groq-Dashboard prüfen; die Modellliste ist dynamisch [3].

## Quellen

[1]: https://console.groq.com/docs/api-reference "Groq Chat Completions API Reference"
[2]: https://console.groq.com/docs/vision "Groq Vision Documentation"
[3]: https://console.groq.com/docs/models "Groq Supported Models"
