"""Gör om förlagor (målarbokssidor) till konturlager för Färga.

Användning:  python3 verktyg/linjer.py namn=FÖRLAGA.png [namn=FÖRLAGA.png ...]
t.ex.        python3 verktyg/linjer.py traktor-verklig=traktor.png

Varje namn måste finnas i BILDER nedan (beskärning m.m.). Skriver
bilder/NAMN.png (1200x900, genomskinlig med mörkgrå linjer) och en
förhandsvisning med rutnät (NAMN-rut.png i aktuell mapp) att rita
färgkartan efter. Kör sedan verktyg/vektor.py för att få SVG:erna.
Kräver Pillow, numpy och scipy.
"""
import os, sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as nd

UT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'bilder') + '/'
LINJE = (0x3a, 0x3a, 0x44)

# namn: (typ, beskärning (x0, y0, x1, y1) i förlagan, himmel att lägga till ovanför i px)
# typ 'ren' = ren linjeteckning, 'blyerts' = blyertsskiss på papper,
# 'skarp' = ren och skarp linjeteckning i hög upplösning: sparas i full
# upplösning (vektor.py skalar ner banorna) så kurvorna blir mjuka.
# Beskärningen ska vara ungefär 4:3 efter att himlen lagts till.
BILDER = {
    'traktor-verklig':      ('ren', (80, 190, 944, 838), 0),
    # (gravmaskin-verklig är numera omritad för hand i app.js, ritaGravmaskinRen)
    'gravmaskin-verklig':   ('blyerts', (69, 145, 956, 810), 0),
    'flygplan-litet':       ('ren', (0, 258, 784, 846), 0),
    'helikopter-stig':      ('ren', (0, 330, 784, 918), 0),
    'helikopter-luft':      ('ren', (44, 26, 1211, 642), 266),
    'flygplan-falt':        ('ren', (0, 516, 1024, 1022), 307),
    # Gemini-sidor i samma stil: traktor, grävmaskin, flygplan, helikopter
    'traktor':              ('skarp', (0, 0, 2000, 1493), 0),
    'gravmaskin':           ('skarp', (0, 0, 2000, 1493), 0),
    'flygplan':             ('skarp', (0, 0, 2000, 1493), 0),
    'helikopter':           ('skarp', (0, 0, 1200, 896), 0),
    'traktor-snett':        ('skarp', (0, 0, 1200, 896), 0),
}

# Tillagda streck (i 1200x900-koordinater) som stänger glapp i förlagan,
# t.ex. mellan bakskärmens spets och däcket så att ytan under skärmen blir
# en egen yta i stället för en del av kullen.
TILLAGG = {
    'traktor': [[(185, 491), (214, 503)]],
}


def gray(f):
    return np.asarray(Image.open(f).convert('L')).astype(float)


def smaborta(mask, minsta):
    lab, n = nd.label(mask, structure=np.ones((3, 3)))
    sz = nd.sum(mask, lab, range(1, n + 1))
    return mask & ~np.isin(lab, np.where(sz < minsta)[0] + 1)


def ren(f):
    """Ren linjeteckning: mörka pixlar blir linjer, små prickar tas bort."""
    g = gray(f)
    alpha = np.clip((215 - g) * 2.6, 0, 255)
    alpha[~smaborta(alpha > 200, 12) & (alpha > 200)] = 0
    return alpha


def skarp(f):
    """Skarp linjeteckning (t.ex. Gemini): jämna ut JPEG-bruset lite och
    tröskla mitt i kanten, så linjerna får sin verkliga bredd."""
    g = nd.gaussian_filter(gray(f), 1.0)
    mask = smaborta(g < 140, 30)
    return mask * 255.0


