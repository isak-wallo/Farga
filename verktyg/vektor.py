"""Gör om konturlagren i bilder/*.png till vektorer (bilder/*.svg).

Användning: python3 verktyg/vektor.py   (efter verktyg/linjer.py; tar alla bilder/*.png)
Spårar linjerna med potrace (pip install potracer) till en enda SVG-bana.
SVG:n blir ungefär en fjärdedel så stor som PNG:n att ladda ner (GitHub
Pages skickar den gzippad) och skarp i alla storlekar.
"""
import os, gzip, time
import numpy as np, potrace
from PIL import Image
BILDER=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),'bilder')
import glob
for namn in sorted(os.path.basename(f)[:-4] for f in glob.glob(os.path.join(BILDER,'*.png'))):
    a=np.asarray(Image.open(os.path.join(BILDER,namn+'.png')))[...,3]
    # PNG:er i högre upplösning (typ 'skarp') skalas ner till 1200 px bredd
    k=1200/a.shape[1]
    def p(q): return f"{q.x*k:.1f} {q.y*k:.1f}".replace('.0 ',' ') if k!=1 else f"{q.x:.0f} {q.y:.0f}"
    t=time.time()
    bm=potrace.Bitmap(a<=127)
    plist=bm.trace(turdsize=4, alphamax=1.0, opticurve=True, opttolerance=0.4)
    d=[]
    for curve in plist:
        d.append(f"M{p(curve.start_point)}")
        for seg in curve.segments:
            if seg.is_corner:
                d.append(f"L{p(seg.c)}L{p(seg.end_point)}")
            else:
                d.append(f"C{p(seg.c1)} {p(seg.c2)} {p(seg.end_point)}")
        d.append("Z")
    svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900"><path fill="#3a3a44" fill-rule="evenodd" d="{"".join(d)}"/></svg>'
    open(os.path.join(BILDER,namn+'.svg'),'w').write(svg)
    png=open(os.path.join(BILDER,namn+'.png'),'rb').read()
    print(namn, 'png', len(png), 'png-gzip', len(gzip.compress(png)), 'svg', len(svg), 'svg-gzip', len(gzip.compress(svg.encode())), f'{time.time()-t:.0f}s')
