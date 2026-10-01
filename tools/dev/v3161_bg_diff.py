"""v3.16.1: сравнение кадров фона боя (стабильность + яркость)."""
from PIL import Image
import sys, glob

frames = sorted(glob.glob('/home/user/shots/bgcheck/frame*.png'))
print(f"кадров: {len(frames)}")
prev = None
maxdiff = 0
for f in frames:
    im = Image.open(f).convert('RGB')
    px = list(im.getdata())
    if prev is not None:
        d = sum(abs(a[0]-b[0])+abs(a[1]-b[1])+abs(a[2]-b[2]) for a, b in zip(px, prev)) / len(px) / 3
        maxdiff = max(maxdiff, d)
        print(f"{f.split('/')[-1]}: средняя Δпикселя к предыдущему = {d:.3f}")
    prev = px

full = Image.open('/home/user/shots/bgcheck/battle_full.png').convert('RGB')
reg = full.crop((60, 240, 220, 420))
px = list(reg.getdata())
lum = sum(0.299*r + 0.587*g + 0.114*b for r, g, b in px) / len(px)
print(f"яркость участка стола (0-255): {lum:.1f}")
print(f"МАКСИМАЛЬНАЯ разница между кадрами: {maxdiff:.3f} (старый код: >1.5 из-за зерна/дрейфа)")
sys.exit(0 if maxdiff < 0.75 else 2)
