# Slice approved-style reindeer sheets (dark #1e1e28 bg) into the pet art contract:
# pet_reindeer[_sN].png + anim/reindeer[_sN]_{walk1,walk2,walk3,sit,action}.png, 64x64 bottom-aligned, facing RIGHT.
import sys
from PIL import Image, ImageFilter
from collections import deque
SRC='attached_assets/generated_images/reindeer_s%d_sheet.png'
OUT='artifacts/jpo-huddle/public/assets/pets/'
NAMES=['static','walk1','walk2','walk3','sit','action']
def blobs(mask,W,H):
    m=Image.new('L',(W,H)); m.putdata([255 if v else 0 for v in mask]); m=m.filter(ImageFilter.MaxFilter(11))
    d=list(m.getdata()); lab=[0]*(W*H); out=[]
    for i in range(W*H):
        if d[i] and not lab[i]:
            lab[i]=1; q=deque([i]); cnt=0; x0=y0=10**9; x1=y1=0
            while q:
                j=q.popleft(); cnt+=1; y,x=divmod(j,W)
                x0=min(x0,x);x1=max(x1,x+1);y0=min(y0,y);y1=max(y1,y+1)
                for nj in (j-1 if x else -1, j+1 if x<W-1 else -1, j-W, j+W):
                    if 0<=nj<W*H and d[nj] and not lab[nj]: lab[nj]=1; q.append(nj)
            out.append((cnt,x0,y0,x1,y1))
    return out
for s in ([int(v) for v in sys.argv[1:]] or (1,2,3)):
    im=Image.open(SRC%s).convert('RGBA'); W,H=im.size; px=list(im.getdata())
    bg=px[4*W+4][:3]
    mask=[max(abs(p[0]-bg[0]),abs(p[1]-bg[1]),abs(p[2]-bg[2]))>26 for p in px]
    im.putdata([p if m else (0,0,0,0) for p,m in zip(px,mask)])
    bl=sorted(blobs(mask,W,H),reverse=True)[:7 if s==2 else 6]
    bl=sorted(bl,key=lambda b:(b[2] >= H*.47,b[1]))
    # Adult source has four poses on top, then an EXTRA walking pose,
    # sitting and action below. Selecting six by area dropped the sitter.
    if s==2: bl=[bl[i] for i in (0,1,2,3,5,6)]
    crops=[]
    for _,x0,y0,x1,y1 in bl:
        c=im.crop((x0,y0,x1,y1)); crops.append(c.crop(c.getbbox()))
    mx=max(max(c.size) for c in crops); k=60/mx
    for name,c in zip(NAMES,crops):
        c=c.resize((max(1,round(c.width*k)),max(1,round(c.height*k))),Image.NEAREST)
        f=Image.new('RGBA',(64,64)); f.paste(c,((64-c.width)//2,64-c.height),c)
        stem='reindeer'+('' if s==1 else '_s%d'%s)
        path=OUT+('pet_'+stem+'.png' if name=='static' else 'anim/%s_%s.png'%(stem,name))
        f.save(path); print(path,c.size)