def blyerts(f):
    """Blyertsskiss: normalisera mot pappret, behåll bara tjocka konturstreck
    på maskinen (öppning tar bort tunn skuggning och prickar) och de längre
    strecken i bakgrunden. Ramen tas bort."""
    g = gray(f)
    bg = nd.gaussian_filter(nd.maximum_filter(g, 15), 8)
    d = np.clip(bg - g, 0, 255)
    d[:, :107] = 0; d[:, 916:] = 0; d[:107, :] = 0; d[916:, :] = 0
    mask = d > 70
    stark = nd.binary_opening(mask, structure=np.ones((3, 3)))
    maskinlinjer = smaborta(nd.binary_dilation(stark, iterations=2) & mask, 150)
    maskin = nd.binary_fill_holes(nd.binary_closing(nd.binary_dilation(maskinlinjer, iterations=4),
                                                    structure=np.ones((25, 25))))
    maskin = nd.binary_dilation(maskin, iterations=3)
    linjer = maskinlinjer | (smaborta(d > 85, 200) & ~maskin)
    alpha = np.clip((d - 45) * 8, 0, 255)
    alpha[~nd.binary_dilation(linjer, iterations=1)] = 0
    return alpha


def spara(alpha, crop, himmel, namn, hog=False):
    x0, y0, x1, y1 = crop
    a = Image.fromarray(alpha.astype(np.uint8)).crop(crop)
    if hog:
        # full upplösning, bara bredden 4:3 mot 1200x900 (vektor.py skalar)
        b = x1 - x0
        duk = Image.new('L', (b, round(b * 0.75)), 0)
        duk.paste(a, (0, round(himmel * b / 1200)))
        rgba = np.zeros((duk.height, b, 4), np.uint8)
        rgba[..., 0], rgba[..., 1], rgba[..., 2] = LINJE
        rgba[..., 3] = np.asarray(duk)
        Image.fromarray(rgba).save(UT + namn + '.png', optimize=True)
        alpha_liten = Image.fromarray(rgba).resize((1200, 900), Image.LANCZOS)
        rgba = np.asarray(alpha_liten)
        rutnat(rgba, namn)
        return
    s = 1200 / (x1 - x0)
    h = round((y1 - y0) * s)
    a = a.resize((1200, h), Image.LANCZOS)
    duk = Image.new('L', (1200, 900), 0)
    duk.paste(a, (0, round(himmel)))
    a = np.asarray(duk).astype(float)
    # skärp kanten lite efter skalningen så linjerna förblir slutna
    a = np.clip((a - 40) * 1.6, 0, 255).astype(np.uint8)
    rgba = np.zeros((900, 1200, 4), np.uint8)
    rgba[..., 0], rgba[..., 1], rgba[..., 2] = LINJE
    rgba[..., 3] = a
    Image.fromarray(rgba).save(UT + namn + '.png', optimize=True)
    rutnat(rgba, namn)


def rutnat(rgba, namn):
    """Förhandsvisning med rutnät (1200x900) att rita färgkartan efter."""
    v = Image.new('RGB', (1200, 900), 'white')
    v.paste(Image.fromarray(rgba), (0, 0), Image.fromarray(rgba))
    d = ImageDraw.Draw(v)
    for x in range(0, 1200, 50):
        d.line([(x, 0), (x, 900)], fill=(255, 150, 150) if x % 100 == 0 else (255, 215, 215))
        if x % 100 == 0: d.text((x + 2, 2), str(x), fill=(200, 0, 0))
    for y in range(0, 900, 50):
        d.line([(0, y), (1200, y)], fill=(150, 150, 255) if y % 100 == 0 else (215, 215, 255))
        if y % 100 == 0: d.text((2, y + 2), str(y), fill=(0, 0, 200))
    v.save(namn + '-rut.png')


for arg in sys.argv[1:]:
    namn, fil = arg.split('=', 1)
    typ, crop, himmel = BILDER[namn]
    alpha = {'blyerts': blyerts, 'skarp': skarp}.get(typ, ren)(fil)
    if namn in TILLAGG:
        k = (crop[2] - crop[0]) / 1200
        duk = Image.fromarray(alpha.astype(np.uint8))
        d = ImageDraw.Draw(duk)
        for streck in TILLAGG[namn]:
            pts = [(crop[0] + x * k, crop[1] + y * k) for x, y in streck]
            d.line(pts, fill=255, width=round(6.5 * k), joint='curve')
            for x, y in pts:
                r = 3.25 * k
                d.ellipse((x - r, y - r, x + r, y + r), fill=255)
        alpha = np.asarray(duk).astype(float)
    spara(alpha, crop, himmel, namn, hog=(typ == 'skarp'))
    print('skrev', namn)
