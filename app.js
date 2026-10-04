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
        heli:   '#5fae7e',
        fjarrkulle: '#c6e2b3',
        akerkulle:  '#a9d494',
        kulle2:     '#b7dba1',   // kulle mellan fjärr- och åkerkullen
        mark:       '#9ccb85',   // gräset längst fram
        morkgul:    '#dcab3c',
        asfalt:     '#b9bdc4',
        vit:        '#f7f7f2',
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

    // Lugn bakgrund för helikoptern, i finare målarboksstil: tunna linjer,
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

    // Rena sidor med helt slutna ytor (t.ex. från Gemini): bara konturerna
    // ritas, och varje yta får sin färg från en punkt i den (`farger` i
    // PICTURES, fargaFranPunkter) — ingen färgkarta behövs.
    function ritaFil(ctx, pic) {
        if (!fargLage) ctx.drawImage(pic.img, 0, 0);
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
        fyllEllips(ctx, F.trad, 1152, 148, 24, 16);
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
        fyllPoly(ctx, F.rod, [[628, 470], [800, 462], [796, 546], [628, 552]]);
        fyllPoly(ctx, F.ljusstal, [[458, 58], [520, 36], [700, 20], [930, 66], [942, 106], [466, 98]]);
        fyllEllips(ctx, F.sol, 680, 46, 20, 10);
        fyllEllips(ctx, F.sol, 492, 70, 18, 10);
        fyllPoly(ctx, F.glas, [[494, 104], [692, 98], [692, 304], [490, 304]]);
        fyllPoly(ctx, F.glas, [[708, 100], [844, 100], [848, 304], [704, 304]]);
        fyllPoly(ctx, F.glas, [[852, 108], [922, 110], [926, 302], [856, 302]]);
        fyllPoly(ctx, F.glas, [[700, 360], [796, 360], [796, 506], [702, 506]]);
        fyllPoly(ctx, F.glas, [[630, 344], [666, 344], [666, 512], [632, 512]]);
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

    // Grävmaskin snett framifrån, omritad för hand som rena vektorer efter
    // ägarens blyertsskiss (samma konturer, men utan skuggning, reflexer och
    // småstreck — som i en målarbok). Ritad i bildens koordinater (1200x900).
    function ritaGravmaskinRen(ctx) {
        stilSatt(ctx);
        kant = 4;
        // Bakgrund: himmel, två kullar, åker
        const kulle = c => {
            c.moveTo(-20, 238);
            c.bezierCurveTo(120, 230, 220, 262, 330, 286);
            c.bezierCurveTo(480, 318, 600, 335, 700, 322);
            c.bezierCurveTo(850, 300, 1000, 262, 1220, 250);
        };
        const falt = c => {
            c.moveTo(-20, 330);
            c.bezierCurveTo(120, 336, 260, 372, 380, 398);
            c.bezierCurveTo(520, 420, 640, 390, 760, 372);
            c.bezierCurveTo(900, 352, 1060, 338, 1220, 335);
        };
        if (fargLage) {
            ctx.fillStyle = F.himmel;
            ctx.fillRect(0, 0, PAPER_W, PAPER_H);
            [[kulle, F.fjarrkulle], [falt, F.akerkulle]].forEach(([bana, farg]) => {
                ctx.beginPath();
                bana(ctx);
                ctx.lineTo(1220, 1000);
                ctx.lineTo(-20, 1000);
                ctx.closePath();
                ctx.fillStyle = farg;
                ctx.fill();
            });
        }
        linje(ctx, kulle, 4);
        linje(ctx, falt, 4);
        trad(ctx, 135, 300, 0.8);
        trad(ctx, 205, 318, 0.55);
        sol(ctx, 105, 95);
        moln(ctx, 760, 120, 0.7);
        // Stort träd till höger (bakom hytten)
        form(ctx, c => {
            c.moveTo(1078, 470);
            c.bezierCurveTo(1088, 380, 1086, 260, 1066, 190);
            c.lineTo(1100, 186);
            c.bezierCurveTo(1112, 260, 1120, 380, 1126, 470);
            c.closePath();
        }, F.stam);
        form(ctx, c => {
            cirkel(c, 880, 80, 55);
            cirkel(c, 965, 58, 66);
            cirkel(c, 1060, 62, 72);
            cirkel(c, 1150, 100, 56);
            cirkel(c, 1010, 120, 48);
            cirkel(c, 1095, 150, 44);
        }, F.trad);
        // Gräs och jordhög under skopan
        [[40, 800, 0.9], [1120, 690, 1.1], [1150, 860, 1], [560, 870, 0.8]].forEach(g => grastuss(ctx, g[0], g[1], g[2]));
        form(ctx, c => {
            c.moveTo(40, 920);
            c.bezierCurveTo(90, 830, 190, 790, 290, 800);
            c.bezierCurveTo(370, 770, 470, 785, 540, 845);
            c.bezierCurveTo(570, 870, 590, 900, 600, 920);
            c.closePath();
        }, F.jord);
        [[170, 860, 200, 852], [330, 850, 365, 842], [450, 870, 480, 866], [260, 890, 290, 884]].forEach(s => {
            linje(ctx, c => { c.moveTo(s[0], s[1]); c.lineTo(s[2], s[3]); }, 3);
        });

        kant = 5;
        // Bortre larvbandet (bakom)
        // Bortre larvbandet (bakom), sett snett: ovansida med bandplattor, rundad
        // gavel i änden och sidan med ram och rullar i skugga.
        form(ctx, c => {
            c.moveTo(374, 744);
            c.bezierCurveTo(372, 712, 392, 684, 440, 664);
            c.lineTo(660, 642);
            c.lineTo(660, 794);
            c.lineTo(480, 788);
            c.bezierCurveTo(430, 786, 384, 774, 374, 744);
            c.closePath();
        }, F.dack);
        linje(ctx, c => {                       // ovansidans innerkant och gavelns kant
            c.moveTo(660, 670);
            c.lineTo(470, 690);
            c.bezierCurveTo(446, 694, 440, 712, 446, 740);
            c.bezierCurveTo(452, 766, 466, 782, 480, 788);
        }, 3);
        for (let k = 0; k < 7; k++) {           // bandplattor på ovansidan (fria ändar)
            const x = 482 + k * 26, y = 664 - k * 2.5;
            linje(ctx, c => { c.moveTo(x, y + 6); c.lineTo(x - 4, y + 20); }, 3);
        }
        [[404, 690], [394, 714], [392, 740], [402, 762]].forEach(([x, y]) => {     // plattor på gaveln
            linje(ctx, c => { c.moveTo(x + 4, y); c.lineTo(x + 24, y + 2); }, 3);
        });
        form(ctx, c => rmangel(c, [[480, 712], [660, 696], [660, 772], [486, 772]], 8), F.morkstal);
        [520, 568, 616].forEach(x => prick(ctx, x, 758 - (x - 520) * 0.04, 9));
        // Svängkrans under överdelen
        form(ctx, c => rmangel(c, [[625, 640], [1000, 630], [1000, 668], [640, 678]], 8), F.morkstal);
        // Närmre larvbandet med ram, hjul och rullar
        form(ctx, c => rmangel(c, [[640, 722], [700, 682], [1000, 655], [1076, 690], [1080, 800],
            [1050, 832], [760, 886], [650, 860]], 42), F.dack);
        for (let k = 0; k < 9; k++) {           // bandplattor uppe
            const x = 730 + k * 32, y = 678 - k * 2.6;
            linje(ctx, c => { c.moveTo(x, y); c.lineTo(x - 6, y + 12); }, 3);
        }
        form(ctx, c => ellips(c, 735, 802, 50, 62), F.stal);
        linje(ctx, c => c.ellipse(738, 802, 30, 40, 0, 0.3 * Math.PI, 1.7 * Math.PI), 3);
        form(ctx, c => ellips(c, 1030, 738, 34, 48), F.stal);
        linje(ctx, c => c.ellipse(1033, 738, 18, 28, 0, 0.3 * Math.PI, 1.7 * Math.PI), 3);
        [[848, 700], [925, 690]].forEach(([x, y]) => form(ctx, c => ellips(c, x, y, 17, 18), F.stal));
        [830, 885, 938, 990].forEach(x => form(ctx, c => ellips(c, x, 828 - (x - 830) * 0.12, 18, 22), F.stal));
        form(ctx, c => rmangel(c, [[770, 745], [998, 714], [1002, 792], [778, 828]], 8), F.stal);
        tunnForm(ctx, c => rr(c, 870, 762, 30, 14, 4), F.morkstal, 3);

        // Motorrum till vänster om hytten (högt rundat skal), med lampa
        form(ctx, c => rmangel(c, [[490, 600], [490, 470], [504, 420], [540, 396], [662, 394],
            [662, 622], [494, 616]], 22), F.gul);
        linje(ctx, c => { c.moveTo(492, 522); c.lineTo(566, 518); }, 3);
        tunnForm(ctx, c => rr(c, 522, 548, 24, 18, 4), F.glas, 3);
        tunnForm(ctx, c => rr(c, 503, 588, 46, 13, 5), F.morkstal, 3);
        // Däck under hytten och motorhuven till höger
        form(ctx, c => rmangel(c, [[640, 598], [1032, 588], [1032, 626], [1000, 642], [800, 656], [650, 642]], 14), F.gul);
        form(ctx, c => rmangel(c, [[946, 416], [988, 412], [1012, 440], [1032, 472], [1032, 598], [946, 604]], 20), F.gul);
        [468, 488, 508].forEach(y => tunnForm(ctx, c => rr(c, 966, y, 40, 10, 5), F.morkstal, 3));

        // Sticka (bakom bommens rundade spets). Smalnar av nedåt; vänster
        // sida har ett fäste för skopcylindern, och toppen en sned platta.
        form(ctx, c => {
            c.moveTo(297, 72);
            c.bezierCurveTo(300, 50, 312, 28, 345, 16);
            c.lineTo(385, 13);
            c.bezierCurveTo(396, 14, 402, 24, 402, 40);
            c.lineTo(398, 250);
            c.lineTo(383, 300);
            c.lineTo(345, 495);
            c.lineTo(342, 545);
            c.lineTo(276, 545);
            c.lineTo(276, 300);
            c.lineTo(288, 214);
            c.bezierCurveTo(268, 210, 264, 176, 292, 166);
            c.closePath();
        }, F.gul);
        linje(ctx, c => { c.moveTo(298, 84); c.lineTo(342, 77); c.lineTo(396, 30); }, 3);   // toppens platta
        linje(ctx, c => { c.moveTo(301, 226); c.lineTo(300, 480); }, 3);                    // stickans kant
        prick(ctx, 317, 180, 7);
        // Skopcylinder längs stickans vänstra sida (cylinder + kolvstång)
        form(ctx, c => stav(c, 278, 205, 258, 392, 26), F.morkstal);
        linje(ctx, c => { c.moveTo(245, 352); c.lineTo(271, 356); }, 3);
        form(ctx, c => stav(c, 256, 390, 228, 494, 14), F.ljusstal);

        // Bom (böjd) med rundad spets som ligger framför stickan
        form(ctx, c => {
            c.moveTo(378, 122);
            c.bezierCurveTo(420, 120, 480, 140, 560, 175);
            c.bezierCurveTo(600, 190, 630, 225, 642, 262);
            c.bezierCurveTo(656, 300, 660, 340, 658, 400);
            c.lineTo(656, 600);
            c.lineTo(600, 600);
            c.lineTo(598, 420);
            c.bezierCurveTo(594, 360, 576, 312, 545, 280);
            c.bezierCurveTo(510, 252, 460, 220, 400, 188);
            c.bezierCurveTo(388, 196, 384, 220, 380, 240);
            c.bezierCurveTo(376, 256, 360, 262, 348, 256);
            c.bezierCurveTo(330, 246, 326, 220, 327, 190);
            c.bezierCurveTo(327, 160, 340, 128, 378, 122);
            c.closePath();
        }, F.gul);
        const s0 = [430, 150], s1 = [592, 240];
        linje(ctx, c => { c.moveTo(s0[0], s0[1] + 12); c.bezierCurveTo(500, 178, 560, 210, s1[0], s1[1]); }, 3);
        prick(ctx, 410, 155, 9);
        prick(ctx, 352, 236, 6);
        // Stickcylinder ovanpå bommen (kolvstång + cylinder)
        form(ctx, c => stav(c, 386, 36, 466, 106, 16), F.ljusstal);
        form(ctx, c => stav(c, 462, 108, 586, 202, 32), F.morkstal);
        prick(ctx, 384, 35, 7);
        prick(ctx, 582, 201, 7);
        // Bomcylindrar (bortre först): kolvstång, krage och cylinder
        form(ctx, c => stav(c, 553, 320, 560, 412, 16), F.ljusstal);
        form(ctx, c => stav(c, 561, 406, 578, 606, 30), F.morkstal);
        linje(ctx, c => { c.moveTo(546, 428); c.lineTo(576, 426); }, 3);
        form(ctx, c => stav(c, 612, 272, 616, 404, 18), F.ljusstal);
        form(ctx, c => stav(c, 628, 400, 632, 606, 32), F.morkstal);
        linje(ctx, c => { c.moveTo(612, 428); c.lineTo(644, 428); }, 3);
        prick(ctx, 612, 272, 7);
        prick(ctx, 553, 320, 6);

        // Skopa med öron, sidoplåt, slitskena och tänder
        const skar0 = [225, 812], skar1 = [400, 855];
        form(ctx, c => {
            c.moveTo(180, 600);
            c.lineTo(186, 574);
            c.lineTo(214, 570);
            c.lineTo(222, 600);
            c.lineTo(350, 598);
            c.lineTo(368, 622);
            c.lineTo(370, 770);
            c.lineTo(skar1[0], skar1[1]);
            c.lineTo(skar0[0], skar0[1]);
            c.bezierCurveTo(175, 795, 128, 752, 123, 692);
            c.bezierCurveTo(120, 640, 146, 606, 180, 600);
            c.closePath();
            [0.1, 0.32, 0.54, 0.76].forEach(t => {
                const x = skar0[0] + (skar1[0] - skar0[0]) * t, y = skar0[1] + (skar1[1] - skar0[1]) * t;
                mangel(c, [[x, y], [x + 24, y + 6], [x + 9, y + 26]]);
            });
        }, F.gul);
        linje(ctx, c => { c.moveTo(318, 599); c.bezierCurveTo(264, 660, 252, 772, 305, 830); }, 4);   // sidoplåt
        linje(ctx, c => { c.moveTo(150, 668); c.quadraticCurveTo(140, 712, 160, 752); }, 3);           // ribbor
        linje(ctx, c => { c.moveTo(208, 650); c.quadraticCurveTo(196, 712, 214, 778); }, 3);
        prick(ctx, 380, 800, 4);
        prick(ctx, 386, 822, 4);
        // Länkar mellan sticka och skopa
        form(ctx, c => mangel(c, [[222, 518], [262, 518], [258, 600], [216, 600]]), F.gul);
        form(ctx, c => stav(c, 322, 578, 268, 594, 24), F.gul);
        form(ctx, c => stav(c, 326, 512, 322, 580, 26), F.gul);
        form(ctx, c => rr(c, 198, 486, 140, 34, 17), F.gul);
        [[216, 503], [326, 506], [322, 579], [268, 594]].forEach(([x, y]) => prick(ctx, x, y, 6));

        // Hytt: kaross, tak, rutor, dörrfog och handtag
        form(ctx, c => rmangel(c, [[660, 300], [948, 296], [952, 592], [870, 616], [790, 622], [650, 602]], 12), F.gul);
        form(ctx, c => rmangel(c, [[668, 266], [935, 258], [950, 280], [948, 304], [668, 308], [660, 286]], 10), F.ljusstal);
        tunnForm(ctx, c => rr(c, 676, 272, 26, 14, 5), F.sol, 3);
        tunnForm(ctx, c => rr(c, 776, 268, 28, 14, 5), F.sol, 3);
        form(ctx, c => rmangel(c, [[670, 322], [770, 316], [778, 500], [664, 500]], 12), F.glas);
        form(ctx, c => rmangel(c, [[664, 512], [776, 510], [778, 598], [662, 596]], 10), F.glas);
        form(ctx, c => rmangel(c, [[818, 308], [884, 308], [888, 466], [815, 466]], 14), F.glas);
        form(ctx, c => rmangel(c, [[814, 492], [880, 490], [884, 518], [868, 560], [816, 574]], 12), F.glas);
        form(ctx, c => rmangel(c, [[905, 320], [936, 322], [936, 480], [905, 490]], 12), F.glas);
        linje(ctx, c => { c.moveTo(896, 304); c.lineTo(898, 612); }, 4);
        linje(ctx, c => { c.moveTo(792, 306); c.lineTo(796, 620); }, 4);                  // hörnstolpe
        tunnForm(ctx, c => rr(c, 830, 358, 42, 34, 12), F.morkstal, 3);                    // stol (nackstöd)
        tunnForm(ctx, c => rmangel(c, [[822, 400], [878, 398], [882, 466], [818, 466]], 12), F.morkstal, 3);
        linje(ctx, c => { c.moveTo(888, 528); c.lineTo(888, 556); }, 4);
        tunnForm(ctx, c => rr(c, 812, 574, 16, 18, 4), F.morkstal, 3);
    }

    // Bilderna. `clawd` = var den lilla kompisen Clawd gömmer sig:
    // (x, y) = mitt under fötterna, s = skala, `ytor` = punkter i de ytor han
    // syns i (han ritas bara där, så det som ligger framför skymmer honom).
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
        { namn: 'Traktor snett', rita: ritaTraktorSnett,
          clawd: { x: 1100, y: 360, s: 0.24, ytor: [[1100, 310]] } },     // bakom trädet
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
        { namn: 'Helikopter', rita: ritaHelikopter,
          clawd: { x: 466, y: 470, s: 0.32, ytor: [[466, 380]] } },        // i dörrens ruta
        { namn: 'Traktor (verklig)', rita: ritaTraktorVerklig, bild: 'bilder/traktor-verklig.svg',
          clawd: { x: 600, y: 304, s: 0.42, ytor: [[520, 150], [650, 150], [560, 240], [640, 230]] } },  // kör traktorn
        { namn: 'Grävmaskin (verklig)', rita: ritaGravmaskinRen,
          clawd: { x: 718, y: 504, s: 0.36, ytor: [[718, 420]] } },        // i framrutan
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
        cCtx.setTransform(1, 0, 0, 1, 0, 0);
        cCtx.clearRect(0, 0, PAPER_W, PAPER_H);
        fargLage = true;
        kant = LW;
        rita(cCtx, pic);
        fargLage = false;
        labelRegions();
        if (pic.farger) fargaFranPunkter(pic.farger);
        else pickRegionColors();
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
    const PENSEL = 31;         // penselns radie i bildpixlar
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
