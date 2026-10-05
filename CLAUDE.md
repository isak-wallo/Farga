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
- Bilder (i ordning): fyra från sidan (traktor, grävmaskin, flygplan på
  banan, helikopter på plattan), fem i perspektiv (traktor, grävmaskin,
  helikopter, stort flygplan, propellerplan) — alla nio rena AI-sidor i
  samma stil, se "Rena sidor" nedan — samt fyra äldre bilder spårade från
  förlagor ägaren skickade: litet flygplan på gräset, helikopter på stigen,
  helikopter i luften och flygplan vid flygfältet (se "Verkliga bilder").
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
  fyller himmel och kullar i färgläget.
  `kant` styr formernas kantbredd (nollställs till `LW` före varje bild).
  Hjälpare: `form()` ritar en
  *sluten* form och raderar det som ligger bakom (destination-out), så
  överlappande delar skymmer varandra; `linje()` ritar ett löst streck;
  `ellips()`, `sol()`, `moln()`;
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
- Ritfunktionen (t.ex. `ritaFlygplanLitet`, `ritaHelikopterLuft`) ritar
  bilden på `lineCanvas` (och kan lägga till egna `moln()`/`sol()` i
  tillagd himmel), och i färgläget en **grov färgkarta** (`fyllPoly`,
  `fyllEllips` i bildens koordinater, rutnätsbilden hjälper) som ungefär
  täcker varje del.
- Färgning: små eller tydliga ytor tar kartans dominerande färg. Stora ytor
  utan tydlig färg ("blandade", t.ex. himmel och mark som läcker ihop genom
  glapp i linjerna) städas i `stadaBlandade` så att färggränserna följer
  linjerna i stället för kartans grova kanter: (1) linjerna görs tillfälligt
  `GLAPP` px tjockare så glappen sluts, och delar med tydlig färg får den;
  (2) i delar som fortfarande är blandade krymps varje färgfläck i kartan
  till en kärna (`KARNA` px in, fläckar tunnare än `TUNN_FLACK` hoppas
  över); (3) resten fylls bredden-först från närmaste klara pixel i samma
  yta — först bara in där kartan har samma färg, sedan överallt. I ytor på
  själva fordonet tar smala bitar kartans färg direkt (stolpar, springor),
  i bakgrundsytor (`BAKGRUND_F`) fylls de från grannarna. En yta/del får
  bara en enda färg om den dominerar (`DOMINANS`), resten är litet
  (`REST_MAX`) och den inte innehåller skyddad bakgrundsfärg (`SKYDDAD_MIN`).
- **`helaYtor: true`** (alla fyra äldre bilder): varje yta får en enda
  färg (den som täcker flest pixlar i kartan, `helaYtor()`), så färgen
  alltid stannar inom linjerna. Bara de riktigt stora läckande ytorna
  (`STOR_YTA`, himmel/mark/stig som hänger ihop genom glapp) färgas pixel
  för pixel i `delaStoraYtor()`: fordonsfärger tas bort ur kartan där,
  linjerna görs `GLAPP` px tjockare, varje del som domineras av en färg
  får bara den, och pixlarna närmast linjerna fylls från närmaste del.
  Glapp som ändå läcker stängs med korta streck i `tillagg: [[x1, y1, x2,
  y2, …], …]` (ritas på linjelagret före numreringen), och enstaka ytor
  rättas med `farger`-punkter. Hitta glappen genom att leta efter
  färggränser i kartan som ligger mer än 8 px från närmaste linje.
- **Kartan ska följa linjerna.** Mät upp linjernas lägen längs kolumner
  (skriv ut var alfa > 128 längs x = 0, 25, 50 …) och lägg kartans
  hörnpunkter efter dem, i stället för att gissa från en översiktsbild.
- **Kontroll av alla bilder:** ladda varje bild, fyll alla ytor
  (`regionDone`/`commitRegion`) och spara både linjerna och den färglagda
  bilden i full upplösning; titta på förstorade kvadranter. Gör det efter
  varje ändring av kartor eller färgningen.

