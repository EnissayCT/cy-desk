"""Builds docs/cy-demo.gif and docs/cy-demo.webp from docs/demo-frames/*.png (see record-demo.js)."""
import glob
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
files = sorted(glob.glob(os.path.join(ROOT, 'docs', 'demo-frames', 'f*.png')))
frames = []
for f in files:
    im = Image.open(f).convert('RGB')
    w = 520
    frames.append(im.resize((w, round(im.height * w / im.width)), Image.LANCZOS))
if not frames:
    raise SystemExit('no frames')
import json
timing = os.path.join(ROOT, 'docs', 'demo-frames', 'timing.json')
ms = json.load(open(timing))[:len(frames)] if os.path.exists(timing) else 84
frames[0].save(os.path.join(ROOT, 'docs', 'cy-demo.webp'), save_all=True, append_images=frames[1:], duration=ms, loop=0, quality=80)
pal = [f.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for f in frames]
pal[0].save(os.path.join(ROOT, 'docs', 'cy-demo.gif'), save_all=True, append_images=pal[1:], duration=ms, loop=0, optimize=True)
for name in ('cy-demo.gif', 'cy-demo.webp'):
    print(name, round(os.path.getsize(os.path.join(ROOT, 'docs', name)) / 1024), 'KB,', len(frames), 'frames')
