document.addEventListener('DOMContentLoaded', () => {
    const viewCanvas = document.getElementById('viewCanvas');
    const vCtx = viewCanvas.getContext('2d');
    const canvasContainer = document.getElementById('canvas-container');

    // Element-referenser — deklarerade först så att funktionerna nedan
    // aldrig kan råka använda dem före deklarationen.
    const startOverlay = document.getElementById('start-overlay');
    const colorBoxes = document.querySelectorAll('.color-box');
    const undoBtn = document.getElementById('undo-btn');
    const clearBtn = document.getElementById('clear-btn');
    const app = document.getElementById('app');

    // Bilden är 1200x900 (landskap). Tre lager:
    //  - lineCanvas: bara de svarta linjerna (genomskinlig bakgrund)
    //  - fillCanvas: färgerna (vit där inget är ifyllt)
    //  - viewCanvas: det som syns — fillCanvas med lineCanvas ovanpå
    // Områdena (ytor omringade av linjer) numreras en gång när bilden
    // laddas (`labels`), så att ett tryck bara behöver slå upp vilket
    // område det träffade.
    const PAPER_W = 1200;
    const PAPER_H = 900;
    const lineCanvas = document.createElement('canvas');
    lineCanvas.width = PAPER_W;
    lineCanvas.height = PAPER_H;
    const lCtx = lineCanvas.getContext('2d', { willReadFrequently: true });
    const fillCanvas = document.createElement('canvas');
    fillCanvas.width = PAPER_W;
    fillCanvas.height = PAPER_H;
    const fCtx = fillCanvas.getContext('2d');
    const fillImage = fCtx.createImageData(PAPER_W, PAPER_H);
    const fillPx = new Uint32Array(fillImage.data.buffer);

    const WHITE = 0xFFFFFFFF;
    // Canvas-pixlar lagras som ABGR (little-endian) i en Uint32Array.
    function colorToInt(hex) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
    }

    let currentColor = colorToInt('#ff3b30');
    let clearState = 0;
    let clearTimer = null;
    const MAX_UNDO = 10;   // Hur många steg bakåt man kan ångra
    const undoStack = [];
    let viewRect = { left: 0, top: 0 };
    // --- Håll-in-logik för systemknappar (ÅNGRA / RENSA) ---
    // Båda kräver att man håller fingret intryckt i HOLD_MS (ca 1 s) för att
    // aktiveras. RENSA har kvar sin tvåstegsbekräftelse: första hållningen
    // visar SÄKER?, andra hållningen tömmer duken. En kort tryckning gör inget
    // — det förhindrar att ett barn råkar rensa/ångra vid missögon.
    const HOLD_MS = 1000;
    // Synka håll-animationens längd i CSS med HOLD_MS (--hold-ms används
    // av .sys-btn.holding i style.css).
    document.documentElement.style.setProperty('--hold-ms', HOLD_MS + 'ms');
    let holdTimer = null;

    function startHold(target) {
        if (holdTimer) clearTimeout(holdTimer);
        holdTimer = setTimeout(() => {
            const btn = target === 'undo' ? undoBtn : clearBtn;
            btn.classList.remove('holding');
            if (target === 'undo') undo();
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
            vCtx.imageSmoothingEnabled = false;
        }
        viewRect = viewCanvas.getBoundingClientRect();
        render();
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
    // Varje bild är en funktion som ritar svarta streck på lineCanvas.
    // Fler bilder läggs till i PICTURES.
    const LW = 9;   // linjebredd (yttre kant av formerna, se form())

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
    function form(ctx, bygg) {
        ctx.beginPath();
        bygg(ctx);
        ctx.lineWidth = LW * 2;
        ctx.stroke();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
    }

    // Ett löst streck (stängs inte till ett område).
    function linje(ctx, bygg) {
        ctx.beginPath();
        bygg(ctx);
        ctx.lineWidth = LW;
        ctx.stroke();
    }

    function ritaTraktor(ctx) {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#000';
        ctx.fillStyle = '#000';

        // Marken: en mjuk kulle tvärs över bilden (himmel ovanför, mark under).
        // Den går bakom traktorn (högt upp) så att glappet under huven
        // hör till marken och inte blir en egen liten yta.
        linje(ctx, c => {
            c.moveTo(-20, 520);
            c.bezierCurveTo(300, 470, 800, 560, 1220, 480);
        });

        // Solen med strålar och ansikte
        form(ctx, c => cirkel(c, 130, 125, 60));
        for (let k = 0; k < 10; k++) {
            const v = k * Math.PI / 5 + 0.15;
            linje(ctx, c => {
                c.moveTo(130 + Math.cos(v) * 85, 125 + Math.sin(v) * 85);
                c.lineTo(130 + Math.cos(v) * 112, 125 + Math.sin(v) * 112);
            });
        }
        ctx.beginPath(); ctx.arc(110, 112, 6, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(150, 112, 6, 0, Math.PI * 2); ctx.fill();
        linje(ctx, c => c.arc(130, 125, 30, 0.25 * Math.PI, 0.75 * Math.PI));

        // Moln
        form(ctx, c => {
            cirkel(c, 655, 140, 34);
            cirkel(c, 712, 112, 46);
            cirkel(c, 770, 136, 38);
            rr(c, 625, 140, 180, 50, 25);
        });

        // Avgasrör med rökpuffar
        form(ctx, c => rr(c, 842, 315, 34, 130, 6));
        form(ctx, c => rr(c, 830, 292, 58, 30, 10));
        form(ctx, c => cirkel(c, 880, 250, 20));
        form(ctx, c => cirkel(c, 925, 203, 27));
        form(ctx, c => cirkel(c, 985, 148, 35));

        // Hytt med tak och fönster (två rutor)
        form(ctx, c => rr(c, 262, 265, 290, 320, 22));
        form(ctx, c => rr(c, 236, 214, 342, 56, 20));
        form(ctx, c => rr(c, 292, 298, 200, 140, 16));
        linje(ctx, c => { c.moveTo(392, 292); c.lineTo(392, 444); });

        // Huv med kylare och strålkastare
        form(ctx, c => rr(c, 515, 420, 475, 155, 30));
        form(ctx, c => rr(c, 918, 448, 52, 100, 10));
        form(ctx, c => cirkel(c, 992, 478, 20));

        // Framhjul: däck, fälg och nav
        form(ctx, c => cirkel(c, 860, 610, 80));
        form(ctx, c => cirkel(c, 860, 610, 50));
        form(ctx, c => cirkel(c, 860, 610, 18));

        // Bakhjul (stort)
        form(ctx, c => cirkel(c, 400, 520, 170));
        form(ctx, c => cirkel(c, 400, 520, 105));
        form(ctx, c => cirkel(c, 400, 520, 38));

        // Två blommor i förgrunden
        [[1090, 745], [150, 790]].forEach(p => {
            linje(ctx, c => { c.moveTo(p[0], p[1] + 24); c.lineTo(p[0], p[1] + 100); });
            form(ctx, c => cirkel(c, p[0], p[1], 24));
        });
    }

    function ritaGravmaskin(ctx) {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#000';
        ctx.fillStyle = '#000';

        // Marken (går bakom maskinen)
        linje(ctx, c => {
            c.moveTo(-20, 565);
            c.bezierCurveTo(300, 525, 700, 605, 1220, 545);
        });

        // Sol (uppe till höger) och två moln
        form(ctx, c => cirkel(c, 1090, 105, 50));
        for (let k = 0; k < 10; k++) {
            const v = k * Math.PI / 5 + 0.15;
            linje(ctx, c => {
                c.moveTo(1090 + Math.cos(v) * 72, 105 + Math.sin(v) * 72);
                c.lineTo(1090 + Math.cos(v) * 98, 105 + Math.sin(v) * 98);
            });
        }
        ctx.beginPath(); ctx.arc(1073, 94, 5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(1107, 94, 5, 0, Math.PI * 2); ctx.fill();
        linje(ctx, c => c.arc(1090, 105, 25, 0.25 * Math.PI, 0.75 * Math.PI));
        form(ctx, c => {
            cirkel(c, 130, 150, 32);
            cirkel(c, 185, 125, 42);
            cirkel(c, 243, 148, 34);
            rr(c, 100, 150, 175, 46, 23);
        });
        form(ctx, c => {
            cirkel(c, 505, 100, 24);
            cirkel(c, 545, 85, 32);
            cirkel(c, 590, 102, 24);
            rr(c, 482, 100, 130, 34, 17);
        });

        // Jordhög till höger (bakom skopan). Underkanten går utanför bilden.
        form(ctx, c => {
            c.moveTo(860, 728);
            c.bezierCurveTo(900, 590, 1010, 520, 1130, 520);
            c.bezierCurveTo(1200, 520, 1245, 620, 1275, 728);
            c.closePath();
        });
        form(ctx, c => cirkel(c, 1140, 600, 15));
        form(ctx, c => cirkel(c, 1195, 660, 12));
        form(ctx, c => cirkel(c, 1085, 690, 11));

        // Underrede: ram och larvband med hjul
        form(ctx, c => rr(c, 300, 550, 400, 55, 10));
        form(ctx, c => rr(c, 225, 590, 550, 125, 62));
        form(ctx, c => cirkel(c, 290, 652, 34));
        form(ctx, c => cirkel(c, 500, 652, 28));
        form(ctx, c => cirkel(c, 710, 652, 34));
        // Larvbandets klackar (korta streck på över- och undersidan)
        for (let x = 270; x <= 730; x += 40) {
            linje(ctx, c => { c.moveTo(x, 592); c.lineTo(x, 606); });
            linje(ctx, c => { c.moveTo(x, 699); c.lineTo(x, 713); });
        }

        // Överdel: plattform, motvikt, motorhuv med avgasrör
        form(ctx, c => rr(c, 270, 520, 445, 52, 10));
        form(ctx, c => rr(c, 430, 362, 26, 80, 6));
        form(ctx, c => rr(c, 422, 345, 42, 24, 8));
        form(ctx, c => rr(c, 210, 395, 190, 177, 48));
        form(ctx, c => rr(c, 385, 430, 175, 142, 16));
        form(ctx, c => rr(c, 410, 465, 125, 14, 7));
        form(ctx, c => rr(c, 410, 495, 125, 14, 7));

        // Hytt med tak, varningslampa, fönster och förare
        form(ctx, c => rr(c, 530, 332, 170, 240, 20));
        form(ctx, c => rr(c, 514, 312, 202, 32, 12));
        form(ctx, c => cirkel(c, 615, 292, 14));
        form(ctx, c => rr(c, 552, 358, 126, 118, 14));
        form(ctx, c => cirkel(c, 615, 422, 26));
        form(ctx, c => c.arc(615, 408, 30, Math.PI, 2 * Math.PI));
        ctx.beginPath(); ctx.arc(605, 424, 4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(626, 424, 4, 0, Math.PI * 2); ctx.fill();
        linje(ctx, c => c.arc(615, 426, 12, 0.2 * Math.PI, 0.8 * Math.PI));

        // Bom (böjd)
        form(ctx, c => mangel(c, [
            [675, 548], [690, 455], [800, 300], [930, 235], [988, 262],
            [962, 312], [868, 362], [805, 470], [772, 552]
        ]));
        // Bomcylinder
        form(ctx, c => stav(c, 740, 530, 795, 425, 28));
        form(ctx, c => stav(c, 795, 425, 835, 350, 14));
        form(ctx, c => cirkel(c, 740, 530, 14));
        form(ctx, c => cirkel(c, 835, 350, 12));

        // Stickan (nedåt till höger) och dess cylinder
        form(ctx, c => { stav(c, 952, 265, 1090, 515, 66); cirkel(c, 952, 265, 40); cirkel(c, 1090, 515, 34); });
        // Stickcylinder: ligger ovanpå bommen, fäst med två fästen
        form(ctx, c => stav(c, 800, 298, 790, 252, 18));
        form(ctx, c => stav(c, 950, 236, 958, 196, 18));
        form(ctx, c => stav(c, 790, 252, 872, 224, 32));
        form(ctx, c => stav(c, 872, 224, 958, 196, 16));
        form(ctx, c => cirkel(c, 790, 252, 12));
        form(ctx, c => cirkel(c, 958, 196, 12));

        // Skopa med tänder
        form(ctx, c => mangel(c, [
            [1070, 488], [1145, 505], [1185, 585], [1168, 665], [1115, 700],
            [1040, 705], [1012, 690], [1030, 640], [1058, 560]
        ]));
        form(ctx, c => mangel(c, [[1008, 688], [1040, 706], [1014, 730]]));
        form(ctx, c => mangel(c, [[1046, 708], [1082, 710], [1064, 735]]));
        form(ctx, c => mangel(c, [[1090, 708], [1125, 698], [1112, 728]]));

        // Leder (bultar)
        form(ctx, c => cirkel(c, 952, 265, 14));
        form(ctx, c => cirkel(c, 1090, 515, 14));
        form(ctx, c => cirkel(c, 690, 470, 14));
    }

    const PICTURES = [
        { namn: 'Traktor', rita: ritaTraktor },
        { namn: 'Grävmaskin', rita: ritaGravmaskin }
    ];
    let currentPicture = 0;

    // --- Områden (numrerade ytor) ---
    // labels[i]: 0 = linje (går inte att färga), >0 = områdets nummer.
    // Pixlar med alpha >= LINE_ALPHA räknas som linje; kantpixlarna under
    // den gränsen färgas så att färgen går hela vägen in under linjens
    // anti-aliasade kant (ingen vit hinna).
    const LINE_ALPHA = 200;
    // Områden mindre än så här (pixlar) är bara kantrester och ignoreras
    // när man träffar en linje och vi letar närmaste riktiga yta.
    const MIN_REGION = 150;
    let labels = new Int32Array(PAPER_W * PAPER_H);
    let regionSize = [0];
    let regionTop = [0];      // översta/nedersta raden för varje område,
    let regionBottom = [0];   // så att ifyllnad bara går igenom dess rader
    let regionInt = new Uint32Array(1);   // nuvarande färg per område

    function labelRegions() {
        const W = PAPER_W, H = PAPER_H;
        const alpha = lCtx.getImageData(0, 0, W, H).data;
        labels.fill(0);
        for (let i = 0, n = W * H; i < n; i++) {
            if (alpha[i * 4 + 3] < LINE_ALPHA) labels[i] = -1;   // ofärgad, ej besökt
        }
        regionSize = [0];
        regionTop = [0];
        regionBottom = [0];
        let id = 0;
        for (let seed = 0, n = W * H; seed < n; seed++) {
            if (labels[seed] !== -1) continue;
            id++;
            floodLabel(seed, id);
        }
        regionInt = new Uint32Array(id + 1).fill(WHITE);
    }

    // Scanline-fyllning som numrerar ett sammanhängande område (4-grannar).
    function floodLabel(seed, id) {
        const W = PAPER_W, H = PAPER_H;
        const stack = [seed];
        let count = 0, top = H, bottom = 0;
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
    }

    // Varje bild minns sina färger och sin ångra-historik medan appen är
    // öppen, så man kan bläddra fram och tillbaka utan att förlora något.
    // Bara färgtabellen sparas (ytorna numreras likadant varje gång).
    const pictureState = [];
    let pictureLoaded = false;

    function loadPicture(index) {
        if (pictureLoaded) {
            pictureState[currentPicture] = { regionInt: regionInt, undo: undoStack.slice() };
        }
        pictureLoaded = true;
        currentPicture = index;
        lCtx.setTransform(1, 0, 0, 1, 0, 0);
        lCtx.clearRect(0, 0, PAPER_W, PAPER_H);
        PICTURES[index].rita(lCtx);
        labelRegions();
        undoStack.length = 0;
        const saved = pictureState[index];
        if (saved && saved.regionInt.length === regionInt.length) {
            regionInt = saved.regionInt;
            saved.undo.forEach(u => undoStack.push(u));
            paintAll();
        } else {
            fillPx.fill(WHITE);
            fCtx.putImageData(fillImage, 0, 0);
        }
        updateUndoState();
        resetClearButton();
        render();
    }

    function changePicture(step) {
        loadPicture((currentPicture + step + PICTURES.length) % PICTURES.length);
    }

    // Målar om ett enda område (snabbt: bara dess rader).
    function paintRegion(id) {
        const W = PAPER_W;
        const c = regionInt[id];
        const y0 = regionTop[id], y1 = regionBottom[id];
        for (let i = y0 * W, end = (y1 + 1) * W; i < end; i++) {
            if (labels[i] === id) fillPx[i] = c;
        }
        fCtx.putImageData(fillImage, 0, 0, 0, y0, W, y1 - y0 + 1);
    }

    // Målar om hela bilden (efter ångra / rensa).
    function paintAll() {
        for (let i = 0, n = labels.length; i < n; i++) {
            const l = labels[i];
            fillPx[i] = l > 0 ? regionInt[l] : WHITE;
        }
        fCtx.putImageData(fillImage, 0, 0);
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

    function render() {
        const W = viewCanvas.width, H = viewCanvas.height;
        if (W === 0 || H === 0) return;
        updateTransform();
        vCtx.setTransform(1, 0, 0, 1, 0, 0);
        vCtx.fillStyle = '#ffffff';
        vCtx.fillRect(0, 0, W, H);
        vCtx.setTransform(xf.a, xf.b, xf.c, xf.d, xf.e, xf.f);
        vCtx.drawImage(fillCanvas, 0, 0);
        vCtx.drawImage(lineCanvas, 0, 0);
        vCtx.setTransform(1, 0, 0, 1, 0, 0);
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

    // --- Tryck = färglägg området ---
    // Hittar området vid (px, py). Träffas en linje (barn träffar sällan
    // exakt) letar vi efter närmaste riktiga yta inom några pixlar.
    const SNAP_RADIUS = 16;
    function regionAt(px, py) {
        const W = PAPER_W, H = PAPER_H;
        const x0 = Math.round(px), y0 = Math.round(py);
        if (x0 < 0 || y0 < 0 || x0 >= W || y0 >= H) return 0;
        const direct = labels[y0 * W + x0];
        if (direct > 0 && regionSize[direct] >= MIN_REGION) return direct;
        let best = 0, bestD = SNAP_RADIUS * SNAP_RADIUS + 1;
        for (let y = Math.max(0, y0 - SNAP_RADIUS); y <= Math.min(H - 1, y0 + SNAP_RADIUS); y++) {
            for (let x = Math.max(0, x0 - SNAP_RADIUS); x <= Math.min(W - 1, x0 + SNAP_RADIUS); x++) {
                const l = labels[y * W + x];
                if (l <= 0 || regionSize[l] < MIN_REGION) continue;
                const d = (x - x0) * (x - x0) + (y - y0) * (y - y0);
                if (d < bestD) { bestD = d; best = l; }
            }
        }
        return best;
    }

    function fillAt(clientX, clientY) {
        const p = getPaperCoords(clientX, clientY);
        const id = regionAt(p.x, p.y);
        if (id === 0 || regionInt[id] === currentColor) return;
        pushUndo();
        regionInt[id] = currentColor;
        paintRegion(id);
        render();
        resetClearButton();
    }

    // Ett tryck räknas bara om fingret knappt rör sig och lyfts snabbt —
    // en vilande hand eller ett glidande finger färgar ingenting.
    const TAP_MAX_MOVE = 24;   // skärm-px
    const TAP_MAX_MS = 700;
    const taps = new Map();

    function onTouchStart(e) {
        if (e.cancelable) e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i];
            taps.set(t.identifier, { x: t.clientX, y: t.clientY, t: Date.now(), moved: false });
        }
    }

    function onTouchMove(e) {
        if (e.cancelable) e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i];
            const tap = taps.get(t.identifier);
            if (!tap) continue;
            const dx = t.clientX - tap.x, dy = t.clientY - tap.y;
            if (dx * dx + dy * dy > TAP_MAX_MOVE * TAP_MAX_MOVE) tap.moved = true;
        }
    }

    function onTouchEnd(e) {
        for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i];
            const tap = taps.get(t.identifier);
            if (!tap) continue;
            taps.delete(t.identifier);
            if (!tap.moved && Date.now() - tap.t <= TAP_MAX_MS) fillAt(tap.x, tap.y);
        }
    }

    function onTouchCancel(e) {
        for (let i = 0; i < e.changedTouches.length; i++) taps.delete(e.changedTouches[i].identifier);
    }

    function selectColor(hex, element) {
        currentColor = colorToInt(hex);
        colorBoxes.forEach(box => box.classList.remove('selected'));
        element.classList.add('selected');
        resetClearButton();
    }

    // RENSA — tvåstegs med hållning: första hållningen (1 s) visar "SÄKER?"
    // (röd, 5 s timeout / nollställs vid nytt tryck), andra hållningen
    // (1 s) tömmer bilden på färg.
    function handleClear() {
        if (clearState === 0) {
            clearState = 1;
            clearBtn.textContent = 'SÄKER?';
            clearBtn.classList.add('confirm');
            clearTimer = setTimeout(resetClearButton, 5000);
        } else {
            pushUndo();
            regionInt.fill(WHITE);
            paintAll();
            render();
            resetClearButton();
        }
    }

    function resetClearButton() {
        clearState = 0;
        if (clearTimer) {
            clearTimeout(clearTimer);
            clearTimer = null;
        }
        if (clearBtn) {
            clearBtn.textContent = 'RENSA';
            clearBtn.classList.remove('confirm');
        }
    }

    // Ångra-historiken sparar bara områdenas färger (liten lista), inte pixlar.
    function pushUndo() {
        undoStack.push(regionInt.slice());
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        updateUndoState();
    }

    function undo() {
        if (undoStack.length === 0) return;
        regionInt = undoStack.pop();
        paintAll();
        render();
        resetClearButton();
        updateUndoState();
    }

    function updateUndoState() {
        if (undoBtn) undoBtn.disabled = (undoStack.length === 0);
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
    // och när fullscreen tappats, och BÖRJA FÄRGA-knappen (en äkta gest) tar
    // tillbaka in i fullscreen. Ritningen på papperet påverkas inte.
    function showStartOverlay() {
        startOverlay.style.display = 'flex';
        resetClearButton();
    }

    // --- Händelsebindningar (tidigare inline i HTML) ---
    document.getElementById('start-btn').addEventListener('click', startApp);

    colorBoxes.forEach(box => {
        // Click för mus, touchstart för multi-touch under ritning
        box.addEventListener('click', function() {
            const color = this.getAttribute('data-color');
            selectColor(color, this);
        });
        box.addEventListener('touchstart', function(e) {
            e.preventDefault();  // Förhindra ghost clicks (simulerade mus-event)
            e.stopPropagation(); // Hindra canvas touch-hantering
            const color = this.getAttribute('data-color');
            selectColor(color, this);
        }, { passive: false });
    });

    // Bläddra mellan bilder. Som färgrutorna: touchstart (med stopPropagation)
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

    // Systemknappar (undo, clear) — håll in HOLD_MS (1 s) för att aktivera.
    // RENSA har tvåstegs: första hållningen visar SÄKER?, andra hållningen
    // tömmer duken. Touchstart på knapparna stopPropagates så de inte startar
    // ett streck; click finns kvar för mus/test på dator (håll via mousedown).
    function holdStart(target) {
        const btn = (target === 'undo') ? undoBtn : clearBtn;
        if (btn.disabled) return;
        startHold(target);
        btn.classList.add('holding');
    }
    function holdEnd() {
        endHold();
        undoBtn.classList.remove('holding');
        clearBtn.classList.remove('holding');
    }

    undoBtn.addEventListener('touchstart', function(e) {
        e.stopPropagation();
        holdStart('undo');
        e.preventDefault();
    }, { passive: false });
    clearBtn.addEventListener('touchstart', function(e) {
        e.stopPropagation();
        holdStart('clear');
        e.preventDefault();
    }, { passive: false });

    // Touch-hållning avbryts om fingret glider utanför knappen (samma som
    // mouseleave för mus). Touch-event riktas alltid till elementet där
    // touchen startade, så touchmove på knappen räcker för en bounds-check.
    function holdTouchMove(e) {
        const t = e.changedTouches[0];
        const r = this.getBoundingClientRect();
        if (t.clientX < r.left || t.clientX > r.right ||
            t.clientY < r.top || t.clientY > r.bottom) {
            holdEnd();
        }
    }
    undoBtn.addEventListener('touchmove', holdTouchMove, { passive: true });
    clearBtn.addEventListener('touchmove', holdTouchMove, { passive: true });

    // touchend/cancel på hela fönstret stänger hållningen (fingret lyfts)
    window.addEventListener('touchend', holdEnd, { passive: true });
    window.addEventListener('touchcancel', holdEnd, { passive: true });

    // Mus: mousedown startar hållningen (bara vänster knapp — höger- och
    // mittklick ignoreras), mouseup/mouseleave avslutar
    undoBtn.addEventListener('mousedown', function(e) {
        if (e.button !== 0) return;
        e.stopPropagation();
        holdStart('undo');
    });
    clearBtn.addEventListener('mousedown', function(e) {
        if (e.button !== 0) return;
        e.stopPropagation();
        holdStart('clear');
    });
    window.addEventListener('mouseup', holdEnd);
    undoBtn.addEventListener('mouseleave', holdEnd);
    clearBtn.addEventListener('mouseleave', holdEnd);

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

    // Mus (test på dator): ett klick färgar. På touch-enheter ger
    // preventDefault i touchstart inget klick, så det blir inte dubbelt.
    viewCanvas.addEventListener('click', e => fillAt(e.clientX, e.clientY));

    viewCanvas.addEventListener('touchstart', onTouchStart, { passive: false });
    viewCanvas.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchCancel, { passive: true });

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
