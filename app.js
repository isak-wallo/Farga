document.addEventListener('DOMContentLoaded', () => {
    const viewCanvas = document.getElementById('viewCanvas');
    const vCtx = viewCanvas.getContext('2d');
    const canvasContainer = document.getElementById('canvas-container');

    // Element-referenser — deklarerade först så att funktionerna nedan
    // aldrig kan råka använda dem före deklarationen.
    const startOverlay = document.getElementById('start-overlay');
    const restartBtn = document.getElementById('restart-btn');
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
    // --- Håll-in-logik för BÖRJA OM ---
    // Man måste hålla fingret intryckt i HOLD_MS (ca 1 s). Första hållningen
    // visar SÄKER?, andra hållningen tömmer bilden. En kort tryckning gör
    // inget — så att ett barn inte råkar sudda allt av misstag.
    const HOLD_MS = 1000;
    // Synka håll-animationens längd i CSS med HOLD_MS (--hold-ms används
    // av .sys-btn.holding i style.css).
    document.documentElement.style.setProperty('--hold-ms', HOLD_MS + 'ms');
    let holdTimer = null;

    function startHold() {
        if (holdTimer) clearTimeout(holdTimer);
        holdTimer = setTimeout(() => {
            holdTimer = null;
            restartBtn.classList.remove('holding');
            handleClear();
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
        heli:   '#5fae7e',
        fjarrkulle: '#c6e2b3',
        akerkulle:  '#a9d494'
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

    // En liten sluten yta med tunn kant (fönster). Raderar inget bakom sig.
    function tunnForm(ctx, bygg, farg, bredd) {
        ctx.beginPath();
        bygg(ctx);
        if (fargLage) {
            ctx.fillStyle = farg;
            ctx.fill();
            return;
        }
        ctx.lineWidth = bredd || TUNN;
        ctx.stroke();
    }

    function ellips(ctx, x, y, rx, ry) {
        ctx.moveTo(x + rx, y);
        ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    }

    function stilSatt(ctx) {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = LINJEFARG;
        ctx.fillStyle = LINJEFARG;
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

    // Grästuss: tre korta tunna streck
    function grastuss(ctx, x, y, s) {
        linje(ctx, c => {
            c.moveTo(x, y); c.lineTo(x - 12 * s, y - 30 * s);
            c.moveTo(x, y); c.lineTo(x + 2 * s, y - 38 * s);
            c.moveTo(x, y); c.lineTo(x + 14 * s, y - 28 * s);
        }, 3);
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

    // Gårdsbakgrund för fordonen: bortre kullar med små träd, en åker
    // och marken som fordonet står på. Tunna linjer, lugna färger.
    // `o.sol` = [x, y], `o.moln` = [[x, y, skala]], `o.trad` = [[x, y, skala]].
    function faltBakgrund(ctx, o) {
        const bortre = c => {
            c.moveTo(-20, 470);
            c.bezierCurveTo(160, 420, 360, 420, 540, 462);
            c.bezierCurveTo(720, 500, 900, 430, 1060, 440);
            c.bezierCurveTo(1130, 444, 1180, 455, 1220, 452);
        };
        const faltkant = c => {
            c.moveTo(-20, 600);
            c.bezierCurveTo(300, 575, 800, 612, 1220, 585);
        };
        if (fargLage) {
            ctx.fillStyle = F.himmel;
            ctx.fillRect(0, 0, PAPER_W, PAPER_H);
            [[bortre, F.fjarrkulle], [faltkant, F.akerkulle]].forEach(([bana, farg]) => {
                ctx.beginPath();
                bana(ctx);
                ctx.lineTo(1220, 1000);
                ctx.lineTo(-20, 1000);
                ctx.closePath();
                ctx.fillStyle = farg;
                ctx.fill();
            });
        }
        linje(ctx, bortre, 4);
        linje(ctx, faltkant, 4);
        // Fåror på bortre åkern (fria ändar)
        [[40, 540, 190, 532], [60, 572, 230, 566], [960, 520, 1140, 512], [930, 556, 1150, 548]].forEach(f => {
            linje(ctx, c => {
                c.moveTo(f[0], f[1]);
                c.quadraticCurveTo((f[0] + f[2]) / 2, (f[1] + f[3]) / 2 - 6, f[2], f[3]);
            }, 3);
        });
        o.trad.forEach(t => trad(ctx, t[0], t[1], t[2]));
        sol(ctx, o.sol[0], o.sol[1]);
        o.moln.forEach(m => moln(ctx, m[0], m[1], m[2]));
        // Hjulspår och gräs i förgrunden
        [[30, 850, 260, 842], [700, 868, 980, 858], [330, 885, 600, 880]].forEach(f => {
            linje(ctx, c => {
                c.moveTo(f[0], f[1]);
                c.quadraticCurveTo((f[0] + f[2]) / 2, (f[1] + f[3]) / 2 - 6, f[2], f[3]);
            }, 3);
        });
        grastuss(ctx, 70, 815, 1);
        grastuss(ctx, 640, 845, 0.8);
        grastuss(ctx, 1150, 870, 1);
    }

    // Punkt på en kubisk bezierkurva (p = fyra [x, y]-punkter, t 0..1)
    function bez(p, t) {
        const u = 1 - t;
        return [
            u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0],
            u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1]
        ];
    }

    // Månghörning med rundade hörn (punkter medurs, r = hörnradie)
    function rmangel(ctx, pts, r) {
        const n = pts.length;
        const mitt = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const m0 = mitt(pts[n - 1], pts[0]);
        ctx.moveTo(m0[0], m0[1]);
        for (let i = 0; i < n; i++) {
            const p = pts[i], m = mitt(p, pts[(i + 1) % n]);
            ctx.arcTo(p[0], p[1], m[0], m[1], r);
        }
        ctx.closePath();
    }

    // Ett böjt band (bom, sticka) längs en bezierkurva p. Bredden går från
    // w0 till w1, med `buk` extra på mitten. Ändarna rundas med cirklar.
    // Punkterna vänds alltid medurs så att cirklarna inte gör hål.
    function band(ctx, p, w0, w1, buk) {
        const N = 24, L = [], R = [];
        for (let i = 0; i <= N; i++) {
            const t = i / N;
            const a = bez(p, Math.max(0, t - 0.01)), b = bez(p, Math.min(1, t + 0.01));
            const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
            const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
            const w = (w0 * (1 - t) + w1 * t + buk * Math.sin(Math.PI * t)) / 2;
            const q = bez(p, t);
            L.push([q[0] + nx * w, q[1] + ny * w]);
            R.push([q[0] - nx * w, q[1] - ny * w]);
        }
        const pts = L.concat(R.reverse());
        let area = 0;
        for (let i = 0; i < pts.length; i++) {
            const q = pts[i], r = pts[(i + 1) % pts.length];
            area += q[0] * r[1] - r[0] * q[1];
        }
        if (area < 0) pts.reverse();
        mangel(ctx, pts);
        cirkel(ctx, p[0][0], p[0][1], w0 / 2);
        cirkel(ctx, p[3][0], p[3][1], w1 / 2);
    }

    // Hjul från sidan: däck med klackar, fälg (andel f av radien), nav och bultar.
    function hjul(ctx, cx, cy, r, f) {
        form(ctx, c => cirkel(c, cx, cy, r), F.dack);
        const rf = r * f;
        const n = Math.round(r / 7);
        for (let k = 0; k < n; k++) {       // klackar: når bara däckets ytterkant
            const a = k * 2 * Math.PI / n;
            const ri = rf + (r - rf) * 0.4;
            linje(ctx, c => {
                c.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
                c.lineTo(cx + Math.cos(a + 0.09) * ri, cy + Math.sin(a + 0.09) * ri);
            }, 3);
        }
        form(ctx, c => cirkel(c, cx, cy, rf), F.falg);
        linje(ctx, c => c.arc(cx, cy, rf * 0.72, 0.2 * Math.PI, 1.8 * Math.PI), 3);
        form(ctx, c => cirkel(c, cx, cy, rf * 0.34), F.stal);
        for (let k = 0; k < 8; k++) {
            const a = k * Math.PI / 4;
            prick(ctx, cx + Math.cos(a) * rf * 0.22, cy + Math.sin(a) * rf * 0.22, 3);
        }
        prick(ctx, cx, cy, 6);
    }

    // Traktor från sidan, fronten åt höger. Verkliga proportioner
    // (ungefär 1 m = 190 px): bakhjul 1,7 m, framhjul 1,2 m, axelavstånd
    // 2,6 m, höjd 3 m. Marken ligger på y = 785.
    function ritaTraktor(ctx) {
        stilSatt(ctx);
        kant = 4;
        faltBakgrund(ctx, {
            sol: [1100, 95], moln: [[330, 110, 0.8], [800, 90, 0.65]],
            trad: [[95, 455, 0.45], [145, 458, 0.34], [1010, 442, 0.4]]
        });
        kant = 5;

        // Avgasrör med ljuddämpare framför hytten
        form(ctx, c => {
            stav(c, 612, 405, 612, 214, 18);
            rr(c, 598, 250, 28, 108, 8);
        }, F.stal);
        linje(ctx, c => { c.moveTo(606, 268); c.lineTo(606, 340); }, 3);

        // Varningsljus, hytt, tak och rutor
        tunnForm(ctx, c => rr(c, 424, 184, 30, 24, 8), F.sol, 4);
        form(ctx, c => rmangel(c, [[300, 232], [565, 232], [580, 525], [292, 525]], 14), F.rod);
        form(ctx, c => rmangel(c, [[282, 204], [590, 204], [596, 238], [276, 238]], 12), F.ljusstal);
        form(ctx, c => rmangel(c, [[318, 254], [548, 254], [560, 436], [314, 436]], 10), F.glas);
        linje(ctx, c => { c.moveTo(430, 254); c.lineTo(429, 436); }, 9);     // dörrstolpe
        // Säte och ratt syns genom rutan (fria ändar)
        linje(ctx, c => {
            c.moveTo(452, 424); c.lineTo(454, 362);
            c.quadraticCurveTo(456, 348, 470, 350); c.lineTo(474, 400); c.lineTo(506, 402);
        }, 3);
        linje(ctx, c => { c.moveTo(540, 424); c.lineTo(524, 382); }, 3);
        linje(ctx, c => c.ellipse(520, 374, 18, 7, -0.3, 0, 2 * Math.PI), 3);
        linje(ctx, c => { c.moveTo(500, 470); c.lineTo(530, 470); }, 4);    // dörrhandtag
        // Backspegel
        linje(ctx, c => { c.moveTo(566, 252); c.lineTo(604, 262); }, 4);
        tunnForm(ctx, c => rr(c, 600, 246, 14, 38, 5), F.morkstal, 4);

        // Ram under huven och huven
        form(ctx, c => rmangel(c, [[590, 548], [1010, 548], [1010, 612], [590, 612]], 6), F.morkstal);
        form(ctx, c => {
            c.moveTo(560, 398);
            c.lineTo(940, 410);
            c.bezierCurveTo(975, 412, 990, 426, 992, 450);
            c.lineTo(998, 560);
            c.lineTo(560, 560);
            c.closePath();
        }, F.rod);
        for (let x = 870; x <= 950; x += 16) {     // luftgaller
            linje(ctx, c => { c.moveTo(x, 440); c.lineTo(x, 522); }, 3);
        }
        linje(ctx, c => { c.moveTo(584, 470); c.lineTo(842, 478); }, 3);   // panelfog
        tunnForm(ctx, c => rr(c, 944, 424, 36, 18, 7), F.glas, 4);        // strålkastare

        // Frontvikter med spår
        form(ctx, c => rmangel(c, [[996, 540], [1076, 548], [1076, 642], [996, 642]], 8), F.morkstal);
        [1018, 1037, 1056].forEach(x => linje(ctx, c => { c.moveTo(x, 560); c.lineTo(x, 628); }, 3));

        // Bränsletank mellan hjulen
        form(ctx, c => rr(c, 552, 574, 112, 62, 14), F.ljusstal);
        linje(ctx, c => { c.moveTo(570, 590); c.lineTo(646, 590); }, 3);

        // Hjulen
        hjul(ctx, 380, 622, 163, 0.58);
        hjul(ctx, 874, 670, 115, 0.58);

        // Stänkskärmar
        form(ctx, c => {
            c.arc(380, 622, 190, Math.PI * 1.06, Math.PI * 1.97);
            c.arc(380, 622, 172, Math.PI * 1.97, Math.PI * 1.06, true);
            c.closePath();
        }, F.rod);
        form(ctx, c => {
            c.arc(874, 670, 134, Math.PI * 1.12, Math.PI * 1.86);
            c.arc(874, 670, 122, Math.PI * 1.86, Math.PI * 1.12, true);
            c.closePath();
        }, F.rod);
    }

    // Grävmaskin (ungefär 20 ton) från sidan, riktad åt höger. Verkliga
    // proportioner (ungefär 1 m = 125 px). Marken ligger på y = 785.
    function ritaGravmaskin(ctx) {
        stilSatt(ctx);
        kant = 4;
        faltBakgrund(ctx, {
            sol: [110, 95], moln: [[480, 105, 0.8], [880, 80, 0.6]],
            trad: [[1060, 440, 0.4], [1110, 446, 0.32], [300, 432, 0.38]]
        });
        kant = 5;

        // Jordhög under skopan
        form(ctx, c => {
            c.moveTo(860, 800);
            c.bezierCurveTo(930, 720, 1050, 690, 1230, 700);
            c.lineTo(1230, 840);
            c.bezierCurveTo(1100, 845, 980, 835, 860, 800);
            c.closePath();
        }, F.jord);
        [[930, 770, 950, 762], [1000, 740, 1030, 734], [1120, 760, 1150, 756], [1060, 800, 1090, 796]].forEach(s => {
            linje(ctx, c => { c.moveTo(s[0], s[1]); c.lineTo(s[2], s[3]); }, 3);
        });

        // Svängkrans och larvband med ram, drivhjul, spännhjul och rullar
        form(ctx, c => rr(c, 330, 640, 320, 34, 6), F.morkstal);
        form(ctx, c => rr(c, 170, 668, 570, 117, 58), F.dack);
        for (let x = 236; x <= 676; x += 28) {     // bandplattor
            linje(ctx, c => { c.moveTo(x, 668); c.lineTo(x, 679); }, 3);
            linje(ctx, c => { c.moveTo(x, 785); c.lineTo(x, 774); }, 3);
        }
        form(ctx, c => rr(c, 240, 692, 430, 70, 30), F.morkstal);
        [[227, 'driv'], [683, 'spann']].forEach(([x]) => {
            form(ctx, c => cirkel(c, x, 727, 44), F.stal);
            linje(ctx, c => c.arc(x, 727, 30, 0.2 * Math.PI, 1.8 * Math.PI), 3);
            prick(ctx, x, 727, 8);
        });
        [320, 395, 470, 545, 610].forEach(x => prick(ctx, x, 750, 11));
        prick(ctx, 455, 702, 8);

        // Motvikt och motorhuv med avgasrör, galler och ledstång
        form(ctx, c => stav(c, 472, 510, 472, 462, 16), F.stal);
        form(ctx, c => {
            c.moveTo(345, 500);
            c.lineTo(215, 500);
            c.bezierCurveTo(182, 500, 165, 522, 165, 552);
            c.lineTo(165, 640);
            c.bezierCurveTo(165, 652, 172, 657, 186, 657);
            c.lineTo(345, 657);
            c.closePath();
        }, F.gul);
        form(ctx, c => rmangel(c, [[332, 506], [588, 506], [590, 657], [332, 657]], 8), F.gul);
        [540, 562, 584].forEach(y => linje(ctx, c => { c.moveTo(390, y); c.lineTo(520, y); }, 3));
        linje(ctx, c => { c.moveTo(362, 506); c.lineTo(362, 484); c.lineTo(530, 484); }, 4);
        linje(ctx, c => { c.moveTo(200, 530); c.quadraticCurveTo(186, 560, 190, 610); }, 3);

        // Sticka (bakom bommen vid armbågen)
        const sticka = [[1032, 205], [1060, 320], [1090, 445], [1115, 560]];
        form(ctx, c => band(c, sticka, 60, 44, 8), F.gul);
        linje(ctx, c => { c.moveTo(1050, 268); c.lineTo(1095, 470); }, 3);

        // Bom
        const bom = [[745, 612], [790, 420], [880, 290], [1036, 236]];
        form(ctx, c => band(c, bom, 78, 62, 26), F.gul);
        const s0 = bez(bom, 0.25), s1 = bez(bom, 0.85);
        linje(ctx, c => {               // svetsfog längs bommen (fria ändar)
            c.moveTo(s0[0] + 14, s0[1] + 2);
            c.quadraticCurveTo(870, 330, s1[0], s1[1] + 8);
        }, 3);
        prick(ctx, 1036, 236, 10);

        // Stickcylinder ovanpå bommen
        form(ctx, c => stav(c, 960, 230, 1030, 196, 13), F.ljusstal);
        form(ctx, c => stav(c, 892, 272, 966, 228, 26), F.morkstal);

        // Skopa från sidan: rak överplatta mellan lederna, rundad rygg,
        // bottenplatta fram till skäret och tänder som pekar framåt-nedåt.
        // Ungefär lika djup som hög, som en riktig skopa.
        const skar = [1056, 730], hal = [1156, 714];
        form(ctx, c => {
            c.moveTo(1088, 550);
            c.lineTo(1164, 556);
            c.bezierCurveTo(1198, 590, 1198, 676, hal[0], hal[1]);
            c.lineTo(skar[0], skar[1]);
            c.bezierCurveTo(1064, 680, 1076, 610, 1088, 550);
            c.closePath();
            // Tänder längs skäret (medurs, som resten av formen)
            [[1056, 730], [1082, 726], [1108, 722]].forEach(([x, y]) => {
                mangel(c, [[x, y - 4], [x + 18, y - 7], [x + 6, y + 20]]);
            });
        }, F.gul);
        // Sidoplåtens förstärkning, slitskena och kant vid öppningen (fria ändar)
        linje(ctx, c => { c.moveTo(1160, 580); c.bezierCurveTo(1182, 615, 1180, 670, 1150, 698); }, 3);
        linje(ctx, c => { c.moveTo(1140, 704); c.lineTo(1078, 713); }, 3);
        linje(ctx, c => { c.moveTo(1094, 568); c.bezierCurveTo(1086, 610, 1078, 660, 1074, 700); }, 3);
        prick(ctx, 1115, 560, 9);

        // Skopcylinder och länk längs stickan
        form(ctx, c => stav(c, 1094, 400, 1122, 512, 12), F.ljusstal);
        form(ctx, c => stav(c, 1064, 262, 1096, 404, 24), F.morkstal);
        form(ctx, c => stav(c, 1122, 512, 1146, 566, 14), F.morkstal);
        prick(ctx, 1122, 512, 6);

        // Bomcylinder (framför bommen, nedre änden bakom hytten)
        form(ctx, c => stav(c, 792, 516, 842, 414, 16), F.ljusstal);
        form(ctx, c => stav(c, 730, 640, 796, 510, 30), F.morkstal);
        prick(ctx, 842, 414, 6);

        // Varningsljus, hytt, rutor och förarstol
        tunnForm(ctx, c => rr(c, 626, 400, 26, 20, 7), F.sol, 4);
        form(ctx, c => rmangel(c, [[585, 415], [735, 415], [765, 500], [768, 657], [585, 657]], 14), F.gul);
        form(ctx, c => rmangel(c, [[600, 432], [720, 432], [746, 500], [748, 598], [600, 598]], 8), F.glas);
        linje(ctx, c => { c.moveTo(662, 432); c.lineTo(664, 598); }, 8);   // dörrstolpe
        linje(ctx, c => {
            c.moveTo(614, 588); c.lineTo(616, 520);
            c.quadraticCurveTo(618, 506, 632, 508); c.lineTo(636, 560); c.lineTo(652, 562);
        }, 3);
        linje(ctx, c => { c.moveTo(704, 622); c.lineTo(730, 622); }, 4);   // handtag
    }

    // Lugn bakgrund för flygplanet, i finare målarboksstil: tunna linjer,
    // två kullar långt ner, några små träd, moln och en sol utan ansikte.
    function luftBakgrund(ctx, molnLista) {
        const bortre = c => {
            c.moveTo(-20, 735);
            c.bezierCurveTo(150, 690, 330, 690, 480, 730);
            c.bezierCurveTo(640, 770, 820, 700, 1000, 712);
            c.bezierCurveTo(1100, 718, 1160, 730, 1220, 724);
        };
        const narmre = c => {
            c.moveTo(-20, 818);
            c.bezierCurveTo(300, 780, 700, 850, 1220, 792);
        };
        if (fargLage) {
            ctx.fillStyle = F.himmel;
            ctx.fillRect(0, 0, PAPER_W, PAPER_H);
            [[bortre, F.fjarrkulle], [narmre, F.akerkulle]].forEach(([bana, farg]) => {
                ctx.beginPath();
                bana(ctx);
                ctx.lineTo(1220, 1000);
                ctx.lineTo(-20, 1000);
                ctx.closePath();
                ctx.fillStyle = farg;
                ctx.fill();
            });
        }
        linje(ctx, bortre, 5);
        linje(ctx, narmre, 5);

        // Små träd på bortre kullen
        trad(ctx, 170, 712, 0.42);
        trad(ctx, 215, 716, 0.32);
        trad(ctx, 930, 722, 0.38);
        // Fåror på åkern (fria ändar)
        [[60, 860, 260, 845], [420, 870, 640, 868], [820, 850, 1080, 832],
         [180, 892, 420, 884], [700, 890, 960, 878]].forEach(f => {
            linje(ctx, c => {
                c.moveTo(f[0], f[1]);
                c.quadraticCurveTo((f[0] + f[2]) / 2, (f[1] + f[3]) / 2 - 8, f[2], f[3]);
            }, 3);
        });

        sol(ctx, 1095, 100);
        molnLista.forEach(m => moln(ctx, m[0], m[1], m[2]));
    }

    // Flygplan (ungefär en Airbus A330) från sidan, på väg uppåt åt höger.
    // Lite verkligare stil: tunnare kant och fler, mindre ytor (fönster,
    // dörrar, motorns delar). Ritat i ett eget koordinatsystem där kroppen
    // går från x = 0 (stjärten) till x = 1000 (nosen), mittlinjen y = 0.
    function ritaFlygplan(ctx) {
        stilSatt(ctx);
        kant = 4;
        luftBakgrund(ctx, [[650, 140, 0.9], [1040, 600, 0.75], [150, 600, 0.65]]);
        kant = 5;

        ctx.save();
        ctx.translate(95, 360);
        ctx.rotate(-0.06);

        // Bortre vingen (bakom kroppen) med winglet
        form(ctx, c => {
            mangel(c, [[410, -40], [300, -165], [345, -172], [580, -40]]);
            mangel(c, [[300, -166], [310, -208], [328, -210], [345, -172]]);
        }, F.vinge);

        // Kroppen
        const nosUnder = [[1000, 0], [1008, 20], [975, 46], [920, 48]];
        const stjartUnder = [[330, 48], [200, 48], [70, 20], [6, -2]];
        const kropp = c => {
            c.moveTo(0, -14);
            c.bezierCurveTo(60, -30, 140, -46, 220, -48);
            c.lineTo(860, -48);
            c.bezierCurveTo(930, -48, 985, -30, 1000, 0);
            c.bezierCurveTo(1008, 20, 975, 46, 920, 48);
            c.lineTo(330, 48);
            c.bezierCurveTo(200, 48, 70, 20, 6, -2);
            c.closePath();
        };
        form(ctx, kropp, F.flygkropp);
        // Gräns mot den blå buken (når kroppens kant i båda ändar)
        const b0 = bez(nosUnder, 0.35), b1 = bez(stjartUnder, 0.55);
        const bukLinje = c => {
            c.moveTo(b0[0], b0[1]);
            c.bezierCurveTo(960, 26, 920, 26, 880, 26);
            c.lineTo(300, 26);
            c.bezierCurveTo(220, 26, 170, 27, b1[0], b1[1]);
        };
        if (fargLage) {     // buken: allt under linjen, innanför kroppen
            ctx.save();
            ctx.beginPath();
            kropp(ctx);
            ctx.clip();
            ctx.beginPath();
            bukLinje(ctx);
            ctx.lineTo(-100, 200);
            ctx.lineTo(1100, 200);
            ctx.closePath();
            ctx.fillStyle = F.buk;
            ctx.fill();
            ctx.restore();
        }
        linje(ctx, bukLinje, 4);
        // Nosens kon (öppen båge) och stjärtkonen
        linje(ctx, c => { c.moveTo(986, -16); c.quadraticCurveTo(978, 2, 988, 18); }, 3);

        // Fönsterrad och dörrar
        const dorrar = [268, 470, 700, 868];
        dorrar.forEach(x => linje(ctx, c => rr(c, x - 13, -38, 26, 50, 7), 3));
        for (let x = 296; x <= 846; x += 23) {
            if (dorrar.some(d => Math.abs(d - x) < 26)) continue;
            tunnForm(ctx, c => rr(c, x - 5, -24, 11, 16, 5), F.ruta, 3);
        }
        // Cockpitfönster
        tunnForm(ctx, c => mangel(c, [[900, -30], [928, -30], [934, -16], [900, -16]]), F.ruta, 3);
        tunnForm(ctx, c => mangel(c, [[938, -28], [950, -24], [958, -14], [938, -14]]), F.ruta, 3);

        // Fena med en tunn linje för rodret
        form(ctx, c => rmangel(c, [[20, -22], [30, -250], [95, -252], [240, -46]], 8), F.fena);
        linje(ctx, c => { c.moveTo(48, -230); c.lineTo(42, -60); }, 3);
        // Höjdroder (närmre)
        form(ctx, c => rmangel(c, [[70, -8], [190, -2], [50, 74], [0, 72]], 6), F.vinge);
        linje(ctx, c => { c.moveTo(62, 12); c.lineTo(22, 60); }, 3);

        // Motorn hänger under närmre vingen. Vi ser planet lite ovanifrån,
        // så vingen skymmer motorns bakre del; bara främre delen med
        // luftintaget sticker fram framför vingens framkant.
        form(ctx, c => rmangel(c, [[400, 92], [588, 84], [588, 158], [400, 150]], 26), F.buk);
        linje(ctx, c => { c.moveTo(540, 96); c.lineTo(540, 146); }, 3);
        form(ctx, c => ellips(c, 592, 121, 18, 38), F.ljusstal);
        form(ctx, c => ellips(c, 596, 121, 9, 26), F.morkstal);

        // Närmre vingen med klaffar och winglet
        form(ctx, c => rmangel(c, [[380, 28], [610, 22], [275, 300], [222, 304], [318, 112]], 6), F.vinge);
        linje(ctx, c => { c.moveTo(392, 50); c.lineTo(340, 118); c.lineTo(262, 268); }, 3);
        [[366, 84], [318, 160], [290, 214]].forEach(([x, y]) => {
            linje(ctx, c => { c.moveTo(x, y); c.lineTo(x - 22, y - 8); }, 3);
        });
        form(ctx, c => mangel(c, [[226, 300], [236, 252], [254, 250], [270, 299]]), F.fena);

        ctx.restore();
    }

    // Däck och fälg i perspektiv (ellipser): klackar runt däcket, fälg,
    // nav och bultar. (cx, cy, rx, ry) = däcket, (fx, fy, frx, fry) = fälgen.
    function hjulSnett(ctx, cx, cy, rx, ry, fx, fy, frx, fry) {
        form(ctx, c => ellips(c, cx, cy, rx, ry), F.dack);
        // Klackar: grova på vänstra sidan där slitbanan syns, korta runt om
        for (let g = 0; g < 360; g += 12) {
            const a = g * Math.PI / 180;
            const grov = g > 100 && g < 260;
            const f = grov ? 0.62 : 0.84;
            linje(ctx, c => {
                c.moveTo(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
                c.lineTo(cx + Math.cos(a + 0.1) * rx * f, cy + Math.sin(a + 0.1) * ry * f);
            }, grov ? 5 : 3);
        }
        form(ctx, c => ellips(c, fx, fy, frx, fry), F.falg);
        linje(ctx, c => c.ellipse(fx + frx * 0.08, fy, frx * 0.7, fry * 0.7, 0, 0.2 * Math.PI, 1.8 * Math.PI), 3);
        form(ctx, c => ellips(c, fx + frx * 0.12, fy + fry * 0.04, frx * 0.34, fry * 0.34), F.stal);
        for (let k = 0; k < 6; k++) {
            const a = k * Math.PI / 3;
            prick(ctx, fx + frx * 0.12 + Math.cos(a) * frx * 0.22, fy + fry * 0.04 + Math.sin(a) * fry * 0.22, 3);
        }
        prick(ctx, fx + frx * 0.12, fy + fry * 0.04, 5);
    }

    // Traktor snett framifrån, nära förlagan ägaren skickade (klassisk
    // målarbok). Ritad i förlagans koordinater (1024-bilden) och skalad in.
    function ritaTraktorSnett(ctx) {
        stilSatt(ctx);
        kant = 4;
        faltBakgrund(ctx, {
            sol: [110, 95], moln: [[330, 120, 0.7], [1020, 190, 0.55]],
            trad: [[1100, 450, 0.8], [70, 456, 0.38], [120, 460, 0.3]]
        });
        kant = 5;

        ctx.save();
        ctx.translate(60, -120);
        ctx.scale(1.05, 1.05);

        // Avgasrör med ljuddämpare och nät
        form(ctx, c => {
            stav(c, 352, 445, 352, 268, 18);
            stav(c, 352, 268, 344, 254, 18);
            rr(c, 333, 328, 38, 104, 6);
        }, F.stal);
        for (let k = 0; k < 4; k++) {
            linje(ctx, c => { c.moveTo(341, 344 + k * 20); c.lineTo(363, 360 + k * 20); }, 3);
            linje(ctx, c => { c.moveTo(363, 344 + k * 20); c.lineTo(341, 360 + k * 20); }, 3);
        }

        // Bortre framhjulet (bakom stötfångaren)
        hjulSnett(ctx, 238, 700, 70, 94, 250, 706, 30, 50);

        // Ram under huven
        form(ctx, c => mangel(c, [[372, 600], [600, 585], [650, 600], [650, 650], [390, 672]]), F.morkstal);

        // Hytt: sida, front, varningsljus och tak
        form(ctx, c => rmangel(c, [[582, 240], [750, 250], [754, 545], [590, 560]], 8), F.rod);
        form(ctx, c => rmangel(c, [[424, 254], [582, 240], [590, 452], [408, 442]], 8), F.rod);
        tunnForm(ctx, c => rr(c, 436, 214, 24, 16, 5), F.sol, 4);
        tunnForm(ctx, c => rr(c, 562, 196, 24, 16, 5), F.sol, 4);
        form(ctx, c => rmangel(c, [[414, 230], [575, 208], [750, 226], [756, 250], [578, 240], [410, 256]], 10), F.ljusstal);

        // Rutor: vindruta, dörr och bakre sidoruta
        form(ctx, c => rmangel(c, [[438, 268], [568, 258], [574, 432], [424, 426]], 10), F.glas);
        form(ctx, c => rmangel(c, [[600, 262], [690, 266], [690, 420], [602, 424]], 8), F.glas);
        form(ctx, c => rmangel(c, [[702, 268], [738, 271], [738, 410], [702, 416]], 8), F.glas);
        // Ratt och torkare genom vindrutan, stol genom dörrens ruta
        linje(ctx, c => c.ellipse(520, 390, 30, 10, -0.1, 0, 2 * Math.PI), 3);
        linje(ctx, c => { c.moveTo(526, 400); c.lineTo(536, 420); }, 3);
        linje(ctx, c => { c.moveTo(456, 412); c.lineTo(504, 284); }, 3);
        linje(ctx, c => {
            c.moveTo(614, 410); c.lineTo(618, 352);
            c.quadraticCurveTo(622, 338, 640, 340); c.lineTo(648, 384); c.lineTo(676, 388);
        }, 3);
        // Dörrfogar och handtag
        linje(ctx, c => { c.moveTo(597, 440); c.lineTo(599, 548); }, 3);
        linje(ctx, c => { c.moveTo(694, 436); c.lineTo(696, 540); }, 3);
        linje(ctx, c => { c.moveTo(612, 456); c.lineTo(634, 456); }, 4);

        // Huv med front och sida
        form(ctx, c => {
            c.moveTo(248, 500);
            c.bezierCurveTo(250, 470, 272, 455, 305, 450);
            c.lineTo(520, 424);
            c.bezierCurveTo(548, 420, 575, 428, 590, 445);
            c.lineTo(590, 598);
            c.lineTo(372, 630);
            c.lineTo(262, 634);
            c.bezierCurveTo(254, 600, 248, 550, 248, 500);
            c.closePath();
        }, F.rod);
        linje(ctx, c => { c.moveTo(350, 445); c.quadraticCurveTo(372, 470, 372, 630); }, 4);   // kant front/sida
        linje(ctx, c => { c.moveTo(392, 470); c.quadraticCurveTo(470, 450, 566, 448); }, 3);   // huvens rundning
        for (let k = 0; k < 4; k++) {                                                          // luftspringor
            linje(ctx, c => { c.moveTo(478 + k * 14, 474); c.lineTo(478 + k * 14, 516); }, 3);
        }
        linje(ctx, c => { c.moveTo(404, 548); c.lineTo(570, 532); }, 3);                       // panelfog

        // Grill i två halvor, strålkastare
        form(ctx, c => rmangel(c, [[262, 490], [338, 484], [340, 612], [266, 618]], 14), F.stal);
        linje(ctx, c => { c.moveTo(300, 487); c.lineTo(302, 615); }, 5);
        [276, 288, 314, 326].forEach(x => linje(ctx, c => { c.moveTo(x, 502); c.lineTo(x + 1, 600); }, 3));
        form(ctx, c => cirkel(c, 234, 552, 14), F.glas);
        form(ctx, c => cirkel(c, 390, 566, 22), F.glas);
        linje(ctx, c => c.arc(390, 566, 12, 0.3 * Math.PI, 1.7 * Math.PI), 3);

        // Stötfångare / frontvikt
        form(ctx, c => rmangel(c, [[232, 640], [372, 632], [412, 645], [410, 688], [372, 698], [236, 686]], 6), F.morkstal);
        linje(ctx, c => { c.moveTo(372, 632); c.lineTo(372, 698); }, 4);

        // Närmre framhjulet
        hjulSnett(ctx, 486, 718, 76, 84, 494, 722, 40, 52);

        // Fotsteg upp till hytten
        linje(ctx, c => { c.moveTo(592, 572); c.lineTo(602, 690); }, 4);
        linje(ctx, c => { c.moveTo(628, 568); c.lineTo(640, 686); }, 4);
        [604, 636, 668].forEach(y => linje(ctx, c => { c.moveTo(595, y); c.lineTo(634, y - 2); }, 4));

        // Bakhjulet och stänkskärmen
        hjulSnett(ctx, 762, 625, 120, 155, 795, 622, 50, 82);
        form(ctx, c => {
            c.moveTo(640, 585);
            c.bezierCurveTo(642, 505, 700, 440, 788, 436);
            c.bezierCurveTo(830, 435, 856, 452, 860, 478);
            c.lineTo(846, 490);
            c.bezierCurveTo(800, 466, 722, 470, 688, 520);
            c.bezierCurveTo(672, 545, 664, 568, 662, 588);
            c.closePath();
        }, F.rod);

        ctx.restore();
    }

    // Helikopter (en lätt ambulans-/polishelikopter i storlek som en
    // H135) i luften, snett framifrån: vi ser vänster sida och lite av
    // fronten, rotorn som en platt ellips ovanför.
    function ritaHelikopter(ctx) {
        stilSatt(ctx);
        kant = 4;
        luftBakgrund(ctx, [[180, 130, 0.8], [700, 90, 0.6], [1050, 560, 0.7]]);
        kant = 5;

        // Bortre meden (bakom kroppen)
        form(ctx, c => {
            stav(c, 420, 598, 760, 584, 11);
            stav(c, 420, 598, 396, 580, 11);
        }, F.morkstal);

        // Stjärtbom, fena, stabilisator och stjärtrotor
        form(ctx, c => mangel(c, [[690, 382], [1040, 318], [1048, 342], [700, 452]]), F.heli);
        form(ctx, c => rmangel(c, [[1006, 330], [1060, 236], [1092, 240], [1064, 340], [1076, 392], [1056, 394]], 8), F.heli);
        form(ctx, c => mangel(c, [[930, 340], [978, 330], [958, 378], [932, 380]]), F.heli);
        tunnForm(ctx, c => ellips(c, 1048, 288, 14, 44), F.ljusstal, 3);
        linje(ctx, c => { c.moveTo(1040, 254); c.lineTo(1056, 322); c.moveTo(1036, 296); c.lineTo(1060, 280); }, 4);
        prick(ctx, 1048, 288, 6);

        // Kroppen
        const kropp = c => {
            c.moveTo(232, 470);
            c.bezierCurveTo(240, 390, 300, 330, 400, 318);
            c.lineTo(640, 318);
            c.bezierCurveTo(700, 330, 722, 380, 722, 420);
            c.bezierCurveTo(716, 480, 690, 540, 620, 556);
            c.lineTo(330, 560);
            c.bezierCurveTo(270, 556, 234, 522, 232, 470);
            c.closePath();
        };
        form(ctx, kropp, F.heli);
        // Vit nederdel (gräns som når kroppens kant i båda ändar)
        const vitLinje = c => {
            c.moveTo(238, 505);
            c.bezierCurveTo(400, 500, 600, 496, 712, 470);
        };
        if (fargLage) {
            ctx.save();
            ctx.beginPath();
            kropp(ctx);
            ctx.clip();
            ctx.beginPath();
            vitLinje(ctx);
            ctx.lineTo(800, 700);
            ctx.lineTo(200, 700);
            ctx.closePath();
            ctx.fillStyle = F.flygkropp;
            ctx.fill();
            ctx.restore();
        }
        linje(ctx, vitLinje, 4);

        // Motorkåpa på taket med luftintag
        form(ctx, c => {
            c.moveTo(440, 324);
            c.bezierCurveTo(460, 292, 600, 286, 642, 306);
            c.bezierCurveTo(660, 316, 656, 326, 640, 328);
            c.lineTo(440, 330);
            c.closePath();
        }, F.heli);
        [470, 488, 506].forEach(x => linje(ctx, c => { c.moveTo(x, 306); c.lineTo(x + 4, 320); }, 3));

        // Glaskupol fram (delad av en mittbåge) och rutor på sidan
        form(ctx, c => {
            c.moveTo(252, 462);
            c.bezierCurveTo(258, 400, 300, 350, 385, 335);
            c.lineTo(398, 335);
            c.bezierCurveTo(385, 400, 372, 450, 366, 492);
            c.bezierCurveTo(320, 497, 280, 494, 252, 476);
            c.closePath();
        }, F.glas);
        linje(ctx, c => { c.moveTo(318, 342); c.quadraticCurveTo(284, 400, 280, 488); }, 5);
        form(ctx, c => rmangel(c, [[415, 340], [520, 338], [522, 452], [410, 456]], 14), F.glas);
        form(ctx, c => rmangel(c, [[542, 340], [632, 346], [646, 420], [542, 440]], 14), F.glas);
        // Dörrfogar (från taket ner till kroppens underkant) och handtag
        linje(ctx, c => { c.moveTo(404, 318); c.lineTo(398, 560); }, 3);
        linje(ctx, c => { c.moveTo(532, 318); c.lineTo(530, 558); }, 3);
        linje(ctx, c => { c.moveTo(500, 474); c.lineTo(520, 474); }, 4);
        tunnForm(ctx, c => rr(c, 300, 536, 26, 12, 5), F.sol, 3);    // landningsljus

        // Närmre meden med stag
        form(ctx, c => {
            stav(c, 380, 556, 370, 632, 10);
            stav(c, 610, 552, 620, 622, 10);
        }, F.morkstal);
        form(ctx, c => {
            stav(c, 300, 638, 720, 622, 12);
            stav(c, 300, 638, 268, 612, 12);
        }, F.morkstal);

        // Rotormast, nav och fyra blad (rotorskivan ses som en platt ellips)
        form(ctx, c => stav(c, 540, 300, 540, 250, 14), F.morkstal);
        form(ctx, c => {
            [0.35, 1.92, 3.49, 5.06].forEach(v => {
                stav(c, 540, 244, 540 + Math.cos(v) * 500, 244 + Math.sin(v) * 72, 14);
            });
            ellips(c, 540, 244, 30, 11);
        }, F.morkstal);

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

    function ritaTraktorVerklig(ctx, pic) {
        if (!fargLage) { ctx.drawImage(pic.img, 0, 0); return; }
        // Mark, himmel och bortre kulle
        ctx.fillStyle = F.akerkulle;
        ctx.fillRect(0, 0, PAPER_W, PAPER_H);
        fyllPoly(ctx, F.himmel, [[0, 0], [1200, 0], [1200, 268], [1170, 272], [950, 278], [940, 290],
            [440, 262], [300, 236], [200, 204], [100, 186], [0, 182]]);
        fyllPoly(ctx, F.fjarrkulle, [[0, 182], [100, 186], [200, 204], [300, 236], [440, 262], [440, 332],
            [330, 332], [150, 286], [0, 272]]);
        // Träd, buskar och ladan
        fyllEllips(ctx, F.trad, 110, 192, 58, 48);
        fyllEllips(ctx, F.trad, 188, 238, 30, 40);
        fyllEllips(ctx, F.trad, 90, 405, 62, 26);
        fyllEllips(ctx, F.trad, 1000, 200, 28, 70);
        fyllEllips(ctx, F.trad, 1150, 140, 30, 22);
        fyllEllips(ctx, F.trad, 965, 245, 30, 22);
        fyllEllips(ctx, F.trad, 1150, 262, 30, 14);
        fyllPoly(ctx, F.morkrod, [[1020, 195], [1068, 152], [1110, 190], [1172, 168], [1172, 275], [1020, 278]]);
        fyllPoly(ctx, F.ljusstal, [[1040, 150], [1075, 148], [1172, 158], [1172, 170], [1110, 185], [1068, 152]]);
        fyllPoly(ctx, F.flygkropp, [[1045, 235], [1095, 235], [1095, 278], [1045, 278]]);
        fyllEllips(ctx, F.glas, 1072, 198, 12, 14);

        // Hjulen
        fyllEllips(ctx, F.dack, 205, 705, 105, 135);
        fyllEllips(ctx, F.falg, 238, 712, 48, 68);
        fyllEllips(ctx, F.dack, 565, 762, 120, 142);
        fyllEllips(ctx, F.falg, 582, 765, 62, 88);
        fyllEllips(ctx, F.stal, 582, 762, 22, 34);
        fyllEllips(ctx, F.dack, 940, 605, 180, 225);
        fyllEllips(ctx, F.falg, 992, 612, 80, 120);
        fyllEllips(ctx, F.stal, 965, 612, 28, 42);

        // Ram, steg, axel, stötfångare
        fyllPoly(ctx, F.morkstal, [[600, 540], [700, 540], [712, 720], [650, 722], [600, 640]]);
        fyllPoly(ctx, F.stal, [[690, 548], [762, 545], [778, 702], [720, 706]]);
        fyllPoly(ctx, F.morkstal, [[250, 688], [470, 660], [482, 722], [262, 722]]);
        fyllPoly(ctx, F.morkstal, [[205, 612], [402, 624], [407, 702], [214, 692]]);

        // Huv, motorrum, grill och strålkastare
        fyllPoly(ctx, F.rod, [[226, 400], [300, 345], [600, 318], [624, 345], [626, 545], [470, 602],
            [240, 618], [228, 520]]);
        fyllPoly(ctx, F.morkstal, [[482, 470], [520, 450], [612, 468], [615, 600], [480, 606]]);
        fyllPoly(ctx, F.stal, [[238, 415], [290, 410], [292, 592], [245, 590]]);
        fyllPoly(ctx, F.stal, [[300, 412], [356, 418], [358, 600], [305, 600]]);
        fyllEllips(ctx, F.ljusstal, 205, 503, 25, 26);
        fyllEllips(ctx, F.glas, 205, 503, 14, 15);
        fyllEllips(ctx, F.ljusstal, 420, 520, 42, 44);
        fyllEllips(ctx, F.glas, 422, 522, 25, 29);

        // Avgasrör
        fyllPoly(ctx, F.stal, [[343, 92], [372, 86], [392, 112], [392, 190], [412, 195], [412, 332],
            [354, 332], [354, 190], [343, 122]]);

        // Stänkskärm
        fyllPoly(ctx, F.rod, [[758, 525], [790, 420], [860, 358], [960, 343], [1042, 368], [1072, 410],
            [1060, 428], [1000, 396], [920, 386], [862, 420], [812, 482], [792, 548]]);

        // Hytt: ram, tak, rutor
        fyllPoly(ctx, F.rod, [[458, 92], [942, 98], [946, 332], [862, 348], [628, 545], [468, 322]]);
        fyllPoly(ctx, F.ljusstal, [[458, 58], [520, 36], [700, 20], [930, 66], [942, 106], [466, 98]]);
        fyllEllips(ctx, F.sol, 680, 46, 20, 10);
        fyllEllips(ctx, F.sol, 492, 70, 18, 10);
        fyllPoly(ctx, F.glas, [[478, 104], [692, 98], [692, 304], [472, 304]]);
        fyllPoly(ctx, F.glas, [[708, 100], [844, 100], [848, 304], [704, 304]]);
        fyllPoly(ctx, F.glas, [[852, 108], [922, 110], [926, 302], [856, 302]]);
        fyllPoly(ctx, F.glas, [[700, 360], [796, 360], [796, 506], [702, 506]]);
        fyllPoly(ctx, F.glas, [[630, 344], [666, 344], [666, 512], [632, 512]]);
    }

    function ritaGravmaskinVerklig(ctx, pic) {
        if (!fargLage) { ctx.drawImage(pic.img, 0, 0); return; }
        // Mark, himmel, kullar, jordhög och grusväg
        ctx.fillStyle = F.akerkulle;
        ctx.fillRect(0, 0, PAPER_W, PAPER_H);
        fyllPoly(ctx, F.himmel, [[0, 0], [1200, 0], [1200, 250], [1143, 250], [950, 280], [900, 290],
            [660, 330], [500, 323], [387, 300], [253, 273], [53, 240], [0, 240]]);
        fyllPoly(ctx, F.fjarrkulle, [[0, 240], [53, 240], [253, 273], [387, 300], [500, 323], [660, 330],
            [950, 280], [1143, 250], [1200, 250], [1200, 332], [1143, 330], [950, 340], [660, 380],
            [500, 372], [387, 398], [243, 360], [50, 323], [0, 323]]);
        fyllPoly(ctx, F.grus, [[380, 760], [560, 820], [700, 900], [1200, 900], [1200, 780], [1080, 768]]);
        fyllPoly(ctx, F.jord, [[96, 900], [136, 822], [220, 790], [330, 800], [380, 778], [432, 800],
            [462, 860], [482, 900]]);
        // Träd och buskar
        fyllEllips(ctx, F.trad, 140, 250, 50, 45);
        fyllEllips(ctx, F.trad, 197, 292, 32, 36);
        fyllEllips(ctx, F.trad, 95, 466, 52, 24);
        fyllEllips(ctx, F.trad, 1012, 318, 48, 22);
        fyllEllips(ctx, F.trad, 1040, 430, 48, 30);
        [[830, 60, 60, 38], [930, 40, 80, 45], [1050, 40, 90, 50], [960, 110, 70, 38],
         [870, 115, 45, 28], [1130, 110, 40, 45], [1080, 120, 50, 30]].forEach(e => fyllEllips(ctx, F.trad, e[0], e[1], e[2], e[3]));
        fyllPoly(ctx, F.stam, [[1036, 150], [1062, 180], [1078, 250], [1084, 330], [1078, 444],
            [1122, 444], [1116, 330], [1110, 250], [1120, 170], [1146, 110], [1122, 98], [1100, 158],
            [1058, 138]]);

        // Larvband, ram, rullar och svängkrans
        fyllPoly(ctx, F.dack, [[368, 690], [450, 648], [652, 638], [662, 700], [642, 792], [560, 792],
            [420, 762], [368, 742]]);
        fyllPoly(ctx, F.morkstal, [[440, 690], [650, 680], [650, 790], [440, 780]]);
        fyllPoly(ctx, F.dack, [[636, 720], [700, 678], [1002, 658], [1082, 700], [1082, 800], [982, 862],
            [760, 892], [648, 862], [628, 780]]);
        fyllPoly(ctx, F.morkstal, [[748, 752], [1002, 724], [1002, 802], [760, 832]]);
        fyllEllips(ctx, F.stal, 1030, 730, 34, 44);
        fyllPoly(ctx, F.morkstal, [[640, 608], [1004, 600], [1004, 660], [640, 668]]);

        // Överdel: motorrum, hytt, motorhuv, tak och rutor
        fyllPoly(ctx, F.gul, [[492, 428], [560, 414], [652, 330], [660, 300], [952, 292], [956, 420], [1000, 436], [1032, 470],
            [1032, 610], [800, 650], [640, 640], [490, 615]]);
        fyllPoly(ctx, F.ljusstal, [[668, 262], [948, 268], [952, 302], [664, 300]]);
        fyllPoly(ctx, F.glas, [[664, 310], [802, 305], [802, 590], [654, 590]]);
        fyllPoly(ctx, F.glas, [[815, 310], [886, 310], [886, 470], [815, 470]]);
        fyllPoly(ctx, F.glas, [[810, 482], [886, 482], [886, 552], [810, 556]]);
        fyllPoly(ctx, F.glas, [[900, 315], [936, 315], [936, 476], [904, 480]]);

        // Bom, sticka, skopa och länkar (gula), cylindrar (stål)
        fyllPoly(ctx, F.gul, [[300, 40], [392, 14], [410, 70], [600, 186], [646, 240], [660, 330],
            [646, 410], [600, 424], [560, 412], [530, 330], [470, 244], [404, 190], [394, 244], [360, 254],
            [346, 500], [334, 600], [380, 780], [400, 850], [250, 850], [130, 760], [120, 650], [190, 580],
            [230, 500], [300, 200]]);
        fyllPoly(ctx, F.ljusstal, [[262, 205], [292, 198], [286, 330], [276, 402], [238, 396], [246, 330]]);
        fyllPoly(ctx, F.ljusstal, [[396, 52], [422, 44], [618, 196], [600, 228]]);
        fyllPoly(ctx, F.ljusstal, [[592, 262], [628, 258], [652, 420], [618, 428]]);
        fyllPoly(ctx, F.ljusstal, [[540, 400], [570, 394], [606, 604], [576, 612]]);
    }

    // Litet propellerplan på gräset (förlaga: ägarens målarbokssida).
    function ritaFlygplanLitet(ctx, pic) {
        if (!fargLage) { ctx.drawImage(pic.img, 0, 0); return; }
        ctx.fillStyle = F.akerkulle;
        ctx.fillRect(0, 0, PAPER_W, PAPER_H);
        fyllPoly(ctx, F.himmel, [[0, 0], [1200, 0], [1200, 205], [1000, 212], [740, 232], [640, 238],
            [560, 215], [490, 208], [400, 238], [300, 248], [150, 255], [0, 262]]);
        fyllPoly(ctx, F.himmel, [[0, 0], [1200, 0], [1200, 200], [960, 120], [730, 125], [570, 145],
            [400, 95], [300, 110], [220, 150], [0, 185]]);
        fyllPoly(ctx, F.fjarrkulle, [[220, 150], [300, 110], [400, 95], [570, 145], [730, 125], [740, 232],
            [640, 238], [560, 215], [490, 208], [400, 238], [220, 245]]);
        // Stigen som slingrar sig under planet
        fyllPoly(ctx, F.grus, [[0, 790], [200, 742], [300, 735], [420, 700], [560, 690], [450, 560],
            [400, 420], [500, 282], [700, 300], [870, 330], [882, 382], [820, 430], [960, 450], [1040, 372],
            [1120, 415], [1200, 505], [1200, 725], [1120, 790], [1090, 900], [0, 900]]);
        // Träd, buskar och ladan
        fyllEllips(ctx, F.trad, 230, 40, 140, 60);
        fyllEllips(ctx, F.trad, 95, 155, 62, 62);
        fyllEllips(ctx, F.trad, 1098, 95, 70, 72);
        fyllEllips(ctx, F.trad, 315, 225, 85, 30);
        fyllEllips(ctx, F.trad, 670, 222, 45, 16);
        fyllEllips(ctx, F.trad, 1050, 205, 90, 14);
        fyllPoly(ctx, F.stam, [[180, 40], [215, 40], [222, 250], [190, 250]]);
        fyllPoly(ctx, F.stam, [[88, 160], [104, 160], [104, 252], [88, 252]]);
        fyllPoly(ctx, F.stam, [[1086, 110], [1104, 110], [1104, 215], [1086, 215]]);
        fyllPoly(ctx, F.morkrod, [[732, 140], [800, 62], [870, 140], [1000, 175], [1000, 232], [732, 236]]);
        fyllPoly(ctx, F.ljusstal, [[800, 58], [905, 72], [970, 140], [875, 140]]);
        fyllPoly(ctx, F.flygkropp, [[768, 150], [840, 150], [840, 228], [768, 228]]);

        // Planet: kropp (blå), vingar och stjärtplan (vita)
        fyllPoly(ctx, F.buk, [[200, 520], [330, 470], [420, 370], [520, 350], [640, 360], [800, 430],
            [900, 440], [960, 300], [1040, 290], [1040, 490], [940, 560], [800, 640], [560, 700],
            [400, 728], [260, 715], [200, 640]]);
        fyllPoly(ctx, F.flygkropp, [[480, 640], [780, 600], [1000, 700], [1060, 780], [1000, 822],
            [860, 800], [490, 680]]);
        fyllPoly(ctx, F.flygkropp, [[930, 505], [1000, 495], [1150, 525], [1155, 550], [1060, 552], [935, 525]]);
        fyllPoly(ctx, F.flygkropp, [[65, 520], [200, 512], [210, 590], [120, 600], [65, 545]]);
        // Rutor
        fyllPoly(ctx, F.glas, [[350, 465], [405, 385], [545, 400], [530, 505], [420, 495]]);
        fyllPoly(ctx, F.glas, [[565, 405], [665, 405], [665, 510], [560, 510]]);
        fyllPoly(ctx, F.glas, [[680, 415], [750, 440], [750, 492], [684, 497]]);
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
        fyllPoly(ctx, F.stam, [[1000, 262], [1200, 262], [1200, 385], [1000, 385]]);
        // Helikoptern: kropp (röd), nos nertill (ljus), rutor, rotor och medar
        fyllPoly(ctx, F.rod, [[230, 600], [270, 480], [340, 400], [490, 370], [500, 320], [640, 315],
            [720, 340], [760, 400], [790, 470], [800, 560], [760, 640], [650, 690], [500, 720],
            [330, 720], [240, 660]]);
        fyllPoly(ctx, F.rod, [[780, 445], [940, 455], [940, 500], [790, 550]]);
        fyllPoly(ctx, F.rod, [[915, 450], [960, 330], [995, 330], [975, 470], [985, 580], [950, 585]]);
        fyllPoly(ctx, F.ljusstal, [[232, 600], [245, 548], [330, 538], [490, 560], [500, 610],
            [330, 632], [235, 622]]);
        fyllPoly(ctx, F.glas, [[275, 520], [330, 430], [420, 395], [520, 408], [525, 570], [430, 568], [280, 540]]);
        fyllPoly(ctx, F.glas, [[545, 435], [632, 430], [638, 570], [542, 570]]);
        fyllPoly(ctx, F.glas, [[668, 438], [735, 440], [740, 550], [670, 552]]);
        fyllPoly(ctx, F.morkstal, [[225, 242], [540, 248], [545, 272], [228, 276]]);
        fyllPoly(ctx, F.morkstal, [[622, 248], [945, 256], [945, 284], [624, 276]]);
        fyllPoly(ctx, F.stal, [[540, 215], [620, 215], [620, 320], [545, 320]]);
        fyllPoly(ctx, F.morkstal, [[940, 470], [1000, 470], [1050, 410], [1060, 540], [1000, 560], [985, 500]]);
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
            fyllEllips(ctx, F.moln, 100, 580, 105, 45);
            fyllEllips(ctx, F.moln, 890, 735, 100, 38);
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
            fyllPoly(ctx, F.stal, [[495, 370], [630, 370], [630, 420], [590, 462], [540, 462], [495, 420]]);
            fyllPoly(ctx, F.morkstal, [[1100, 460], [1145, 465], [1165, 630], [1080, 660], [1060, 520]]);
            fyllPoly(ctx, F.morkstal, [[262, 820], [760, 822], [760, 870], [440, 870], [262, 840]]);
            fyllPoly(ctx, F.morkstal, [[340, 760], [380, 760], [365, 822], [340, 822]]);
            fyllPoly(ctx, F.morkstal, [[485, 765], [530, 765], [530, 850], [490, 850]]);
            fyllPoly(ctx, F.morkstal, [[655, 750], [700, 750], [720, 830], [690, 830]]);
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
            fyllPoly(ctx, F.fjarrkulle, [[0, 430], [100, 412], [300, 435], [500, 438], [650, 465], [820, 432],
                [1000, 450], [1200, 410], [1200, 560], [0, 556]]);
            fyllPoly(ctx, F.akerkulle, [[0, 556], [1200, 560], [1200, 900], [0, 900]]);
            fyllEllips(ctx, F.trad, 82, 485, 35, 40);
            fyllEllips(ctx, F.trad, 145, 500, 20, 32);
            fyllEllips(ctx, F.trad, 790, 505, 30, 30);
            fyllEllips(ctx, F.trad, 190, 550, 45, 10);
            fyllEllips(ctx, F.trad, 1170, 545, 30, 15);
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
    const PICTURES = [
        { namn: 'Traktor', rita: ritaTraktor,
          clawd: { x: 372, y: 442, s: 0.36, ytor: [[372, 330]] } },        // i bakre rutan
        { namn: 'Traktor snett', rita: ritaTraktorSnett,
          clawd: { x: 1100, y: 360, s: 0.24, ytor: [[1100, 310]] } },     // bakom trädet
        { namn: 'Grävmaskin', rita: ritaGravmaskin,
          clawd: { x: 706, y: 604, s: 0.28, ytor: [[706, 520]] } },       // i hytten
        { namn: 'Flygplan', rita: ritaFlygplan,
          clawd: { x: 1040, y: 574, s: 0.34, ytor: [[1040, 500]] } },     // bakom molnet
        { namn: 'Helikopter', rita: ritaHelikopter,
          clawd: { x: 466, y: 470, s: 0.32, ytor: [[466, 380]] } },        // i dörrens ruta
        { namn: 'Traktor (verklig)', rita: ritaTraktorVerklig, bild: 'bilder/traktor-verklig.svg',
          clawd: { x: 600, y: 304, s: 0.42, ytor: [[520, 150], [650, 150], [560, 240], [640, 230]] } },  // kör traktorn
        { namn: 'Grävmaskin (verklig)', rita: ritaGravmaskinVerklig, bild: 'bilder/gravmaskin-verklig.svg',
          clawd: { x: 820, y: 292, s: 0.4, ytor: [[820, 200]] } },         // kikar över hyttaket
        { namn: 'Litet flygplan', rita: ritaFlygplanLitet, bild: 'bilder/flygplan-litet.svg',
          clawd: { x: 455, y: 508, s: 0.4, ytor: [[455, 440]] } },         // i cockpitrutan
        { namn: 'Helikopter på stigen', rita: ritaHelikopterStig, bild: 'bilder/helikopter-stig.svg',
          clawd: { x: 590, y: 585, s: 0.32, ytor: [[590, 500]] } },        // i dörrens ruta
        { namn: 'Helikopter i luften', rita: ritaHelikopterLuft, bild: 'bilder/helikopter-luft.svg',
          clawd: { x: 597, y: 664, s: 0.28, ytor: [[597, 600]] } },        // i sidorutan
        { namn: 'Flygplan vid fältet', rita: ritaFlygplanFalt, bild: 'bilder/flygplan-falt.svg',
          clawd: { x: 590, y: 585, s: 0.24, ytor: [[590, 540]] } }         // i sidorutan
    ];

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
    function pickRegionColors() {
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

    // Blandade ytor läcker ofta bara genom små glapp i linjerna. Inom dem
    // görs linjerna tillfälligt tjockare (GLAPP px åt varje håll) så att
    // glappen sluts, och ytan delas upp i riktiga delar. Varje del tar sin
    // dominerande färg ur kartan (om den har en tydlig sådan), och pixlarna
    // närmast linjerna får färg från närmaste del (bredden-först).
    const GLAPP = 3;
    const REST_MAX = 12000;        // en del får en enda färg bara om resten är så här litet …
    const SKYDDAD_MIN = 1500;      // … och den inte har mer skyddad bakgrundsfärg än så
    const SKVATT = 0.08;           // andel under vilken en färg räknas som skvätt …
    const SKVATT_MAX = 8000;       // … om den dessutom täcker färre pixlar än så
    // Bakgrundens färger (gräs, kullar, grus, jord, moln, träd, stammar,
    // ladan) räknas aldrig som skvätt: strimlorna kommer alltid från
    // fordonens former, och små bitar mark mellan linjer ska få behålla sin färg.
    function hexTillInt(hex) {
        const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
        return (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
    }
    const SKYDDAD = new Set([F.trad, F.stam, F.morkrod, F.akerkulle, F.fjarrkulle, F.grus, F.jord,
        F.moln].map(hexTillInt));
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
                // Fortfarande blandad (t.ex. himmel + mark): färger som bara
                // skvätt in lite (kartans grova kanter) fylls från grannarna.
                for (const i of medlem) {
                    const k = rakna.get(px[i]);
                    if (SKYDDAD.has(px[i]) || !(k < medlem.length * SKVATT && k < SKVATT_MAX)) klar[i] = 1;
                }
            }
        }
        // Pixlarna nära linjerna: färg från närmaste klara pixel i samma yta
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
                px[q] = px[i];
                klar[q] = 1;
                ko[svans++] = q;
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
        cCtx.setTransform(1, 0, 0, 1, 0, 0);
        cCtx.clearRect(0, 0, PAPER_W, PAPER_H);
        fargLage = true;
        kant = LW;
        rita(cCtx, pic);
        fargLage = false;
        labelRegions();
        pickRegionColors();
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
            const t = (now - f.start) / FADE_MS;
            if (t >= 1) {
                commitRegion(f.id);
                fades.splice(k, 1);
                continue;
            }
            vCtx.globalAlpha = t * t * (3 - 2 * t);   // mjuk in/ut
            vCtx.drawImage(f.canvas, f.x, f.y);
        }
        vCtx.globalAlpha = 1;
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
    // själv och tonas mjukt fram (FADE_MS).
    const PENSEL = 34;         // penselns radie i bildpixlar
    const FYLL_ANDEL = 0.8;
    const FADE_MS = 700;
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
        for (let y = 0; y < h; y++) {
            const row = (y0 + y) * W + x0;
            for (let x = 0; x < w; x++) {
                const i = row + x;
                if (labels[i] === id && fillPx[i] === PAPER) px[y * w + x] = blandad ? facitPx[i] : col;
            }
        }
        ctx.putImageData(img, 0, 0);
        fades.push({ id, canvas: c, x: x0, y: y0, start: performance.now() });
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

    // BÖRJA OM — håll in HOLD_MS (1 s) för att aktivera, två gånger (SÄKER?).
    // Touchstart stopPropagates så den inte målar; mousedown för test på dator.
    function holdStart() {
        startHold();
        restartBtn.classList.add('holding');
    }
    function holdEnd() {
        endHold();
        restartBtn.classList.remove('holding');
    }

    restartBtn.addEventListener('touchstart', function(e) {
        e.stopPropagation();
        holdStart();
        e.preventDefault();
    }, { passive: false });

    // Touch-hållning avbryts om fingret glider utanför knappen (samma som
    // mouseleave för mus). Touch-event riktas alltid till elementet där
    // touchen startade, så touchmove på knappen räcker för en bounds-check.
    restartBtn.addEventListener('touchmove', function(e) {
        const t = e.changedTouches[0];
        const r = this.getBoundingClientRect();
        if (t.clientX < r.left || t.clientX > r.right ||
            t.clientY < r.top || t.clientY > r.bottom) {
            holdEnd();
        }
    }, { passive: true });

    // touchend/cancel på hela fönstret stänger hållningen (fingret lyfts)
    window.addEventListener('touchend', holdEnd, { passive: true });
    window.addEventListener('touchcancel', holdEnd, { passive: true });

    // Mus: mousedown startar hållningen (bara vänster knapp), mouseup/mouseleave avslutar
    restartBtn.addEventListener('mousedown', function(e) {
        if (e.button !== 0) return;
        e.stopPropagation();
        holdStart();
    });
    window.addEventListener('mouseup', holdEnd);
    restartBtn.addEventListener('mouseleave', holdEnd);

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
