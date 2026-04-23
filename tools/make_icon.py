#!/usr/bin/env python3
# Generates a 128x128 PNG icon using only stdlib (zlib + struct).
# Design: rounded-square Dracula-dark background with a clean
# download-to-tray glyph (shaft + arrowhead + horizontal bar).

import os
import struct
import zlib

SIZE = 128

# DaisyUI "black" theme palette — pure black with a cool cyan accent for
# the download glyph so the icon stays legible at toolbar sizes.
BG       = (0, 0, 0, 255)       # #000000 background
HIGHLIGHT = (38, 38, 38, 255)   # #262626 subtle top inner edge
ACCENT   = (139, 233, 253, 255) # #8be9fd cyan glyph
TRANSPARENT = (0, 0, 0, 0)

# Glyph geometry.
CX = SIZE / 2
SHAFT_W       = 18
SHAFT_TOP     = 22
SHAFT_BOTTOM  = 58
HEAD_TOP_Y    = 52
HEAD_TIP_Y    = 86
HEAD_HALF_W   = 26
TRAY_X1, TRAY_X2 = 18, 110
TRAY_Y1, TRAY_Y2 = 94, 106
TRAY_RADIUS   = 3

CORNER_RADIUS = 24

def blend(a, b, t):
    # Linear blend between two RGBA tuples (t=0 → a, t=1 → b).
    return tuple(int(round(a[i] * (1 - t) + b[i] * t)) for i in range(4))

def in_rounded_rect(px, py, cx, cy, w, h, r):
    # True when point lies inside a rounded rect.
    dx = abs(px - cx) - (w / 2 - r)
    dy = abs(py - cy) - (h / 2 - r)
    if dx <= 0 and dy <= 0:
        return True
    ax = max(dx, 0)
    ay = max(dy, 0)
    return (ax * ax + ay * ay) <= r * r

def in_triangle(px, py, x1, y1, x2, y2, x3, y3):
    # Barycentric point-in-triangle test.
    d = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3)
    if d == 0:
        return False
    a = ((y2 - y3) * (px - x3) + (x3 - x2) * (py - y3)) / d
    b = ((y3 - y1) * (px - x3) + (x1 - x3) * (py - y3)) / d
    c = 1 - a - b
    return a >= 0 and b >= 0 and c >= 0

def in_bg(px, py):
    return in_rounded_rect(px, py, CX, CX, SIZE, SIZE, CORNER_RADIUS)

def in_glyph(px, py):
    # Shaft.
    if abs(px - CX) <= SHAFT_W / 2 and SHAFT_TOP <= py <= SHAFT_BOTTOM:
        return True
    # Arrowhead (downward-pointing triangle).
    if in_triangle(px, py,
                   CX - HEAD_HALF_W, HEAD_TOP_Y,
                   CX + HEAD_HALF_W, HEAD_TOP_Y,
                   CX, HEAD_TIP_Y):
        return True
    # Tray bar under the arrow.
    tcx = (TRAY_X1 + TRAY_X2) / 2
    tcy = (TRAY_Y1 + TRAY_Y2) / 2
    tw  = TRAY_X2 - TRAY_X1
    th  = TRAY_Y2 - TRAY_Y1
    if in_rounded_rect(px, py, tcx, tcy, tw, th, TRAY_RADIUS):
        return True
    return False

def coverage(fn, x, y):
    # 4x super-sampling for smooth anti-aliased edges.
    n = 0
    for sx in (0.25, 0.75):
        for sy in (0.25, 0.75):
            if fn(x + sx, y + sy):
                n += 1
    return n / 4.0

def make_pixels():
    pixels = bytearray()
    for y in range(SIZE):
        row = bytearray([0])  # PNG filter byte per row (0 = none)
        for x in range(SIZE):
            bga = coverage(in_bg, x, y)
            if bga == 0:
                row.extend(TRANSPARENT)
                continue

            # Start with background colour.
            colour = BG

            # Soft top inner highlight gives subtle depth (first ~6px).
            if y < 8:
                t = max(0, (8 - y) / 8) * 0.35
                colour = blend(colour, HIGHLIGHT, t)

            # Composite glyph on top using its coverage.
            fga = coverage(in_glyph, x, y)
            if fga > 0:
                colour = blend(colour, ACCENT, fga)

            # Apply bg coverage to the pixel's alpha for rounded-corner AA.
            final = (colour[0], colour[1], colour[2], int(round(colour[3] * bga)))
            row.extend(final)
        pixels.extend(row)
    return bytes(pixels)

def chunk(tag, data):
    length = struct.pack("!I", len(data))
    crc = struct.pack("!I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return length + tag + data + crc

def write_png(path):
    signature = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack("!IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    idat = zlib.compress(make_pixels(), 9)
    iend = b""
    png = signature + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", iend)
    with open(path, "wb") as f:
        f.write(png)

if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, "..", "icon", "icon.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    write_png(out)
    print(f"wrote {out}")
