#!/usr/bin/env python3
"""Christmas clothing LAYER sheets (sweater / elf outfit / Santa beard).

Same layer-sheet contract as the raincoat, with per-frame body geometry
derived from the native sprite and skin/pants/hair masks. Split clothing
masks are incomplete on some seated sheets, so they are not the sole source.
Rules enforced by tools/christmas-layer-check.py:
  * never paint skin pixels or above the inferred chin/head boundary
  * preserve head and predominantly-hair rows before the shoulder line
  * only paint where the base sprite is opaque (fitted, no stickers)
Run: python3 artifacts/jpo-huddle/tools/christmas-layer-gen.py
"""
import os
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'assets')
LDIR = os.path.join(ROOT, 'layers')
CHARS = ['adam', 'alex', 'amelia', 'bob']
SUFFIXES = ['run', 'sit', 'sit2', 'sit3']
FRAME_W = {'run': 16, 'sit3': 16, 'sit': 32, 'sit2': 32}

RED = (196, 38, 52); RED_D = (122, 20, 34)
GREEN = (36, 132, 72); GREEN_D = (18, 78, 44)
CREAM = (246, 236, 214); GOLD = (232, 182, 54)


def load(char, suffix, part):
    name = f'{char.capitalize()}_{suffix}_{part}.png' if part else f'{char.capitalize()}_{suffix}_16x16.png'
    d = LDIR if part else ROOT
    return Image.open(os.path.join(d, name)).convert('RGBA')


def lum(p):
    return (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) / 255


def shade(col, base_px, ref):
    k = max(0.45, min(1.15, lum(base_px) / ref if ref else 1))
    return tuple(min(255, round(c * k)) for c in col) + (255,)


def feet_row(B, x, h):
    for y in range(h - 1, -1, -1):
        if B[x, y][3] >= 128:
            return y
    return -1


_HAIR = [None]


def torso_rows(B, K, P, x0, x1, h):
    """(shoulder row, chin row, waist row) for one frame. The split hair layer
    swallows outfit pixels on some sheets, so geometry comes from the base +
    face skin: chin = end of the first skin run near the head top (or head top
    + 9 for back views); waist = pants top - 1, else ~55% down the body."""
    rows = [y for y in range(h) if any(B[x, y][3] >= 128 for x in range(x0, x1))]
    if not rows:
        return None, None, None
    T, BOT = rows[0], rows[-1]
    H = _HAIR[0]
    def cnt(L, y): return sum(1 for x in range(x0, x1) if L[x, y][3] >= 128)
    # face = first skin run of >=3 rows that starts in the head zone
    chin, y = None, T
    while y <= T + 14:
        if cnt(K, y):
            e = y
            while e + 1 < h and cnt(K, e + 1): e += 1
            if e - y >= 2:
                chin = e; break
            y = e + 1
        else:
            y += 1
    # hair hanging below the face (and the whole head on back views) stays
    # visible: extend while the row is mostly hair.
    hy = T
    for yy in range(T, min(h, T + 17)):
        if cnt(H, yy) * 10 >= cnt(B, yy) * 6 and cnt(B, yy): hy = yy
    chin = max(chin if chin is not None else T + 9, hy)
    top = chin + 1
    ptop = [y for y in range(top, h) if any(P[x, y][3] >= 128 for x in range(x0, x1))]
    waist = ptop[0] - 1 if ptop and ptop[0] - 1 >= top + 2 else top + max(3, round((BOT - top) * 0.55))
    return top, chin, min(waist, BOT)


def gen(char, suffix):
    shirt, pants, skin, hair, base = (load(char, suffix, p) for p in ('shirt', 'pants', 'skin', 'hair', None))
    w, h = shirt.size
    S, P, K, H, B = (im.load() for im in (shirt, pants, skin, hair, base))
    fw = FRAME_W[suffix]
    _HAIR[0] = H
    outs = {k: Image.new('RGBA', (w, h), (0, 0, 0, 0)) for k in ('christmassweater', 'elfoutfit', 'christmasscarf')}
    O = {k: v.load() for k, v in outs.items()}
    ref = 0.55
    for f in range(w // fw):
        x0, x1 = f * fw, (f + 1) * fw
        top, chin, bot = torso_rows(B, K, P, x0, x1, h)
        if top is None:
            continue

        def body(x, y):  # paintable clothing pixel: opaque, below chin, not skin
            return B[x, y][3] >= 128 and K[x, y][3] < 128 and y > chin

        cols = [x for x in range(x0, x1) if any(body(x, y) for y in range(top, bot + 1))]
        if not cols:
            continue
        cx = (cols[0] + cols[-1]) / 2
        band = top + max(1, (bot - top) // 2)
        for x in range(x0, x1):
            for y in range(top, h):
                if not body(x, y):
                    continue
                legs = y > bot
                # sweater: torso only
                if not legs:
                    if y == bot: c = GREEN_D
                    elif y == band: c = CREAM if (x + y) % 2 == 0 else GREEN
                    elif y == top: c = RED_D
                    else: c = RED
                    O['christmassweater'][x, y] = shade(c, B[x, y], ref) if c in (RED, RED_D) else c + (255,)
                    c = RED if y == top else GOLD if y == bot else GREEN
                    O['elfoutfit'][x, y] = GOLD + (255,) if c == GOLD else shade(c, B[x, y], ref)
                elif P[x, y][3] >= 128 or y < feet_row(B, x, h):
                    c = RED if (y // 2) % 2 == 0 else CREAM
                    O['elfoutfit'][x, y] = shade(c, B[x, y], ref)
        # Keep the persisted scarf ID so existing owners receive the beard.
        # Fit to the lower FACE, not the clothing/hair-derived shoulder.
        direction = ('right', 'up', 'left', 'down')[f // 6] if suffix == 'run' else ('right' if f < 6 else 'left')
        if direction == 'up':
            continue
        headtop = min(y for y in range(h) if any(B[x,y][3] for x in range(x0,x1)))
        face_rows = [y for y in range(headtop, min(h, headtop + 13))
                     if any(K[x,y][3] for x in range(x0,x1))]
        if not face_rows:
            continue
        face_bottom = face_rows[0]
        while face_bottom + 1 in face_rows:
            face_bottom += 1
        face_x = [x for x in range(x0,x1)
                  if any(K[x,y][3] for y in range(max(headtop,face_bottom-2),face_bottom+1))]
        center = round((min(face_x)+max(face_x))/2)
        for dy in range(5):
            radius = (3,3,2,1,0)[dy] if direction == 'down' else (1,1,1,0,0)[dy]
            for x in range(center-radius,center+radius+1):
                y = face_bottom - 1 + dy
                if x0 <= x < x1 and 0 <= y < h:
                    O['christmasscarf'][x,y] = ((255,253,246) if dy<3 else (217,225,226))+(255,)
    for k, im in outs.items():
        im.save(os.path.join(LDIR, f'{char.capitalize()}_{suffix}_wear_{k}.png'))


if __name__ == '__main__':
    for c in CHARS:
        for s in SUFFIXES:
            gen(c, s)
        print('christmas layers:', c, 'OK')
