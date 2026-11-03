#!/usr/bin/env python3
"""
Generates PLACEHOLDER brand assets so the pipeline renders end-to-end before the approved
brand files are dropped into assets/brand/. Every output goes to assets/brand/generated/.
The renderer prefers the real files (assets/brand/*.png|mp4) and falls back to these.

Usage: python3 scripts/generate_brand_placeholders.py [--out assets/brand/generated]
Requires Pillow.
"""
import argparse
import math
import os
import random

from PIL import Image, ImageDraw, ImageFont

RED = (226, 35, 26, 255)
DARK_RED = (160, 20, 14, 255)
BLACK = (17, 17, 17, 255)
YELLOW = (255, 212, 0, 255)
WHITE = (255, 255, 255, 255)


def burst(size=2400, rays=40):
    """Brand-style burst (black base, red rays, yellow brush spikes, halftone): the animated background's source frame."""
    img = Image.new("RGBA", (size, size), BLACK)
    d = ImageDraw.Draw(img)
    c = size / 2
    r = size
    rnd0 = random.Random(11)
    for i in range(rays):
        a0 = (2 * math.pi / rays) * i
        w = (2 * math.pi / rays) * rnd0.uniform(0.25, 0.55)
        a1 = a0 + w
        col = RED if i % 2 else DARK_RED
        d.polygon([(c, c), (c + r * math.cos(a0), c + r * math.sin(a0)), (c + r * math.cos(a1), c + r * math.sin(a1))], fill=col)
    # yellow brush spikes, shorter and jagged, like the channel art
    for i in range(rays):
        a0 = (2 * math.pi / rays) * i + rnd0.uniform(-0.03, 0.03)
        w = (2 * math.pi / rays) * rnd0.uniform(0.10, 0.22)
        ln = r * rnd0.uniform(0.28, 0.62)
        pts = [(c + 60 * math.cos(a0 + w / 2), c + 60 * math.sin(a0 + w / 2)), (c + ln * math.cos(a0), c + ln * math.sin(a0)), (c + ln * 0.9 * math.cos(a0 + w), c + ln * 0.9 * math.sin(a0 + w))]
        d.polygon(pts, fill=YELLOW)
    # halftone dots, denser toward the edges
    rnd = random.Random(7)
    step = 26
    for y in range(0, size, step):
        for x in range(0, size, step):
            dist = math.hypot(x - c, y - c) / c
            rad = max(0, (dist - 0.25)) * 7
            if rad > 1.2:
                d.ellipse([x - rad, y - rad, x + rad, y + rad], fill=(38, 38, 38, 255))
    # vignette
    vign = Image.new("L", (size, size), 0)
    vd = ImageDraw.Draw(vign)
    for i in range(40):
        k = i / 40
        vd.ellipse([c - r * (1.25 - k * 0.5), c - r * (1.25 - k * 0.5), c + r * (1.25 - k * 0.5), c + r * (1.25 - k * 0.5)], fill=int(90 * k))
    dark = Image.new("RGBA", (size, size), BLACK)
    img = Image.composite(dark, img, vign)
    _ = rnd
    return img


def headline_box(w=1000, h=340):
    """Jagged comic burst box (red fill, thick black outline, yellow inner stroke) with transparency."""
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pts = []
    n = 28
    cx, cy = w / 2, h / 2
    rnd = random.Random(3)
    for i in range(n):
        a = 2 * math.pi * i / n
        spike = 1.0 if i % 2 == 0 else 0.86
        rx = (w / 2 - 14) * spike
        ry = (h / 2 - 14) * spike
        jitter = 1 + rnd.uniform(-0.03, 0.03)
        pts.append((cx + rx * math.cos(a) * jitter, cy + ry * math.sin(a) * jitter))
    d.polygon(pts, fill=BLACK)
    inner = [(cx + (x - cx) * 0.93, cy + (y - cy) * 0.90) for x, y in pts]
    d.polygon(inner, fill=YELLOW)
    inner2 = [(cx + (x - cx) * 0.86, cy + (y - cy) * 0.80) for x, y in pts]
    d.polygon(inner2, fill=RED)
    return img


def mascot(size=700):
    """Angry toaster placeholder: yellow body, black outline, furious eyebrows, two slices of toast."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = size / 700
    # shadow
    d.rounded_rectangle([120 * s, 300 * s, 600 * s, 620 * s], radius=int(60 * s), fill=(0, 0, 0, 90))
    # toast slices
    for x in (200, 360):
        d.rounded_rectangle([x * s, 150 * s, (x + 140) * s, 330 * s], radius=int(40 * s), fill=(210, 140, 60, 255), outline=BLACK, width=int(10 * s))
        d.rounded_rectangle([(x + 18) * s, 170 * s, (x + 122) * s, 310 * s], radius=int(30 * s), fill=(240, 190, 110, 255))
    # body
    d.rounded_rectangle([100 * s, 280 * s, 600 * s, 600 * s], radius=int(60 * s), fill=YELLOW, outline=BLACK, width=int(14 * s))
    d.rounded_rectangle([150 * s, 280 * s, 550 * s, 320 * s], radius=int(10 * s), fill=BLACK)
    # feet
    d.rounded_rectangle([140 * s, 590 * s, 230 * s, 640 * s], radius=int(14 * s), fill=BLACK)
    d.rounded_rectangle([470 * s, 590 * s, 560 * s, 640 * s], radius=int(14 * s), fill=BLACK)
    # lever
    d.rounded_rectangle([600 * s, 360 * s, 660 * s, 400 * s], radius=int(12 * s), fill=BLACK)
    # eyes
    for ex in (240, 400):
        d.ellipse([ex * s, 380 * s, (ex + 90) * s, 470 * s], fill=WHITE, outline=BLACK, width=int(10 * s))
        d.ellipse([(ex + 35) * s, 415 * s, (ex + 70) * s, 455 * s], fill=BLACK)
    # angry eyebrows
    d.line([(225 * s, 370 * s), (335 * s, 400 * s)], fill=BLACK, width=int(22 * s))
    d.line([(505 * s, 370 * s), (395 * s, 400 * s)], fill=BLACK, width=int(22 * s))
    # mouth (shouting)
    d.rounded_rectangle([270 * s, 500 * s, 440 * s, 570 * s], radius=int(30 * s), fill=BLACK)
    d.rounded_rectangle([290 * s, 535 * s, 420 * s, 565 * s], radius=int(16 * s), fill=RED)
    d.rectangle([290 * s, 500 * s, 420 * s, 520 * s], fill=WHITE)
    return img


def logo(size=256):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([4, 4, size - 4, size - 4], fill=RED, outline=BLACK, width=10)
    m = mascot(size).resize((int(size * 0.8), int(size * 0.8)))
    img.alpha_composite(m, (int(size * 0.1), int(size * 0.08)))
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "assets", "brand", "generated"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    burst().save(os.path.join(a.out, "burst.png"))
    headline_box().save(os.path.join(a.out, "headline_box_placeholder.png"))
    mascot().save(os.path.join(a.out, "mascot_placeholder.png"))
    logo().save(os.path.join(a.out, "logo_placeholder.png"))
    print("placeholder brand assets written to", os.path.abspath(a.out))


if __name__ == "__main__":
    main()
