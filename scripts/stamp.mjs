// Eseguito da Netlify a ogni pubblicazione: scrive il numero di versione
// nella pagina e in version.json, così l'app si aggiorna da sola.
import fs from 'node:fs';
const v = (process.env.COMMIT_REF || String(Date.now())).slice(0, 12);
fs.writeFileSync('public/version.json', JSON.stringify({ v }));
const p = 'public/index.html';
fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('__APP_VERSION__', v));
console.log('versione', v);
