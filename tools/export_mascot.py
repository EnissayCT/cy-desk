"""Turns the Blender renders (mascot/frames/*.png + anchors.json) into what the page loads:
ui/mascot/*.webp and ui/mascot/anchors.js.
Usage: python tools/export_mascot.py            re-encode every frame
       python tools/export_mascot.py point,bow  encode only these (anchors.js is always rewritten)"""
import json
import os
import sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = os.path.join(ROOT, 'mascot', 'frames')
dst = os.path.join(ROOT, 'ui', 'mascot')
os.makedirs(dst, exist_ok=True)
only = set(sys.argv[1].split(',')) if len(sys.argv) > 1 else None
if not only:
    for f in os.listdir(dst):  # drop frames from an older grid
        if f.endswith('.webp'):
            os.remove(os.path.join(dst, f))

anchors = json.load(open(os.path.join(src, 'anchors.json')))
META = ('width', 'height', 'yaws', 'pitches')
total = 0
for f in sorted(os.listdir(src)):
    if f.endswith('.png') and (not only or f[:-4] in only):
        out = os.path.join(dst, f[:-4] + '.webp')
        Image.open(os.path.join(src, f)).convert('RGBA').save(out, 'WEBP', quality=86, method=6)
        total += os.path.getsize(out)
frames = {k: v for k, v in anchors.items() if k not in META and k != 'mic'}
meta = {k: anchors[k] for k in META}
meta['frames'] = frames
with open(os.path.join(dst, 'anchors.js'), 'w') as fh:
    fh.write('// Face anchors per rendered pose, from mascot/build_mascot.py\nwindow.MASCOT = ' + json.dumps(meta, separators=(',', ':')) + ';\n')
print(len(frames), 'frames + mic,', round(total / 1024), 'KB written')
