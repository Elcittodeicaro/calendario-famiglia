# Calendario di famiglia

Web app privata (installabile su iPhone) per condividere gli impegni di famiglia.

- `public/` – l'app (una sola pagina, funziona anche offline con gli ultimi dati)
- `netlify/functions/api.mts` – API protetta dal codice famiglia
- `netlify/functions/ics.mts` – feed `/calendario.ics?k=CODICE` per iscriversi dal Calendario dell'iPhone (sola lettura, con ripetizioni e avvisi)
- `netlify/functions/reminders.mts` – ogni 5 minuti invia i promemoria a chi li ha attivati
- `netlify/lib/shared.mts` – codice comune (ripetizioni, fusi orari, invio notifiche)
- Notifiche: chiavi `VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY` nelle variabili d'ambiente di Netlify.
- I dati stanno in Netlify Blobs (store `calendario`), non in questo repository.
- Il codice d'accesso è la variabile d'ambiente `FAMILY_CODE` su Netlify.
  Per cambiarlo: modifica la variabile e ripubblica; poi rientrate col nuovo codice.
