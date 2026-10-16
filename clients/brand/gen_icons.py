import sys, os
from PIL import Image, ImageDraw, ImageFont
from PIL import ImageFilter as IF

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.normpath(os.path.join(HERE, '..', 'android', 'app', 'src', 'main', 'res'))
OUT = os.path.join(HERE, 'icon-assets')
MARK = Image.open(os.path.join(HERE, 'cybion-mark.png')).convert('RGBA')

FG_SCALE = float(sys.argv[1]) if len(sys.argv) > 1 else 0.50   # adaptive foreground mark size (of 108dp canvas)
LG_SCALE = float(sys.argv[2]) if len(sys.argv) > 2 else 0.60   # legacy rounded mark size (of canvas)

def grad_rgb(size):
    im = Image.new('RGB', (size, size)); px = im.load()
    c = [(0x54,0x54,0x5E),(0x2A,0x2A,0x30),(0x16,0x16,0x16)]
    for y in range(size):
        for x in range(size):
            t = (x+y)/(2*(size-1))
            if t <= 0.45: a,b,tt = c[0],c[1],t/0.45
            else: a,b,tt = c[1],c[2],(t-0.45)/0.55
            px[x,y] = tuple(int(a[k]+(b[k]-a[k])*tt) for k in range(3))
    return im

def marker(canvas, scale):
    inner = int(canvas*scale)
    m = MARK.resize((inner, inner), Image.LANCZOS)
    c = Image.new('RGBA', (canvas,canvas), (0,0,0,0)); off = (canvas-inner)//2
    c.paste(m, (off, off), m); return c

def mask_squircle(size, ss=4):
    W = size*ss; m = Image.new('L',(W,W),0)
    ImageDraw.Draw(m).rounded_rectangle([0,0,W-1,W-1], radius=int(0.225*W), fill=255)
    return m.resize((size,size), Image.LANCZOS)

def mask_circle(size, ss=4):
    W = size*ss; m = Image.new('L',(W,W),0)
    ImageDraw.Draw(m).ellipse([0,0,W-1,W-1], fill=255)
    return m.resize((size,size), Image.LANCZOS)

# ---- high-res legacy bases (1024) ----
BG = grad_rgb(1024).convert('RGBA')
def legacy_base(kind):
    o = BG.copy(); o.putalpha(mask_squircle(1024) if kind=='squircle' else mask_circle(1024))
    return Image.alpha_composite(o, marker(1024, LG_SCALE))
LEG_SQ = legacy_base('squircle')
LEG_RD = legacy_base('circle')

dens = {'mdpi':1,'hdpi':1.5,'xhdpi':2,'xxhdpi':3,'xxxhdpi':4}
for d,f in dens.items():
    la = int(48*f)
    LEG_SQ.resize((la,la), Image.LANCZOS).save(f'{RES}/mipmap-{d}/ic_launcher.png')
    LEG_RD.resize((la,la), Image.LANCZOS).save(f'{RES}/mipmap-{d}/ic_launcher_round.png')
    marker(int(108*f), FG_SCALE).save(f'{RES}/mipmap-{d}/ic_launcher_foreground.png')

# ---- adaptive home-screen preview (mask crops central 72/108) ----
def adaptive(kind, S=1024):
    icon = Image.alpha_composite(BG, marker(S, FG_SCALE))
    vis = int(S*72/108); off = (S-vis)//2
    crop = icon.crop((off,off,off+vis,off+vis)).resize((S,S), Image.LANCZOS)
    o = crop.copy(); o.putalpha(mask_squircle(S) if kind=='squircle' else mask_circle(S)); return o

# ---- old legacy for reference (square, 48%) ----
def old_legacy(S=1024):
    return Image.alpha_composite(BG, marker(S, 0.48))

def font(sz):
    for p in ['/System/Library/Fonts/Supplemental/Arial.ttf','/System/Library/Fonts/Helvetica.ttc']:
        try: return ImageFont.truetype(p, sz)
        except Exception: pass
    return ImageFont.load_default()

legacy_new = LEG_SQ
home = adaptive('squircle')
old = old_legacy()
panels = [(old,'install dialog OLD  square 48%'),
          (legacy_new,'install dialog NEW  rounded 36%'),
          (home,'home screen  adaptive 36%')]
S=1024; pad=110; lab=150
W = pad*(len(panels)+1) + S*len(panels); H = pad*2 + S + lab
sheet = Image.new('RGBA',(W,H),(38,38,43,255))
for i,(img,t) in enumerate(panels):
    x = pad + i*(S+pad); y = pad
    sh = Image.new('RGBA',(W,H),(0,0,0,0))
    ImageDraw.Draw(sh).ellipse([x+90,y+S-80,x+S-90,y+S+40], fill=(0,0,0,115))
    sheet = Image.alpha_composite(sheet, sh.filter(IF.GaussianBlur(28)))
    sheet.alpha_composite(img,(x,y))
    ImageDraw.Draw(sheet).text((x+S/2,y+S+34), t, fill=(205,205,212,255), anchor='ma', font=font(40))
sheet.convert('RGB').save(f'{OUT}/android-compare.png')
LEG_SQ.convert('RGB').save(f'{OUT}/android-preview-squircle.png')
LEG_RD.convert('RGB').save(f'{OUT}/android-preview-circle.png')
print(f'done  FG={FG_SCALE}  LG={LG_SCALE}')
