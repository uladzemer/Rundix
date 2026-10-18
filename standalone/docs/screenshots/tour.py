"""Encode a feature tour from the three isolated demo captures (requires Pillow)."""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent
frames = []
for name in ('chat-dark.jpg', 'access-modes.jpg', 'questions-light.jpg'):
    with Image.open(root / name) as source:
        frames.append(source.convert('RGB').quantize(colors=192))
frames[0].save(root / 'demo.gif', save_all=True, append_images=frames[1:],
               duration=[3500, 3000, 3500], loop=0, optimize=True, disposal=2)
