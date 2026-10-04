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
- Panelen har fyra knappar, till höger i liggande läge (en rad nederst
  i stående): **◀** föregående bild, **▶** nästa bild (agerar direkt på
  `touchstart` med `stopPropagation`), **SPARA** (håll 1 s → bilden laddas
  ner som PNG 1200×900 till plattans Hämtade filer, `sparaBild`; knappen
  visar SPARAD ✓ en stund) och **BÖRJA OM** (håll 1 s → SÄKER?, håll 1 s
  igen → bilden töms; samma spärr som Kluddas RENSA). Håll-logiken
  (`startHold`/`holdEnd`) delas av SPARA och BÖRJA OM.
- Varje bild minns det man målat så länge appen är öppen
  (`pictureState`/`loadPicture`).
- **Clawd** (den lilla orange kompisen från https://github.com/isak-wallo/clawd)
  gömmer sig i varje bild, som krypet i Richard Scarrys böcker. Han syns
  inte från början; när man målat `CLAWD_TRAFF` pixlar där han är (eller hans
  yta fylls i) poppar han upp med en liten studs, vinkar två gånger,
  blinkar och blir kvar. BÖRJA OM gömmer honom igen.
- Bilder (i ordning): traktor från sidan, traktor snett framifrån (nära en
  klassisk målarboksförlaga ägaren skickade), grävmaskin, flygplan (A330),
  helikopter, samt sex bilder gjorda direkt från förlagor ägaren skickade
  (AI-genererade målarbokssidor): verklig traktor och grävmaskin (den
  senare omritad för hand som rena vektorer, `ritaGravmaskinRen`), litet
  flygplan på gräset, helikopter på stigen, helikopter i luften och
  flygplan vid flygfältet — se "Verkliga bilder" nedan.
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
  `linje()`/`prick()` gör ingenting. Färgerna finns i `F`. Bakgrunden
  fyller himmel och kullar i färgläget. `tunnForm()` är
  en liten sluten yta med tunn kant som inte raderar bakom sig (fönster).
  `kant` styr formernas kantbredd (nollställs till `LW` före varje bild).
  Hjälpare: `form()` ritar en
  *sluten* form och raderar det som ligger bakom (destination-out), så
  överlappande delar skymmer varandra; `linje()` ritar ett löst streck;
  `ellips()`, `trad()`, `grastuss()`, `sol()`, `moln()`, `hjul()`, `band()`;
  `stav()` (cylinder/stång) och `mangel()`
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

## Clawd (`ritaClawd`, `prepClawd`, `renderClawd`)
- Ritas av sina pixelklossar i originalets mått (280 × 178 px, kropp, armar,
  fyra ben, ögon 24 × 30) i färgen `#d77656`, skalad med `s`. Höger arm
  flyttas i steg om 12 px när han vinkar (som i repots `clawd-vinka.gif`).
- Varje bild i `PICTURES` har `clawd: { x, y, s, ytor }`: (x, y) = mitt under
  fötterna, `ytor` = punkter i de ytor han syns i. Han ritas bara på de
  ytornas pixlar (mask), ovanpå färgen men under linjerna — så det som
  ligger framför (molnet, trädkronan, fönsterkarmen, stänkskärmen) skymmer
  honom och han ser ut att titta fram bakom det. Placera fötterna bakom
  något så att han "kikar" upp.

## Verkliga bilder (konturer från bildfil)
- `bilder/*.svg` är konturlager (1200×900, mörkgrå linjer som
  **vektorer**, en enda SVG-bana). Så görs de: `verktyg/linjer.py
  namn=FÖRLAGA ...` (beskärning, typ och ev. tillagd himmel per namn står i
  `BILDER` i skriptet) gör rena konturer som PNG (för blyertsskissen: bara tjocka konturstreck på
  maskinen så skuggning och prickar försvinner, längre streck i
  bakgrunden; ramen tas bort), sedan spårar `verktyg/vektor.py` dem till SVG
  med potrace (`pip install potracer`). PNG:erna behövs inte i repot. SVG är
  ungefär en fjärdedel så stor att ladda ner (GitHub Pages gzippar den).
  PICTURES-posten har `bild: '...'`; filen laddas i förväg (`pic.img`, SVG:n
  måste ha width/height) och `loadPicture` väntar på den. Lägg nya filer i
  `ASSETS` i `sw.js`.
- Ritfunktionen (t.ex. `ritaTraktorVerklig`, `ritaHelikopterLuft`) ritar
  bilden på `lineCanvas` (och kan lägga till egna `moln()`/`sol()` i
  tillagd himmel), och i färgläget en **grov färgkarta** (`fyllPoly`,
  `fyllEllips` i bildens koordinater, rutnätsbilden hjälper) som ungefär
  täcker varje del.
- Färgning: små eller tydliga ytor tar kartans dominerande färg. Stora ytor
  utan tydlig färg ("blandade", t.ex. himmel och mark som läcker ihop genom
  glapp i linjerna) städas i `stadaBlandade`: linjerna görs tillfälligt
  `GLAPP` px tjockare så glappen sluts, varje del tar sin dominerande färg,
  färgstrimlor från kartans grova kanter (`SKVATT`, `SKVATT_MAX`) fylls från
  grannarna, och pixlarna närmast linjerna tar färg från närmaste del.
  En yta/del får bara en enda färg om den dominerar (`DOMINANS`), resten är
  litet (`REST_MAX`) och den inte innehåller skyddad bakgrundsfärg
  (`SKYDDAD_MIN`). `SKYDDAD` (bakgrundens färger: gräs, kullar, grus, jord,
  moln, träd, stammar, ladan) räknas aldrig som strimlor.

### Rita om en förlaga för hand (`ritaGravmaskinRen`)
När en förlaga är för plottrig (blyertsskissen) ritas den om med
`form()`/`linje()` i bildens koordinater: lägg förlagan i 1200×900 bredvid ett
rutnät, rita bara de yttre konturerna och de viktigaste delarna (rutor,
hjul, cylindrar), hoppa över skuggning, reflexer och småstreck. Kontrollera
genom att lägga de nya linjerna över förlagan (röda på grå) — de ska följa
förlagans konturer. Mät upp delarna i förstorade utsnitt med tätt rutnät
(10 px) och tänk på vad som ligger framför vad (bommens rundade spets ligger
framför stickan, så stickan ritas först).

## Bildstil
Alla bilder är ritade i en finare målarboksstil: tunna jämna konturer
(`kant = 4–5`), verkliga proportioner (fordonen från sidan, skalade efter
riktiga mått — se kommentaren över varje `ritaXxx`), fler och mindre ytor
(fönster, dörrar, motordelar) är OK nu när man målar över i stället för att
trycka, sol utan ansikte och en lugn bakgrund med tunna linjer
(`faltBakgrund` för fordonen, `luftBakgrund` för flygplanet). Hjälpare:
`hjul()` (däck med klackar, fälg, nav), `hjulSnett()` (samma i perspektiv),
`band()` (böjd bom/sticka längs en
bezierkurva), `sol()`, `moln()`. Tänk på vad som skymmer vad (t.ex. motorn
under flygplanets vinge: rita den före vingen så bara fronten syns).

## Lägga till en ny bild
1. Skriv `ritaXxx(ctx)` (se `ritaTraktor`/`ritaGravmaskin`; börja med
   `stilSatt(ctx)`, `kant = 4`, bakgrunden och sedan `kant = 5`). Ge varje `form()` sin
   givna färg som tredje argument (lägg nya färger i `F`, lugna toner). Se
   **Bildstil** ovan. Detaljer (bultar, springor, galler, fogar) ritas som
   `prick()` eller tunna `linje()`-streck med fria ändar så de inte blir
   egna ytor. Slå ihop delar som hör ihop (t.ex. skopa och tänder, rör och
   ljuddämpare) till en `form()`. Lägg bilden i
   `PICTURES` med ett gömställe för Clawd (`clawd: {...}`). Bläddra-knapparna
   hittar den automatiskt.
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
  små ytor. Det är OK (de får rätt färg), men flytta gärna delar så kilen
  hänger ihop med stora himlen/marken.
- Testa genom att måla över hela bilden (t.ex. Playwright med musdrag i
  sicksack) och titta på skärmbilden: varje yta ska ha fått rätt färg.

## Konventioner
- Svenska i UI och kommentarer. Ingen byggpipeline, inga dependencies.
- Tänk på multi-touch och `stopPropagation` på nya knappar.
