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
        flygkropp: '#eef2f7',
        buk:    '#7aa6da',
        fena:   '#5b8fd0',
        vinge:  '#c5ccd5',
        ruta:   '#4d6886',
        jord:   '#cfae84',
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

        // Skopa med tänder
        const a = [1078, 742], b = [1160, 718];
        form(ctx, c => {
            c.moveTo(1086, 548);
            c.lineTo(1150, 548);
            c.bezierCurveTo(1196, 580, 1200, 670, b[0], b[1]);
            c.lineTo(a[0], a[1]);
            c.bezierCurveTo(1078, 680, 1080, 600, 1086, 548);
            c.closePath();
            [0.15, 0.45, 0.75].forEach(t => {
                const p0 = [a[0] + (b[0] - a[0]) * (t - 0.08), a[1] + (b[1] - a[1]) * (t - 0.08)];
                const p1 = [a[0] + (b[0] - a[0]) * (t + 0.08), a[1] + (b[1] - a[1]) * (t + 0.08)];
                const m = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
                mangel(c, [p0, p1, [m[0] - 6, m[1] + 22]]);
            });
        }, F.gul);
        linje(ctx, c => { c.moveTo(1158, 574); c.bezierCurveTo(1180, 610, 1178, 670, 1150, 700); }, 3);
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
        linje(ctx, c => { c.moveTo(700, 452); c.lineTo(734, 520); }, 3);   // torkare
        linje(ctx, c => { c.moveTo(704, 622); c.lineTo(730, 622); }, 4);   // handtag
    }

    // Lugn bakgrund för flygplanet, i finare målarboksstil: tunna linjer,
    // två kullar långt ner, några små träd, moln och en sol utan ansikte.
    function luftBakgrund(ctx) {
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
        [[650, 140, 0.9], [1040, 600, 0.75], [150, 600, 0.65]].forEach(m => moln(ctx, m[0], m[1], m[2]));
    }

    // Flygplan (ungefär en Airbus A330) från sidan, på väg uppåt åt höger.
    // Lite verkligare stil: tunnare kant och fler, mindre ytor (fönster,
    // dörrar, motorns delar). Ritat i ett eget koordinatsystem där kroppen
    // går från x = 0 (stjärten) till x = 1000 (nosen), mittlinjen y = 0.
    function ritaFlygplan(ctx) {
        stilSatt(ctx);
        kant = 4;
        luftBakgrund(ctx);
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

    const PICTURES = [
        { namn: 'Traktor', rita: ritaTraktor },
        { namn: 'Grävmaskin', rita: ritaGravmaskin },
        { namn: 'Flygplan', rita: ritaFlygplan }
    ];
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
    // anti-aliasade kantpixlarna i blandfärg röstas bort).
    function pickRegionColors() {
        const n = regionSize.length;
        const px = new Uint32Array(cCtx.getImageData(0, 0, PAPER_W, PAPER_H).data.buffer);
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
        regionColor = new Uint32Array(n);
        for (let l = 1; l < n; l++) {
            // Saknas färg (genomskinligt) eller blev den exakt pappersvit:
            // ta en ljusgrå så att det ändå syns att ytan är ifylld.
            const c = cand[l];
            regionColor[l] = ((c >>> 24) < 255 || c === PAPER) ? 0xFFEEEEEE : c;
        }
    }

    // Varje bild minns det man målat medan appen är öppen, så man kan
    // bläddra fram och tillbaka utan att förlora något.
    const pictureState = [];
    let pictureLoaded = false;

    function loadPicture(index) {
        if (pictureLoaded) {
            finishFades();
            pictureState[currentPicture] = fillPx.slice();
        }
        pictureLoaded = true;
        currentPicture = index;
        const rita = PICTURES[index].rita;
        lCtx.setTransform(1, 0, 0, 1, 0, 0);
        lCtx.clearRect(0, 0, PAPER_W, PAPER_H);
        kant = LW;
        rita(lCtx);
        cCtx.setTransform(1, 0, 0, 1, 0, 0);
        cCtx.clearRect(0, 0, PAPER_W, PAPER_H);
        fargLage = true;
        kant = LW;
        rita(cCtx);
        fargLage = false;
        labelRegions();
        pickRegionColors();
        fades.length = 0;
        const saved = pictureState[index];
        if (saved) {
            fillPx.set(saved);
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
        loadPicture((currentPicture + step + PICTURES.length) % PICTURES.length);
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
        vCtx.drawImage(lineCanvas, 0, 0);
        vCtx.setTransform(1, 0, 0, 1, 0, 0);
        if (fades.length) requestRender();
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
            for (let i = y * W + xa, end = y * W + xb; i <= end; i++) {
                const l = labels[i];
                if (l <= 0 || regionDone[l] || fillPx[i] !== PAPER) continue;
                fillPx[i] = regionColor[l];
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
        if (clearState) resetClearButton();
        requestRender();
    }

    // Lägger det som är kvar av ytan på en egen liten canvas som tonas fram
    // ovanpå; när toningen är klar skrivs den in i fillPx (commitRegion).
    function startFade(id) {
        regionDone[id] = 1;
        const W = PAPER_W;
        const x0 = regionLeft[id], y0 = regionTop[id];
        const w = regionRight[id] - x0 + 1, h = regionBottom[id] - y0 + 1;
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(w, h);
        const px = new Uint32Array(img.data.buffer);
        const col = regionColor[id];
        for (let y = 0; y < h; y++) {
            const row = (y0 + y) * W + x0;
            for (let x = 0; x < w; x++) {
                const i = row + x;
                if (labels[i] === id && fillPx[i] === PAPER) px[y * w + x] = col;
            }
        }
        ctx.putImageData(img, 0, 0);
        fades.push({ id, canvas: c, x: x0, y: y0, start: performance.now() });
    }

    // Fyller hela ytan i fillPx (direkt, utan toning).
    function commitRegion(id) {
        const W = PAPER_W;
        const col = regionColor[id];
        const x0 = regionLeft[id], x1 = regionRight[id];
        const y0 = regionTop[id], y1 = regionBottom[id];
        for (let y = y0; y <= y1; y++) {
            for (let i = y * W + x0, end = y * W + x1; i <= end; i++) {
                if (labels[i] === id) fillPx[i] = col;
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
