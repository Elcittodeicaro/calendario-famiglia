# Calendario di famiglia

Web app privata (installabile su iPhone) per condividere gli impegni di famiglia.

- `public/` – l'app (una sola pagina, funziona anche offline con gli ultimi dati)
- `netlify/functions/api.mts` – API protetta dal codice famiglia
- I dati stanno in Netlify Blobs (store `calendario`), non in questo repository.
- Il codice d'accesso è la variabile d'ambiente `FAMILY_CODE` su Netlify.
  Per cambiarlo: modifica la variabile e ripubblica; poi rientrate col nuovo codice.
