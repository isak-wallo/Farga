"""Gör om förlagor (målarbokssidor) till konturlager för Färga.

Användning: python3 verktyg/linjer.py GRAVMASKIN.png TRAKTOR.png
Skriver bilder/gravmaskin-verklig.png och bilder/traktor-verklig.png
(1200x900, genomskinliga med mörkgrå linjer) samt förhandsvisningar med
rutnät (*-rut.png i aktuell mapp) att rita färgkartan efter.
Kräver Pillow, numpy och scipy.
"""
import os, sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as nd
UT=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),'bilder')+'/'
GRAV, TRAK = sys.argv[1], sys.argv[2]
LINJE=(0x3a,0x3a,0x44)
def gray(f): return np.asarray(Image.open(f).convert('L')).astype(float)

def spara(alpha, crop, namn):
    x0,y0,x1,y1=crop
    a=Image.fromarray(alpha.astype(np.uint8)).crop(crop).resize((1200,900), Image.LANCZOS)
    a=np.asarray(a).astype(float)
    # skärp kanten lite efter skalningen så linjerna förblir slutna
    a=np.clip((a-40)*1.6,0,255).astype(np.uint8)
    rgba=np.zeros((900,1200,4),np.uint8); rgba[...,0],rgba[...,1],rgba[...,2]=LINJE; rgba[...,3]=a
    Image.fromarray(rgba).save(UT+namn+'.png', optimize=True)
    # förhandsvisning med rutnät
    v=Image.new('RGB',(1200,900),'white'); v.paste(Image.fromarray(rgba),(0,0),Image.fromarray(rgba))
    d=ImageDraw.Draw(v)
    for x in range(0,1200,50):
        d.line([(x,0),(x,900)],fill=(255,150,150) if x%100==0 else (255,215,215))
        if x%100==0: d.text((x+2,2),str(x),fill=(200,0,0))
    for y in range(0,900,50):
        d.line([(0,y),(1200,y)],fill=(150,150,255) if y%100==0 else (215,215,255))
        if y%100==0: d.text((2,y+2),str(y),fill=(0,0,200))
    v.save(namn+'-rut.png')

# Grävmaskin (blyertsskiss på papper)
def smaborta(mask, minsta):
    lab,n=nd.label(mask,structure=np.ones((3,3)))
    sz=nd.sum(mask,lab,range(1,n+1))
    return mask & ~np.isin(lab,np.where(sz<minsta)[0]+1)
g=gray(GRAV)
bg=nd.gaussian_filter(nd.maximum_filter(g,15),8)
d=np.clip(bg-g,0,255)
d[:, :107]=0; d[:, 916:]=0; d[:107,:]=0; d[916:,:]=0      # ramen och pappret utanför
# Maskinen: bara de tjocka konturstrecken (öppning tar bort tunn skuggning
# och prickar), i sin ursprungliga form.
mask=d>70
stark=nd.binary_opening(mask,structure=np.ones((3,3)))
maskinlinjer=smaborta(nd.binary_dilation(stark,iterations=2) & mask, 150)
# Bakgrunden (kullar, träd, buskar) är tunnare streck: ta de längre strecken
# utanför maskinens område.
maskin=nd.binary_fill_holes(nd.binary_closing(nd.binary_dilation(maskinlinjer,iterations=4),structure=np.ones((25,25))))
maskin=nd.binary_dilation(maskin,iterations=3)
linjer=maskinlinjer | (smaborta(d>85,200) & ~maskin)
alpha=np.clip((d-45)*8,0,255); alpha[~nd.binary_dilation(linjer,iterations=1)]=0
spara(alpha,(69,145,956,810),'gravmaskin-verklig')

# Traktor (ren linjekonst)
g=gray(TRAK)
alpha=np.clip((215-g)*2.6,0,255)
mask=alpha>200
lab,n=nd.label(mask,structure=np.ones((3,3)))
sz=nd.sum(mask,lab,range(1,n+1))
alpha[np.isin(lab,np.where(sz<12)[0]+1)]=0
spara(alpha,(80,190,944,838),'traktor-verklig')