### Rena sidor (Gemini) med färg från punkter (`ritaFil`, `fargaFranPunkter`)
Bästa vägen till nya bilder: be en bildgenerator (Gemini gav bäst
resultat) om en svartvit målarbokssida i samma stil som de befintliga, med
alla regler i första prompten (slutna ytor, jämna linjer, bultar som fyllda
prickar, inga tunna dubbellinjer). Den är dålig på att ändra i efterhand:
börja hellre om i en ny chatt med traktorsidan bifogad som stilförebild
(så gjordes helikoptern), och be om strikt sidovy utan perspektiv.
Traktorn snett framifrån gjordes i ägarens "Image Studio" (Gemini 3 Pro
Image): Quality Pro, stilförval Photorealistic avvalt, 4:3, traktorsidan
som referensbild och en negativ prompt mot skuggning, gråtoner, papper,
ram och text. Den klarar perspektiv bra. Däckmönster ger många små celler
(fylls direkt) — titta efter skymda delar, t.ex. bortre bakhjulet som
syns under traktorn och ska ha däckfärg, inte markens. Övriga
perspektivbilder har traktorn snett framifrån som referensbild. Image
Studio kan slå på Photorealistic igen (blev ett färgfoto): välj Minimalist
aktivt, börja prompten med "BLACK AND WHITE LINE DRAWING ONLY" och lägg
"photo, photorealistic, 3D render" i den negativa prompten. Formatet 4:3
hålls inte alltid: kom bilden kvadratisk breddas den i `linjer.py` med en
beskärning utanför bilden (`bredda`, kantkolumnerna upprepas så kullarnas
linjer fortsätter vågrätt); 16:9 är lättare (beskärs i sidled). Vanliga
Gemini-chatten funkar också (propellerplanet) — skriv "4:3, wider than
tall" och be om att hela fordonet ska synas med luft till kanterna, annars
zoomar den in för mycket.
- `verktyg/linjer.py` med typ `'skarp'`: tröskar mitt i linjekanten efter
  lätt brusreducering och sparar i full upplösning; `vektor.py` spårar där
  och skalar ner banorna till 1200 px — mjuka kurvor och rätt linjebredd.
  Jämför SVG:n med förlagan i förstorade kvadranter. Glapp i förlagan som
  gör att en del av fordonet hänger ihop med bakgrunden (t.ex. under
  traktorns bakskärm) stängs med ett kort streck i `TILLAGG` i linjer.py.
  Titta på varje del: grävmaskinen tar version 8 av Gemini-sidan eftersom
  den senare versionen tappade länken mellan cylindern och skopan.
- Ytorna är helt slutna, så ingen färgkarta behövs: PICTURES-posten har
  `rita: ritaFil` och `farger: { [F.xxx]: [[x, y], ...] }` med en punkt
  inne i varje yta. `fargaFranPunkter` ger varje yta färgen från sin punkt;
  ytor utan punkt (små celler) tar färgen från närmaste färgade yta.
  Punkt på en linje varnas i konsolen.
- Ta fram punkterna ur appens egna ytor (`labels` efter laddning): numrera
  dem, ta den inre punkt som ligger längst från kanten i varje yta och
  titta på en numrerad, förstorad karta. Ge varje yta en färg.
- Kullarna färgas i djupled, ljusast längst bort: `fjarrkulle`, `kulle2`,
  `akerkulle`, `mark` (gräset längst fram). Rutor på fordon: `fonster` (lite
  djupare än himlen). Glipor där bakgrunden syns mellan maskindelar får
  bakgrundens färg (kullen/himlen bakom), smala remsor på maskinen
  maskinens färg.

## Bildstil
**Önskemål för nya bilder:** mer tecknat och barnsligt, lite mindre
verklighetstroget — som det blå flygplanet på gräset, inte som de mer
detaljerade gula och röd-vita planen. Enkla runda former, färre
detaljer (inga nitar, ventiler, ekrar).

Alla bilder är i en finare målarboksstil: jämna konturer, verkliga
proportioner, fler och mindre ytor (fönster, dörrar, motordelar) är OK nu
när man målar över i stället för att trycka, sol utan ansikte och en lugn
bakgrund (mjuka kullar, runda träd, sol bakom moln). Tänk på vad som
skymmer vad.

## Lägga till en ny bild
1. Ta fram en ren sida från en bildgenerator (se "Rena sidor" ovan) och
   lägg till den i `BILDER` i `verktyg/linjer.py` (typ `'skarp'`), kör
   `linjer.py` och `vektor.py`. Jämför SVG:n med förlagan.
2. Lägg en post i `PICTURES` (`rita: ritaFil`, `bild: '...'`, `farger`)
   med ett gömställe för Clawd. Ta fram en punkt per yta ur appens `labels`
   och ge varje yta sin färg (nya färger i `F`, lugna toner).
3. Fyll alla ytor och titta på förstorade utsnitt: varje yta ska ha rätt
   färg och Clawd ska kika fram. Lägg SVG:n i `ASSETS` och bumpa `VERSION`
   i `sw.js`.

## Fallgropar när man ritar (gäller främst kodritade bilder; inga finns kvar
utom bakgrunden i de äldre spårade bilderna)
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
