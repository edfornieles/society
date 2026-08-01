#!/usr/bin/env python3
"""Build the presentation export: one folder per session, each scene image
composited with its in-game caption card (title + description) in the game's
own visual style (parchment panel, chunky border, offset shadow, retro fonts).
"""
import json, os, re, sys, urllib.request
from PIL import Image, ImageDraw, ImageFont

BASE = "https://edfornieles.com/society"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = "/Users/edfornieles/society/society-sessions"
CATALOG = os.path.join(HERE, "sessions-export.json")

# Game palette (globals.css)
PANEL = (244, 216, 183, 245)   # rgba(244,216,183,0.96)
BORDER = (85, 50, 29, 255)     # --border #55321d
SHADOW = (42, 23, 15, 255)     # --shadow #2a170f
INK = (43, 26, 20, 255)        # --ink #2b1a14

TITLE_FONT = os.path.join(HERE, "PressStart2P.ttf")
BODY_FONT = os.path.join(HERE, "VT323.ttf")

def slug(s, n=48):
    s = re.sub(r"[^a-zA-Z0-9]+", "-", str(s or "untitled")).strip("-").lower()
    return (s or "untitled")[:n]

RAW_CACHE = os.path.join(HERE, "raw-cache")
os.makedirs(RAW_CACHE, exist_ok=True)

def fetch(url, dest):
    """Fetch a media image with a local cache, gentle pacing, retries, and a
    direct-R2 (wrangler) fallback for objects the Worker rate-limits."""
    import shutil, subprocess, time
    key = url.split("/api/media/", 1)[-1]           # game-images/{sid}/{ts}.png
    cached = os.path.join(RAW_CACHE, key.replace("/", "_"))
    if os.path.exists(cached) and os.path.getsize(cached) > 1000:
        shutil.copyfile(cached, dest)
        return
    last = None
    for attempt in range(3):
        try:
            time.sleep(0.3 + attempt * 2)
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (export)"})
            with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
                f.write(r.read())
            if os.path.getsize(dest) > 1000:
                shutil.copyfile(dest, cached)
                return
            last = Exception("empty response")
        except Exception as e:
            last = e
            if "404" in str(e):
                raise
    # Worker keeps refusing — pull the object straight from R2.
    r = subprocess.run(
        ["npx", "wrangler", "r2", "object", "get", f"society-canyon/{key}", "--file", dest, "--remote"],
        capture_output=True, timeout=120, cwd="/Users/edfornieles/society")
    if r.returncode == 0 and os.path.exists(dest) and os.path.getsize(dest) > 1000:
        shutil.copyfile(dest, cached)
        return
    raise last or Exception("fetch failed")

