# Auth-Speicher: einmalige Umstellung

Studio verwendet `plexia-studio-auth-v1`, Connect `plexia-connect-auth-v1`. Die Schlüssel sind öffentliche Bezeichner, keine Secrets. Beim ersten Aufruf nach dem Update müssen sich Lehrkräfte einmal erneut in Studio anmelden; danach bleibt die Sitzung wie bisher erhalten.

Eine automatische Übernahme des alten Supabase-Standardschlüssels erfolgt bewusst nicht: Er wurde von beiden Apps geteilt und lässt die zugehörige App oder Rolle nicht zuverlässig erkennen. Sein Inhalt wird weder gelesen noch gelöscht oder protokolliert. Das schützt ältere, noch geöffnete App-Versionen vor unbeabsichtigtem Logout; deren Sitzungen bleiben allerdings bis zu ihrer eigenen Abmeldung oder Ablauf bestehen. Sind noch alte Versionen im Einsatz, besteht dort weiterhin das bisherige Kollisionsrisiko. Auch eine bereits serverseitig beendete Sitzung kann durch diese Umstellung nicht wiederhergestellt werden.
