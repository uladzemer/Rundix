"""Encode the authentic seven-scene workbench tour (requires Pillow)."""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent
frames = []
for scene in ('overview', 'tests', 'split', 'queue', 'access', 'history', 'questions'):
    name = f'workbench-{scene}.jpg'
    with Image.open(root / name) as source:
        frames.append(source.convert('RGB').quantize(colors=192))
frames[0].save(root / 'demo.gif', save_all=True, append_images=frames[1:],
               duration=[5000, 3500, 4500, 4000, 3500, 3500, 5000],
               loop=0, optimize=True, disposal=2)
