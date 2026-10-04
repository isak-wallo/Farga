"""Gör om konturlagren i bilder/*.png till vektorer (bilder/*.svg).

Användning: python3 verktyg/vektor.py   (efter verktyg/linjer.py)
Spårar linjerna med potrace (pip install potracer) till en enda SVG-bana.
SVG:n blir ungefär en fjärdedel så stor som PNG:n att ladda ner (GitHub
Pages skickar den gzippad) och skarp i alla storlekar.
"""
import os, gzip, time
import numpy as np, potrace
from PIL import Image
BILDER=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),'bilder')
for namn in ['traktor-verklig','gravmaskin-verklig']:
    a=np.asarray(Image.open(os.path.join(BILDER,namn+'.png')))[...,3]
    t=time.time()
    bm=potrace.Bitmap(a<=127)
    plist=bm.trace(turdsize=4, alphamax=1.0, opticurve=True, opttolerance=0.4)
    d=[]
    for curve in plist:
        f=curve.start_point; d.append(f"M{f.x:.0f} {f.y:.0f}")
        for seg in curve.segments:
            if seg.is_corner:
                d.append(f"L{seg.c.x:.0f} {seg.c.y:.0f}L{seg.end_point.x:.0f} {seg.end_point.y:.0f}")
            else:
                d.append(f"C{seg.c1.x:.0f} {seg.c1.y:.0f} {seg.c2.x:.0f} {seg.c2.y:.0f} {seg.end_point.x:.0f} {seg.end_point.y:.0f}")
        d.append("Z")
    svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900"><path fill="#3a3a44" fill-rule="evenodd" d="{"".join(d)}"/></svg>'
    open(os.path.join(BILDER,namn+'.svg'),'w').write(svg)
    png=open(os.path.join(BILDER,namn+'.png'),'rb').read()
    print(namn, 'png', len(png), 'png-gzip', len(gzip.compress(png)), 'svg', len(svg), 'svg-gzip', len(gzip.compress(svg.encode())), f'{time.time()-t:.0f}s')
