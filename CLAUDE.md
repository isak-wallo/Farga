# Färga — färgläggningsapp för barn

En enkel färgläggningsapp (PWA) för en gammal Android-platta. Syskon till
Kludda (fri ritning, https://github.com/isak-wallo/Kludda) och bygger på samma
skal. Språk i appen och i koden (kommentarer, knappnamn) är **svenska**.

## Vad appen gör

- En tecknad bild med tydliga svarta streck. Tryck på ett område → det får
  den valda färgen. Samma 6 färger som Kludda (svart, röd, gul, blå, grön,
  lila); röd är vald från start.
- **◀ ▶** bläddrar mellan bilderna (traktor, grävmaskin). Varje bild minns
  sina färger och sin ångra-historik så länge appen är öppen
  (`pictureState`/`loadPicture`). Knapparna agerar direkt på `touchstart`
  (med `stopPropagation`), inget håll krävs.
- **ÅNGRA** (håll 1 s, upp till 10 steg) och **RENSA** (tvåstegs, håll 1 s +
  SÄKER?) fungerar som i Kludda. RENSA tömmer bilden på färg.
- Panelens rutnät: liggande 2×5 (bläddra överst, sedan ÅNGRA/RENSA, sedan
  färgerna), stående 4×3. Se `style.css`.
- Landskapslås, fullscreen, layoutlås/dö-yta, back-fälla och offline-SW är
  kopierade från Kludda — se Kluddas CLAUDE.md för detaljerna.
- Hostas via GitHub Pages: `https://isak-wallo.github.io/Farga/`.
  **Inget byggsteg** — commit + push är driftsättning.

### Arbetsflöde: bara `main`
Jobba direkt på `main` (inga sidgrenar). Commit-meddelanden på svenska,
signera med `Co-Authored-By: Claude <noreply@anthropic.com>`. Ägaren testar
från GitHub Pages och förväntar sig att nya versioner ligger ute.

### VIKTIGT vid uppdatering: bumpa SW-versionen
`sw.js` har `const VERSION = 'vNN'`. Höj den varje gång filer ändras och
pushas, annars fastnar plattan på gammal cache.

## Arkitektur (`app.js`)

- **Tre lager** i 1200×900: `lineCanvas` (bara de svarta strecken,
  genomskinlig bakgrund), `fillCanvas` (färgerna) och synliga `viewCanvas`
  som ritar fill + linjer ovanpå. Bilden passas in utan beskärning; i
  stående vy roteras den 90° (`updateTransform`/`getPaperCoords`).
- **Bilder** är funktioner som ritar på `lineCanvas` och listas i
  `PICTURES`. Hjälpare: `form()` ritar en *sluten* form och raderar det som
  ligger bakom (destination-out), så överlappande delar skymmer varandra;
  `linje()` ritar ett löst streck; `ellips()`, `trad()`, `grastuss()` och
  `landskap()` (kullar, träd, sol, moln, väg — gemensamt för alla bilder); `stav()` (cylinder/stång) och `mangel()`
  (månghörning) lägger till banor i en `form()`. Ange banor **medurs** —
  blandade riktningar som överlappar i samma form kan ta ut varandra
  (nonzero-fyllning) så att det blir hål. Det som ska gå att färga måste vara helt
  omslutet av linjer (inga glapp, linjebredd `LW`).
- **Områden** numreras en gång vid laddning (`labelRegions`, scanline-flood,
  4-grannar). `labels[i]` = områdesnummer (0 = linje). Tryck → slå upp
  området (`regionAt`, med snap till närmaste yta om man träffar en linje),
  färga om bara det (`paintRegion`). Pixlar med alpha < `LINE_ALPHA` räknas
  som yta så färgen går in under linjens anti-aliasade kant.
- **Ångra** sparar bara områdenas färgtabell (`regionInt.slice()`), inte
  pixlar.
- **Tryck** räknas först vid `touchend` om fingret knappt rört sig
  (`TAP_MAX_MOVE`) och lyfts inom `TAP_MAX_MS` — vilande hand/glidande
  finger färgar inget. Knappar har `stopPropagation` på `touchstart` precis
  som i Kludda.

## Lägga till en ny bild
1. Skriv `ritaXxx(ctx)` (se `ritaTraktor`/`ritaGravmaskin`; börja med
   `stilSatt(ctx)` och `landskap(ctx, {...})`). Stil: realistiska, lugna
   konturer i ungefär 30–50 färgbara ytor — inte fler, så det blir lätt för
   små fingrar. Traktorn är ritad snett framifrån i ett eget
   koordinatsystem (`ctx.translate/scale`) och lägg den i
   `PICTURES`. Bläddra-knapparna hittar den automatiskt.
2. Kontrollera i webbläsaren att alla ytor går att färga (inga läckor):
   ytor som inte ska hänga ihop måste vara helt omslutna. Tänk på att en
   `form()` som läggs ovanpå raderar linjerna under sig — se till att
   ovanpåliggande delar själva stänger ytan.
3. Bumpa `VERSION` i `sw.js`.

## Konventioner
- Svenska i UI och kommentarer. Ingen byggpipeline, inga dependencies.
- Tänk på multi-touch och `stopPropagation` på nya knappar.
