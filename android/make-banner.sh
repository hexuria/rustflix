#!/usr/bin/env bash
# Draws the Android TV launcher banner (android:banner, 16:9) into
# app/src/main/res/mipmap-*/banner.png: the app icon (store/app-icon-1024.png)
# on the left and the word "rustflix" on the right, on the launcher
# background colour (@color/ic_launcher_background). Google TV shows the
# banner without the app's label, so the name has to be in the picture.
#
#   ./android/make-banner.sh
#
# Needs Python 3 with Pillow and a bold sans-serif font (macOS's Avenir Next
# or Helvetica Neue; FONT=/path/to/font.ttf to use another one).
set -euo pipefail
cd "$(dirname "$0")"

python3 - "$PWD" <<'PY'
import os, sys
from PIL import Image, ImageDraw, ImageFont

root = sys.argv[1]
icon_src = Image.open(os.path.join(root, "..", "store", "app-icon-1024.png")).convert("RGBA")
background = (0x18, 0x18, 0x1B, 255)  # res/values/colors.xml ic_launcher_background
ink = (0xFA, 0xFA, 0xFA, 255)

# (path, face index or None, face name wanted)
candidates = [
    (os.environ.get("FONT"), 0, None),
    ("/System/Library/Fonts/Avenir Next.ttc", None, "Bold"),
    ("/System/Library/Fonts/HelveticaNeue.ttc", None, "Bold"),
]

def load_font(size):
    for path, index, style in candidates:
        if not path or not os.path.exists(path):
            continue
        if index is not None:
            return ImageFont.truetype(path, size, index=index)
        for i in range(32):
            try:
                f = ImageFont.truetype(path, size, index=i)
            except OSError:
                break
            if f.getname()[1] == style:
                return f
    sys.exit("make-banner: no bold font found (set FONT=/path/to/font.ttf)")

def rounded(img, radius):
    mask = Image.new("L", (img.width * 4, img.height * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, mask.width - 1, mask.height - 1), radius * 4, fill=255)
    mask = mask.resize(img.size, Image.LANCZOS)
    out = img.copy()
    out.putalpha(mask)
    return out

sizes = {"mdpi": 160, "hdpi": 240, "xhdpi": 320, "xxhdpi": 480, "xxxhdpi": 640}
for bucket, w in sizes.items():
    h = w * 9 // 16
    s = w / 320.0  # layout in xhdpi pixels (320x180), scaled per bucket
    banner = Image.new("RGBA", (w, h), background)

    icon_px = round(92 * s)
    icon = rounded(icon_src.resize((icon_px, icon_px), Image.LANCZOS), icon_px * 0.225)

    # The word fills what the icon and the margins leave, at most 46 px tall type.
    gap, margin = round(16 * s), round(26 * s)
    room = w - 2 * margin - icon_px - gap
    size = round(46 * s)
    font = load_font(size)
    while font.getbbox("rustflix")[2] - font.getbbox("rustflix")[0] > room:
        size -= 1
        font = load_font(size)
    l, t, r, b = font.getbbox("rustflix")
    text_w = r - l

    # The pair is centred as a group; the word's x-height centre sits on the icon's centre line.
    x0 = (w - (icon_px + gap + text_w)) // 2
    banner.alpha_composite(icon, (x0, (h - icon_px) // 2))
    xl, xt, xr, xb = font.getbbox("x")
    tx = x0 + icon_px + gap - l
    ty = round(h / 2 - (xt + xb) / 2)
    ImageDraw.Draw(banner).text((tx, ty), "rustflix", font=font, fill=ink)

    out_dir = os.path.join(root, "app", "src", "main", "res", "mipmap-" + bucket)
    os.makedirs(out_dir, exist_ok=True)
    banner.convert("RGB").save(os.path.join(out_dir, "banner.png"), optimize=True)
    print(f"mipmap-{bucket}/banner.png {w}x{h} (type {size} px)")
PY
