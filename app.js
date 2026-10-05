document.addEventListener('DOMContentLoaded', () => {
    const viewCanvas = document.getElementById('viewCanvas');
    const vCtx = viewCanvas.getContext('2d');
    const canvasContainer = document.getElementById('canvas-container');

    // Element-referenser — deklarerade först så att funktionerna nedan
    // aldrig kan råka använda dem före deklarationen.
    const startOverlay = document.getElementById('start-overlay');
    const restartBtn = document.getElementById('restart-btn');
    const saveBtn = document.getElementById('save-btn');
    const app = document.getElementById('app');

    // Bilden är 1200x900 (landskap). Lager:
    //  - lineCanvas: bara konturerna (genomskinlig bakgrund)
    //  - colorCanvas: facit — bilden ritad med sina givna färger (syns
    //    aldrig, används bara för att ta reda på varje ytas färg)
    //  - fillCanvas: det barnet målat fram (vitt där inget är målat)
    //  - viewCanvas: det som syns — fillCanvas med lineCanvas ovanpå
    // Områdena (ytor omringade av linjer) numreras en gång när bilden
    // laddas (`labels`), och varje område får sin färg från colorCanvas.
    const PAPER_W = 1200;
    const PAPER_H = 900;
    const lineCanvas = document.createElement('canvas');
    lineCanvas.width = PAPER_W;
    lineCanvas.height = PAPER_H;
    const lCtx = lineCanvas.getContext('2d', { willReadFrequently: true });
    const colorCanvas = document.createElement('canvas');
    colorCanvas.width = PAPER_W;
    colorCanvas.height = PAPER_H;
    const cCtx = colorCanvas.getContext('2d', { willReadFrequently: true });
    const fillCanvas = document.createElement('canvas');
    fillCanvas.width = PAPER_W;
    fillCanvas.height = PAPER_H;
    const fCtx = fillCanvas.getContext('2d');
    const fillImage = fCtx.createImageData(PAPER_W, PAPER_H);
    const fillPx = new Uint32Array(fillImage.data.buffer);

    // Omålat papper. Canvas-pixlar lagras som ABGR (little-endian) i en
    // Uint32Array; vitt är samma åt båda hållen.
    const PAPER = 0xFFFFFFFF;
    const BAKGRUND = '#dcecf8';   // runt bilden (samma ljusblå som Poppas himmel)

    let clearState = 0;
    let clearTimer = null;
    let viewRect = { left: 0, top: 0 };
    // --- Håll-in-logik för BÖRJA OM och SPARA ---
    // Man måste hålla fingret intryckt i HOLD_MS (ca 1 s). BÖRJA OM: första
    // hållningen visar SÄKER?, andra hållningen tömmer bilden. SPARA: en
    // hållning sparar bilden. En kort tryckning gör inget — så att ett barn
    // inte råkar sudda allt (eller fylla plattan med bilder) av misstag.
    const HOLD_MS = 1000;
    // Synka håll-animationens längd i CSS med HOLD_MS (--hold-ms används
    // av .sys-btn.holding i style.css).
    document.documentElement.style.setProperty('--hold-ms', HOLD_MS + 'ms');
    let holdTimer = null;

    function startHold(btn) {
        if (holdTimer) clearTimeout(holdTimer);
        holdTimer = setTimeout(() => {
            holdTimer = null;
            btn.classList.remove('holding');
            if (btn === saveBtn) sparaBild();
            else handleClear();
        }, HOLD_MS);
    }

    function endHold() {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    }

    function resizeCanvas() {
        if (!canvasContainer) return;
        const w = canvasContainer.clientWidth;
        const h = canvasContainer.clientHeight;
        // Att sätta width/height nollställer HELA canvas-bufferten även om
        // storleken är oförändrad — gör det bara vid faktisk ändring, så
        // slipper varje applyLayout kosta en omallokering.
        if (viewCanvas.width !== w || viewCanvas.height !== h) {
            viewCanvas.width = w;
            viewCanvas.height = h;
        }
        viewRect = viewCanvas.getBoundingClientRect();
        requestRender();
    }

    // Layoutlås
    let lockedW = 0, lockedH = 0;
    let lockLandscape = null;
    let shrinkTimer = null;

    // Hur länge (ms) en MINDRE layout-viewport måste bestå innan låset
    // släpper och appen krymper till den. Transienta systemfält i immersive
    // fullscreen ändrar aldrig innerWidth/innerHeight och triggar inte detta.
    // En bestående mindre viewport är ett äkta lägesbyte — t.ex. skärmlåsning
    // (pinning) som tvingar fram status-/navigeringsfält och förskjuter hela
    // fönstret nedåt så knapparna annars klipps vid skärmens nederkant.
    const SHRINK_ADOPT_MS = 400;

    // Statisk dö-yta: en permanent svart remsa som alltid finns där.
    // Garanterar att Androids systemknappar (bakåt/hem/översikt) hamnar
    // framför svart dö-yta istället för framför knapparna eller ritytan.
    // safe-area-inset fungerar inte i installerad standalone-app (inset = 0),
    // därför en fast remsa. 48 px ≈ en systemknappshöjd.
    // Sidan beror på enhet: telefon i landskap har systemknapparna på en
    // långsida (höger), tablet i botten. Vi skiljer på skärmhöjd: låst
    // höjd < 550 px räknas som telefon (dö-yta till höger), annars tablet
    // (dö-yta i botten).
    // Den statiska remsan sätts bara på Android — på iPad/dator finns inga
    // systemknappar över appen, så där skulle den bara ta plats.
    const DEAD_ZONE = 48;
    const PHONE_LANDSCAPE_MAX_H = 550;
    const IS_ANDROID = /Android/i.test(navigator.userAgent);

    function applyLayout() {
        const isLandscape = window.innerWidth > window.innerHeight;
        const w = window.innerWidth;
        const h = window.innerHeight;

        if (lockLandscape === null || isLandscape !== lockLandscape) {
            lockLandscape = isLandscape;
            lockedW = w;
            lockedH = h;
            if (shrinkTimer) { clearTimeout(shrinkTimer); shrinkTimer = null; }
        } else {
            if (w > lockedW) lockedW = w;
            if (h > lockedH) lockedH = h;
        }

        // Mindre viewport än låset? Anta den nya storleken om den består.
        if (w < lockedW || h < lockedH) {
            if (shrinkTimer) clearTimeout(shrinkTimer);
            shrinkTimer = setTimeout(() => {
                shrinkTimer = null;
                const w2 = window.innerWidth;
                const h2 = window.innerHeight;
                if ((w2 > h2) === lockLandscape && (w2 < lockedW || h2 < lockedH)) {
                    lockedW = w2;
                    lockedH = h2;
                    applyLayout();
                }
            }, SHRINK_ADOPT_MS);
        }

        if (app) {
            app.style.width = lockedW + 'px';
            app.style.height = lockedH + 'px';
            // Dö-yta: telefon (låst höjd < 550 px) -> svart remsa till höger,
            // tablet -> svart remsa i botten. + extra dynamisk padding om
            // visualViewport indikerar synliga systemfält (t.ex. vid
            // skärmlåsning/pinning där hela fönstret förskjuts). I immersive
            // fullscreen är den dynamiska delen 0.
            const isPhone = lockedH < PHONE_LANDSCAPE_MAX_H;
            let staticPad = IS_ANDROID ? DEAD_ZONE : 0;
            let dynPad = 0;
            if (window.visualViewport) {
                const dyn = isPhone
                    ? lockedW - window.visualViewport.width - window.visualViewport.offsetLeft
                    : lockedH - window.visualViewport.height - window.visualViewport.offsetTop;
                if (dyn > 0) dynPad = dyn;
            }
            if (isPhone) {
                app.style.paddingRight = (staticPad + dynPad) + 'px';
                app.style.paddingBottom = '';
            } else {
                app.style.paddingBottom = (staticPad + dynPad) + 'px';
                app.style.paddingRight = '';
            }
        }
        resizeCanvas();
    }

    // --- Bilder ---
    // Varje bild är en funktion som ritas två gånger: först konturerna på
    // lineCanvas, sedan (med `fargLage` = true) samma former ifyllda med
    // sina givna färger på colorCanvas. I färgläget fyller form() banan med
    // sin färg och linje()/prick() gör ingenting.
    // Fler bilder läggs till i PICTURES.
    const LW = 8;     // linjebredd (yttre kant av formerna, se form())
    const TUNN = 4;   // tunn linje för detaljer (springor, fogar, slitbana)
    const LINJEFARG = '#3a3a44';   // mjukt mörkgrå konturer i stället för kolsvart
    let fargLage = false;
    // Kantens bredd för form() (synlig del, utanför banan). Bilder i den
    // finare målarboksstilen (flygplanet) sätter en tunnare kant.
    let kant = LW;

    // Givna färger — lugna, lite mjukare än rena grundfärger.
    const F = {
        himmel: '#cfe6f7',
        sol:    '#f8d66d',
        moln:   '#e6edf5',
        trad:   '#8cc47e',
        rod:    '#e2655a',
        morkrod:'#c4524a',
        gul:    '#f3c34f',
        glas:   '#cfe8f6',
        dack:   '#5c5f68',
        falg:   '#f2d06b',
        stal:   '#a3a9b0',
        ljusstal: '#ccd1d6',
        morkstal: '#6f747c',
        stam:   '#a8845c',
        grus:   '#e8d6ad',
        flygkropp: '#eef2f7',
        buk:    '#7aa6da',
        fena:   '#5b8fd0',
        vinge:  '#c5ccd5',
        ruta:   '#4d6886',
        jord:   '#cfae84',
        fjarrkulle: '#c6e2b3',
        akerkulle:  '#a9d494',
        kulle2:     '#b7dba1',   // kulle mellan fjärr- och åkerkullen
        mark:       '#9ccb85',   // gräset längst fram
        morkgul:    '#dcab3c',
        asfalt:     '#b9bdc4',
        vit:        '#f7f7f2',
        orange:     '#f2a05a',
        gron:       '#6cbf86',
        vatten:     '#a7d3ec',   // båtens hav
        vag:        '#cde6f5',   // sopbilen
        morkgron:   '#4f9e6b',
        fonster:    '#b3d8f0'    // lite djupare än himlen så rutan inte ser ut som ett hål
    };

    function rr(ctx, x, y, w, h, r) {
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function cirkel(ctx, x, y, r) {
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
    }

    // En stång (t.ex. hydraulcylinder) mellan två punkter. Banorna ritas
    // medurs, som övriga hjälpare — blandade riktningar i samma form kan
    // annars ta ut varandra där de överlappar.
    function stav(ctx, x1, y1, x2, y2, w) {
        const l = Math.hypot(x2 - x1, y2 - y1);
        const nx = (y2 - y1) / l * w / 2;
        const ny = -(x2 - x1) / l * w / 2;
        ctx.moveTo(x1 + nx, y1 + ny);
        ctx.lineTo(x2 + nx, y2 + ny);
        ctx.lineTo(x2 - nx, y2 - ny);
        ctx.lineTo(x1 - nx, y1 - ny);
        ctx.closePath();
    }

    // En månghörning av punkter [x, y] (ange dem medurs).
    function mangel(ctx, pts) {
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
    }

    // En sluten form: ritar kanten utanför banan och raderar allt inuti,
    // så att det som ligger bakom (t.ex. markens linje bakom ett hjul)
    // skyms. Flera delbanor i samma form smälter ihop till en kontur.
    // `farg` är formens givna färg (fylls i på colorCanvas i färgläget).
    function form(ctx, bygg, farg) {
        ctx.beginPath();
        bygg(ctx);
        if (fargLage) {
            ctx.fillStyle = farg;
            ctx.fill();
            return;
        }
        ctx.lineWidth = kant * 2;
        ctx.stroke();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
    }

    // Ett löst streck (stängs inte till ett område).
    function linje(ctx, bygg, bredd) {
        if (fargLage) return;
        ctx.beginPath();
        bygg(ctx);
        ctx.lineWidth = bredd || LW;
        ctx.stroke();
    }

    function ellips(ctx, x, y, rx, ry) {
        ctx.moveTo(x + rx, y);
        ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    }

    // En liten svart prick (bult, nav, stödhjul). Ren färg, ingen yta att färga.
    function prick(ctx, x, y, r) {
        if (fargLage) return;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }

    // Ett träd: stam och krona i ett enda färgbart stycke.
    function trad(ctx, x, y, s) {
        form(ctx, c => {
            rr(c, x - 7 * s, y - 40 * s, 14 * s, 80 * s, 4);
            cirkel(c, x - 28 * s, y - 62 * s, 32 * s);
            cirkel(c, x + 2 * s, y - 92 * s, 38 * s);
            cirkel(c, x + 32 * s, y - 60 * s, 30 * s);
            rr(c, x - 50 * s, y - 62 * s, 100 * s, 36 * s, 18 * s);
        }, F.trad);
    }

    // Moln (sluten form) och sol utan ansikte, i den finare stilen.
    function moln(ctx, x, y, s) {
        form(ctx, c => {
            cirkel(c, x - 55 * s, y, 32 * s);
            cirkel(c, x, y - 28 * s, 42 * s);
            cirkel(c, x + 55 * s, y - 4 * s, 34 * s);
            rr(c, x - 87 * s, y - 2 * s, 176 * s, 36 * s, 18 * s);
        }, F.moln);
    }

    function sol(ctx, x, y) {
        form(ctx, c => cirkel(c, x, y, 44), F.sol);
        for (let k = 0; k < 12; k++) {
            const v = k * Math.PI / 6 + 0.1;
            linje(ctx, c => {
                c.moveTo(x + Math.cos(v) * 58, y + Math.sin(v) * 58);
                c.lineTo(x + Math.cos(v) * 76, y + Math.sin(v) * 76);
            }, 4);
        }
    }

    // --- Verkliga bilder (från förlagor ägaren skickade) ---
    // Konturerna kommer från en bildfil (bilder/*.png, genomskinlig med
    // mörkgrå linjer, 1200x900) i stället för att ritas med kod. Färgerna
    // kommer från en grov färgkarta: former som ungefär täcker varje del.
    // Varje yta tar den färg som dominerar i kartan; ytor som läcker ihop
    // (glapp i blyertslinjerna) färgas pixel för pixel efter kartan.
    function fyllPoly(ctx, farg, pts) {
        ctx.beginPath();
        mangel(ctx, pts);
        ctx.fillStyle = farg;
        ctx.fill();
    }
    function fyllEllips(ctx, farg, x, y, rx, ry) {
        ctx.beginPath();
        ellips(ctx, x, y, rx, ry);
        ctx.fillStyle = farg;
        ctx.fill();
    }

    // Rena sidor med helt slutna ytor (t.ex. från Gemini): bara konturerna
    // ritas, och varje yta får sin färg från en punkt i den (`farger` i
    // PICTURES, fargaFranPunkter) — ingen färgkarta behövs.
    function ritaFil(ctx, pic) {
        if (!fargLage) ctx.drawImage(pic.img, 0, 0);
    }

    // Litet propellerplan på gräset (förlaga: ägarens målarbokssida).
    function ritaFlygplanLitet(ctx, pic) {
        if (!fargLage) { ctx.drawImage(pic.img, 0, 0); return; }
        // Färgkartan följer förlagans linjer (uppmätta längs kolumner).
        ctx.fillStyle = F.akerkulle;
        ctx.fillRect(0, 0, PAPER_W, PAPER_H);
        fyllPoly(ctx, F.himmel, [[0, 0], [1200, 0], [1200, 205], [1000, 212], [740, 232], [640, 238],
            [560, 215], [490, 208], [400, 238], [300, 248], [150, 255], [0, 262]]);
        fyllPoly(ctx, F.himmel, [[0, 0], [1200, 0], [1200, 200], [960, 120], [730, 125], [570, 145],
            [400, 95], [300, 110], [220, 150], [0, 185]]);
        fyllPoly(ctx, F.fjarrkulle, [[220, 150], [300, 110], [400, 95], [570, 145], [730, 125], [740, 232],
            [640, 238], [560, 215], [490, 208], [400, 238], [220, 245]]);
        // Stigen: under planet, till höger om stjärten och längst ner till vänster
        fyllPoly(ctx, F.grus, [[0, 806], [40, 789], [80, 778], [120, 760], [200, 738], [280, 714], [330, 716],
            [420, 735], [560, 700], [780, 636], [960, 560], [1000, 470], [1040, 397], [1060, 387],
            [1100, 401], [1140, 427], [1180, 455], [1200, 470], [1200, 740], [1160, 772], [1120, 822],
            [1080, 846], [1040, 884], [1030, 900], [0, 900]]);
        // Träd, buskar och ladan
        fyllPoly(ctx, F.trad, [[80, 0], [367, 0], [358, 22], [332, 42], [312, 72], [280, 88], [253, 96],
            [222, 96], [182, 86], [145, 90], [118, 78], [95, 52], [88, 26]]);
        fyllEllips(ctx, F.trad, 95, 155, 60, 58);
        fyllEllips(ctx, F.trad, 1098, 95, 68, 70);
        fyllPoly(ctx, F.trad, [[234, 250], [234, 216], [256, 206], [286, 190], [320, 192], [340, 214],
            [366, 228], [392, 242], [398, 258], [234, 258]]);
        fyllEllips(ctx, F.trad, 670, 222, 45, 16);
        fyllEllips(ctx, F.trad, 1050, 205, 90, 14);
        fyllPoly(ctx, F.stam, [[186, 92], [218, 96], [228, 250], [182, 250]]);
        fyllPoly(ctx, F.stam, [[88, 160], [104, 160], [104, 252], [88, 252]]);
        fyllPoly(ctx, F.stam, [[1086, 110], [1104, 110], [1104, 215], [1086, 215]]);
        fyllPoly(ctx, F.morkrod, [[732, 140], [800, 62], [870, 140], [1000, 175], [1000, 232], [732, 236]]);
        fyllPoly(ctx, F.ljusstal, [[800, 58], [905, 72], [970, 140], [875, 140]]);
        fyllPoly(ctx, F.flygkropp, [[768, 150], [840, 150], [840, 228], [768, 228]]);

        // Planets kropp (blå) från nosen till stjärten, med fenan
        fyllPoly(ctx, F.buk, [[190, 700], [190, 520], [300, 474], [348, 458], [378, 420], [402, 388],
            [426, 370], [450, 362], [500, 355], [550, 356], [600, 360], [650, 371], [700, 387], [750, 411],
            [800, 434], [850, 448], [905, 444], [935, 380], [960, 330], [978, 296], [1010, 282],
            [1034, 294], [1036, 484], [1028, 528], [980, 552], [940, 572], [900, 590], [860, 608],
            [820, 625], [780, 634], [560, 700], [420, 728], [260, 715]]);
        // Rutor (en bit innanför linjerna)
        fyllPoly(ctx, F.glas, [[388, 466], [408, 422], [428, 388], [462, 386], [500, 390], [528, 396],
            [530, 500], [480, 490], [440, 482], [400, 476]]);
        fyllPoly(ctx, F.glas, [[560, 410], [640, 412], [652, 426], [648, 494], [560, 500]]);
        fyllPoly(ctx, F.glas, [[688, 424], [740, 438], [744, 486], [690, 492]]);
        // Vinge (vit), med klaffen
        fyllPoly(ctx, F.flygkropp, [[476, 652], [500, 640], [580, 612], [660, 605], [700, 608], [740, 620],
            [780, 636], [820, 653], [860, 669], [900, 687], [940, 705], [980, 725], [1020, 745], [1062, 774],
            [1062, 784], [1020, 812], [980, 816], [940, 812], [900, 804], [860, 793], [820, 781],
            [780, 769], [740, 756], [660, 731], [580, 705], [500, 684], [474, 668]]);
        // Bortre vingens spets till vänster om nosen (vit)
        fyllPoly(ctx, F.flygkropp, [[70, 520], [100, 514], [150, 512], [200, 512], [200, 590], [150, 582],
            [120, 580], [96, 566], [72, 540]]);
        // Höjdroder (vitt)
        fyllPoly(ctx, F.flygkropp, [[940, 508], [980, 497], [1020, 495], [1060, 500], [1100, 512],
            [1140, 526], [1146, 544], [1100, 549], [1060, 544], [1020, 538], [980, 530], [940, 520]]);
        // Motorkåpa, nos och propeller
        fyllEllips(ctx, F.ljusstal, 230, 600, 45, 80);
        fyllEllips(ctx, F.sol, 160, 610, 45, 40);
        fyllPoly(ctx, F.morkstal, [[120, 390], [160, 375], [195, 470], [195, 560], [160, 565]]);
        fyllPoly(ctx, F.morkstal, [[180, 640], [215, 640], [270, 800], [250, 820], [205, 760]]);
        // Hjul och ben
        fyllEllips(ctx, F.dack, 290, 835, 45, 50);
        fyllEllips(ctx, F.ljusstal, 295, 838, 16, 20);
        fyllEllips(ctx, F.dack, 692, 822, 52, 58);
        fyllEllips(ctx, F.ljusstal, 708, 830, 18, 24);
        fyllPoly(ctx, F.stal, [[300, 728], [340, 722], [320, 790], [290, 785]]);
        fyllPoly(ctx, F.stal, [[620, 700], [650, 700], [680, 770], [655, 775]]);
    }

    // Röd helikopter som står på stigen (förlaga: ägarens målarbokssida).
    function ritaHelikopterStig(ctx, pic) {
        if (!fargLage) { ctx.drawImage(pic.img, 0, 0); return; }
        ctx.fillStyle = F.akerkulle;
        ctx.fillRect(0, 0, PAPER_W, PAPER_H);
        fyllPoly(ctx, F.himmel, [[0, 0], [1200, 0], [1200, 95], [1050, 90], [870, 48], [780, 52],
            [690, 85], [500, 38], [400, 20], [230, 60], [0, 60]]);
        fyllPoly(ctx, F.fjarrkulle, [[0, 60], [230, 60], [400, 20], [500, 38], [690, 85], [780, 52],
            [870, 48], [1050, 90], [1200, 95], [1200, 190], [1000, 180], [780, 240], [520, 220],
            [250, 150], [0, 150]]);
        fyllPoly(ctx, F.grus, [[0, 830], [110, 775], [300, 718], [500, 700], [780, 598], [900, 625],
            [1000, 700], [990, 780], [930, 850], [860, 900], [0, 900]]);
        // Träd, buskar och staket
        fyllEllips(ctx, F.trad, 110, 115, 70, 40);
        fyllEllips(ctx, F.trad, 300, 135, 65, 35);
        fyllEllips(ctx, F.trad, 1070, 155, 130, 32);
        fyllEllips(ctx, F.trad, 1030, 15, 90, 30);
        fyllEllips(ctx, F.trad, 1160, 15, 50, 30);
        fyllPoly(ctx, F.stam, [[170, 0], [235, 0], [240, 150], [180, 150]]);
        fyllPoly(ctx, F.stam, [[1040, 30], [1080, 30], [1080, 185], [1040, 185]]);
        // Staket: två slanor och två stolpar (gräset syns mellan dem)
        fyllPoly(ctx, F.stam, [[1004, 287], [1200, 287], [1200, 298], [1004, 298]]);
        fyllPoly(ctx, F.stam, [[1004, 335], [1200, 335], [1200, 346], [1004, 346]]);
        fyllPoly(ctx, F.stam, [[1034, 262], [1050, 262], [1050, 376], [1034, 376]]);
        fyllPoly(ctx, F.stam, [[1135, 262], [1151, 262], [1151, 376], [1135, 376]]);
        // Helikoptern: kropp (röd), nos nertill (ljus), rutor, rotor och medar
        fyllPoly(ctx, F.rod, [[230, 600], [270, 480], [340, 400], [490, 370], [500, 320], [640, 315],
            [720, 340], [760, 400], [790, 470], [800, 560], [760, 640], [650, 690], [500, 720],
            [330, 720], [240, 660]]);
        fyllPoly(ctx, F.rod, [[780, 445], [940, 455], [940, 500], [790, 550]]);
        fyllPoly(ctx, F.rod, [[915, 450], [960, 330], [995, 330], [975, 470], [985, 580], [950, 585]]);
        // Hakrutan under vindrutan (ljusgrå) och vindrutan, uppmätta efter linjerna
        fyllPoly(ctx, F.ljusstal, [[244, 590], [262, 560], [282, 547], [320, 543], [360, 544], [400, 551],
            [440, 562], [480, 575], [492, 580], [492, 604], [480, 609], [460, 618], [420, 628], [380, 633],
            [340, 634], [300, 633], [260, 628], [244, 620]]);
        fyllPoly(ctx, F.glas, [[276, 520], [300, 472], [322, 444], [345, 420], [380, 402], [420, 410],
            [460, 396], [488, 400], [490, 556], [480, 567], [440, 554], [400, 543], [360, 536], [320, 535],
            [284, 538]]);
        fyllPoly(ctx, F.glas, [[545, 435], [632, 430], [638, 570], [542, 570]]);
        fyllPoly(ctx, F.glas, [[668, 438], [735, 440], [740, 550], [670, 552]]);
        fyllPoly(ctx, F.morkstal, [[225, 242], [540, 248], [545, 272], [228, 276]]);
        fyllPoly(ctx, F.morkstal, [[622, 248], [945, 256], [945, 284], [624, 276]]);
        fyllPoly(ctx, F.stal, [[540, 215], [620, 215], [620, 320], [545, 320]]);
        // Stjärtrotorns tre blad
        fyllPoly(ctx, F.morkstal, [[1014, 412], [1030, 402], [1046, 416], [1040, 445], [1030, 462],
            [1010, 462], [1008, 440]]);
        fyllPoly(ctx, F.morkstal, [[990, 500], [1018, 500], [1020, 530], [1016, 550], [1000, 558],
            [986, 550], [984, 520]]);
        fyllPoly(ctx, F.morkstal, [[942, 472], [980, 470], [996, 480], [984, 494], [944, 496]]);
        fyllPoly(ctx, F.morkstal, [[232, 782], [525, 752], [532, 778], [240, 815]]);
        fyllPoly(ctx, F.morkstal, [[465, 822], [800, 765], [812, 792], [472, 852]]);
        fyllPoly(ctx, F.morkstal, [[320, 715], [360, 715], [340, 780], [318, 780]]);
        fyllPoly(ctx, F.morkstal, [[690, 680], [740, 680], [765, 780], [735, 780]]);
        fyllPoly(ctx, F.morkstal, [[540, 720], [590, 720], [590, 840], [555, 840]]);
        fyllPoly(ctx, F.morkstal, [[470, 720], [500, 720], [495, 760], [470, 760]]);
    }

    // Blå helikopter i luften (förlaga: ägarens målarbokssida). Himlen ovanför
    // är tillagd med appens egna moln och sol.
    function ritaHelikopterLuft(ctx, pic) {
        kant = 4;
        if (!fargLage) ctx.drawImage(pic.img, 0, 0);
        else {
            ctx.fillStyle = F.himmel;
            ctx.fillRect(0, 0, PAPER_W, PAPER_H);
            fyllPoly(ctx, F.akerkulle, [[0, 790], [250, 800], [430, 850], [600, 870], [800, 815],
                [1000, 805], [1200, 795], [1200, 900], [0, 900]]);
            // Molnen, uppmätta längs sina konturer
            fyllPoly(ctx, F.moln, [[0, 578], [15, 570], [30, 559], [45, 558], [60, 541], [75, 530], [90, 527],
                [105, 529], [120, 538], [135, 563], [150, 563], [165, 572], [180, 578], [192, 592], [195, 610],
                [0, 612]]);
            fyllPoly(ctx, F.moln, [[808, 756], [820, 743], [835, 740], [850, 725], [865, 723], [880, 710],
                [895, 700], [910, 700], [925, 707], [940, 731], [955, 733], [970, 743], [982, 750], [984, 763],
                [808, 764]]);
            fyllEllips(ctx, F.trad, 70, 770, 75, 60);
            fyllEllips(ctx, F.trad, 150, 820, 40, 35);
            fyllEllips(ctx, F.trad, 1130, 790, 70, 50);
            fyllEllips(ctx, F.trad, 1040, 840, 50, 40);
            fyllEllips(ctx, F.trad, 750, 885, 60, 25);
            // Helikoptern: kropp, stjärtbom och fena (blå)
            fyllPoly(ctx, F.fena, [[190, 690], [230, 600], [300, 540], [420, 500], [480, 465], [700, 470],
                [760, 540], [780, 600], [770, 700], [700, 752], [500, 772], [300, 762], [200, 732]]);
            fyllPoly(ctx, F.fena, [[740, 550], [1000, 580], [1000, 632], [760, 662]]);
            fyllPoly(ctx, F.fena, [[995, 585], [1068, 392], [1108, 396], [1082, 612], [1080, 715],
                [1040, 715], [1000, 620]]);
            fyllPoly(ctx, F.fena, [[965, 600], [1095, 600], [1095, 618], [965, 620]]);
            // Rutor
            fyllPoly(ctx, F.glas, [[262, 640], [300, 575], [350, 535], [460, 530], [455, 652], [300, 652]]);
            fyllPoly(ctx, F.glas, [[475, 545], [545, 545], [542, 662], [470, 662]]);
            fyllPoly(ctx, F.glas, [[558, 552], [637, 556], [637, 660], [560, 660]]);
            fyllEllips(ctx, F.glas, 355, 705, 60, 38);
            // Rotor, nav, stjärtrotor och medar
            fyllPoly(ctx, F.morkstal, [[95, 320], [150, 298], [510, 380], [505, 398]]);
            fyllPoly(ctx, F.morkstal, [[1065, 298], [1070, 315], [620, 412], [612, 392]]);
            fyllPoly(ctx, F.morkstal, [[105, 455], [150, 468], [500, 412], [495, 400]]);
            fyllPoly(ctx, F.morkstal, [[620, 410], [958, 458], [950, 472], [880, 466], [615, 420]]);
            fyllPoly(ctx, F.stal, [[505, 375], [620, 375], [620, 410], [585, 412], [582, 455], [540, 455],
                [538, 412], [505, 410]]);
            // Stjärtrotorns fyra blad och nav
            [[1140, 468], [1058, 520], [1150, 630], [1072, 652]].forEach(([x, y]) => {
                ctx.beginPath();
                stav(ctx, 1110, 553, x, y, 20);
                ctx.fillStyle = F.morkstal;
                ctx.fill();
            });
            fyllEllips(ctx, F.ljusstal, 1110, 553, 14, 14);
            // Medar (rör) och stag, uppmätta efter linjerna
            fyllPoly(ctx, F.morkstal, [[272, 815], [300, 820], [400, 816], [500, 803], [504, 817], [400, 830],
                [300, 838], [272, 830]]);
            fyllPoly(ctx, F.morkstal, [[452, 846], [480, 851], [600, 843], [700, 834], [760, 828], [788, 832],
                [786, 845], [700, 848], [600, 856], [480, 866], [452, 861]]);
            fyllPoly(ctx, F.morkstal, [[345, 770], [375, 770], [372, 812], [352, 812]]);
            fyllPoly(ctx, F.morkstal, [[492, 772], [528, 772], [530, 846], [508, 848], [498, 810]]);
            fyllPoly(ctx, F.morkstal, [[668, 762], [700, 760], [722, 830], [700, 834], [684, 790]]);
        }
        sol(ctx, 1080, 110);
        moln(ctx, 300, 140, 0.9);
        moln(ctx, 760, 90, 0.7);
    }

    // Gult propellerplan vid flygfältet med hangar och torn (förlaga: ägarens
    // målarbokssida). Himlen ovanför är tillagd med appens moln och sol.
    function ritaFlygplanFalt(ctx, pic) {
        kant = 4;
        if (!fargLage) ctx.drawImage(pic.img, 0, 0);
        else {
            ctx.fillStyle = F.himmel;
            ctx.fillRect(0, 0, PAPER_W, PAPER_H);
            // Bortre kullarnas överkant, uppmätt efter linjen
            fyllPoly(ctx, F.fjarrkulle, [[0, 433], [50, 424], [100, 417], [150, 423], [200, 437], [250, 444],
                [300, 447], [350, 458], [400, 453], [450, 446], [500, 442], [550, 447], [600, 460], [650, 470],
                [700, 460], [750, 449], [800, 439], [850, 436], [900, 444], [950, 450], [1000, 443],
                [1050, 430], [1100, 421], [1150, 422], [1200, 428], [1200, 560], [0, 556]]);
            fyllPoly(ctx, F.akerkulle, [[0, 556], [1200, 560], [1200, 900], [0, 900]]);
            // Grusbanan under planet, efter dess kantlinjer
            fyllPoly(ctx, F.grus, [[0, 755], [200, 733], [300, 722], [500, 700], [650, 698], [900, 730],
                [1000, 722], [1100, 697], [1200, 680], [1200, 748], [1100, 774], [1000, 800], [800, 855],
                [650, 900], [0, 900]]);
            fyllEllips(ctx, F.trad, 82, 485, 35, 40);
            fyllEllips(ctx, F.trad, 145, 500, 20, 32);
            fyllEllips(ctx, F.trad, 790, 505, 30, 30);
            // Hangar och torn
            fyllPoly(ctx, F.ljusstal, [[945, 525], [990, 498], [1060, 495], [1112, 520], [1112, 567], [945, 567]]);
            fyllPoly(ctx, F.flygkropp, [[960, 525], [1050, 525], [1050, 567], [960, 567]]);
            fyllPoly(ctx, F.flygkropp, [[1112, 440], [1152, 440], [1148, 570], [1115, 570]]);
            fyllPoly(ctx, F.glas, [[1105, 462], [1155, 462], [1155, 478], [1105, 478]]);
            // Planet: kropp, vingar och stjärtplan (gula)
            fyllPoly(ctx, F.gul, [[400, 500], [480, 480], [600, 490], [720, 530], [800, 575], [850, 500], [890, 492],
                [900, 600], [860, 690], [700, 700], [500, 690], [440, 640], [400, 600]]);
            fyllPoly(ctx, F.gul, [[40, 590], [60, 585], [300, 600], [420, 625], [440, 670], [200, 640], [45, 605]]);
            fyllPoly(ctx, F.gul, [[520, 640], [700, 620], [1080, 600], [1160, 620], [1150, 640], [860, 690], [560, 680]]);
            fyllPoly(ctx, F.gul, [[780, 640], [1000, 650], [1020, 672], [800, 672]]);
            fyllEllips(ctx, F.gul, 400, 595, 60, 95);
            fyllEllips(ctx, F.stal, 345, 578, 55, 80);
            fyllEllips(ctx, F.ljusstal, 322, 550, 26, 26);
            // Propeller
            fyllPoly(ctx, F.morkstal, [[316, 375], [342, 375], [342, 532], [314, 532]]);
            fyllPoly(ctx, F.morkstal, [[192, 650], [218, 664], [300, 600], [290, 585]]);
            fyllPoly(ctx, F.morkstal, [[330, 580], [352, 568], [446, 664], [430, 676]]);
            // Rutor
            fyllPoly(ctx, F.glas, [[462, 522], [550, 485], [556, 545], [466, 550]]);
            fyllPoly(ctx, F.glas, [[556, 506], [626, 506], [621, 575], [556, 570]]);
            fyllPoly(ctx, F.glas, [[632, 527], [670, 542], [660, 585], [632, 576]]);
            // Hjul och ben
            fyllEllips(ctx, F.dack, 340, 755, 40, 47);
            fyllEllips(ctx, F.ljusstal, 342, 755, 15, 18);
            fyllEllips(ctx, F.dack, 640, 778, 40, 47);
            fyllEllips(ctx, F.ljusstal, 645, 778, 15, 18);
            fyllEllips(ctx, F.dack, 848, 725, 16, 16);
            fyllPoly(ctx, F.stal, [[350, 660], [390, 665], [372, 740], [350, 735]]);
            fyllPoly(ctx, F.stal, [[620, 670], [655, 670], [642, 740], [620, 735]]);
        }
        sol(ctx, 110, 100);
        moln(ctx, 470, 150, 0.85);
        moln(ctx, 920, 230, 0.7);
    }

    // Bilderna. `clawd` = var den lilla kompisen Clawd gömmer sig:
    // (x, y) = mitt under fötterna, s = skala, `ytor` = punkter i de ytor han
    // syns i (han ritas bara där, så det som ligger framför skymmer honom).
    // `vilar: true` = bilden ligger i malpåse: den finns kvar men visas inte.
    const PICTURES = [
        { namn: 'Traktor', rita: ritaFil, bild: 'bilder/traktor.svg',
          farger: {
            [F.himmel]: [[0, 0]],
            [F.sol]: [[209, 123], [912, 472], [932, 463]],
            [F.moln]: [[873, 117], [1005, 140], [133, 175]],
            [F.trad]: [[1094, 309], [102, 387]],
            [F.stam]: [[1092, 371], [103, 476]],
            [F.fjarrkulle]: [[983, 361], [1186, 348], [0, 458], [197, 375]],
            [F.kulle2]: [[1199, 459]],
            [F.akerkulle]: [[0, 631], [1199, 643]],
            [F.mark]: [[603, 899]],
            [F.rod]: [[440, 393], [583, 434], [665, 385], [665, 419], [665, 502], [733, 401], [821, 469], [967, 456], [864, 516], [455, 429], [241, 412], [331, 644], [870, 651]],
            [F.morkrod]: [[737, 532], [668, 623]],
            [F.fonster]: [[389, 326], [541, 305]],
            [F.ljusstal]: [[404, 193]],
            [F.gul]: [[570, 141], [391, 714], [905, 610]],
            [F.falg]: [[371, 689], [876, 625]],
            [F.dack]: [[217, 621], [786, 636]],
            [F.stal]: [[688, 287], [582, 614], [594, 678]],
            [F.morkstal]: [[554, 593], [553, 168], [689, 218], [484, 397], [225, 410], [991, 481], [1003, 467], [978, 473], [1011, 600], [804, 557], [592, 592], [589, 635], [586, 661], [680, 685], [355, 621], [355, 588], [322, 621], [388, 621], [355, 654], [877, 673]] },
          clawd: { x: 386, y: 392, s: 0.34, ytor: [[386, 300]] } },       // i bakre rutan
        { namn: 'Grävmaskin', rita: ritaFil, bild: 'bilder/gravmaskin.svg',
          farger: {
            [F.himmel]: [[505, 0], [890, 261]],
            [F.sol]: [[207, 122]],
            [F.moln]: [[873, 117], [1005, 140], [132, 175]],
            [F.trad]: [[1095, 309], [101, 388]],
            [F.stam]: [[1092, 376], [103, 479]],
            [F.fjarrkulle]: [[0, 458], [201, 378], [298, 387], [1044, 379], [1186, 348]],
            [F.kulle2]: [[859, 414], [935, 479], [1199, 459], [1010, 486]],
            [F.akerkulle]: [[1018, 518], [784, 580], [0, 631], [1199, 643], [1032, 573]],
            [F.mark]: [[78, 899]],
            [F.jord]: [[1019, 769]],
            [F.gul]: [[323, 534], [312, 425], [224, 547], [409, 486], [564, 498], [699, 363], [755, 382], [944, 335], [992, 417], [190, 689], [679, 688], [389, 688], [496, 760]],
            [F.morkgul]: [[1028, 547], [1044, 581], [291, 593], [479, 531], [709, 303], [981, 304], [1016, 610]],
            [F.fonster]: [[411, 415], [522, 385]],
            [F.morkstal]: [[931, 221], [924, 290], [720, 295], [985, 317], [988, 537], [1054, 554], [372, 283], [257, 328], [196, 545], [477, 461], [515, 624], [292, 677], [435, 677], [577, 677], [219, 720], [650, 720], [363, 720], [506, 720], [975, 615], [978, 692], [993, 586], [1024, 623]],
            [F.stal]: [[264, 370], [834, 258], [1008, 402], [214, 635], [266, 635], [321, 635], [376, 635], [428, 635], [481, 635], [537, 635], [589, 635], [644, 635], [151, 667], [704, 653], [133, 711], [736, 710], [150, 771], [713, 779], [213, 804], [265, 804], [319, 804], [373, 804], [427, 804], [480, 804], [534, 804], [587, 804], [641, 804]],
            [F.ljusstal]: [[904, 233], [1032, 480], [896, 653], [878, 666], [861, 680]],
            [F.dack]: [[147, 706]] },
          clawd: { x: 535, y: 462, s: 0.3, ytor: [[535, 380]] } },        // i dörrens ruta
        { namn: 'Flygplan', rita: ritaFil, bild: 'bilder/flygplan.svg',
          farger: {
            [F.himmel]: [[533, 0]],
            [F.sol]: [[209, 123]],
            [F.moln]: [[873, 117], [1005, 140], [132, 175]],
            [F.trad]: [[1095, 309], [437, 364], [86, 395], [958, 370]],
            [F.stam]: [[1092, 375], [437, 430], [960, 426], [128, 450], [103, 459]],
            [F.fjarrkulle]: [[1187, 349]],
            [F.kulle2]: [[859, 391], [0, 438], [333, 407]],
            [F.akerkulle]: [[1195, 459]],
            [F.mark]: [[77, 571], [1199, 593], [823, 634], [0, 899]],
            [F.asfalt]: [[477, 730]],
            [F.vit]: [[1142, 649], [0, 649], [821, 649], [0, 807], [0, 721], [268, 721], [752, 721], [1125, 721]],
            [F.flygkropp]: [[1076, 551]],
            [F.buk]: [[460, 594], [863, 597], [165, 432]],
            [F.fena]: [[229, 405]],
            [F.vinge]: [[531, 560], [151, 486], [306, 519], [322, 545]],
            [F.ljusstal]: [[676, 556], [532, 598], [815, 586], [1140, 551], [721, 640], [583, 630], [336, 488], [978, 527], [686, 497]],
            [F.stal]: [[639, 595], [776, 628], [636, 643], [591, 672], [984, 634], [987, 651], [977, 665], [989, 690], [566, 696], [616, 696]],
            [F.morkstal]: [[793, 634], [614, 621], [614, 632], [606, 649]],
            [F.dack]: [[979, 699], [561, 680], [612, 680]],
            [F.ruta]: [[385, 506], [425, 507], [465, 506], [526, 506], [566, 506], [606, 506], [646, 505], [726, 506], [766, 506], [806, 507], [846, 505], [886, 505], [927, 504], [1057, 499], [1095, 499]] },
          clawd: { x: 1005, y: 128, s: 0.3, ytor: [[1005, 60]] } },       // bakom molnet
        { namn: 'Helikopter', rita: ritaFil, bild: 'bilder/helikopter.svg',
          farger: {
            [F.himmel]: [[575, 0]],
            [F.sol]: [[236, 85]],
            [F.moln]: [[1190, 101], [152, 142]],
            [F.morkstal]: [[827, 147], [384, 147], [363, 257], [855, 258], [1043, 326], [975, 398], [1053, 423], [320, 723], [555, 788], [730, 525]],
            [F.stal]: [[608, 188], [608, 231], [1024, 380], [778, 688], [408, 694], [627, 747]],
            [F.ljusstal]: [[605, 208]],
            [F.orange]: [[395, 544], [623, 290], [659, 570]],
            [F.fonster]: [[561, 293], [509, 427], [685, 453], [481, 638]],
            [F.fjarrkulle]: [[313, 382], [791, 323]],
            [F.kulle2]: [[944, 323], [1199, 262]],
            [F.akerkulle]: [[960, 459]],
            [F.mark]: [[990, 899]],
            [F.trad]: [[1137, 289], [82, 339], [209, 371], [0, 486], [1199, 479], [1199, 404], [1199, 360]],
            [F.stam]: [[1138, 379], [88, 460], [207, 440]],
            [F.vit]: [[1040, 746], [567, 731], [733, 770], [646, 716]],
            [F.asfalt]: [[905, 745], [638, 684], [434, 686], [724, 647], [579, 698], [594, 757]] },
          clawd: { x: 680, y: 522, s: 0.3, ytor: [[685, 453]] } },        // i dörrens ruta
        { namn: 'Brandbil', rita: ritaFil, bild: 'bilder/brandbil.svg',
          tillagg: [[462, 891, 436, 903], [1188, 766, 1204, 763]],
          farger: {
            [F.himmel]: [[801, 0], [564, 212], [643, 224], [730, 237], [810, 249], [889, 261], [828, 293]],
            [F.sol]: [[237, 85]],
            [F.moln]: [[1190, 101], [152, 142]],
            [F.ljusstal]: [[500, 174], [483, 228], [977, 301], [346, 711], [812, 683], [561, 695], [943, 653], [887, 309], [921, 321], [693, 601]],
            [F.stal]: [[520, 188], [601, 201], [687, 217], [780, 248], [856, 255], [920, 253], [325, 301], [248, 595], [268, 615], [242, 629], [262, 649], [563, 726], [942, 681], [1042, 647], [185, 572], [381, 600]],
            [F.morkstal]: [[470, 168], [468, 225], [941, 305], [584, 532], [777, 643], [782, 654], [576, 633], [966, 602]],
            [F.buk]: [[348, 276], [397, 277], [450, 280]],
            [F.fjarrkulle]: [[170, 299], [1046, 293], [780, 303]],
            [F.kulle2]: [[1199, 262]],
            [F.akerkulle]: [[0, 597], [1162, 560], [1150, 880]],
            [F.trad]: [[82, 339], [186, 380], [1, 486], [1199, 479], [1199, 404], [1137, 289], [1199, 360]],
            [F.stam]: [[87, 415], [75, 405], [1138, 379]],
            [F.asfalt]: [[150, 899]],
            [F.rod]: [[329, 558], [481, 562], [798, 378], [831, 597], [557, 613], [940, 580]],
            [F.morkrod]: [[674, 343]],
            [F.fonster]: [[338, 430], [533, 446], [862, 440], [736, 473], [981, 424]],
            [F.gul]: [[732, 633], [186, 596], [364, 617]],
            [F.vit]: [[371, 665], [183, 640]],
            [F.dack]: [[564, 661], [475, 752], [255, 742], [317, 756], [753, 718], [702, 719], [866, 708], [937, 740]] },
          clawd: { x: 981, y: 528, s: 0.28, ytor: [[981, 424]] } },        // i bakersta rutan
        { namn: 'Dumper', rita: ritaFil, bild: 'bilder/dumper.svg',
          farger: {
            [F.himmel]: [[491, 0]],
            [F.sol]: [[234, 84], [251, 576], [399, 600]],
            [F.moln]: [[1191, 100], [152, 142]],
            [F.stal]: [[627, 212], [757, 283], [1048, 816], [1038, 731], [1087, 857], [632, 699], [596, 700], [915, 661], [881, 664], [724, 621]],
            [F.ljusstal]: [[721, 236], [888, 259], [1119, 672], [1108, 746], [960, 794], [1198, 818], [1198, 728], [983, 850], [870, 843], [589, 731], [875, 695], [1018, 651], [84, 751], [306, 813], [488, 862]],
            [F.gul]: [[770, 459]],
            [F.morkgul]: [[552, 257], [713, 331], [630, 323]],
            [F.orange]: [[330, 591], [499, 619]],
            [F.fonster]: [[397, 415], [552, 429]],
            [F.morkstal]: [[595, 501], [698, 572], [698, 685], [867, 565], [625, 590]],
            [F.vit]: [[417, 680]],
            [F.fjarrkulle]: [[170, 299], [1044, 423]],
            [F.kulle2]: [[1199, 262], [1199, 360]],
            [F.trad]: [[1199, 404], [1199, 479], [1137, 290], [82, 338], [209, 371], [1, 486]],
            [F.stam]: [[1138, 379], [87, 416], [75, 405], [208, 440]],
            [F.akerkulle]: [[0, 597], [1142, 558]],
            [F.grus]: [[0, 899], [734, 832]],
            [F.dack]: [[889, 590], [605, 624], [812, 573], [803, 590], [782, 611], [776, 638], [778, 666], [787, 695], [792, 721], [823, 742], [826, 756], [864, 764], [581, 597], [552, 606], [538, 624], [526, 641], [518, 672], [505, 703], [508, 732], [512, 759], [528, 780], [546, 795], [579, 802], [266, 699], [288, 723], [318, 741], [323, 755], [356, 762], [350, 734], [370, 713]] },
          clawd: { x: 553, y: 494, s: 0.26, ytor: [[552, 429]] } },        // i sidorutan
        { namn: 'Sopbil', rita: ritaFil, bild: 'bilder/sopbil.svg',
          tillagg: [[495, 892, 472, 904]],
          farger: {
            [F.himmel]: [[509, 0]],
            [F.sol]: [[236, 85], [251, 577], [399, 600]],
            [F.moln]: [[1191, 100], [152, 142]],
            [F.orange]: [[478, 281]],
            [F.stal]: [[461, 313], [311, 573], [319, 592], [313, 609], [736, 626], [632, 698], [596, 700], [915, 664], [881, 664], [970, 389], [958, 531], [1000, 529], [981, 569], [1102, 653], [1082, 677], [1046, 847], [1163, 807]],
            [F.gron]: [[497, 528], [752, 300], [736, 403], [733, 505], [494, 630], [801, 575], [874, 244]],
            [F.morkgron]: [[621, 295], [908, 257]],
            [F.vit]: [[869, 345], [819, 437]],
            [F.fonster]: [[397, 415], [552, 429]],
            [F.morkstal]: [[598, 501], [744, 569], [619, 587], [697, 686], [868, 561], [914, 560], [1001, 513], [927, 385]],
            [F.ljusstal]: [[417, 680], [589, 731], [875, 695], [1137, 721]],
            [F.dack]: [[600, 623], [493, 722], [284, 716], [360, 740], [370, 713], [870, 740], [783, 688], [892, 709], [1045, 832], [1159, 793]],
            [F.fena]: [[981, 685], [984, 714]],
            [F.buk]: [[1019, 757]],
            [F.fjarrkulle]: [[170, 299], [1066, 428]],
            [F.kulle2]: [[1199, 262], [1199, 360], [1157, 359]],
            [F.trad]: [[82, 339], [209, 371], [1137, 290], [2, 486], [1199, 404], [1199, 479]],
            [F.stam]: [[87, 415], [208, 440], [1138, 379]],
            [F.akerkulle]: [[0, 597], [1133, 558], [700, 880]],
            [F.asfalt]: [[160, 899], [1199, 625]],
            [F.mark]: [[734, 832]] },
          clawd: { x: 1105, y: 646, s: 0.24, ytor: [[1150, 620], [1105, 590]] } },      // bakom soptunnan
        { namn: 'Tåg', rita: ritaFil, bild: 'bilder/tag.svg',
          farger: {
            [F.himmel]: [[845, 0]],
            [F.sol]: [[236, 85]],
            [F.moln]: [[1191, 100], [152, 142], [550, 94], [655, 74], [453, 140]],
            [F.stal]: [[396, 257], [393, 286], [409, 476], [593, 669], [777, 601], [967, 596], [1155, 560], [596, 700], [778, 632], [964, 615], [1155, 577]],
            [F.morkstal]: [[404, 339], [343, 461], [691, 635], [499, 620], [692, 556], [795, 521], [619, 587], [370, 713], [454, 714], [1068, 526], [865, 619], [1076, 570], [1047, 578], [1019, 587], [310, 523], [345, 524], [396, 631]],
            [F.morkrod]: [[556, 264], [668, 258], [416, 680]],
            [F.rod]: [[628, 427], [682, 486], [467, 594]],
            [F.fonster]: [[588, 346], [726, 377], [935, 431], [1015, 422], [1138, 420]],
            [F.fjarrkulle]: [[301, 364], [1199, 262], [846, 295], [455, 379]],
            [F.kulle2]: [[1059, 280], [1199, 406]],
            [F.trad]: [[1139, 272], [82, 339], [209, 371], [2, 486]],
            [F.stam]: [[87, 416], [208, 440]],
            [F.akerkulle]: [[0, 597], [1150, 700], [600, 880], [44, 743]],
            [F.mark]: [[734, 832]],
            [F.gul]: [[897, 341], [822, 354], [842, 424], [1013, 523], [497, 378], [250, 596], [425, 618]],
            [F.gron]: [[1099, 327], [1076, 352], [1075, 381], [1199, 495]],
            [F.buk]: [[477, 515], [571, 488]],
            [F.dack]: [[599, 623], [769, 706], [493, 722], [284, 715], [910, 603], [1107, 588]],
            [F.ljusstal]: [[632, 697], [810, 631], [364, 741], [959, 660], [1154, 538], [690, 758], [846, 708], [0, 788], [1100, 641], [433, 847], [12, 813], [371, 899], [1053, 587], [1199, 623]],
            [F.grus]: [[1199, 585], [1199, 608], [1199, 552], [689, 720], [187, 880], [400, 820], [873, 670], [450, 736], [1015, 644], [1084, 602]],
            [F.jord]: [[300, 834], [600, 828], [763, 773], [898, 726], [1050, 683], [1155, 659], [1028, 610], [246, 852], [566, 843], [721, 784], [873, 731], [1010, 690], [1129, 661], [3, 899], [381, 786], [691, 738], [849, 692], [885, 642], [439, 773], [451, 899], [1018, 626]] },
          delningar: [[100, 898, 620, 898], [1198, 600, 1198, 740]],
          clawd: { x: 726, y: 462, s: 0.28, ytor: [[726, 377]] } },        // i förarhyttens ruta
        { namn: 'Båt', rita: ritaFil, bild: 'bilder/bat.svg',
          farger: {
            [F.himmel]: [[450, 0]],
            [F.sol]: [[236, 85], [1087, 239]],
            [F.moln]: [[784, 74], [1191, 100], [152, 142]],
            [F.vatten]: [[803, 899]],
            [F.vag]: [[845, 428], [1119, 521], [109, 605], [1117, 667], [222, 803], [1004, 833], [509, 838]],
            [F.fjarrkulle]: [[968, 364]],
            [F.kulle2]: [[1199, 320]],
            [F.grus]: [[1156, 406], [0, 375], [21, 381], [65, 385], [93, 394], [112, 407], [20, 398], [182, 401], [225, 404], [255, 412], [28, 407], [9, 416], [81, 427], [129, 418], [170, 442], [291, 521], [336, 542], [766, 526]],
            [F.stam]: [[46, 414], [150, 422], [118, 371], [246, 384], [247, 439], [8, 346], [0, 360]],
            [F.jord]: [[44, 389], [147, 404], [117, 356], [247, 368]],
            [F.rod]: [[1086, 215], [1069, 255], [1080, 275], [1078, 327], [844, 709], [597, 305], [423, 487], [465, 487], [421, 539], [467, 543]],
            [F.vit]: [[1087, 297], [1101, 345], [829, 639], [228, 525], [518, 236], [442, 474], [409, 514], [472, 519], [441, 547], [867, 498]],
            [F.fonster]: [[1076, 230], [469, 412], [566, 427], [687, 431]],
            [F.morkstal]: [[1087, 367], [537, 275], [520, 207], [510, 184], [712, 482], [930, 602], [971, 533], [939, 505]],
            [F.fena]: [[710, 607]],
            [F.ljusstal]: [[465, 384], [558, 397], [707, 425], [939, 648], [961, 646]],
            [F.gul]: [[549, 523], [444, 514]],
            [F.morkgul]: [[644, 388], [690, 522]] },
          clawd: { x: 800, y: 548, s: 0.22, ytor: [[768, 527]] } },        // på däcket bakom relingen
        { namn: 'Traktor snett', rita: ritaFil, bild: 'bilder/traktor-snett.svg',
          tillagg: [[1188, 313, 1201, 316]],
          farger: {
            [F.sol]: [[207, 122], [639, 182], [511, 192], [257, 452], [343, 450], [447, 448], [427, 443]],
            [F.moln]: [[874, 117], [1005, 140], [131, 175]],
            [F.trad]: [[1096, 309], [102, 387]],
            [F.stam]: [[1093, 376], [103, 477]],
            [F.fjarrkulle]: [[0, 458], [210, 387], [1011, 374], [1180, 330]],
            [F.kulle2]: [[1199, 459]],
            [F.akerkulle]: [[0, 632], [1199, 643], [741, 702], [394, 711]],
            [F.mark]: [[716, 899]],
            [F.rod]: [[660, 384], [727, 510], [626, 417], [614, 511], [326, 408], [576, 381], [420, 516], [370, 475], [283, 446], [534, 507], [787, 446], [810, 466], [947, 414], [893, 574], [541, 648]],
            [F.morkrod]: [[582, 488], [611, 559], [571, 545]],
            [F.fonster]: [[587, 285], [745, 312], [839, 328]],
            [F.ljusstal]: [[742, 181], [602, 184], [667, 184], [491, 194]],
            [F.stal]: [[435, 272], [312, 452], [272, 566], [260, 600], [291, 672], [708, 567], [723, 622], [742, 677], [954, 380], [965, 384]],
            [F.morkstal]: [[422, 206], [775, 367], [665, 501], [666, 514], [348, 480], [247, 475], [257, 476], [269, 485], [318, 483], [286, 484], [305, 506], [333, 497], [321, 613], [397, 602], [382, 654], [356, 636], [659, 562], [680, 543], [713, 540], [720, 592], [707, 667], [753, 542], [731, 653], [909, 422], [902, 433], [864, 438], [859, 458], [828, 479], [952, 438], [905, 601], [905, 566], [927, 600], [883, 600], [905, 634], [545, 670]],
            [F.gul]: [[935, 699], [964, 566], [542, 602], [587, 651], [298, 721], [336, 681]],
            [F.falg]: [[907, 667], [539, 720], [295, 698]],
            [F.dack]: [[672, 701], [629, 742], [921, 736], [825, 504], [805, 534], [805, 565], [794, 602], [802, 633], [802, 672], [818, 698], [827, 733], [849, 750], [896, 769], [865, 769], [952, 757], [554, 571], [484, 536], [457, 653], [451, 558], [426, 597], [410, 635], [406, 680], [458, 703], [417, 727], [470, 750], [478, 775], [495, 788], [531, 801], [509, 801], [306, 748], [217, 680], [214, 554], [189, 585], [216, 587], [215, 617], [176, 625], [172, 667], [182, 709], [228, 723], [235, 747], [251, 758], [285, 773], [263, 773]],
            [F.himmel]: [[410, 0]] },
          clawd: { x: 600, y: 386, s: 0.32, ytor: [[587, 285]] } },       // i framrutan
        { namn: 'Grävmaskin snett', rita: ritaFil, bild: 'bilder/gravmaskin-snett.svg',
          farger: {
            [F.himmel]: [[1199, 0], [742, 160], [734, 313]],
            [F.sol]: [[394, 102]],
            [F.moln]: [[317, 157]],
            [F.trad]: [[973, 323], [229, 357]],
            [F.stam]: [[971, 379], [229, 422]],
            [F.fjarrkulle]: [[0, 386], [401, 383], [1188, 356], [932, 385], [754, 407]],
            [F.kulle2]: [[122, 509], [779, 492], [1163, 481], [888, 421], [895, 463]],
            [F.akerkulle]: [[776, 574], [1199, 665]],
            [F.mark]: [[0, 899]],
            [F.jord]: [[1199, 899]],
            [F.gul]: [[590, 271], [804, 232], [491, 500], [573, 230], [875, 543], [853, 515], [861, 586], [618, 555], [593, 546], [674, 572], [430, 447], [328, 448], [297, 499], [354, 494], [419, 492], [410, 548], [846, 543]],
            [F.morkgul]: [[844, 139], [556, 386], [555, 475], [551, 501], [537, 547], [593, 482], [704, 426], [711, 463], [713, 528], [264, 534], [460, 545], [416, 583], [461, 508], [494, 523], [903, 552], [918, 594], [902, 632], [944, 622], [452, 467], [925, 513], [940, 510]],
            [F.fonster]: [[656, 460], [667, 523]],
            [F.stal]: [[682, 164], [881, 324], [522, 457], [579, 454], [922, 535], [821, 623], [850, 703], [293, 641], [327, 649], [275, 651], [344, 647], [366, 647], [410, 662], [428, 662], [441, 663], [451, 700], [270, 710], [289, 718], [304, 719], [321, 725], [338, 725], [357, 733], [372, 732], [393, 741], [409, 740], [429, 748], [447, 748], [456, 750], [614, 701], [630, 700], [648, 707], [665, 707], [668, 720], [249, 706], [492, 760], [698, 719]],
            [F.ljusstal]: [[763, 112], [699, 156], [541, 319], [592, 370], [581, 381], [901, 426], [896, 408], [746, 763], [758, 767], [765, 730], [245, 677], [487, 722], [689, 683]],
            [F.morkstal]: [[540, 294], [554, 294], [528, 414], [585, 417], [871, 234], [340, 393], [468, 583], [510, 562], [554, 562], [566, 559], [590, 576], [586, 593], [546, 598], [528, 620], [412, 713], [358, 667], [617, 654], [612, 682], [455, 762], [844, 579], [885, 601], [853, 605], [893, 536], [893, 543], [933, 674], [933, 612]],
            [F.dack]: [[492, 783], [704, 737], [338, 613], [382, 614], [278, 616], [414, 619], [449, 624], [478, 632], [497, 642], [538, 649], [540, 669], [557, 696], [557, 729], [565, 756], [529, 780], [733, 632], [761, 653], [749, 685], [748, 713], [734, 734], [616, 597], [647, 603], [683, 610], [578, 615], [720, 617], [620, 623], [577, 629], [670, 639]] },
          clawd: { x: 652, y: 508, s: 0.26, ytor: [[656, 460]] } },       // i hyttens ruta
        { namn: 'Helikopter snett', vilar: true, rita: ritaFil, bild: 'bilder/helikopter-snett.svg',
          farger: {
            [F.himmel]: [[672, 0]],
            [F.sol]: [[145, 123], [285, 522]],
            [F.moln]: [[89, 178]],
            [F.trad]: [[1130, 320], [73, 400], [166, 443]],
            [F.stam]: [[1130, 391], [74, 498], [166, 502]],
            [F.fjarrkulle]: [[0, 475]],
            [F.kulle2]: [[235, 425], [1199, 460], [898, 473]],
            [F.mark]: [[0, 899]],
            [F.vit]: [[87, 709], [1000, 204], [596, 306], [616, 268], [646, 301], [713, 298], [742, 354]],
            [F.asfalt]: [[855, 711], [409, 665], [623, 684], [573, 638], [548, 642], [534, 641], [544, 669], [582, 671]],
            [F.rod]: [[671, 564], [497, 534], [582, 525], [512, 295], [631, 236], [788, 409], [811, 368], [994, 270], [1006, 411], [985, 516], [851, 454]],
            [F.morkrod]: [[395, 613], [767, 475], [952, 414]],
            [F.fonster]: [[377, 448], [356, 554], [496, 457], [582, 401], [664, 401], [310, 402], [270, 539]],
            [F.stal]: [[589, 148], [989, 384], [408, 699], [546, 737], [372, 663], [700, 635], [360, 637], [401, 634], [502, 630], [676, 622]],
            [F.morkstal]: [[615, 177], [570, 176], [540, 186], [819, 241], [563, 158], [617, 160], [593, 173], [589, 193], [603, 193], [563, 200], [570, 195], [616, 196], [574, 207], [601, 205], [600, 215], [579, 218], [537, 277], [556, 307], [628, 326], [782, 333], [792, 354], [999, 344], [988, 342], [979, 350], [1003, 359], [994, 358], [975, 364], [970, 376], [969, 387], [971, 399], [986, 424], [970, 427], [976, 431], [987, 440], [995, 445], [979, 450], [998, 459]] },
          clawd: { x: 492, y: 506, s: 0.28, ytor: [[496, 457]] } },       // i dörrens ruta
        { namn: 'Flygplan snett', rita: ritaFil, bild: 'bilder/flygplan-snett.svg',
          tillagg: [[432, 892, 412, 902], [488, 892, 468, 902], [1188, 312, 1203, 315]],
          farger: {
            [F.himmel]: [[550, 0]],
            [F.sol]: [[211, 124]],
            [F.moln]: [[874, 117], [1005, 140], [131, 175]],
            [F.trad]: [[1096, 309], [421, 285], [102, 387]],
            [F.stam]: [[420, 325], [1093, 373], [103, 480]],
            [F.fjarrkulle]: [[465, 373], [999, 336], [0, 458], [1180, 340]],
            [F.kulle2]: [[198, 437]],
            [F.mark]: [[0, 581], [1150, 880]],
            [F.asfalt]: [[600, 800], [1000, 470]],
            [F.vit]: [[1199, 436], [0, 655], [384, 701], [3, 821], [558, 646], [450, 895], [1199, 377], [1088, 472], [215, 758], [828, 557]],
            [F.flygkropp]: [[248, 611], [154, 616]],
            [F.fena]: [[809, 344]],
            [F.buk]: [[845, 348], [221, 371], [1141, 481], [1104, 503]],
            [F.vinge]: [[252, 369], [693, 526], [732, 363], [728, 348], [725, 347], [870, 395], [595, 487], [567, 494], [324, 521], [794, 403]],
            [F.ljusstal]: [[897, 383], [283, 416], [284, 439], [362, 435], [559, 556], [808, 537], [818, 513], [734, 570], [696, 611], [853, 544]],
            [F.stal]: [[714, 544], [960, 536], [641, 603], [640, 657], [740, 646], [742, 602], [494, 607], [468, 609], [651, 565], [640, 567], [290, 666], [276, 663], [259, 667], [281, 686], [290, 688], [280, 700], [288, 696], [271, 717], [293, 722]],
            [F.morkstal]: [[605, 639], [641, 633]],
            [F.dack]: [[728, 657], [482, 611], [461, 614], [262, 723], [282, 731]],
            [F.ruta]: [[165, 551], [255, 551], [226, 552], [197, 551], [770, 431], [752, 435], [734, 439], [715, 441], [696, 449], [676, 453], [656, 458], [636, 465], [615, 467], [540, 485], [520, 493], [499, 496], [478, 501], [457, 507], [436, 513], [414, 517], [392, 521], [370, 526]] },
          clawd: { x: 1000, y: 112, s: 0.28, ytor: [[550, 0]] } },        // bakom molnet
        { namn: 'Propellerplan', vilar: true, rita: ritaFil, bild: 'bilder/propellerplan.svg',
          farger: {
            [F.himmel]: [[533, 0]],
            [F.sol]: [[209, 123], [191, 448], [337, 611], [293, 600]],
            [F.moln]: [[874, 117], [1005, 140], [129, 176]],
            [F.trad]: [[1096, 309], [106, 348]],
            [F.stam]: [[1093, 372], [103, 479]],
            [F.fjarrkulle]: [[0, 458], [181, 357], [661, 364], [887, 358], [1023, 360], [1187, 348], [241, 442], [325, 442], [333, 468]],
            [F.kulle2]: [[1199, 466], [908, 459], [763, 453], [709, 446]],
            [F.akerkulle]: [[131, 605], [1021, 629], [590, 671], [255, 481]],
            [F.mark]: [[593, 899]],
            [F.vit]: [[779, 527], [574, 528], [381, 579], [609, 579], [813, 422], [316, 413], [710, 538]],
            [F.rod]: [[389, 500], [835, 400], [376, 402], [948, 362], [976, 315], [918, 508], [253, 527], [351, 689], [430, 646], [684, 669], [978, 500]],
            [F.morkrod]: [[982, 370], [952, 484], [1058, 514], [1046, 398], [70, 387], [1062, 403], [349, 714], [450, 663], [676, 697], [990, 428]],
            [F.fonster]: [[485, 441], [589, 472], [662, 469], [700, 488], [724, 478]],
            [F.ljusstal]: [[276, 423], [750, 430], [512, 617], [613, 615], [939, 523]],
            [F.stal]: [[366, 641], [383, 650], [366, 657], [377, 659], [361, 669], [492, 645], [509, 643], [502, 656], [644, 643]],
            [F.morkstal]: [[223, 484], [308, 579], [306, 525], [283, 619], [531, 511], [610, 515], [523, 579], [478, 615], [455, 487]],
            [F.dack]: [[351, 734], [338, 733], [360, 729], [364, 714], [462, 686], [471, 677], [445, 682], [685, 722], [666, 717], [694, 712], [694, 695]] },
          clawd: { x: 588, y: 513, s: 0.26, ytor: [[589, 472]] } },       // i sidorutan
        { namn: 'Litet flygplan', rita: ritaFlygplanLitet, bild: 'bilder/flygplan-litet.svg', helaYtor: true,
          farger: {
            [F.fjarrkulle]: [[162, 213], [45, 249]],
            [F.stam]: [[100, 237], [1103, 200]],
            [F.trad]: [[163, 244], [1157, 211]],
            [F.ljusstal]: [[944, 158], [168, 559], [193, 664]],
            [F.dack]: [[247, 835]],
            [F.buk]: [[203, 515]] },
          tillagg: [[63, 240, 93, 244], [89, 211, 109, 211],
                    [1092, 167, 1111, 167]],
          clawd: { x: 455, y: 508, s: 0.4, ytor: [[455, 440]] } },         // i cockpitrutan
        { namn: 'Helikopter på stigen', rita: ritaHelikopterStig, bild: 'bilder/helikopter-stig.svg', helaYtor: true,
          farger: {
            [F.rod]: [[976, 581], [980, 463], [352, 530]],
            [F.stal]: [[1012, 484], [1011, 470]],
            [F.stam]: [[1143, 360], [1180, 298], [1180, 347]] },
          tillagg: [[352, 106, 360, 118, 363, 131, 358, 143, 350, 150],
                    [524, 222, 553, 228], [614, 230, 650, 231, 700, 235, 745, 239],
                    [113, 774, 60, 800, 0, 829], [301, 721, 327, 714], [1132, 386, 1155, 386], [1201, 270, 1201, 370]],
          clawd: { x: 590, y: 585, s: 0.32, ytor: [[590, 500]] } },        // i dörrens ruta
        { namn: 'Helikopter i luften', vilar: true, rita: ritaHelikopterLuft, bild: 'bilder/helikopter-luft.svg', helaYtor: true,
          farger: {
            [F.akerkulle]: [[220, 830], [800, 845]],
            [F.akerkulle]: [[100, 880]],
            [F.stam]: [[1136, 868], [1135, 855], [90, 815], [39, 828], [149, 842], [1057, 880]],
            [F.morkstal]: [[1015, 310]] },
          delningar: [[248, 811, 268, 818], [293, 837, 310, 862, 332, 896], [772, 818, 756, 832], [735, 846, 738, 870]],
          tillagg: [[1128, 862, 1143, 862], [1128, 898, 1143, 898]],
          clawd: { x: 597, y: 664, s: 0.28, ytor: [[597, 600]] } },        // i sidorutan
        { namn: 'Flygplan vid fältet', vilar: true, rita: ritaFlygplanFalt, bild: 'bilder/flygplan-falt.svg', helaYtor: true,
          farger: {
            [F.fonster]: [[462, 502]],
            [F.stal]: [[309, 519], [311, 527], [285, 607]],
            [F.ljusstal]: [[342, 518], [301, 590]],
            [F.stam]: [[84, 535], [148, 545], [788, 550]],
            [F.akerkulle]: [[760, 576]] },
          tillagg: [[1184, 553, 1200, 558], [1186, 563, 1200, 563], [77, 523, 91, 521], [143, 537, 154, 537], [783, 535, 795, 535]],
          clawd: { x: 590, y: 585, s: 0.24, ytor: [[590, 540]] } }         // i sidorutan
    ];
    for (let k = PICTURES.length - 1; k >= 0; k--) if (PICTURES[k].vilar) PICTURES.splice(k, 1);

    // Bildfilerna laddas i förväg så att bläddring går direkt.
    PICTURES.forEach(pic => {
        if (!pic.bild) return;
        pic.img = new Image();
        pic.img.src = pic.bild;
    });
    let vantarPaBild = -1;
    let currentPicture = 0;

    // --- Områden (numrerade ytor) ---
    // labels[i]: 0 = linje (går inte att måla), >0 = områdets nummer.
    // Pixlar med alpha >= LINE_ALPHA räknas som linje; kantpixlarna under
    // den gränsen hör till ytan så att färgen går hela vägen in under
    // linjens anti-aliasade kant (ingen vit hinna).
    const LINE_ALPHA = 200;
    // Områden mindre än så här (pixlar) är bara små celler mellan
    // detaljstreck. De fylls i direkt när penseln nuddar dem.
    const MIN_REGION = 150;
    let labels = new Int32Array(PAPER_W * PAPER_H);
    let regionSize = [0];
    let regionTop = [0];      // omslutande rektangel för varje område, så att
    let regionBottom = [0];   // ifyllnad bara behöver gå igenom den
    let regionLeft = [0];
    let regionRight = [0];
    let regionColor = new Uint32Array(1);   // områdets givna färg
    let regionBlandad = new Uint8Array(1);  // 1 = ytan har flera färger i kartan
    let facitPx = new Uint32Array(PAPER_W * PAPER_H);   // färgkartan pixel för pixel
    let regionPainted = new Int32Array(1);  // antal målade pixlar
    let regionDone = new Uint8Array(1);     // 1 = helt ifyllt (eller på väg)

    function labelRegions() {
        const W = PAPER_W, H = PAPER_H;
        const alpha = lCtx.getImageData(0, 0, W, H).data;
        labels.fill(0);
        for (let i = 0, n = W * H; i < n; i++) {
            if (alpha[i * 4 + 3] < LINE_ALPHA) labels[i] = -1;   // yta, ej besökt
        }
        regionSize = [0];
        regionTop = [0];
        regionBottom = [0];
        regionLeft = [0];
        regionRight = [0];
        let id = 0;
        for (let seed = 0, n = W * H; seed < n; seed++) {
            if (labels[seed] !== -1) continue;
            id++;
            floodLabel(seed, id);
        }
        regionPainted = new Int32Array(id + 1);
        regionDone = new Uint8Array(id + 1);
    }

    // Pixlarna under de osynliga delningarna (linje vid numreringen men inte
    // på lineCanvas) får grannens yta, bredden-först, så att de kan målas.
    function fyllDelningar(alpha) {
        const W = PAPER_W, N = labels.length, ko = [];
        for (let i = 0; i < N; i++) {
            if (labels[i] === 0 && alpha[i * 4 + 3] < LINE_ALPHA) labels[i] = -2;
        }
        for (let i = 0; i < N; i++) {
            if (labels[i] !== -2) continue;
            const x = i % W;
            if ((x > 0 && labels[i - 1] > 0) || (x < W - 1 && labels[i + 1] > 0) ||
                (i >= W && labels[i - W] > 0) || (i < N - W && labels[i + W] > 0)) ko.push(i);
        }
        for (let h = 0; h < ko.length; h++) {
            const i = ko[h];
            if (labels[i] !== -2) continue;
            const x = i % W, y = (i / W) | 0;
            const g = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
            let l = 0;
            for (const q of g) if (q >= 0 && q < N && labels[q] > 0) { l = labels[q]; break; }
            if (!l) continue;
            labels[i] = l;
            regionSize[l]++;
            if (y < regionTop[l]) regionTop[l] = y;
            if (y > regionBottom[l]) regionBottom[l] = y;
            if (x < regionLeft[l]) regionLeft[l] = x;
            if (x > regionRight[l]) regionRight[l] = x;
            for (const q of g) if (q >= 0 && q < N && labels[q] === -2) ko.push(q);
        }
        for (let i = 0; i < N; i++) if (labels[i] === -2) labels[i] = 0;
    }

    // Scanline-fyllning som numrerar ett sammanhängande område (4-grannar).
    function floodLabel(seed, id) {
        const W = PAPER_W, H = PAPER_H;
        const stack = [seed];
        let count = 0, top = H, bottom = 0, left = W, right = 0;
        while (stack.length) {
            const p = stack.pop();
            if (labels[p] !== -1) continue;
            const y = (p / W) | 0;
            const rowStart = y * W;
            let l = p, r = p;
            while (l > rowStart && labels[l - 1] === -1) l--;
            while (r < rowStart + W - 1 && labels[r + 1] === -1) r++;
            for (let i = l; i <= r; i++) labels[i] = id;
            count += r - l + 1;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
            if (l - rowStart < left) left = l - rowStart;
            if (r - rowStart > right) right = r - rowStart;
            for (let dy = -1; dy <= 1; dy += 2) {
                const yy = y + dy;
                if (yy < 0 || yy >= H) continue;
                const base = yy * W;
                let inSpan = false;
                for (let x = l - rowStart; x <= r - rowStart; x++) {
                    if (labels[base + x] === -1) {
                        if (!inSpan) { stack.push(base + x); inSpan = true; }
                    } else {
                        inSpan = false;
                    }
                }
            }
        }
        regionSize[id] = count;
        regionTop[id] = top;
        regionBottom[id] = bottom;
        regionLeft[id] = left;
        regionRight[id] = right;
    }

    // Varje områdes färg = den färg som dominerar på dess pixlar i
    // colorCanvas (Boyer–Moore-majoritet: en enda genomgång, och de få
    // anti-aliasade kantpixlarna i blandfärg röstas bort). Har ytan inte en
    // tydligt dominerande färg och är den stor (t.ex. himmel och mark som
    // läcker ihop genom ett glapp i en blyertslinje) blir den "blandad" och
    // färgas pixel för pixel efter kartan, städad av stadaBlandade().
    const DOMINANS = 0.75;
    const BLANDAD_MIN = 30000;     // mindre ytor tar alltid sin dominerande färg
    function pickRegionColors(pic) {
        const n = regionSize.length;
        facitPx = new Uint32Array(cCtx.getImageData(0, 0, PAPER_W, PAPER_H).data.buffer);
        const px = facitPx;
        for (let i = 0, len = px.length; i < len; i++) {
            // Saknas färg (genomskinligt) eller blev den exakt pappersvit:
            // ta en ljusgrå så att det ändå syns att ytan är ifylld.
            const c = px[i];
            if ((c >>> 24) < 255 || c === PAPER) px[i] = 0xFFEEEEEE;
        }
        const cand = new Uint32Array(n);
        const votes = new Int32Array(n);
        for (let i = 0, len = labels.length; i < len; i++) {
            const l = labels[i];
            if (l <= 0) continue;
            const c = px[i];
            if (votes[l] === 0) { cand[l] = c; votes[l] = 1; }
            else if (cand[l] === c) votes[l]++;
            else votes[l]--;
        }
        const antal = new Int32Array(n);
        const skyddadRest = new Int32Array(n);
        for (let i = 0, len = labels.length; i < len; i++) {
            const l = labels[i];
            if (l <= 0) continue;
            if (px[i] === cand[l]) antal[l]++;
            else if (SKYDDAD.has(px[i])) skyddadRest[l]++;
        }
        regionColor = cand;
        regionBlandad = new Uint8Array(n);
        if (pic && pic.helaYtor) {
            helaYtor(pic.farger);
            return;
        }
        let nagonBlandad = false;
        for (let l = 1; l < n; l++) {
            const tydlig = antal[l] >= regionSize[l] * DOMINANS && regionSize[l] - antal[l] < REST_MAX &&
                skyddadRest[l] < SKYDDAD_MIN;
            if (regionSize[l] >= BLANDAD_MIN && !tydlig) {
                regionBlandad[l] = 1;
                nagonBlandad = true;
            }
        }
        if (nagonBlandad) stadaBlandade();
    }

    // `helaYtor` (äldre spårade bilder): varje yta får en enda färg — den
    // som täcker flest av ytans pixlar i färgkartan — så färgerna följer
    // linjerna. Bara de riktigt stora ytorna (himmel/mark som läcker ihop
    // genom glapp i linjerna, STOR_YTA) färgas pixel för pixel, och där tas
    // fordonets färger bort ur kartan först (det är kartans kanter som
    // slunkit ut utanför fordonets linjer) och ersätts med närmaste
    // bakgrundsfärg. `farger` (punkter) rättar enstaka ytor.
    const STOR_YTA = 100000;
    function helaYtor(farger) {
        const n = regionSize.length, px = facitPx, W = PAPER_W, N = labels.length;
        const rakna = [];
        for (let i = 0; i < N; i++) {
            const l = labels[i];
            if (l <= 0) continue;
            let m = rakna[l];
            if (!m) rakna[l] = m = new Map();
            m.set(px[i], (m.get(px[i]) || 0) + 1);
        }
        let nagonStor = false;
        for (let l = 1; l < n; l++) {
            let bast = 0, flest = -1;
            if (rakna[l]) rakna[l].forEach((k, c) => { if (k > flest) { flest = k; bast = c; } });
            regionColor[l] = bast;
            if (regionSize[l] >= STOR_YTA && flest < regionSize[l] * 0.97) {
                regionBlandad[l] = 1;
                nagonStor = true;
            }
        }
        if (nagonStor) {
            const ko = new Int32Array(N), klar = new Uint8Array(N);
            let svans = 0;
            for (let i = 0; i < N; i++) {
                const l = labels[i];
                if (l > 0 && regionBlandad[l] && BAKGRUND_F.has(px[i])) { klar[i] = 1; ko[svans++] = i; }
            }
            let huvud = 0;
            while (huvud < svans) {
                const i = ko[huvud++], l = labels[i], x = i % W;
                const grannar = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
                for (const q of grannar) {
                    if (q < 0 || q >= N || klar[q] || labels[q] !== l) continue;
                    px[q] = px[i]; klar[q] = 1; ko[svans++] = q;
                }
            }
            delaStoraYtor();
        }
        if (!farger) return;
        Object.keys(farger).forEach(hex => {
            const c = hexTillInt(hex);
            farger[hex].forEach(([x, y]) => {
                const l = labels[y * W + x];
                if (l > 0) { regionColor[l] = c; regionBlandad[l] = 0; }
                else console.warn('Färgpunkt på en linje:', hex, x, y);
            });
        });
    }

    // De stora läckande ytorna i `helaYtor`: linjerna görs tillfälligt GLAPP px
    // tjockare så att ytan delas i delar. En del där en färg dominerar
    // (DEL_DOMINANS) får bara den färgen; annars behålls kartan. Pixlarna
    // närmast linjerna får sedan färg från närmaste del (utan hänsyn till
    // kartan), så gränserna hamnar på linjerna och bara mitt i glappen där
    // det inte finns någon linje.
    const DEL_DOMINANS = 0.85;
    function delaStoraYtor() {
        const W = PAPER_W, H = PAPER_H, N = labels.length, px = facitPx;
        const linjeAvst = new Float32Array(N).fill(1e9);
        // avstånd till närmaste linje (två svep, schackbrädesavstånd räcker)
        for (let i = 0; i < N; i++) if (labels[i] === 0) linjeAvst[i] = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = y * W + x; let d = linjeAvst[i];
            if (x > 0) d = Math.min(d, linjeAvst[i - 1] + 1);
            if (y > 0) d = Math.min(d, linjeAvst[i - W] + 1, x > 0 ? linjeAvst[i - W - 1] + 1.4 : 1e9, x < W - 1 ? linjeAvst[i - W + 1] + 1.4 : 1e9);
            linjeAvst[i] = d;
        }
        for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
            const i = y * W + x; let d = linjeAvst[i];
            if (x < W - 1) d = Math.min(d, linjeAvst[i + 1] + 1);
            if (y < H - 1) d = Math.min(d, linjeAvst[i + W] + 1, x < W - 1 ? linjeAvst[i + W + 1] + 1.4 : 1e9, x > 0 ? linjeAvst[i + W - 1] + 1.4 : 1e9);
            linjeAvst[i] = d;
        }
        const klar = new Uint8Array(N), del = new Uint8Array(N), stack = new Int32Array(N);
        for (let seed = 0; seed < N; seed++) {
            const l = labels[seed];
            if (l <= 0 || !regionBlandad[l] || del[seed] || linjeAvst[seed] <= GLAPP) continue;
            const medlem = [];
            let sp = 0;
            stack[sp++] = seed; del[seed] = 1;
            while (sp) {
                const i = stack[--sp];
                medlem.push(i);
                const x = i % W;
                const grannar = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
                for (const q of grannar) {
                    if (q < 0 || q >= N || del[q] || labels[q] !== l || linjeAvst[q] <= GLAPP) continue;
                    del[q] = 1; stack[sp++] = q;
                }
            }
            const rakna = new Map();
            for (const i of medlem) rakna.set(px[i], (rakna.get(px[i]) || 0) + 1);
            let bast = 0, flest = -1;
            rakna.forEach((k, c) => { if (k > flest) { flest = k; bast = c; } });
            const enhetlig = flest >= medlem.length * DEL_DOMINANS;
            for (const i of medlem) { if (enhetlig) px[i] = bast; klar[i] = 1; }
        }
        let huvud = 0, svans = 0;
        for (let i = 0; i < N; i++) if (klar[i]) stack[svans++] = i;
        while (huvud < svans) {
            const i = stack[huvud++], l = labels[i], x = i % W;
            const grannar = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
            for (const q of grannar) {
                if (q < 0 || q >= N || klar[q] || labels[q] !== l) continue;
                px[q] = px[i]; klar[q] = 1; stack[svans++] = q;
            }
        }
    }

    // Färger från punkter: `farger` = { färg: [[x, y], ...] }, varje punkt
    // ligger inne i en yta som får den färgen. Ytor utan punkt (små celler)
    // tar färgen från närmaste färgade yta: färgen sprids bredden-först
    // från de färgade ytorna genom allt (linjer och ofärgade ytor), och
    // varje ofärgad yta tar den färg som når flest av dess pixlar.
    function fargaFranPunkter(farger) {
        const W = PAPER_W, N = labels.length, n = regionSize.length;
        regionColor = new Uint32Array(n);
        regionBlandad = new Uint8Array(n);
        Object.keys(farger).forEach(hex => {
            const c = hexTillInt(hex);
            farger[hex].forEach(([x, y]) => {
                const l = labels[y * W + x];
                if (l > 0) regionColor[l] = c;
                else console.warn('Färgpunkt på en linje:', hex, x, y);
            });
        });
        const nara = new Uint32Array(N);
        const ko = new Int32Array(N);
        let fram = 0, bak = 0;
        for (let i = 0; i < N; i++) {
            const l = labels[i];
            if (l > 0 && regionColor[l]) { nara[i] = regionColor[l]; ko[bak++] = i; }
        }
        while (fram < bak) {
            const i = ko[fram++], x = i % W;
            const grannar = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
            for (const j of grannar) {
                if (j < 0 || j >= N || nara[j]) continue;
                nara[j] = nara[i];
                ko[bak++] = j;
            }
        }
        const roster = new Map();
        for (let i = 0; i < N; i++) {
            const l = labels[i];
            if (l <= 0 || regionColor[l]) continue;
            let m = roster.get(l);
            if (!m) roster.set(l, m = new Map());
            m.set(nara[i], (m.get(nara[i]) || 0) + 1);
        }
        roster.forEach((m, l) => {
            let bast = 0, flest = -1;
            m.forEach((k, c) => { if (k > flest) { flest = k; bast = c; } });
            regionColor[l] = bast;
        });
    }

    // Blandade ytor (flera färger i kartan, t.ex. himmel + kullar + träd som
    // hänger ihop genom glapp i linjerna) färgas så att färggränserna följer
    // linjerna, inte kartans grova kanter (stadaBlandade):
    //  1. Linjerna görs tillfälligt GLAPP px tjockare så att små glapp sluts,
    //     och ytan delas i delar. En del med tydlig färg får den färgen.
    //  2. Delar som fortfarande är blandade (större glapp): varje färgfläck i
    //     kartan krymps till sin kärna (en bit in från kanten).
    //  3. Allt som återstår (pixlarna nära linjerna och resten av de blandade
    //     delarna) får färg bredden-först från närmaste klara pixel i samma
    //     yta. Linjerna stoppar tillväxten, så gränsen hamnar på linjen där
    //     det finns en, och bara mitt i ett glapp där det inte finns någon.
    const GLAPP = 6;
    const REST_MAX = 12000;        // en yta får en enda färg bara om resten är så här litet …
    const SKYDDAD_MIN = 1500;      // … och den inte har mer skyddad bakgrundsfärg än så
    const KARNA = 22;              // hur långt in från kartans kant kärnan börjar (px)
    const TUNN_FLACK = 6;          // tunnare fläckar (remsor mellan kartans former) får ingen kärna
    function hexTillInt(hex) {
        const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
        return (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
    }
    const BAKGRUND_F = new Set([F.himmel, F.trad, F.stam, F.morkrod, F.akerkulle, F.fjarrkulle, F.grus,
        F.jord, F.moln, F.sol].map(hexTillInt));
    const SKYDDAD = new Set([F.trad, F.stam, F.morkrod, F.akerkulle, F.fjarrkulle, F.grus, F.jord,
        F.moln].map(hexTillInt));
    // Avstånd (i px, ungefärligt) till närmaste pixel med annan färg i kartan.
    function kantAvstand(px) {
        const W = PAPER_W, H = PAPER_H, N = W * H, d = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            const x = i % W;
            const kant = (x > 0 && px[i - 1] !== px[i]) || (x < W - 1 && px[i + 1] !== px[i]) ||
                (i >= W && px[i - W] !== px[i]) || (i < N - W && px[i + W] !== px[i]);
            d[i] = kant ? 0 : 1e9;
        }
        const D = 1, Dd = 1.414;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = y * W + x; let v = d[i];
            if (x > 0) v = Math.min(v, d[i - 1] + D);
            if (y > 0) {
                v = Math.min(v, d[i - W] + D);
                if (x > 0) v = Math.min(v, d[i - W - 1] + Dd);
                if (x < W - 1) v = Math.min(v, d[i - W + 1] + Dd);
            }
            d[i] = v;
        }
        for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
            const i = y * W + x; let v = d[i];
            if (x < W - 1) v = Math.min(v, d[i + 1] + D);
            if (y < H - 1) {
                v = Math.min(v, d[i + W] + D);
                if (x < W - 1) v = Math.min(v, d[i + W + 1] + Dd);
                if (x > 0) v = Math.min(v, d[i + W - 1] + Dd);
            }
            d[i] = v;
        }
        return d;
    }

    function stadaBlandade() {
        const W = PAPER_W, H = PAPER_H, N = labels.length, px = facitPx;
        // Tjockare linjer: max-filter, först längs rader och sedan kolumner
        const rad = new Uint8Array(N), nara = new Uint8Array(N);
        for (let y = 0; y < H; y++) {
            let senast = -1e9;
            for (let x = 0; x < W; x++) {
                if (labels[y * W + x] === 0) senast = x;
                if (x - senast <= GLAPP) rad[y * W + x] = 1;
            }
            senast = 1e9;
            for (let x = W - 1; x >= 0; x--) {
                if (labels[y * W + x] === 0) senast = x;
                if (senast - x <= GLAPP) rad[y * W + x] = 1;
            }
        }
        for (let x = 0; x < W; x++) {
            let senast = -1e9;
            for (let y = 0; y < H; y++) {
                if (rad[y * W + x]) senast = y;
                if (y - senast <= GLAPP) nara[y * W + x] = 1;
            }
            senast = 1e9;
            for (let y = H - 1; y >= 0; y--) {
                if (rad[y * W + x]) senast = y;
                if (senast - y <= GLAPP) nara[y * W + x] = 1;
            }
        }
        // Dela upp de blandade ytorna i delar (4-grannar, utanför de tjocka linjerna)
        const del = new Int32Array(N);
        const klar = new Uint8Array(N);
        const stack = new Int32Array(N);
        const ko = new Int32Array(N);
        const blandDel = new Uint8Array(N);
        let nagonBlandDel = false;
        let svans = 0;
        for (let seed = 0; seed < N; seed++) {
            const l = labels[seed];
            if (l <= 0 || !regionBlandad[l] || nara[seed] || del[seed]) continue;
            // Samla delen och rösta fram dess färg
            const medlem = [];
            let sp = 0;
            stack[sp++] = seed;
            del[seed] = 1;
            let cand = 0, votes = 0;
            while (sp) {
                const i = stack[--sp];
                medlem.push(i);
                const c = px[i];
                if (votes === 0) { cand = c; votes = 1; }
                else if (c === cand) votes++;
                else votes--;
                const x = i % W;
                if (x > 0) { const q = i - 1; if (!del[q] && !nara[q] && labels[q] === l) { del[q] = 1; stack[sp++] = q; } }
                if (x < W - 1) { const q = i + 1; if (!del[q] && !nara[q] && labels[q] === l) { del[q] = 1; stack[sp++] = q; } }
                if (i >= W) { const q = i - W; if (!del[q] && !nara[q] && labels[q] === l) { del[q] = 1; stack[sp++] = q; } }
                if (i < N - W) { const q = i + W; if (!del[q] && !nara[q] && labels[q] === l) { del[q] = 1; stack[sp++] = q; } }
            }
            const rakna = new Map();
            for (const i of medlem) rakna.set(px[i], (rakna.get(px[i]) || 0) + 1);
            const antal = rakna.get(cand);
            // Skyddade bakgrundsfärger (t.ex. lite mark under himlen) stoppar utplattning
            let skyddadRest = 0;
            rakna.forEach((k, c) => { if (c !== cand && SKYDDAD.has(c)) skyddadRest += k; });
            if ((antal >= medlem.length * DOMINANS && medlem.length - antal < REST_MAX &&
                 skyddadRest < SKYDDAD_MIN) || medlem.length < BLANDAD_MIN) {
                for (const i of medlem) { px[i] = cand; klar[i] = 1; }
            } else {
                // Fortfarande blandad (t.ex. trädkrona + himmel genom ett större
                // glapp): färgas från kärnor längre fram.
                for (const i of medlem) blandDel[i] = 1;
                nagonBlandDel = true;
            }
        }
        // Blandade delar: kärnor (en bit in från kartans kanter, bara i fläckar
        // som är tjockare än en remsa) som sedan växer ut nedan.
        if (nagonBlandDel) {
            const d = kantAvstand(px);
            const flack = new Int32Array(N).fill(-1), flackMax = [];
            let nf = 0;
            for (let seed = 0; seed < N; seed++) {
                if (flack[seed] >= 0) continue;
                const c = px[seed];
                let sp = 0, max = 0;
                stack[sp++] = seed; flack[seed] = nf;
                while (sp) {
                    const i = stack[--sp];
                    if (d[i] > max) max = d[i];
                    const x = i % W;
                    if (x > 0 && flack[i - 1] < 0 && px[i - 1] === c) { flack[i - 1] = nf; stack[sp++] = i - 1; }
                    if (x < W - 1 && flack[i + 1] < 0 && px[i + 1] === c) { flack[i + 1] = nf; stack[sp++] = i + 1; }
                    if (i >= W && flack[i - W] < 0 && px[i - W] === c) { flack[i - W] = nf; stack[sp++] = i - W; }
                    if (i < N - W && flack[i + W] < 0 && px[i + W] === c) { flack[i + W] = nf; stack[sp++] = i + W; }
                }
                flackMax.push(max);
                nf++;
            }
            for (let i = 0; i < N; i++) {
                if (!blandDel[i]) continue;
                const m = flackMax[flack[i]];
                if (m >= TUNN_FLACK && d[i] >= Math.min(KARNA, m * 0.5)) klar[i] = 1;
            }
        }
        // Pixlarna nära linjerna och resten av de blandade delarna: färg från
        // närmaste klara pixel i samma yta. Först växer varje färg bara in där
        // kartan har samma färg (så smala stolpar och ramar mellan linjerna får
        // sin egen färg), sedan fylls det som återstår utan den begränsningen.
        const karta = px.slice();
        for (let steg = 0; steg < 2; steg++) {
            if (steg === 1) {
                // Det som inte nåtts: i ytor på själva fordonet (dominerande
                // färg är ingen bakgrundsfärg) tar smala bitar kartans färg
                // direkt (en stolpe i hyttens ram, springor i grillen). I
                // bakgrundsytor är kartans fordonsfärg däremot kanter som
                // slunkit ut utanför linjerna, och de fylls från grannarna nedan.
                for (let i = 0; i < N; i++) {
                    const l = labels[i];
                    if (klar[i] || l <= 0 || !regionBlandad[l]) continue;
                    if (karta[i] === regionColor[l] ||
                        (!BAKGRUND_F.has(regionColor[l]) && !BAKGRUND_F.has(karta[i]))) {
                        px[i] = karta[i]; klar[i] = 1;
                    }
                }
            }
            svans = 0;
            for (let i = 0; i < N; i++) {
                if (!klar[i]) continue;
                const x = i % W;
                if ((x > 0 && !klar[i - 1]) || (x < W - 1 && !klar[i + 1]) ||
                    (i >= W && !klar[i - W]) || (i < N - W && !klar[i + W])) ko[svans++] = i;
            }
            let huvud = 0;
            while (huvud < svans) {
                const i = ko[huvud++], l = labels[i], x = i % W;
                const grannar = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
                for (const q of grannar) {
                    if (q < 0 || q >= N || klar[q] || labels[q] !== l) continue;
                    if (steg === 0 && karta[q] !== px[i]) continue;
                    px[q] = px[i];
                    klar[q] = 1;
                    ko[svans++] = q;
                }
            }
        }
    }

    // --- Clawd ---
    // Den busiga lilla kompisen (från repot isak-wallo/clawd) gömmer sig i
    // varje bild, som krypet i Richard Scarrys böcker. Han syns inte från
    // början; när man målar där han är poppar han upp, vinkar och blir kvar.
    // Han ritas av sina pixelklossar (originalets mått 280 x 178 px, origo
    // nere till vänster), så han blir skarp i alla storlekar.
    const CLAWD_ORANGE = '#d77656';
    const CLAWD_TRAFF = 40;     // så många målade pixlar på honom innan han poppar
    const CLAWD_MS = 3200;      // hela animationen: upp, vinka, blinka
    let clawd = null;           // { x, y, s, box, mask, tmp, hittad, start, traff }
    let clawdYta = new Uint8Array(1);   // 1 för ytor han syns i

    function ritaClawd(ctx, x, y, s, arm, blink) {
        const X = v => Math.round(x + (v - 140) * s), Y = v => Math.round(y + v * s);
        const kloss = (x0, y0, x1, y1) => ctx.fillRect(X(x0), Y(y0), X(x1) - X(x0), Y(y1) - Y(y0));
        ctx.fillStyle = CLAWD_ORANGE;
        kloss(48, -178, 232, -42);                 // kropp
        kloss(0, -130, 48, -86);                   // vänster arm
        const ay = -130 - Math.round(arm * 4) * 12;  // höger arm, flyttas i steg om 12 px
        kloss(232, ay, 280, ay + 44);
        [[48, 72], [96, 116], [164, 188], [212, 232]].forEach(([a, b]) => kloss(a, -42, b, 0));
        ctx.fillStyle = '#000';
        if (blink) {
            kloss(72, -142, 96, -136);
            kloss(188, -142, 212, -136);
        } else {
            kloss(72, -154, 96, -124);
            kloss(188, -154, 212, -124);
        }
    }

    // Förbereder Clawd för bilden: ruta, mask (de ytor han syns i) och
    // en arbetscanvas. Anropas efter labelRegions.
    function prepClawd(c, hittad) {
        clawdYta = new Uint8Array(regionSize.length);
        c.ytor.forEach(([px, py]) => {
            const l = labels[Math.round(py) * PAPER_W + Math.round(px)];
            if (l > 0) clawdYta[l] = 1;
        });
        // Rutan rymmer honom plus lite luft ovanför (han studsar lite förbi)
        const x0 = Math.max(0, Math.floor(c.x - 142 * c.s));
        const x1 = Math.min(PAPER_W - 1, Math.ceil(c.x + 142 * c.s));
        const y0 = Math.max(0, Math.floor(c.y - 178 * c.s * 1.2));
        const y1 = Math.min(PAPER_H - 1, Math.ceil(c.y));
        const w = x1 - x0 + 1, h = y1 - y0 + 1;
        const mask = document.createElement('canvas');
        mask.width = w;
        mask.height = h;
        const mctx = mask.getContext('2d');
        const img = mctx.createImageData(w, h);
        const px = new Uint32Array(img.data.buffer);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (clawdYta[labels[(y0 + y) * PAPER_W + x0 + x]]) px[y * w + x] = 0xFF000000;
            }
        }
        mctx.putImageData(img, 0, 0);
        const tmp = document.createElement('canvas');
        tmp.width = w;
        tmp.height = h;
        clawd = { x: c.x, y: c.y, s: c.s, box: { x0, y0, x1, y1, w, h },
                  mask, tmp, hittad, start: -Infinity, traff: 0 };
    }

    function poppaClawd() {
        if (!clawd || clawd.hittad) return;
        clawd.hittad = true;
        clawd.start = performance.now();
        requestRender();
    }

    // Ritar Clawd (om han är hittad) på vCtx, som redan har bildens transform.
    // Returnerar true medan animationen pågår.
    function renderClawd(now) {
        if (!clawd || !clawd.hittad) return false;
        const t = now - clawd.start;
        const b = clawd.box, hojd = 178 * clawd.s;
        // Upp bakom kanten med en liten studs (0–600 ms)
        let upp = 1;
        if (t < 600) {
            const p = t / 600, k = 1.5;
            upp = 1 + (k + 1) * Math.pow(p - 1, 3) + k * Math.pow(p - 1, 2);
        }
        // Vinkar två gånger (700–2300 ms), blinkar en gång efteråt
        let arm = 0;
        if (t > 700 && t < 2300) {
            const v = ((t - 700) / 800) % 1;
            arm = v < 0.5 ? Math.min(1, v * 4) : Math.max(0, (1 - v) * 4);
        }
        const blink = t > 2600 && t < 2760;
        const tctx = clawd.tmp.getContext('2d');
        tctx.globalCompositeOperation = 'source-over';
        tctx.clearRect(0, 0, b.w, b.h);
        ritaClawd(tctx, clawd.x - b.x0, clawd.y - b.y0 + (1 - upp) * hojd, clawd.s, arm, blink);
        tctx.globalCompositeOperation = 'destination-in';
        tctx.drawImage(clawd.mask, 0, 0);
        tctx.globalCompositeOperation = 'source-over';
        vCtx.drawImage(clawd.tmp, b.x0, b.y0);
        return t < CLAWD_MS;
    }

    // Varje bild minns det man målat medan appen är öppen, så man kan
    // bläddra fram och tillbaka utan att förlora något.
    const pictureState = [];
    let pictureLoaded = false;

    function loadPicture(index) {
        const pic = PICTURES[index];
        if (pic.img && !(pic.img.complete && pic.img.naturalWidth)) {
            // Bildfilen är inte laddad än: byt när den är klar
            vantarPaBild = index;
            pic.img.onload = () => { if (vantarPaBild === index) loadPicture(index); };
            return;
        }
        vantarPaBild = -1;
        if (pictureLoaded) {
            finishFades();
            pictureState[currentPicture] = { fill: fillPx.slice(), clawd: !!(clawd && clawd.hittad) };
        }
        pictureLoaded = true;
        currentPicture = index;
        const rita = PICTURES[index].rita;
        lCtx.setTransform(1, 0, 0, 1, 0, 0);
        lCtx.clearRect(0, 0, PAPER_W, PAPER_H);
        kant = LW;
        rita(lCtx, pic);
        // `tillagg`: korta streck som stänger glapp i en spårad bilds linjer.
        // `delningar` ritas likadant men bara medan ytorna numreras (osynliga
        // gränser, t.ex. mellan himmel och kulle där linjen tar slut).
        const ritaStreck = (lista) => {
            lCtx.save();
            lCtx.strokeStyle = LINJEFARG;
            lCtx.lineWidth = 5;
            lCtx.lineCap = lCtx.lineJoin = 'round';
            lista.forEach(p => {
                lCtx.beginPath();
                lCtx.moveTo(p[0], p[1]);
                for (let k = 2; k < p.length; k += 2) lCtx.lineTo(p[k], p[k + 1]);
                lCtx.stroke();
            });
            lCtx.restore();
        };
        if (pic.tillagg) ritaStreck(pic.tillagg);
        let utanDelningar = null;
        if (pic.delningar) {
            utanDelningar = lCtx.getImageData(0, 0, PAPER_W, PAPER_H);
            ritaStreck(pic.delningar);
        }
        cCtx.setTransform(1, 0, 0, 1, 0, 0);
        cCtx.clearRect(0, 0, PAPER_W, PAPER_H);
        fargLage = true;
        kant = LW;
        rita(cCtx, pic);
        fargLage = false;
        labelRegions();
        if (utanDelningar) {
            lCtx.putImageData(utanDelningar, 0, 0);
            fyllDelningar(utanDelningar.data);
        }
        if (pic.farger && !pic.helaYtor) fargaFranPunkter(pic.farger);
        else pickRegionColors(pic);
        fades.length = 0;
        const saved = pictureState[index];
        prepClawd(PICTURES[index].clawd, !!(saved && saved.clawd));
        if (saved) {
            fillPx.set(saved.fill);
            for (let i = 0, n = labels.length; i < n; i++) {
                const l = labels[i];
                if (l > 0 && fillPx[i] !== PAPER) regionPainted[l]++;
            }
            for (let l = 1; l < regionSize.length; l++) {
                if (regionPainted[l] === regionSize[l]) regionDone[l] = 1;
            }
        } else {
            fillPx.fill(PAPER);
        }
        fCtx.putImageData(fillImage, 0, 0);
        dirty = null;
        resetClearButton();
        requestRender();
    }

    function changePicture(step) {
        const bas = vantarPaBild >= 0 ? vantarPaBild : currentPicture;
        loadPicture((bas + step + PICTURES.length) % PICTURES.length);
    }

    // --- Rendering ---
    // Bilden passas in i ytan (utan beskärning). Är ytan stående (iPad i
    // porträtt) roteras bilden 90° medurs så den fortfarande blir stor.
    let xf = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

    function updateTransform() {
        const W = viewCanvas.width, H = viewCanvas.height;
        if (W >= H) {
            const s = Math.min(W / PAPER_W, H / PAPER_H);
            xf = { a: s, b: 0, c: 0, d: s,
                   e: (W - PAPER_W * s) / 2, f: (H - PAPER_H * s) / 2 };
        } else {
            const s = Math.min(H / PAPER_W, W / PAPER_H);
            xf = { a: 0, b: s, c: -s, d: 0,
                   e: W / 2 + (PAPER_H / 2) * s, f: H / 2 - (PAPER_W / 2) * s };
        }
    }

    // Ritning sker högst en gång per frame (requestRender). Målade pixlar
    // skrivs till fillPx direkt; `dirty` samlar vilken rektangel som
    // behöver föras över till fillCanvas innan nästa ritning.
    let dirty = null;
    let renderPending = false;

    function markDirty(x0, y0, x1, y1) {
        if (!dirty) dirty = { x0, y0, x1, y1 };
        else {
            if (x0 < dirty.x0) dirty.x0 = x0;
            if (y0 < dirty.y0) dirty.y0 = y0;
            if (x1 > dirty.x1) dirty.x1 = x1;
            if (y1 > dirty.y1) dirty.y1 = y1;
        }
    }

    function requestRender() {
        if (renderPending) return;
        renderPending = true;
        requestAnimationFrame(() => {
            renderPending = false;
            render();
        });
    }

    function render() {
        if (dirty) {
            fCtx.putImageData(fillImage, 0, 0, dirty.x0, dirty.y0,
                dirty.x1 - dirty.x0 + 1, dirty.y1 - dirty.y0 + 1);
            dirty = null;
        }
        const W = viewCanvas.width, H = viewCanvas.height;
        if (W === 0 || H === 0) return;
        updateTransform();
        vCtx.setTransform(1, 0, 0, 1, 0, 0);
        vCtx.fillStyle = BAKGRUND;
        vCtx.fillRect(0, 0, W, H);
        vCtx.setTransform(xf.a, xf.b, xf.c, xf.d, xf.e, xf.f);
        vCtx.drawImage(fillCanvas, 0, 0);
        // Ytor som håller på att fyllas i tonas fram ovanpå
        const now = performance.now();
        for (let k = fades.length - 1; k >= 0; k--) {
            const f = fades[k];
            if (ritaFade(f, now)) {
                commitRegion(f.id);
                fades.splice(k, 1);
                continue;
            }
            vCtx.drawImage(f.canvas, f.x, f.y);
        }
        if (dirty) {    // commitRegion ovan kan ha målat klart en yta
            fCtx.putImageData(fillImage, 0, 0, dirty.x0, dirty.y0,
                dirty.x1 - dirty.x0 + 1, dirty.y1 - dirty.y0 + 1);
            dirty = null;
            vCtx.drawImage(fillCanvas, 0, 0);
        }
        const clawdRor = renderClawd(now);
        vCtx.drawImage(lineCanvas, 0, 0);
        vCtx.setTransform(1, 0, 0, 1, 0, 0);
        if (fades.length || clawdRor) requestRender();
    }

    // Skärmkoordinat -> bildkoordinat (inversen av xf)
    function getPaperCoords(clientX, clientY) {
        const vx = clientX - viewRect.left - xf.e;
        const vy = clientY - viewRect.top - xf.f;
        const det = xf.a * xf.d - xf.b * xf.c;
        return {
            x: (xf.d * vx - xf.c * vy) / det,
            y: (-xf.b * vx + xf.a * vy) / det
        };
    }

    // --- Måla ---
    // Fingret är en pensel som målar fram ytornas givna färger (den kan inte
    // välja färg). När FYLL_ANDEL av en yta är målad fylls resten i av sig
    // själv: färgen rinner mjukt ut från det målade (startFade/ritaFade).
    const PENSEL = 28;         // penselns radie i bildpixlar
    const FYLL_ANDEL = 0.95;
    const FADE_MS = 600;        // kortaste ifyllnadstid …
    const FADE_MAX_MS = 1600;   // … och längsta
    const FADE_PER_PX = 12;     // ms per pixel som färgen ska rinna
    const FADE_BAND = 14;       // bredd på den mjuka kanten (px)
    const fades = [];          // { id, canvas, x, y, start }
    const touched = new Set(); // ytor som penseln nuddat i den här rörelsen

    // Målar en rund klick med penseln kring (cx, cy) i bildkoordinater.
    function stamp(cx, cy) {
        const W = PAPER_W, H = PAPER_H, r = PENSEL;
        const y0 = Math.max(0, Math.ceil(cy - r)), y1 = Math.min(H - 1, Math.floor(cy + r));
        if (y0 > y1) return;
        let minX = W, maxX = -1;
        for (let y = y0; y <= y1; y++) {
            const dy = y - cy;
            const half = Math.sqrt(r * r - dy * dy);
            const xa = Math.max(0, Math.ceil(cx - half)), xb = Math.min(W - 1, Math.floor(cx + half));
            if (xa > xb) continue;
            if (xa < minX) minX = xa;
            if (xb > maxX) maxX = xb;
            const kollaClawd = clawd && !clawd.hittad && y >= clawd.box.y0 && y <= clawd.box.y1;
            for (let i = y * W + xa, end = y * W + xb; i <= end; i++) {
                const l = labels[i];
                if (kollaClawd && clawdYta[l]) {
                    const x = i - y * W;
                    if (x >= clawd.box.x0 && x <= clawd.box.x1) clawd.traff++;
                }
                if (l <= 0 || regionDone[l] || fillPx[i] !== PAPER) continue;
                fillPx[i] = regionBlandad[l] ? facitPx[i] : regionColor[l];
                regionPainted[l]++;
                touched.add(l);
            }
        }
        if (maxX >= minX) markDirty(minX, y0, maxX, y1);
    }

    // Penseldrag från a till b: klickar tätt längs sträckan.
    function stroke(ax, ay, bx, by) {
        const d = Math.hypot(bx - ax, by - ay);
        const steg = Math.max(1, Math.ceil(d / (PENSEL * 0.35)));
        for (let k = 1; k <= steg; k++) {
            stamp(ax + (bx - ax) * k / steg, ay + (by - ay) * k / steg);
        }
    }

    // Kollar om någon av de nyss målade ytorna nått gränsen.
    function checkTouched() {
        touched.forEach(l => {
            if (regionDone[l]) return;
            if (regionSize[l] < MIN_REGION) {
                regionDone[l] = 1;
                commitRegion(l);
            } else if (regionPainted[l] >= regionSize[l] * FYLL_ANDEL) {
                startFade(l);
            }
        });
        touched.clear();
        if (clawd && !clawd.hittad && clawd.traff >= CLAWD_TRAFF) poppaClawd();
        if (clearState) resetClearButton();
        requestRender();
    }

    // Lägger det som är kvar av ytan på en egen liten canvas som tonas fram
    // ovanpå; när toningen är klar skrivs den in i fillPx (commitRegion).
    function startFade(id) {
        regionDone[id] = 1;
        if (clawdYta[id]) poppaClawd();
        const W = PAPER_W;
        const x0 = regionLeft[id], y0 = regionTop[id];
        const w = regionRight[id] - x0 + 1, h = regionBottom[id] - y0 + 1;
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(w, h);
        const px = new Uint32Array(img.data.buffer);
        const col = regionColor[id], blandad = regionBlandad[id];
        // Färgen rinner ut från det som redan är målat: bredden-först genom
        // de omålade pixlarna, i avståndsordning (ordning + avstånd sparas).
        const dist = new Int32Array(w * h).fill(-1);
        const ordning = [];
        for (let y = 0; y < h; y++) {
            const row = (y0 + y) * W + x0;
            for (let x = 0; x < w; x++) {
                const i = row + x;
                if (labels[i] === id && fillPx[i] !== PAPER) dist[y * w + x] = 0;
            }
        }
        for (let k = 0; k < w * h; k++) {
            if (dist[k] !== 0) continue;
            const x = k % w;
            if ((x > 0 && dist[k - 1] < 0) || (x < w - 1 && dist[k + 1] < 0) ||
                (k >= w && dist[k - w] < 0) || (k < w * h - w && dist[k + w] < 0)) ordning.push(k);
        }
        const fargAv = (k) => {
            const i = (y0 + ((k / w) | 0)) * W + x0 + (k % w);
            return blandad ? facitPx[i] : col;
        };
        // Avstånd med 8 grannar (5 rakt, 7 snett) i en hink-kö, så att
        // kanten blir rund i stället för spetsig. Avståndet räknas i femtedels px.
        const hinkar = [ordning.slice()];
        ordning.length = 0;
        for (let d = 0; d < hinkar.length; d++) {
            const hink = hinkar[d];
            if (!hink) continue;
            for (let n = 0; n < hink.length; n++) {
                const k = hink[n];
                if (dist[k] !== d) continue;           // redan nådd kortare väg
                ordning.push(k);
                const x = k % w;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (!dx && !dy) continue;
                        const xx = x + dx;
                        if (xx < 0 || xx >= w) continue;
                        const q = k + dy * w + dx;
                        if (q < 0 || q >= w * h) continue;
                        const nd = d + (dx && dy ? 7 : 5);
                        if (dist[q] !== -1 && dist[q] <= nd) continue;
                        const i = (y0 + ((q / w) | 0)) * W + x0 + xx;
                        if (labels[i] !== id || (dist[q] === 0)) continue;
                        dist[q] = nd;
                        (hinkar[nd] || (hinkar[nd] = [])).push(q);
                    }
                }
            }
            hinkar[d] = null;
        }
        for (let k = 0; k < w * h; k++) if (dist[k] > 0) dist[k] = (dist[k] / 5) | 0;
        // Bara de omålade pixlarna ska tonas fram (ordning börjar med kanten av det målade)
        const kvar = ordning.filter(k => dist[k] > 0);
        // Omålade pixlar som inte nås (ingen målad granne) läggs sist
        for (let y = 0; y < h; y++) {
            const row = (y0 + y) * W + x0;
            for (let x = 0; x < w; x++) {
                const k = y * w + x;
                if (dist[k] === -1 && labels[row + x] === id && fillPx[row + x] === PAPER) kvar.push(k);
            }
        }
        const maxD = kvar.length ? Math.max(1, dist[kvar[kvar.length - 1]]) : 1;
        const tid = Math.min(FADE_MAX_MS, Math.max(FADE_MS, 300 + maxD * FADE_PER_PX));
        fades.push({ id, canvas: c, ctx, img, px, x: x0, y: y0, w, kvar, dist, maxD, fargAv,
            klara: 0, start: performance.now(), tid });
    }

    // Flyttar fram färgens kant: pixlar bakom kanten blir helt täckta, de i
    // kantbandet (FADE_BAND px) halvgenomskinliga, så kanten blir mjuk.
    function ritaFade(f, now) {
        const t = Math.min(1, (now - f.start) / f.tid);
        const p = 1 - (1 - t) * (1 - t);                // snabb start, mjukt slut
        const front = p * (f.maxD + FADE_BAND);
        let x0 = f.w, y0 = 1e9, x1 = -1, y1 = -1;
        let k = f.klara;
        for (; k < f.kvar.length; k++) {
            const q = f.kvar[k], d = f.dist[q] < 0 ? f.maxD : f.dist[q];
            if (d > front) break;
            const a = Math.min(1, (front - d) / FADE_BAND);
            const c = f.fargAv(q);
            f.px[q] = ((Math.round(a * 255) << 24) | (c & 0xFFFFFF)) >>> 0;
            const x = q % f.w, y = (q / f.w) | 0;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        // pixlarna längst bak i bandet är nu helt täckta och behöver inte röras igen
        while (f.klara < k) {
            const q = f.kvar[f.klara], d = f.dist[q] < 0 ? f.maxD : f.dist[q];
            if (front - d < FADE_BAND) break;
            f.klara++;
        }
        if (x1 >= 0) f.ctx.putImageData(f.img, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
        return t >= 1;
    }

    // Fyller hela ytan i fillPx (direkt, utan toning).
    function commitRegion(id) {
        const W = PAPER_W;
        const col = regionColor[id], blandad = regionBlandad[id];
        const x0 = regionLeft[id], x1 = regionRight[id];
        const y0 = regionTop[id], y1 = regionBottom[id];
        for (let y = y0; y <= y1; y++) {
            for (let i = y * W + x0, end = y * W + x1; i <= end; i++) {
                if (labels[i] === id) fillPx[i] = blandad ? facitPx[i] : col;
            }
        }
        regionPainted[id] = regionSize[id];
        markDirty(x0, y0, x1, y1);
    }

    // Gör klart alla pågående toningar direkt (inför bildbyte).
    function finishFades() {
        fades.forEach(f => commitRegion(f.id));
        fades.length = 0;
    }

    // Alla fingrar målar. Varje finger minns sin senaste punkt.
    const fingers = new Map();

    function onTouchStart(e) {
        if (e.cancelable) e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i];
            const p = getPaperCoords(t.clientX, t.clientY);
            fingers.set(t.identifier, p);
            stamp(p.x, p.y);
        }
        checkTouched();
    }

    function onTouchMove(e) {
        if (e.cancelable) e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i];
            const last = fingers.get(t.identifier);
            if (!last) continue;
            const p = getPaperCoords(t.clientX, t.clientY);
            stroke(last.x, last.y, p.x, p.y);
            fingers.set(t.identifier, p);
        }
        checkTouched();
    }

    function onTouchEnd(e) {
        for (let i = 0; i < e.changedTouches.length; i++) fingers.delete(e.changedTouches[i].identifier);
    }

    // --- SPARA ---
    // Sparar bilden som den ser ut nu (det målade, Clawd om han är hittad,
    // och konturerna) som en PNG i 1200x900. Laddas ner till plattans
    // Hämtade filer (Downloads), där den syns i Galleri/Filer.
    let sparaTimer = null;
    function sparaBild() {
        finishFades();
        if (dirty) { fCtx.putImageData(fillImage, 0, 0); dirty = null; }
        const c = document.createElement('canvas');
        c.width = PAPER_W;
        c.height = PAPER_H;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, PAPER_W, PAPER_H);
        ctx.drawImage(fillCanvas, 0, 0);
        if (clawd && clawd.hittad) {
            const b = clawd.box, tctx = clawd.tmp.getContext('2d');
            tctx.globalCompositeOperation = 'source-over';
            tctx.clearRect(0, 0, b.w, b.h);
            ritaClawd(tctx, clawd.x - b.x0, clawd.y - b.y0, clawd.s, 0, false);
            tctx.globalCompositeOperation = 'destination-in';
            tctx.drawImage(clawd.mask, 0, 0);
            tctx.globalCompositeOperation = 'source-over';
            ctx.drawImage(clawd.tmp, b.x0, b.y0);
        }
        ctx.drawImage(lineCanvas, 0, 0);
        const d = new Date(), tv = n => String(n).padStart(2, '0');
        const namn = 'farga-' + PICTURES[currentPicture].namn.toLowerCase()
            .replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') +
            '-' + d.getFullYear() + tv(d.getMonth() + 1) + tv(d.getDate()) + '-' +
            tv(d.getHours()) + tv(d.getMinutes()) + tv(d.getSeconds()) + '.png';
        c.toBlob(blob => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = namn;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        }, 'image/png');
        // Kvittens på knappen en stund
        saveBtn.textContent = 'SPARAD ✓';
        saveBtn.classList.add('sparad');
        if (sparaTimer) clearTimeout(sparaTimer);
        sparaTimer = setTimeout(() => {
            saveBtn.textContent = 'SPARA';
            saveBtn.classList.remove('sparad');
        }, 2000);
    }

    // BÖRJA OM — tvåstegs med hållning: första hållningen (1 s) visar
    // "SÄKER?" (5 s timeout / nollställs om man målar), andra hållningen
    // (1 s) tömmer bilden.
    function handleClear() {
        if (clearState === 0) {
            clearState = 1;
            restartBtn.textContent = 'SÄKER?';
            restartBtn.classList.add('confirm');
            clearTimer = setTimeout(resetClearButton, 5000);
        } else {
            fades.length = 0;
            if (clawd) { clawd.hittad = false; clawd.traff = 0; }
            fillPx.fill(PAPER);
            regionPainted.fill(0);
            regionDone.fill(0);
            fCtx.putImageData(fillImage, 0, 0);
            dirty = null;
            requestRender();
            resetClearButton();
        }
    }

    function resetClearButton() {
        clearState = 0;
        if (clearTimer) {
            clearTimeout(clearTimer);
            clearTimer = null;
        }
        if (restartBtn) {
            restartBtn.textContent = 'BÖRJA OM';
            restartBtn.classList.remove('confirm');
        }
    }

    function isInstalledApp() {
        return window.matchMedia('(display-mode: standalone)').matches
            || window.navigator.standalone === true;
    }

    function startApp() {
        // Begär alltid fullscreen — även om fullscreenElement ser satt ut.
        // Android kan tvinga fram systemfälten (t.ex. vid skärmlåsning) utan
        // att HTML-fullscreen formellt släpps; en ny begäran med gest rättar
        // till läget, och är den redan i fullscreen händer inget.
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(err => {
                console.log(`Helskärm misslyckades: ${err.message}`);
            });
        } else if (document.documentElement.webkitRequestFullscreen) {
            // Äldre iPads (före iPadOS 16.4) har bara webkit-prefixet.
            document.documentElement.webkitRequestFullscreen();
        }
        document.getElementById('start-overlay').style.display = 'none';
        setTimeout(applyLayout, 100);
    }

    // Startskärmen fungerar som återhämtningsläge: den visas vid bakåt-tryck
    // och när fullscreen tappats, och BÖRJA MÅLA-knappen (en äkta gest) tar
    // tillbaka in i fullscreen. Det målade påverkas inte.
    function showStartOverlay() {
        startOverlay.style.display = 'flex';
        resetClearButton();
    }

    // --- Händelsebindningar (tidigare inline i HTML) ---
    document.getElementById('start-btn').addEventListener('click', startApp);

    // Bläddra mellan bilder: touchstart (med stopPropagation) agerar direkt
    // för touch, click för mus.
    [['prev-btn', -1], ['next-btn', 1]].forEach(([id, step]) => {
        const btn = document.getElementById(id);
        btn.addEventListener('click', () => changePicture(step));
        btn.addEventListener('touchstart', function(e) {
            e.preventDefault();
            e.stopPropagation();
            changePicture(step);
        }, { passive: false });
    });

    // BÖRJA OM (två hållningar, SÄKER?) och SPARA (en hållning) — håll in
    // HOLD_MS (1 s). Touchstart stopPropagates så den inte målar; mousedown
    // för test på dator.
    function holdEnd() {
        endHold();
        restartBtn.classList.remove('holding');
        saveBtn.classList.remove('holding');
    }

    [restartBtn, saveBtn].forEach(btn => {
        const holdStart = () => {
            startHold(btn);
            btn.classList.add('holding');
        };
        btn.addEventListener('touchstart', function(e) {
            e.stopPropagation();
            holdStart();
            e.preventDefault();
        }, { passive: false });

        // Touch-hållning avbryts om fingret glider utanför knappen (samma som
        // mouseleave för mus). Touch-event riktas alltid till elementet där
        // touchen startade, så touchmove på knappen räcker för en bounds-check.
        btn.addEventListener('touchmove', function(e) {
            const t = e.changedTouches[0];
            const r = this.getBoundingClientRect();
            if (t.clientX < r.left || t.clientX > r.right ||
                t.clientY < r.top || t.clientY > r.bottom) {
                holdEnd();
            }
        }, { passive: true });

        // Mus: mousedown startar hållningen (bara vänster knapp), mouseup/mouseleave avslutar
        btn.addEventListener('mousedown', function(e) {
            if (e.button !== 0) return;
            e.stopPropagation();
            holdStart();
        });
        btn.addEventListener('mouseleave', holdEnd);
    });

    // touchend/cancel på hela fönstret stänger hållningen (fingret lyfts)
    window.addEventListener('touchend', holdEnd, { passive: true });
    window.addEventListener('touchcancel', holdEnd, { passive: true });
    window.addEventListener('mouseup', holdEnd);

    // --- Back-knapp: håll användaren kvar i appen ---
    // Bakåt får aldrig lämna sidan — i pinnat läge strandar den installerade
    // appen annars på WebAPK:ns svarta splash-skärm, som bara går att lämna
    // genom att avpinna. Skydd i två lager:
    //
    // 1) Navigation API: avbryter traverseringen helt tyst. Androids
    //    system-bakåt undantas dock av Chrome (den ska alltid "fungera"),
    //    så i praktiken skyddar detta mest vid test i desktop-Chrome.
    // 2) Gest-armerad pushState-buffert: vid touch fylls historiken på med
    //    poster (samma URL, märkta med fargaDepth) upp till MAX_TRAP_DEPTH.
    //    Poster skapade MED gest respekteras av Chromes "history
    //    manipulation intervention", så varje bakåt-tryck kliver bara ner
    //    ett steg i bufferten — osynligt för användaren, ritytan lämnas
    //    inte. Nästa touch fyller på bufferten igen. Först på botten
    //    (poster utan fargaDepth) visas startskärmen och en sista
    //    fångstpost pushas. OBS: pushState inne i popstate (= utan gest)
    //    flaggas av interventionen så att NÄSTA bakåt lämnar sidan — därför
    //    görs det enbart som sista utväg på botten, aldrig i bufferten.
    const MAX_TRAP_DEPTH = 8;
    let backTrapNeedsArm = true;

    if (window.navigation) {
        navigation.addEventListener('navigate', (e) => {
            if (e.navigationType === 'traverse' && e.cancelable) {
                e.preventDefault();
            }
        });
    }

    history.pushState(null, '', location.href); // grundfälla (utan gest)

    window.addEventListener('popstate', (e) => {
        backTrapNeedsArm = true;
        if (e.state && typeof e.state.fargaDepth === 'number') {
            return; // landade i bufferten — tyst, barnet ritar vidare
        }
        history.pushState(null, '', location.href);
        showStartOverlay();
    });

    document.addEventListener('pointerdown', () => {
        if (!backTrapNeedsArm) return;
        backTrapNeedsArm = false;
        let depth = (history.state && typeof history.state.fargaDepth === 'number')
            ? history.state.fargaDepth + 1 : 0;
        while (depth < MAX_TRAP_DEPTH) {
            history.pushState({ fargaDepth: depth }, '', location.href);
            depth++;
        }
    }, { capture: true, passive: true });

    // Lås orientering till landskap. Låset biter bara i helskärm eller
    // installerad app — i vanligt webbläsarläge utan helskärm nekas det
    // tyst, därför görs ett nytt försök varje gång helskärm tas (se
    // fullscreenchange nedan).
    function lockOrientation() {
        if (screen.orientation && screen.orientation.lock) {
            screen.orientation.lock('landscape').catch(() => {});
        }
    }
    lockOrientation();

    document.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement) {
            startOverlay.style.display = 'none';
            lockOrientation();  // nu kan låset bita (kräver helskärm)
        } else if (!isInstalledApp()) {
            // Webbläsarläge: startskärmen är enda vägen tillbaka till
            // fullscreen. Installerad app visar INGEN startskärm här utan
            // återtar fullscreen tyst vid nästa touch — så bakåt-knappen
            // (som kastar ut ur helskärm) inte lämnar ritytan.
            showStartOverlay();
        }
        setTimeout(applyLayout, 100);
    });

    // Installerad app: återta immersive fullscreen (dolda systemfält) tyst
    // vid touch om det tappats — efter bakåt-tryck (som kastar ut ur helskärm
    // utan att kunna blockeras) eller skärmlåsningens väg via appväxlaren.
    // Barnet ritar bara vidare; fälten döljs igen vid nästa tryck. Kräver
    // användargest, därför på touchend. Nekar Android (t.ex. immersive
    // förbjudet i pinnat läge på vissa versioner) händer inget — layouten
    // klarar sig ändå.
    window.addEventListener('touchend', () => {
        if (isInstalledApp() && !document.fullscreenElement && document.fullscreenEnabled) {
            document.documentElement.requestFullscreen().catch(() => {});
        }
    }, { passive: true });

    // Mus (test på dator): dra med vänster knapp nedtryckt för att måla.
    // På touch-enheter ger preventDefault i touchstart inga mus-event.
    let mouseLast = null;
    viewCanvas.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        mouseLast = getPaperCoords(e.clientX, e.clientY);
        stamp(mouseLast.x, mouseLast.y);
        checkTouched();
    });
    window.addEventListener('mousemove', e => {
        if (!mouseLast) return;
        const p = getPaperCoords(e.clientX, e.clientY);
        stroke(mouseLast.x, mouseLast.y, p.x, p.y);
        mouseLast = p;
        checkTouched();
    });
    window.addEventListener('mouseup', () => { mouseLast = null; });

    viewCanvas.addEventListener('touchstart', onTouchStart, { passive: false });
    viewCanvas.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchEnd, { passive: true });

    // Blockera pinch-zoom på iOS — Safari har ignorerat user-scalable=no
    // ända sedan iOS 10. gesturestart är iOS-specifik och finns inte på
    // Android (där meta-taggen redan räcker), så detta är en no-op där.
    document.addEventListener('gesturestart', e => e.preventDefault());

    // Debounca layout-events så snabba resize/rotation-serier
    // bara triggar en enda omräkning per frame.
    let layoutPending = false;
    function debouncedLayout() {
        if (!layoutPending) {
            layoutPending = true;
            requestAnimationFrame(() => {
                applyLayout();
                layoutPending = false;
            });
        }
    }
    window.addEventListener('resize', debouncedLayout);
    window.addEventListener('orientationchange', debouncedLayout);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) resetClearButton();
    });
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', debouncedLayout);
        window.visualViewport.addEventListener('scroll', debouncedLayout);
    }

    loadPicture(0);
    applyLayout();
    setTimeout(applyLayout, 50);

    // Registrera service worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').then(reg => {
            reg.addEventListener('updatefound', () => {
                const nw = reg.installing;
                if (!nw) return;
                nw.addEventListener('statechange', () => {
                    if (nw.state === 'installed' && navigator.serviceWorker.controller) {
                        window.location.reload();
                    }
                });
            });
        }).catch(() => {});
    }
});
