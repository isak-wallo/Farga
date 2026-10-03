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

    // Givna färger — lugna, lite mjukare än rena grundfärger.
    const F = {
        himmel: '#cfe6f7',
        kulle:  '#b8dba4',
        vag:    '#e8d6ad',
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
        morkstal: '#6f747c'
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
        ctx.lineWidth = LW * 2;
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

    // Grästuss: tre korta streck
    function grastuss(ctx, x, y, s) {
        linje(ctx, c => {
            c.moveTo(x, y); c.lineTo(x - 16 * s, y - 38 * s);
            c.moveTo(x, y); c.lineTo(x + 2 * s, y - 48 * s);
            c.moveTo(x, y); c.lineTo(x + 18 * s, y - 36 * s);
        });
    }

    // Gemensamt landskap: mjuka kullar, träd, buskar, en väg och himmel.
    // `o.sol` = [x, y], `o.moln` = lista av [x, y, skala].
    function landskap(ctx, o) {
        // Bortre kullen och vägkanten (två långa svängar tvärs över bilden)
        // Bortre kullen. Grävmaskinen får en lägre kulle till höger så att
        // luften under bommen blir en enda stor yta.
        const kulle = c => {
            if (o.kulle === 'gravmaskin') {
                c.moveTo(-20, 420);
                c.bezierCurveTo(60, 380, 150, 380, 215, 440);
                c.bezierCurveTo(400, 520, 700, 490, 930, 486);
                c.bezierCurveTo(1060, 490, 1140, 480, 1220, 470);
            } else {
                c.moveTo(-20, 430);
                c.bezierCurveTo(140, 340, 320, 340, 470, 405);
                c.bezierCurveTo(620, 470, 760, 360, 930, 360);
                c.bezierCurveTo(1060, 360, 1140, 395, 1220, 380);
            }
        };
        const vag = c => {
            c.moveTo(-20, 815);
            c.bezierCurveTo(380, 745, 760, 845, 1220, 755);
        };
        if (fargLage) {
            // Himmel överallt, sedan kullen och vägen nedanför sina linjer
            ctx.fillStyle = F.himmel;
            ctx.fillRect(0, 0, PAPER_W, PAPER_H);
            [[kulle, F.kulle], [vag, F.vag]].forEach(([bana, farg]) => {
                ctx.beginPath();
                bana(ctx);
                ctx.lineTo(1220, 1000);
                ctx.lineTo(-20, 1000);
                ctx.closePath();
                ctx.fillStyle = farg;
                ctx.fill();
            });
        }
        linje(ctx, kulle);
        linje(ctx, vag);

        // Fåror på kullen och hjulspår på vägen (lösa streck, ingen egen yta)
        // De ska ha fria ändar (inte nå bildkanten eller maskinen) så att de
        // inte delar upp kullen i fler ytor.
        const faror = [[30, 505, 90, 490, 140, 492, 196, 502], [24, 560, 90, 545, 140, 548, 190, 560]];
        if (o.hogerFaror) {
            faror.push([1000, 480, 1060, 468, 1120, 470, 1180, 482], [1010, 540, 1070, 528, 1120, 530, 1176, 542]);
        }
        faror.forEach(f => {
            linje(ctx, c => { c.moveTo(f[0], f[1]); c.bezierCurveTo(f[2], f[3], f[4], f[5], f[6], f[7]); }, TUNN);
        });
        linje(ctx, c => { c.moveTo(40, 880); c.bezierCurveTo(130, 870, 250, 868, 350, 874); }, TUNN);
        linje(ctx, c => { c.moveTo(760, 874); c.bezierCurveTo(870, 866, 990, 860, 1120, 850); }, TUNN);

        // Träd på bortre kullen
        trad(ctx, 120, 400, 1);
        [[-30, -60], [8, -92], [34, -56], [-6, -42]].forEach(l => {     // löv
            linje(ctx, c => c.arc(120 + l[0], 400 + l[1], 9, 0.2 * Math.PI, 1.1 * Math.PI), TUNN);
        });

        // Sol
        const sx = o.sol[0], sy = o.sol[1];
        form(ctx, c => cirkel(c, sx, sy, 50), F.sol);
        for (let k = 0; k < 10; k++) {
            const v = k * Math.PI / 5 + 0.15;
            linje(ctx, c => {
                c.moveTo(sx + Math.cos(v) * 72, sy + Math.sin(v) * 72);
                c.lineTo(sx + Math.cos(v) * 98, sy + Math.sin(v) * 98);
            });
        }
        prick(ctx, sx - 17, sy - 11, 5);
        prick(ctx, sx + 17, sy - 11, 5);
        linje(ctx, c => c.arc(sx, sy, 25, 0.25 * Math.PI, 0.75 * Math.PI));

        // Moln
        o.moln.forEach(m => {
            const x = m[0], y = m[1], s = m[2];
            form(ctx, c => {
                cirkel(c, x - 55 * s, y, 32 * s);
                cirkel(c, x, y - 28 * s, 42 * s);
                cirkel(c, x + 55 * s, y - 4 * s, 34 * s);
                rr(c, x - 87 * s, y - 2 * s, 176 * s, 36 * s, 18 * s);
            }, F.moln);
        });

        // Gräs i förgrunden
        grastuss(ctx, 80, 868, 1);
        grastuss(ctx, 1120, 872, 1);
        grastuss(ctx, 610, 884, 0.8);
    }

    // Punkt på en kubisk bezierkurva (p = fyra [x, y]-punkter, t 0..1)
    function bez(p, t) {
        const u = 1 - t;
        return [
            u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0],
            u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1]
        ];
    }

    // Slitbana på ett hjul: korta sneda streck på en ellips mellan vinklarna
    // g0..g1 (grader), på avstånden f0..f1 av radien. Stannar innanför däcket.
    function slitbana(ctx, cx, cy, rx, ry, g0, g1, steg, f0, f1) {
        for (let g = g0; g <= g1; g += steg) {
            const a = g * Math.PI / 180, b = (g + 7) * Math.PI / 180;
            linje(ctx, c => {
                c.moveTo(cx + Math.cos(a) * rx * f0, cy + Math.sin(a) * ry * f0);
                c.lineTo(cx + Math.cos(b) * rx * f1, cy + Math.sin(b) * ry * f1);
            }, TUNN);
        }
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

    // Traktor snett framifrån (främre delen åt vänster). Ritad i ett eget
    // koordinatsystem (RX, RY) och skalad in i bilden.
    function ritaTraktor(ctx) {
        stilSatt(ctx);
        landskap(ctx, { sol: [1080, 110], moln: [[420, 120, 1]], hogerFaror: true });

        ctx.save();
        ctx.translate(30, -50);
        ctx.scale(1.08, 1.08);

        // Skuggstreck på marken under hjulen
        [[140, 822, 300], [400, 850, 570], [650, 822, 880]].forEach(s => {
            linje(ctx, c => { c.moveTo(s[0], s[1]); c.lineTo(s[2], s[1] + 6); }, TUNN);
        });

        // Avgasrör med böj och ljuddämpare (bakom huven), en enda yta
        form(ctx, c => {
            stav(c, 352, 362, 352, 282, 22);
            stav(c, 352, 282, 380, 256, 22);
            cirkel(c, 352, 282, 11);
            rr(c, 331, 340, 52, 108, 10);
        }, F.stal);
        for (let k = 0; k < 4; k++) {       // ränder på ljuddämparen (inga korsningar)
            linje(ctx, c => { c.moveTo(344, 366 + k * 18); c.lineTo(370, 360 + k * 18); }, TUNN);
        }

        // Hytt: kaross, tak, fönster (rundade hörn)
        form(ctx, c => rmangel(c, [
            [418, 262], [600, 258], [752, 268], [748, 425], [650, 435],
            [648, 582], [570, 592], [535, 586], [535, 430], [408, 405]
        ], 12), F.rod);
        form(ctx, c => rmangel(c, [
            [418, 240], [470, 222], [600, 204], [745, 238], [752, 262],
            [745, 270], [600, 262], [420, 262]
        ], 12), F.morkrod);
        linje(ctx, c => { c.moveTo(436, 252); c.lineTo(734, 259); }, TUNN);    // takkant
        form(ctx, c => rmangel(c, [[434, 278], [576, 272], [552, 396], [422, 392]], 14), F.glas);
        form(ctx, c => rmangel(c, [[606, 278], [736, 290], [733, 411], [598, 417]], 14), F.glas);
        linje(ctx, c => { c.moveTo(690, 286); c.lineTo(691, 338); }, TUNN);    // dörrstolpe
        linje(ctx, c => { c.moveTo(498, 274); c.lineTo(442, 338); }, TUNN);    // torkare
        linje(ctx, c => { c.moveTo(456, 380); c.lineTo(488, 306); }, TUNN);    // reflexer
        linje(ctx, c => { c.moveTo(474, 384); c.lineTo(498, 328); }, TUNN);
        linje(ctx, c => c.ellipse(512, 368, 30, 12, -0.2, 0.35, 2 * Math.PI - 0.35), TUNN); // ratt
        linje(ctx, c => { c.moveTo(512, 369); c.lineTo(519, 384); }, TUNN);
        linje(ctx, c => { c.moveTo(692, 404); c.bezierCurveTo(672, 390, 668, 352, 690, 328); }, TUNN); // säte
        linje(ctx, c => { c.moveTo(690, 402); c.lineTo(652, 402); }, TUNN);
        linje(ctx, c => { c.moveTo(618, 396); c.lineTo(632, 358); }, TUNN);    // reflexer
        linje(ctx, c => { c.moveTo(601, 448); c.lineTo(598, 564); }, TUNN);    // dörrspringa
        linje(ctx, c => { c.moveTo(588, 452); c.lineTo(588, 474); }, TUNN);    // dörrhandtag

        // Bakhjul (stort) med slitbana och bultar
        form(ctx, c => ellips(c, 765, 640, 112, 162), F.dack);
        form(ctx, c => ellips(c, 800, 630, 56, 104), F.falg);
        slitbana(ctx, 765, 640, 112, 162, 100, 260, 15, 0.7, 0.94);
        linje(ctx, c => c.ellipse(765, 640, 112 * 0.6, 162 * 0.6, 0, 100 * Math.PI / 180, 260 * Math.PI / 180), TUNN);
        linje(ctx, c => c.ellipse(806, 628, 34, 62, 0, 0.35 * Math.PI, 1.65 * Math.PI), TUNN);
        for (let k = 0; k < 5; k++) {
            const v = k * 2 * Math.PI / 5;
            prick(ctx, 806 + Math.cos(v) * 24, 628 + Math.sin(v) * 42, 5);
        }
        prick(ctx, 806, 628, 8);

        // Stänkskärm över bakhjulet
        form(ctx, c => {
            c.moveTo(640, 572);
            c.bezierCurveTo(660, 482, 722, 440, 790, 440);
            c.bezierCurveTo(822, 442, 846, 456, 854, 486);
            c.bezierCurveTo(800, 470, 742, 482, 702, 530);
            c.bezierCurveTo(676, 556, 660, 576, 640, 582);
            c.closePath();
        }, F.rod);
        linje(ctx, c => {
            c.moveTo(672, 522);
            c.bezierCurveTo(690, 482, 735, 455, 790, 454);
            c.bezierCurveTo(812, 455, 830, 462, 838, 474);
        }, TUNN);

        // Främre hjul längst bort (vänster): däck och fälg i en yta
        form(ctx, c => ellips(c, 232, 705, 68, 98), F.dack);
        linje(ctx, c => c.ellipse(245, 708, 36, 60, 0, 0.3 * Math.PI, 1.7 * Math.PI), TUNN);
        slitbana(ctx, 232, 705, 68, 98, 120, 240, 15, 0.74, 0.93);
        prick(ctx, 247, 710, 8);

        // Huv
        form(ctx, c => {
            c.moveTo(248, 500);
            c.bezierCurveTo(260, 455, 330, 425, 420, 420);
            c.bezierCurveTo(470, 418, 510, 425, 530, 440);
            c.lineTo(528, 600);
            c.lineTo(380, 625);
            c.lineTo(262, 625);
            c.bezierCurveTo(250, 580, 245, 540, 248, 500);
            c.closePath();
        }, F.rod);
        linje(ctx, c => {                   // kant mellan huvens topp och sida
            c.moveTo(270, 498);
            c.bezierCurveTo(300, 466, 380, 442, 466, 438);
        }, TUNN);
        linje(ctx, c => {                   // sidolucka
            c.moveTo(432, 584);
            c.bezierCurveTo(440, 532, 482, 518, 518, 532);
            c.lineTo(522, 604);
            c.lineTo(452, 610);
        }, TUNN);
        prick(ctx, 480, 572, 6);
        for (let k = 0; k < 3; k++) {       // luftspringor
            linje(ctx, c => { c.moveTo(476 + k * 16, 446 + k * 3); c.lineTo(480 + k * 16, 480 + k * 3); }, TUNN);
        }
        // Grill med springor
        form(ctx, c => rr(c, 257, 490, 78, 128, 24), F.stal);
        for (let k = 0; k < 4; k++) {
            linje(ctx, c => { c.moveTo(272 + k * 15, 514); c.lineTo(272 + k * 15, 596); }, TUNN);
        }
        // Strålkastare: bara kontur (ingen egen yta)
        linje(ctx, c => c.arc(383, 563, 27, 0.15 * Math.PI, 1.85 * Math.PI), TUNN + 1);
        linje(ctx, c => c.arc(383, 563, 16, 0.3 * Math.PI, 1.8 * Math.PI), TUNN);
        prick(ctx, 383, 563, 5);
        // Främre tyngd
        form(ctx, c => rmangel(c, [[226, 640], [370, 632], [374, 694], [232, 670]], 6), F.morkstal);
        prick(ctx, 246, 654, 5);
        prick(ctx, 356, 650, 5);

        // Främre hjul närmast
        form(ctx, c => ellips(c, 490, 725, 75, 106), F.dack);
        form(ctx, c => ellips(c, 500, 730, 40, 66), F.falg);
        slitbana(ctx, 490, 725, 75, 106, 120, 240, 15, 0.74, 0.93);
        prick(ctx, 502, 735, 9);

        ctx.restore();
    }

    // Grävmaskin från sidan, riktad åt höger.
    function ritaGravmaskin(ctx) {
        stilSatt(ctx);
        landskap(ctx, { sol: [1100, 105], moln: [[430, 110, 1]], kulle: 'gravmaskin' });

        // Maskinen flyttas åt vänster så att luften runt skopan hänger ihop
        // med resten av marken (annars blir en liten instängd yta kvar).
        ctx.save();
        ctx.translate(-30, 0);

        // Skuggstreck under larvbandet
        [[230, 740, 340], [420, 746, 570], [640, 740, 770]].forEach(s => {
            linje(ctx, c => { c.moveTo(s[0], s[1]); c.lineTo(s[2], s[1] + 4); }, TUNN);
        });

        // Jordhög (bara en kontur, ingen egen yta) bakom skopan
        linje(ctx, c => {
            c.moveTo(880, 736);
            c.bezierCurveTo(930, 640, 1020, 570, 1110, 556);
        }, LW - 1);
        [[945, 708, 972, 700], [985, 664, 1012, 652], [930, 676, 952, 664], [1015, 712, 1046, 704]].forEach(s => {
            linje(ctx, c => { c.moveTo(s[0], s[1]); c.lineTo(s[2], s[3]); }, TUNN);
        });

        // Underrede: svängkrans/plattform, larvband med drev och stödhjul
        form(ctx, c => rr(c, 255, 518, 470, 86, 8), F.morkstal);
        prick(ctx, 280, 572, 6);
        prick(ctx, 700, 572, 6);
        form(ctx, c => rr(c, 235, 592, 530, 124, 62), F.dack);
        form(ctx, c => cirkel(c, 297, 654, 54), F.stal);
        form(ctx, c => cirkel(c, 703, 654, 54), F.stal);
        [297, 703].forEach(x => {           // drevens kuggring och bultar
            linje(ctx, c => c.arc(x, 654, 38, 0.25 * Math.PI, 1.75 * Math.PI), TUNN);
            for (let k = 0; k < 6; k++) {
                const v = k * Math.PI / 3 + 0.3;
                prick(ctx, x + Math.cos(v) * 25, 654 + Math.sin(v) * 25, 4);
            }
            prick(ctx, x, 654, 9);
        });
        prick(ctx, 400, 672, 15);
        prick(ctx, 500, 672, 15);
        prick(ctx, 600, 672, 15);
        for (let x = 378; x <= 630; x += 36) {      // klackar (utanför dreven)
            linje(ctx, c => { c.moveTo(x, 594); c.lineTo(x, 608); }, TUNN + 1);
            linje(ctx, c => { c.moveTo(x, 700); c.lineTo(x, 714); }, TUNN + 1);
        }

        // Motvikt
        form(ctx, c => {
            c.moveTo(215, 560);
            c.lineTo(212, 462);
            c.bezierCurveTo(212, 412, 248, 388, 304, 388);
            c.lineTo(392, 394);
            c.lineTo(396, 560);
            c.closePath();
        }, F.gul);
        linje(ctx, c => {
            c.moveTo(230, 470);
            c.bezierCurveTo(230, 432, 258, 410, 300, 406);
        }, TUNN);
        linje(ctx, c => { c.moveTo(236, 488); c.lineTo(374, 488); }, TUNN);   // skarv i motvikten
        prick(ctx, 252, 526, 6);
        prick(ctx, 376, 526, 6);

        // Motorrum med avgasrör i samma yta
        form(ctx, c => {
            c.moveTo(388, 560);
            c.lineTo(388, 440);
            c.bezierCurveTo(388, 420, 398, 410, 416, 410);
            c.lineTo(552, 420);
            c.lineTo(562, 444);
            c.lineTo(562, 560);
            c.closePath();
            stav(c, 448, 428, 448, 352, 22);
            stav(c, 448, 352, 474, 328, 22);
            cirkel(c, 448, 352, 11);
        }, F.gul);
        for (let k = 0; k < 3; k++) {       // luftspringor
            linje(ctx, c => { c.moveTo(424, 458 + k * 28); c.lineTo(526, 458 + k * 28); }, TUNN);
        }
        linje(ctx, c => { c.moveTo(540, 520); c.lineTo(540, 548); }, TUNN);   // lucka
        linje(ctx, c => { c.moveTo(408, 520); c.lineTo(408, 548); }, TUNN);
        linje(ctx, c => {                   // ledstång (öppen i ena änden)
            c.moveTo(490, 414); c.lineTo(490, 398); c.lineTo(538, 402);
        }, TUNN);

        // Hytt: kaross med tak i samma yta, fönster och förare (bara kontur)
        form(ctx, c => {
            c.moveTo(552, 562);
            c.lineTo(552, 352);
            c.bezierCurveTo(552, 338, 560, 330, 574, 330);
            c.lineTo(668, 330);
            c.bezierCurveTo(690, 332, 704, 346, 722, 410);
            c.lineTo(722, 562);
            c.closePath();
            rr(c, 540, 310, 150, 28, 10);
        }, F.gul);
        linje(ctx, c => { c.moveTo(558, 324); c.lineTo(672, 324); }, TUNN);
        prick(ctx, 609, 292, 10);               // varningslampa
        form(ctx, c => rmangel(c, [[570, 354], [652, 354], [698, 410], [698, 482], [570, 482]], 12), F.glas);
        linje(ctx, c => { c.moveTo(578, 468); c.lineTo(588, 424); }, TUNN);    // reflexer
        linje(ctx, c => { c.moveTo(640, 366); c.lineTo(612, 400); }, TUNN);    // torkare
        linje(ctx, c => c.arc(628, 436, 24, 0.65 * Math.PI, 2.35 * Math.PI), TUNN + 1);   // förarens huvud (öppen nedtill)
        prick(ctx, 618, 434, 4);
        prick(ctx, 638, 434, 4);
        linje(ctx, c => c.arc(628, 438, 11, 0.2 * Math.PI, 0.8 * Math.PI), TUNN);
        linje(ctx, c => { c.moveTo(640, 502); c.lineTo(640, 548); }, TUNN);    // dörrspringa
        linje(ctx, c => { c.moveTo(656, 512); c.lineTo(676, 512); }, TUNN);    // handtag

        // Bom (böjd) med slang, svetsfogar och cylinder
        const bomYtter = [[668, 548], [655, 420], [770, 290], [925, 225]];
        const bomInner = [[962, 278], [880, 330], [800, 420], [780, 556]];
        form(ctx, c => {
            c.moveTo(668, 548);
            c.bezierCurveTo(655, 420, 770, 290, 925, 225);
            c.bezierCurveTo(960, 235, 975, 258, 962, 278);
            c.bezierCurveTo(880, 330, 800, 420, 780, 556);
            c.closePath();
        }, F.gul);
        linje(ctx, c => {                       // hydraulslang längs bomen
            c.moveTo(706, 502);
            c.bezierCurveTo(706, 424, 786, 330, 896, 268);
        }, TUNN);
        [0.3, 0.55, 0.78].forEach(t => {        // svetsfogar tvärs över bomen
            const o = bez(bomYtter, t), i = bez(bomInner, 1 - t);
            linje(ctx, c => {
                // bara längs ytterkanten: får inte nå slangen eller cylindern
                c.moveTo(o[0] + (i[0] - o[0]) * 0.08, o[1] + (i[1] - o[1]) * 0.08);
                c.lineTo(o[0] + (i[0] - o[0]) * 0.24, o[1] + (i[1] - o[1]) * 0.24);
            }, TUNN);
        });
        // Cylinderns ände ligger mitt i bommen (annars skär den av en sliver-yta)
        form(ctx, c => { stav(c, 722, 538, 773, 430, 30); stav(c, 773, 430, 815, 342, 15); }, F.ljusstal);
        linje(ctx, c => { c.moveTo(762, 442); c.lineTo(776, 449); }, TUNN);    // kolvring

        // Stickan (avsmalnande) med cylinder uppe på bommen
        form(ctx, c => {
            mangel(c, [[977, 245], [1103, 508], [1057, 532], [913, 279]]);
            cirkel(c, 945, 262, 36);
            cirkel(c, 1080, 520, 28);
        }, F.gul);
        linje(ctx, c => { c.moveTo(958, 296); c.lineTo(1050, 470); }, TUNN);   // förstärkning
        linje(ctx, c => { c.moveTo(970, 366); c.lineTo(1010, 346); }, TUNN);
        linje(ctx, c => { c.moveTo(1018, 442); c.lineTo(1046, 428); }, TUNN);
        form(ctx, c => { stav(c, 800, 275, 885, 232, 30); stav(c, 885, 232, 962, 212, 15); }, F.ljusstal);
        linje(ctx, c => { c.moveTo(871, 232); c.lineTo(876, 241); }, TUNN);    // kolvring

        // Skopa med tänder (en enda yta)
        form(ctx, c => {
            c.moveTo(1066, 490);
            c.bezierCurveTo(1130, 478, 1210, 540, 1200, 640);
            c.bezierCurveTo(1196, 682, 1175, 700, 1150, 708);
            c.lineTo(1030, 726);
            c.lineTo(1000, 690);
            c.bezierCurveTo(990, 620, 1020, 540, 1066, 490);
            c.closePath();
            mangel(c, [[1040, 724], [1074, 720], [1054, 752]]);
            mangel(c, [[1082, 718], [1116, 713], [1098, 746]]);
            mangel(c, [[1124, 712], [1152, 708], [1138, 738]]);
        }, F.morkstal);
        linje(ctx, c => {                       // skopans förstärkningsrand
            c.moveTo(1090, 528);
            c.bezierCurveTo(1150, 540, 1172, 600, 1162, 660);
        }, TUNN);
        linje(ctx, c => {
            c.moveTo(1050, 560);
            c.bezierCurveTo(1030, 610, 1030, 650, 1042, 684);
        }, TUNN);
        prick(ctx, 1140, 690, 5);
        prick(ctx, 1070, 702, 5);

        // Leder (bultar)
        prick(ctx, 945, 262, 11);
        prick(ctx, 1078, 518, 11);

        ctx.restore();
    }

    const PICTURES = [
        { namn: 'Traktor', rita: ritaTraktor },
        { namn: 'Grävmaskin', rita: ritaGravmaskin }
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
        rita(lCtx);
        cCtx.setTransform(1, 0, 0, 1, 0, 0);
        cCtx.clearRect(0, 0, PAPER_W, PAPER_H);
        fargLage = true;
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
