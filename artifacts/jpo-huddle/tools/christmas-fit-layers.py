"""Fit Christmas art to native silhouettes, with padded, unclipped headwear.

Run from any directory: python artifacts/jpo-huddle/tools/christmas-fit-layers.py
"""
from pathlib import Path
import json
import runpy
from PIL import Image

ASSETS = Path(__file__).resolve().parents[1] / 'public/assets'
LAYERS = ASSETS / 'layers'
anchors = json.loads((LAYERS / 'anchors.json').read_text())
GREEN, RED, WHITE, GOLD, BELT = (
    (46,122,78,255), (196,40,52,255), (246,240,228,255),
    (236,190,84,255), (92,58,36,255))

for char in ('Adam','Alex','Amelia','Bob'):
    for suffix in ('run','sit','sit2','sit3'):
        base = Image.open(ASSETS / f'{char}_{suffix}_16x16.png').convert('RGBA')
        layers = {part: Image.open(LAYERS / f'{char}_{suffix}_{part}.png').convert('RGBA')
                  for part in ('shirt','pants','hair','skin')}
        fw = 16 if suffix in ('run','sit3') else 32
        count = base.width // fw
        outputs = {item: Image.new('RGBA',base.size) for item in
                   ('christmassweater','elfoutfit','christmasscarf')}
        hats = {item: Image.new('RGBA',(40*count,48)) for item in ('santahat','reindeerantlers')}
        for f in range(count):
            # Seated source halves face opposite directions regardless of chair labels.
            direction = ('right','up','left','down')[f//6] if suffix=='run' else ('right' if f<6 else 'left')
            a = anchors[char.lower()][suffix][f]
            for item,out in hats.items():
                source = Image.open(ASSETS/f'wear_{item}.png')
                artf = 1 if direction in ('right','left') else 2 if direction=='up' else 0
                art = source.crop((artf*16,0,(artf+1)*16,13))
                if direction=='left': art=art.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
                # 8px vertical padding keeps the tall hat intact on raised seated heads.
                out.alpha_composite(art,(f*40+(40-fw)//2+round(a['hx'])-8,8+a['hy']-10))
            pts=[(x,y) for x in range(f*fw,(f+1)*fw) for y in range(32)
                 if layers['shirt'].getpixel((x,y))[3]]
            # Long back hair can hide the entire shirt (Amelia). Use the
            # waist to locate the neckline, still masking out all hair below.
            if not pts:
                pts=[(x,max(0,y-3)) for x in range(f*fw,(f+1)*fw) for y in range(32)
                     if layers['pants'].getpixel((x,y))[3]]
            # Some seated Amelia sheets classify pink plaid as skin. Recover
            # only the torso band using actual face colors to protect her hands.
            face_colors={base.getpixel((x,y)) for x in range(f*fw,(f+1)*fw)
                         for y in range(a['hy'],min(32,a['hy']+15))
                         if layers['skin'].getpixel((x,y))[3]}
            def protected_skin(x,y):
                return (layers['skin'].getpixel((x,y))[3] and
                        (char!='Amelia' or base.getpixel((x,y)) in face_colors))
            if not pts:
                pts=[(x,y) for x in range(f*fw,(f+1)*fw)
                     for y in range(a['hy']+15,a['fy']-2)
                     if base.getpixel((x,y))[3] and not layers['hair'].getpixel((x,y))[3]
                     and not protected_skin(x,y)]
            if not pts: raise ValueError(f'Missing garment silhouette: {char}/{suffix}/{f}')
            # All native bodies use the same short torso above the last three
            # shoe/leg rows. Layer bounds alone can include lap or miss plaid.
            top=a['fy']-7; bottom=a['fy']-3
            torso=[(x,y) for x in range(f*fw,(f+1)*fw) for y in range(top,bottom+1)
                   if base.getpixel((x,y))[3] and not layers['hair'].getpixel((x,y))[3]
                   and not protected_skin(x,y)]
            if not torso: continue  # legitimately hidden under long back hair
            left=min(x for x,y in torso); right=max(x for x,y in torso)
            mid=(left+right)//2
            for x in range(left,right+1):
                for y in range(top,bottom+1):
                    rgba=base.getpixel((x,y))
                    # Include garment outlines but never repaint face, hands or hair.
                    if not rgba[3] or layers['hair'].getpixel((x,y))[3] or protected_skin(x,y):
                        continue
                    for item in ('christmassweater','elfoutfit'):
                        color=GREEN
                        if item=='christmassweater':
                            if y==top or y==bottom: color=RED
                            elif y==top+2: color=WHITE if (x-left)%2 else RED
                            elif x==mid and y==top+3 and direction!='up': color=GOLD
                        else:
                            if y==top: color=RED
                            if y==bottom-1: color=GOLD if x==mid and direction!='up' else BELT
                        # Keep only genuinely dark outline pixels dark.
                        shade=.55 if max(rgba[:3])<75 else 1
                        outputs[item].putpixel((x,y),tuple(round(v*shade) for v in color[:3])+(255,))
            # Scarf collar sits at the garment neckline, not at the head anchor.
            # Trim it to opaque body pixels; don't paint flowing hair.
            for x in range(left,right+1):
                for y in range(max(0,top-1),min(32,top+2)):
                    if base.getpixel((x,y))[3] and not layers['hair'].getpixel((x,y))[3]:
                        outputs['christmasscarf'].putpixel((x,y),WHITE if y==top else RED)
            tailx=left if direction=='right' else right-1 if direction=='left' else mid+1
            for x in range(tailx,min(right+1,tailx+2)):
                for y in range(top+2,min(32,top+5)):
                    if base.getpixel((x,y))[3] and not layers['hair'].getpixel((x,y))[3] and not protected_skin(x,y):
                        outputs['christmasscarf'].putpixel((x,y),WHITE if y==top+3 else RED)
        # Clothing now has one authoritative generator shared with its pixel
        # regression check. Only persist padded headwear from this fitter.
        for item,out in hats.items():
            out.save(LAYERS/f'{char}_{suffix}_wear_{item}.png')
runpy.run_path(str(Path(__file__).with_name('christmas-layer-gen.py')), run_name='__main__')
print('Christmas layers: all four characters, all four sheets')
