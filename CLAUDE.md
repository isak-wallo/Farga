# Färga — färgläggningsapp för barn

En enkel färgläggningsapp (PWA) för en gammal Android-platta. Syskon till
Kludda (fri ritning, https://github.com/isak-wallo/Kludda) och bygger på samma
skal. Språk i appen och i koden (kommentarer, knappnamn) är **svenska**.

## Vad appen gör

Lugn ton som syskonet Poppa (https://github.com/isak-wallo/Poppa): mjuka
pastellfärger, inga ljud, inga poäng, inga val att göra.

- En tecknad bild med mjukt mörkgrå konturer (`LINJEFARG`). Varje yta har en
  **given färg** (röd traktor, gul grävmaskin, blå himmel, grön kulle …) —
  barnet kan inte välja färg.
- Man **målar fritt med fingret** (alla fingrar, `PENSEL` = radie i
  bildpixlar). Penseln "målar fram" färgen på de ytor den passerar. När
  `FYLL_ANDEL` (80 %) av en yta är målad fylls resten i av sig själv och
  tonas mjukt fram (`FADE_MS`).
- Panelen har bara tre knappar, till höger i liggande läge (en rad nederst
  i stående): **◀** föregående bild, **▶** nästa bild (agerar direkt på
  `touchstart` med `stopPropagation`) och **BÖRJA OM** (håll 1 s → SÄKER?,
  håll 1 s igen → bilden töms; samma spärr som Kluddas RENSA).
- Varje bild minns det man målat så länge appen är öppen
  (`pictureState`/`loadPicture`).
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

- **Lager** i 1200×900: `lineCanvas` (bara konturerna, genomskinlig
  bakgrund), `colorCanvas` (facit: bilden ifylld med sina givna färger,
  syns aldrig), `fillCanvas` (det barnet målat fram, vitt annars) och
  synliga `viewCanvas` som ritar fill + pågående toningar + linjer. Bilden
  passas in utan beskärning; i stående vy roteras den 90°
  (`updateTransform`/`getPaperCoords`).
- **Bilder** är funktioner som listas i `PICTURES` och ritas **två gånger**:
  först konturerna på `lineCanvas`, sedan med `fargLage = true` på
  `colorCanvas` — då fyller `form(ctx, bygg, farg)` banan med sin färg och
  `linje()`/`prick()` gör ingenting. Färgerna finns i `F`. `tunnForm()` är
  en liten sluten yta med tunn kant som inte raderar bakom sig (fönster).
  `kant` styr formernas kantbredd (nollställs till `LW` före varje bild). `landskap()`
  fyller himmel, kulle och väg i färgläget. Hjälpare: `form()` ritar en
  *sluten* form och raderar det som ligger bakom (destination-out), så
  överlappande delar skymmer varandra; `linje()` ritar ett löst streck;
  `ellips()`, `trad()`, `grastuss()`, `landskap()` (kullar, träd, sol, moln,
  väg — gemensamt för alla bilder); `stav()` (cylinder/stång) och `mangel()`
  (månghörning) lägger till banor i en `form()`. Ange banor **medurs** —
  blandade riktningar som överlappar i samma form kan ta ut varandra
  (nonzero-fyllning) så att det blir hål. Det som ska bli en egen yta måste
  vara helt omslutet av linjer (inga glapp, linjebredd `LW`).
- **Områden** numreras en gång vid laddning (`labelRegions`, scanline-flood,
  4-grannar). `labels[i]` = områdesnummer (0 = linje). Varje områdes färg
  (`regionColor`) är den färg som dominerar på dess pixlar i `colorCanvas`
  (`pickRegionColors`, majoritetsröstning). Pixlar med alpha < `LINE_ALPHA`
  räknas som yta så färgen går in under linjens anti-aliasade kant.
- **Måla**: `stamp`/`stroke` skriver områdets färg direkt i `fillPx` för
  omålade pixlar och räknar `regionPainted`. `checkTouched` startar
  `startFade` när andelen nått `FYLL_ANDEL` (toningen ritas i `render`, och
  `commitRegion` skriver in resten när den är klar). Ytor under
  `MIN_REGION` (små celler mellan detaljstreck) fylls direkt när penseln
  nuddar dem. Ritning sker en gång per frame (`requestRender`, `dirty`).

## Bildstil
Traktorn och grävmaskinen har tjocka konturer (`LW`). Flygplanet
(`ritaFlygplan` + `luftBakgrund`) är ritat i en finare målarboksstil som
ägaren vill gå mot: tunnare jämna konturer (`kant = 4–5`), lite verkligare
proportioner, fler och mindre ytor (fönster, dörrar, motordelar) är OK nu när
man målar över i stället för att trycka, sol utan ansikte och en lugn
bakgrund med tunna linjer.

## Lägga till en ny bild
1. Skriv `ritaXxx(ctx)` (se `ritaTraktor`/`ritaGravmaskin`; börja med
   `stilSatt(ctx)` och `landskap(ctx, {...})`). Ge varje `form()` sin
   givna färg som tredje argument (lägg nya färger i `F`, lugna toner). Stil: realistiska, lugna
   konturer i ungefär 20–25 färgbara ytor, och ingen yta mindre än ca 4000 px
   (på 1200×900) — inte fler/mindre, så det blir lätt för små fingrar. Detaljer (bultar, nav, springor, slangar, galler) ritas som
   `prick()` (svart prick) eller `linje(ctx, bygg, TUNN)` (tunt streck) som
   stannar en bit från kanten —
   då syns de utan att bli egna ytor att färga. Slå ihop delar som hör ihop
   (t.ex. skopa och tänder, rör och ljuddämpare) till en `form()`. Traktorn är ritad snett framifrån i ett eget
   koordinatsystem (`ctx.translate/scale`) och lägg den i
   `PICTURES`. Bläddra-knapparna hittar den automatiskt.
2. Kontrollera i webbläsaren att alla ytor får rätt färg (inga läckor):
   ytor som inte ska hänga ihop måste vara helt omslutna. Tänk på att en
   `form()` som läggs ovanpå raderar linjerna under sig — se till att
   ovanpåliggande delar själva stänger ytan.
3. Bumpa `VERSION` i `sw.js`.

## Fallgropar när man ritar
- Ett löst streck som rör två olika konturer (eller bildkanten i båda
  ändar) delar upp ytan i fler fält. Ge dem fria ändar. Det gäller även
  bakgrundsdetaljer (fåror, hjulspår) som går bakom maskinen.
- Streck som korsar varandra inuti en yta kan skapa pyttesmå celler. Celler
  under `MIN_REGION` (150 px) fylls direkt när penseln nuddar dem — det är
  OK för t.ex. ljuddämparens rutnät.
- Cirklar som ligger tätt inuti en rundad form (drev i larvbandets ände)
  lämnar en tunn ring-yta; gör cirkeln så stor att formens kant täcker den.
- Tunna detaljstreck får inte både röra en kontur *och* korsa/röra en annan
  detalj eller form — då stänger de en liten instängd cell (t.ex. svetsfogar
  som når både slangen och cylindern). Låt dem sluta fritt, helst nära en
  kant. Rita förarens huvud, strålkastare m.m. som öppna bågar (lucka) så de
  inte blir egna ytor.
- Små instängda luftkilar mellan maskinens delar och kullens linje blir egna
  små ytor; justera kullens höjd bakom maskinen (`o.kulle` i `landskap`)
  eller flytta delar så kilen hänger ihop med stora himlen/marken.
- Kontrollera antalet ytor: se till att inte fler än ~30 är större än
  `MIN_REGION` (köra appen med en debug-hook på `labelRegions`).

## Konventioner
- Svenska i UI och kommentarer. Ingen byggpipeline, inga dependencies.
- Tänk på multi-touch och `stopPropagation` på nya knappar.
