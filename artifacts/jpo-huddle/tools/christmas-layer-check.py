#!/usr/bin/env python3
"""Regression check: Christmas sheets avoid skin and inferred head rows, and are wired
as bakeLayer (not head stickers) in public/index.html."""
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util
_sp = importlib.util.spec_from_file_location('g', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'christmas-layer-gen.py')); G = importlib.util.module_from_spec(_sp); _sp.loader.exec_module(G)
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', 'public')
L = os.path.join(ROOT, 'assets', 'layers')
IDS = ['christmassweater', 'elfoutfit', 'christmasscarf']
FW = {'run': 16, 'sit3': 16, 'sit': 32, 'sit2': 32}
fail = []
for ch in ['Adam', 'Alex', 'Amelia', 'Bob']:
    for s, fw in FW.items():
        B = Image.open(f'{ROOT}/assets/{ch}_{s}_16x16.png').convert('RGBA').load()
        K = Image.open(f'{L}/{ch}_{s}_skin.png').convert('RGBA').load()
        P = Image.open(f'{L}/{ch}_{s}_pants.png').convert('RGBA').load()
        G._HAIR[0] = Image.open(f'{L}/{ch}_{s}_hair.png').convert('RGBA').load()
        for wid in IDS:
            p = f'{L}/{ch}_{s}_wear_{wid}.png'
            if not os.path.exists(p):
                fail.append(f'missing {p}'); continue
            im = Image.open(p).convert('RGBA'); w, h = im.size; o = im.load()
            n = 0
            for f in range(w // fw):
                _, chin, _ = G.torso_rows(B, K, P, f*fw, (f+1)*fw, h)
                chin = h if chin is None else chin
                for x in range(f*fw, (f+1)*fw):
                    for y in range(h):
                        if o[x, y][3] == 0: continue
                        n += 1
                        if wid != 'christmasscarf':
                            if K[x, y][3] >= 128: fail.append(f'{p} paints skin @{x},{y}')
                            if y <= chin: fail.append(f'{p} paints above shoulder (face) @{x},{y}')
                if wid == 'elfoutfit':
                    for x in range(f*fw,(f+1)*fw):
                        for y in range(chin+1,h):
                            if P[x,y][3] and not K[x,y][3] and B[x,y][3] and not o[x,y][3]:
                                fail.append(f'{p} leaves pants uncovered @{x},{y}')
            if n < (w // fw) * 4: fail.append(f'{p} nearly empty ({n}px)')
html = open(os.path.join(ROOT, 'index.html')).read()
m = re.search(r'const _WEAR_BAKE_ANCHOR = \{(.*?)\};', html, re.S)
for wid in IDS:
    if m and re.search(rf'\b{wid}\s*:', m.group(1)): fail.append(f'{wid} still a head-anchor sticker')
    if f"'{wid}'" not in html.split('_WEAR_NO_STICKER = new Set(')[-1].split(')')[0]: fail.append(f'{wid} not bakeLayer')
if '_WEAR_NO_STICKER' not in html: fail.append('no-sticker readiness guard missing')
print('\n'.join(fail[:40]) or 'christmas layer check: PASS')
sys.exit(1 if fail else 0)