def wrap(draw, text, font, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = f"{cur} {w}".strip()
        if draw.textlength(t, font=font) <= max_w:
            cur = t
        else:
            if cur: lines.append(cur)
            cur = w
    if cur: lines.append(cur)
    return lines

def composite(img_path, title, caption, counter, out_path):
    im = Image.open(img_path).convert("RGBA")
    W, H = im.size
    scale = W / 1024.0
    # COMPACT card (v2): the first pass filled ~half the frame and buried the
    # artwork. Half-size fonts, slim padding, fit-content width, low placement.
    pad = int(13 * scale)
    bw = max(2, int(3 * scale))            # border width
    sh = max(3, int(6 * scale))            # shadow offset
    title_font = ImageFont.truetype(TITLE_FONT, max(10, int(14 * scale)))
    body_font = ImageFont.truetype(BODY_FONT, max(14, int(21 * scale)))
    small_font = ImageFont.truetype(BODY_FONT, max(11, int(15 * scale)))

    max_text_w = int(W * 0.62)
    dr = ImageDraw.Draw(im)

    title_lines = wrap(dr, (title or "SOCIETY SCENE").upper(), title_font, max_text_w)
    cap_lines = wrap(dr, caption or "", body_font, max_text_w) if caption else []
    if len(cap_lines) > 5:                 # safety: never let a rambling caption regrow the card
        cap_lines = cap_lines[:5]
        cap_lines[-1] = cap_lines[-1].rstrip(".,;") + "…"

    # Fit-content panel width from the widest actual line.
    widest = max(
        [dr.textlength(l, font=title_font) for l in title_lines]
        + [dr.textlength(l, font=body_font) for l in cap_lines]
        + [1]
    )
    panel_w = min(int(widest) + 2 * pad, W - int(80 * scale))
    text_w = panel_w - 2 * pad

    th = title_font.size + int(5 * scale)
    bh = int(body_font.size * 1.02)
    content_h = len(title_lines) * th + (int(7 * scale) if cap_lines else 0) + len(cap_lines) * bh
    if counter:
        content_h += small_font.size + int(3 * scale)
    panel_h = content_h + 2 * pad

    x0 = (W - panel_w) // 2
    y0 = H - int(38 * scale) - panel_h
    overlay = Image.new("RGBA", im.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.rectangle([x0 + sh, y0 + sh, x0 + panel_w + sh, y0 + panel_h + sh], fill=SHADOW)  # shadow
    od.rectangle([x0, y0, x0 + panel_w, y0 + panel_h], fill=PANEL, outline=BORDER, width=bw)
    im = Image.alpha_composite(im, overlay)
    dr = ImageDraw.Draw(im)

    y = y0 + pad
    for ln in title_lines:
        lw = dr.textlength(ln, font=title_font)
        dr.text((x0 + (panel_w - lw) / 2, y), ln, font=title_font, fill=INK)
        y += th
    if cap_lines:
        y += int(12 * scale)
        for ln in cap_lines:
            lw = dr.textlength(ln, font=body_font)
            dr.text((x0 + (panel_w - lw) / 2, y), ln, font=body_font, fill=INK)
            y += bh
    if counter:
        lw = dr.textlength(counter, font=small_font)
        dr.text((x0 + (panel_w - lw) / 2, y + int(4 * scale)), counter, font=small_font, fill=(107, 75, 59, 255))

    im.convert("RGB").save(out_path, "PNG")

def main():
    data = json.load(open(CATALOG))
    sessions = data["sessions"]
    os.makedirs(OUT, exist_ok=True)
    done_imgs = skipped = failed = 0
    used_names = set()
    for s in sorted(sessions, key=lambda x: x.get("updatedAt") or 0, reverse=True):
        imgs = [i for i in s["images"] if i.get("imagePath")]
        if not imgs:
            skipped += 1
            continue
        name = slug(s["title"])
        if name in used_names:
            name = f"{name}-{s['id'][:6]}"
        used_names.add(name)
        sdir = os.path.join(OUT, name)
        os.makedirs(sdir, exist_ok=True)
        # Session info sheet
        with open(os.path.join(sdir, "session-info.txt"), "w") as f:
            f.write(f"Title: {s['title']}\nCore value: {s.get('coreValue','')}\n"
                    f"Turns: {s.get('turnCount')}\nImages: {len(imgs)}\nSession id: {s['id']}\n\n"
                    f"Summary:\n{s.get('summary','(none)')}\n")
        for i, img in enumerate(imgs):
            out_png = os.path.join(sdir, f"{i+1:02d}-{slug(img['title'], 40)}.png")
            if os.path.exists(out_png):
                done_imgs += 1
                continue
            raw = os.path.join(sdir, f".raw-{i+1:02d}.png")
            try:
                fetch(BASE + img["imagePath"].replace("/api/media", "/api/media"), raw)
                counter = f"{i+1} / {len(imgs)}" if len(imgs) > 1 else ""
                composite(raw, img["title"], img["caption"], counter, out_png)
                os.remove(raw)
                done_imgs += 1
            except Exception as e:
                failed += 1
                print(f"  FAIL {s['title'][:30]} #{i+1}: {e}", file=sys.stderr)
    print(f"composited={done_imgs} failed={failed} empty_sessions_skipped={skipped}")

if __name__ == "__main__":
    main()
