# Pixel-authored Christmas wearables (texel art; game scales 3x). Frames: 0 front, 1 side(facing right), 2 back.
from PIL import Image
OUT='public/assets/'
def sheet(fw,fh,n,draw,name):
    im=Image.new('RGBA',(fw*n,fh)); p=im.load()
    for f in range(n):
        def px(x,y,c):
            if 0<=x<fw and 0<=y<fh: p[f*fw+x,y]=c
        def rect(x,y,w,h,c):
            for i in range(w):
                for j in range(h): px(x+i,y+j,c)
        draw(f,rect,px)
    im.save(OUT+name); print(name,im.size)
RED=(196,40,52,255);RD=(126,22,40,255);WH=(246,240,228,255);WS=(206,200,196,255);GR=(46,122,78,255);GD=(26,78,52,255);GO=(236,190,84,255);BR=(132,88,52,255);BL=(92,58,36,255);ICE=(206,236,255,235);ICD=(120,180,230,235)
def santa(f,r,px):
    # brim at bottom, cone flops toward back (side frame: tip trails left)
    r(2,9,12,3,WH); r(2,11,12,1,WS)
    r(3,5,10,4,RED); r(4,3,8,2,RED); r(5,1,6,2,RD if f==2 else RED); r(4,8,8,1,RD)
    if f==1: r(1,2,3,2,RED); r(0,3,2,2,WH)
    else: r(11,1,3,2,RED); r(13,2,3,3,WH)
def antlers(f,r,px):
    r(3,11,10,2,RED)  # headband
    for sx in ([0] if f==1 else [0,1]):
        L= sx==0
        bx=4 if L else 11
        if f==1: bx=7
        r(bx,4,1,7,BR); r(bx-1 if L else bx+1,3,1,2,BR)
        r(bx-2 if L else bx+1,6,2,1,BR); r(bx-3 if L else bx+2,4,1,2,BR)
        r(bx+1 if L else bx-1,7,1,1,BL)
    if f!=2: px(8,12,GO)
def scarf(f,r,px):
    r(1,0,10,3,RED); r(1,1,10,1,WH); r(2,3,8,1,RD)
    if f==0: r(7,3,3,5,RED); r(7,5,3,1,WH); r(7,7,1,1,WH); r(9,7,1,1,WH)
    elif f==1: r(0,2,3,5,RED); r(0,4,3,1,WH)
    else: r(3,3,3,4,RED); r(3,5,3,1,WH)
def sweater(f,r,px):
    r(1,0,10,8,GR); r(0,1,1,6,GD); r(11,1,1,6,GD); r(1,8,10,2,RED)
    r(4,0,4,1,RED)
    for x in range(1,11):
        px(x,3,WH if x%2 else RED); px(x,5,RED if x%2 else WH)
    if f!=2: r(5,4,2,1,GO); px(6,3,(255,250,210,255))
def elf(f,r,px):
    r(1,0,10,8,GR); r(0,1,1,6,GD); r(11,1,1,6,GD)
    r(1,6,10,2,BL); r(5,6,2,2,GO)
    for x in range(1,11,2): r(x,8,2,2-(x//2)%2,GR)
    r(3,0,6,1,RED); px(2,1,RED); px(9,1,RED)
    if f==0: px(6,2,GO); px(6,4,GO)
def wings(f,r,px):
    def flake(cx,cy,R):
        for d in range(-R,R+1):
            px(cx+d,cy,ICE); px(cx,cy+d,ICE); px(cx+d,cy+d,ICD); px(cx+d,cy-d,ICD)
        px(cx,cy,(255,255,255,255))
    if f==0:
        for side in (-1,1):
            for y in range(1,19):
                w=max(0,13-abs(y-7)) if y<12 else max(0,8-(y-12))
                for i in range(w):
                    x=16+side*(2+i)
                    px(x,y,(170,214,248,120) if i<w-1 else ICD)
            cx=16+side*8; flake(cx,7,4); flake(16+side*5,15,2)
    else:
        for y in range(1,19):
            w=max(0,11-abs(y-7)) if y<12 else max(0,7-(y-12))
            for i in range(w): px(18-i,y,(170,214,248,120) if i<w-1 else ICD)
        flake(13,7,4); flake(15,15,2)
sheet(16,13,3,santa,'wear_santahat.png')
sheet(16,13,3,antlers,'wear_reindeerantlers.png')
sheet(12,8,3,scarf,'wear_christmasscarf.png')
sheet(12,10,3,sweater,'wear_christmassweater.png')
sheet(12,10,3,elf,'wear_elfoutfit.png')
sheet(32,20,2,wings,'wear_snowflakewings.png')
