# -*- coding: utf-8 -*-
"""
小程序演示视频 · 合成为片
用法：
  <python> compose.py --config demo/config.json [--scenes scenes.json] [--marks marks.json]
  <python> compose.py --config demo/config.json --preview 30   # 只出一帧 JPG，用于快速调版式

产出（outDir）：
  <outName>.mp4 / <outName>-字幕.srt / <outName>-封面.jpg / <outName>-演示脚本.json

时间轴约定：marks.json 里的 start/end 是「相对录制开始」的秒数；
demo 段从 scenes[0].start 起算，合成时对录屏做 -ss 定位，章节/字幕/旁白/进度全部基于这个相对时间。
"""
import argparse
import io
import json
import math
import os
import subprocess
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1440, 900
FPS = 25
COVER_SEC = 3.4
OUTRO_SEC = 3.0

PANEL_X = 520
PHONE_PAD = 11


# ---------------------------------------------------------------- 工具
def hex_rgb(s, fallback):
    if not isinstance(s, str) or not s.startswith('#') or len(s) != 7:
        return fallback
    return tuple(int(s[i:i + 2], 16) for i in (1, 3, 5))


def rgb(c, a=255):
    return tuple(c) + (a,)


def read_json(p):
    with open(p, 'r', encoding='utf-8-sig') as f:
        return json.load(f)


def find_ffmpeg(cfg):
    cands = [cfg.get('ffmpeg'), os.environ.get('DSH_FFMPEG_PATH')]
    tmp = os.environ.get('TEMP', '')
    if tmp and os.path.isdir(tmp):
        for d in os.listdir(tmp):
            if not d.lower().startswith('ffmpeg'):
                continue
            for root, _, files in os.walk(os.path.join(tmp, d)):
                for f in files:
                    if f.lower() == 'ffmpeg.exe':
                        cands.append(os.path.join(root, f))
    cands += [r'C:\ffmpeg\bin\ffmpeg.exe']
    for c in cands:
        if c and os.path.isfile(c):
            return c
    raise SystemExit('找不到 ffmpeg：config.ffmpeg 或 DSH_FFMPEG_PATH 指定一个')


def font(size, bold=False):
    path = r'C:\Windows\Fonts\msyhbd.ttc' if bold else r'C:\Windows\Fonts\msyh.ttc'
    return ImageFont.truetype(path, size)


def wrap(text, fnt, max_w, draw):
    lines, cur = [], ''
    for ch in text:
        trial = cur + ch
        if draw.textlength(trial, font=fnt) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = ch
    if cur:
        lines.append(cur)
    return lines


# ---------------------------------------------------------------- 画面
def detect_device_rect(png):
    """在桌面截图里找模拟器屏幕：左右边缘列贯穿的连续区域，再按整行占比补回圆角。"""
    a = np.asarray(Image.open(png).convert('RGB')).astype(int)
    bg = a[300, 700]
    roi = a[100:1050, 600:1400]
    mask = np.abs(roi - bg).max(axis=2) > 14

    cols = np.where(mask.mean(axis=0) > 0.55)[0]
    c0, c1 = cols.min(), cols.max()
    left = mask[:, c0:c0 + 8].mean(axis=1) > 0.8
    right = mask[:, c1 - 8:c1 + 1].mean(axis=1) > 0.8
    rows = left & right

    best, cur = (0, -1), None
    for i, v in enumerate(rows):
        if v and cur is None:
            cur = i
        elif not v and cur is not None:
            if i - cur > best[1] - best[0]:
                best = (cur, i)
            cur = None
    if cur is not None and len(rows) - cur > best[1] - best[0]:
        best = (cur, len(rows))

    r0, r1 = best
    full = mask[:, c0:c1 + 1].mean(axis=1) > 0.75
    while r0 > 0 and full[r0 - 1] and best[0] - r0 < 60:
        r0 -= 1
    while r1 < len(full) and full[r1] and r1 - best[1] < 60:
        r1 += 1

    band = mask[r0:r1, :]
    ccols = np.where(band.mean(axis=0) > 0.9)[0]
    c0, c1 = ccols.min(), ccols.max()
    return int(c0 + 600), int(r0 + 100), int(c1 - c0 + 1), int(r1 - r0)


def sync_offset(meta, rect, ff, workdir):
    """用「稳定页 → 登录页」的整屏跳变校正抓屏启动误差（秒）。"""
    x, y, w, h = rect
    dur = min(8.0, meta['syncAt'] + 4)
    raw = os.path.join(workdir, 'sync.raw')
    subprocess.run([ff, '-y', '-v', 'error', '-i', meta['file'], '-t', str(dur),
                    '-vf', f'crop={w}:{h}:{x}:{y},fps=10,scale=160:-1',
                    '-pix_fmt', 'gray', '-f', 'rawvideo', raw], check=True)
    data = np.fromfile(raw, dtype=np.uint8)
    fh, fw = int(round(h * 160 / w)), 160
    frames = data.reshape(-1, fh, fw).astype(np.int16)
    diffs = np.abs(np.diff(frames, axis=0)).mean(axis=(1, 2))
    detected = (int(np.argmax(diffs)) + 1) / 10.0
    offset = detected - meta['syncAt']
    print(f'  sync: detected={detected:.2f}s expect={meta["syncAt"]:.2f}s offset={offset:+.2f}s')
    return offset


class Look:
    """把 config.json 里的文字与配色一次性解析成绘图常量。"""

    def __init__(self, cfg):
        theme = cfg.get('theme') or {}
        self.accent = hex_rgb(theme.get('accent'), (226, 75, 54))
        self.bg_top = hex_rgb(theme.get('bgTop'), (32, 22, 19))
        self.bg_bottom = hex_rgb(theme.get('bgBottom'), (18, 12, 10))
        self.cream = hex_rgb(theme.get('cream'), (243, 231, 224))
        self.muted = hex_rgb(theme.get('muted'), (183, 156, 143))
        self.dim = hex_rgb(theme.get('dim'), (138, 112, 101))
        self.brand = cfg.get('brand', '演示')
        self.tagline = cfg.get('tagline', '')
        self.subtitle = cfg.get('subtitle', '')
        self.watermark = cfg.get('watermark', '')
        self.foot = cfg.get('footNote', '')
        self.cover = cfg.get('cover') or {}
        self.outro = cfg.get('outro') or {}
        ph = cfg.get('phone') or {}
        self.phone_x = int(ph.get('x', 104))
        self.phone_y = int(ph.get('y', 63))

    def bg(self):
        t = np.linspace(0, 1, H)[:, None, None]
        arr = np.repeat(np.array(self.bg_top, float) * (1 - t) + np.array(self.bg_bottom, float) * t, W, axis=1)
        img = Image.fromarray(arr.astype(np.uint8), 'RGB')
        glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        gd.ellipse([-260, 240, 620, 1160], fill=rgb(self.accent, 30))
        gd.ellipse([980, -420, 1720, 320], fill=rgb(self.accent, 18))
        return Image.alpha_composite(img.convert('RGBA'), glow.filter(ImageFilter.GaussianBlur(130))).convert('RGB')

    def phone(self, base, screen):
        sw, sh = screen.size
        radius = 46
        bx, by = self.phone_x - PHONE_PAD, self.phone_y - PHONE_PAD
        bw, bh = sw + PHONE_PAD * 2, sh + PHONE_PAD * 2

        shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).rounded_rectangle(
            [bx - 6, by + 12, bx + bw + 6, by + bh + 28], radius=radius + 8, fill=(0, 0, 0, 180))
        base.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(22)))

        d = ImageDraw.Draw(base)
        d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=radius + 6, fill=(9, 7, 6, 255))
        d.rounded_rectangle([bx + 2, by + 2, bx + bw - 2, by + bh - 2], radius=radius + 4,
                            outline=(255, 255, 255, 26), width=2)

        mask = Image.new('L', (sw, sh), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, sw - 1, sh - 1], radius=radius, fill=255)
        base.paste(screen, (bx + PHONE_PAD, by + PHONE_PAD), mask)

    def static(self, scenes):
        img = self.bg().convert('RGBA')
        d = ImageDraw.Draw(img)
        d.text((PANEL_X, 38), self.tagline, font=font(19), fill=self.muted)
        d.text((PANEL_X, 70), self.brand, font=font(50, True), fill=self.cream)
        d.text((PANEL_X, 146), self.subtitle, font=font(21), fill=self.muted)
        for i, (x, y, w, h) in enumerate(chapter_boxes(len(scenes))):
            d.rounded_rectangle([x, y, x + w, y + h], radius=12, fill=(255, 255, 255, 12))
            d.text((x + 16, y + 8), f'{i + 1:02d}', font=font(12, True), fill=self.dim)
            d.text((x + 16, y + 26), scenes[i]['chapter'], font=font(19), fill=(208, 185, 173))
        if self.watermark:
            d.text((self.phone_x, 866), self.watermark, font=font(15), fill=(118, 96, 86))
        if self.foot:
            d.text((PANEL_X, 856), self.foot, font=font(15), fill=(118, 96, 86))
        return img

    def cover_layer(self, n_scenes):
        c = self.cover
        layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        d.rounded_rectangle([500, 292, 506, 462], radius=3, fill=rgb(self.accent))
        d.text((536, 278), c.get('title', self.brand), font=font(64, True), fill=rgb(self.cream))
        d.text((540, 376), c.get('subtitle', ''), font=font(27), fill=rgb((212, 184, 171)))
        for i, ln in enumerate(c.get('lines', [])):
            d.text((540, 444 + i * 36), ln, font=font(21), fill=rgb(self.dim))
        note = c.get('note') or f'{n_scenes} 个功能场景 · 录制自微信开发者工具模拟器'
        d.text((540, 546), note, font=font(18), fill=(120, 98, 88, 255))
        chip = c.get('chip', '')
        if chip:
            tw = d.textlength(chip, font=font(19))
            d.rounded_rectangle([540, 604, 540 + tw + 40, 654], radius=25, fill=(255, 255, 255, 10))
            d.rounded_rectangle([540, 604, 540 + tw + 40, 654], radius=25, outline=rgb(self.accent, 150), width=1)
            d.text((560, 616), chip, font=font(19), fill=(228, 160, 143, 255))
        return layer

    def outro_layer(self):
        o = self.outro
        layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        d.text((W // 2, 396), o.get('title', '谢谢观看'), font=font(62, True), fill=rgb(self.cream), anchor='mm')
        lines = o.get('lines', [])
        if lines:
            d.text((W // 2, 480), lines[0], font=font(25), fill=rgb(self.muted), anchor='mm')
        d.rounded_rectangle([W // 2 - 40, 516, W // 2 + 40, 522], radius=3, fill=rgb(self.accent))
        if len(lines) > 1:
            d.text((W // 2, 564), lines[1], font=font(19), fill=(150, 124, 112, 255), anchor='mm')
        return layer

    def caption(self, scene, index, total):
        layer = Image.new('RGBA', (880, 220), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        d.rounded_rectangle([0, 26, 5, 140], radius=3, fill=rgb(self.accent))
        d.text((26, 22), f'{index + 1:02d} / {total:02d}  {scene["chapter"]}', font=font(17, True), fill=rgb(self.accent))
        fnt = font(29)
        for i, ln in enumerate(wrap(scene['caption'], fnt, 820, d)[:4]):
            d.text((26, 54 + i * 42), ln, font=fnt, fill=(236, 223, 216))
        return layer

    def highlight(self, box, text):
        x, y, w, h = box
        layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        d.rounded_rectangle([0, 0, w - 1, h - 1], radius=12, fill=rgb(self.accent))
        d.text((16, 26), text, font=font(19, True), fill=(255, 255, 255))
        return layer


def chapter_boxes(n):
    cols, cw, ch, gap = 3, 272, 56, 10
    return [(PANEL_X + (i % cols) * (cw + gap), 228 + (i // cols) * (ch + gap), cw, ch) for i in range(n)]


# ---------------------------------------------------------------- 声音
def build_audio(marks, rel_starts, total_sec, audio_dir, out_wav):
    rate = 44100
    total = int(math.ceil(total_sec * rate)) + rate // 4
    track = np.zeros(total, dtype=np.float32)
    if os.path.isdir(audio_dir):
        for i, sc in enumerate(marks['scenes']):
            f = os.path.join(audio_dir, f"{i + 1:02d}-{sc['id']}.wav")
            if not os.path.isfile(f):
                continue
            with wave.open(f, 'rb') as w:
                data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
            s = max(0, int((COVER_SEC + rel_starts[i] + 0.35) * rate))
            e = min(total, s + len(data))
            if e > s:
                track[s:e] += data[: e - s]
    peak = float(np.abs(track).max()) if len(track) else 0.0
    if peak > 0.97:
        track *= 0.97 / peak
    fade = int(rate * 0.25)
    if len(track) > fade:
        track[-fade:] *= np.linspace(1, 0, fade)
    with wave.open(out_wav, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((track * 32767).astype(np.int16).tobytes())


def fmt_srt(sec):
    ms = int(round(sec * 1000))
    return f'{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}'


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--config', required=True)
    ap.add_argument('--scenes')
    ap.add_argument('--marks')
    ap.add_argument('--out-dir')
    ap.add_argument('--preview', type=float, help='只渲染 t 秒处的一帧 JPG')
    args = ap.parse_args()

    cfg_path = os.path.abspath(args.config)
    cfg = read_json(cfg_path)
    base = os.path.dirname(cfg_path)
    work = os.path.join(base, cfg.get('workDir') or '.')
    scenes_path = os.path.abspath(args.scenes or os.path.join(base, cfg.get('scenes') or 'scenes.json'))
    marks_path = os.path.abspath(args.marks or os.path.join(work, 'marks.json'))
    out_dir = os.path.abspath(args.out_dir or cfg.get('outDir') or os.path.join(base, 'out'))

    scenes_cfg = read_json(scenes_path)
    marks = read_json(marks_path)
    scenes = marks['scenes']
    look = Look(cfg)
    ff = find_ffmpeg(cfg)

    still = os.path.join(work, 'capture', 'still.png')
    os.makedirs(os.path.dirname(still), exist_ok=True)
    subprocess.run([ff, '-y', '-v', 'error', '-i', marks['file'], '-frames:v', '1', still], check=True)
    x, y, w, h = detect_device_rect(still)
    print('  device rect:', (x, y, w, h))

    offset = sync_offset(marks, (x, y, w, h), ff, os.path.join(work, 'capture'))
    demo_r0 = scenes[0]['start'] - offset
    rel_starts = [s['start'] - offset - demo_r0 for s in scenes]
    rel_ends = [s['end'] - offset - demo_r0 for s in scenes]
    demo_len = rel_ends[-1] + 1.2
    total_sec = COVER_SEC + demo_len + OUTRO_SEC
    n = len(scenes)

    static = look.static(scenes_cfg['scenes'])
    cover = look.cover_layer(n)
    outro = look.outro_layer()
    boxes = chapter_boxes(n)
    caps = [look.caption(s, i, n) for i, s in enumerate(scenes)]
    highs = [look.highlight(boxes[i], scenes_cfg['scenes'][i]['chapter']) for i in range(n)]

    def scene_at(rel):
        idx = 0
        for k, rs in enumerate(rel_starts):
            if rs <= rel + 0.001:
                idx = k
        return idx

    def frame_at(rel, screen, live=True):
        canvas = static.copy() if live else look.bg().convert('RGBA')
        if live:
            look.phone(canvas, screen)
        d = ImageDraw.Draw(canvas)
        si = scene_at(rel)
        canvas.alpha_composite(highs[si], (boxes[si][0], boxes[si][1]))
        canvas.alpha_composite(caps[si], (PANEL_X - 4, 496))
        prog = min(1.0, max(0.0, rel / max(0.001, demo_len)))
        d.rounded_rectangle([PANEL_X, 800, 1340, 806], radius=3, fill=(255, 255, 255, 22))
        d.rounded_rectangle([PANEL_X, 800, PANEL_X + int(820 * prog), 806], radius=3, fill=rgb(look.accent))
        d.text((1340, 774), f'{si + 1:02d} / {n:02d}', font=font(16, True), fill=look.muted, anchor='ra')
        return canvas

    if args.preview is not None:
        t = args.preview
        if t < COVER_SEC:
            home = os.path.join(work, 'capture', 'home.png')
            subprocess.run([ff, '-y', '-v', 'error', '-ss', f'{max(0.0, marks["syncAt"] - 1.6):.2f}',
                            '-i', marks['file'], '-frames:v', '1', '-vf', f'crop={w}:{h}:{x}:{y}', home], check=True)
            canvas = look.bg().convert('RGBA')
            look.phone(canvas, Image.open(home).convert('RGB'))
            canvas.alpha_composite(cover)
        else:
            rel = t - COVER_SEC
            raw = os.path.join(work, 'capture', 'preview.raw')
            subprocess.run([ff, '-y', '-v', 'error', '-ss', f'{demo_r0 + rel:.3f}', '-i', marks['file'],
                            '-frames:v', '1', '-vf', f'crop={w}:{h}:{x}:{y}', '-pix_fmt', 'rgb24',
                            '-f', 'rawvideo', raw], check=True)
            canvas = frame_at(rel, Image.frombytes('RGB', (w, h), open(raw, 'rb').read()))
        os.makedirs(out_dir, exist_ok=True)
        out = os.path.join(out_dir, f'preview-{args.preview:.0f}.jpg')
        canvas.convert('RGB').save(out, quality=92)
        print('  preview ->', out)
        return

    os.makedirs(out_dir, exist_ok=True)
    name = cfg.get('outName') or 'demo'
    video = os.path.join(out_dir, f'{name}.mp4')
    audio = os.path.join(work, 'capture', 'narration.wav')
    build_audio(marks, rel_starts, total_sec, os.path.join(base, cfg.get('audio') or 'audio'), audio)

    png = subprocess.run([ff, '-v', 'error', '-ss', f'{max(0.0, marks["syncAt"] - 1.6):.2f}',
                          '-i', marks['file'], '-frames:v', '1', '-vf', f'crop={w}:{h}:{x}:{y}',
                          '-f', 'image2pipe', '-vcodec', 'png', '-'], capture_output=True).stdout
    cover_base = look.bg().convert('RGBA')
    look.phone(cover_base, Image.open(io.BytesIO(png)).convert('RGB'))
    cover_base.alpha_composite(cover)
    cover_base.convert('RGB').save(os.path.join(out_dir, f'{name}-封面.jpg'), quality=92)

    dec = subprocess.Popen([ff, '-v', 'error', '-ss', f'{demo_r0:.3f}', '-i', marks['file'],
                            '-vf', f'crop={w}:{h}:{x}:{y}', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
                           stdout=subprocess.PIPE)
    enc = subprocess.Popen([ff, '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
                            '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-', '-i', audio,
                            '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
                            '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', video],
                           stdin=subprocess.PIPE)

    demo_frames_start = int(COVER_SEC * FPS)
    demo_frames = int(demo_len * FPS)
    total_frames = int(round(total_sec * FPS))
    frame_bytes = w * h * 3
    last = None

    for i in range(total_frames):
        idx = i - demo_frames_start
        if 0 <= idx < demo_frames:
            buf = dec.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            canvas = frame_at(idx / FPS, Image.frombytes('RGB', (w, h), buf))
            if idx < 0.55 * FPS:
                canvas = Image.blend(cover_base, canvas, min(1.0, idx / (0.55 * FPS)))
            last = canvas.convert('RGB')
            frame = last.tobytes()
        elif i < demo_frames_start:
            canvas = cover_base.copy()
            scrim = Image.new('RGBA', (W, H), (0, 0, 0, int(255 * (1 - min(1.0, i / (0.5 * FPS))))))
            canvas.alpha_composite(scrim)
            frame = canvas.convert('RGB').tobytes()
        else:
            tail = (i - demo_frames_start - demo_frames) / FPS
            base_img = Image.blend(last, Image.new('RGB', (W, H), (20, 14, 12)), min(1.0, tail / 0.5))
            canvas = base_img.convert('RGBA')
            lay = outro
            t = min(1.0, max(0.0, (tail - 0.45) / 0.5), max(0.0, (OUTRO_SEC - tail) / 0.55))
            lay = lay.copy()
            lay.putalpha(int(255 * t))
            canvas.alpha_composite(lay)
            frame = canvas.convert('RGB').tobytes()
        enc.stdin.write(frame)

    enc.stdin.close()
    dec.stdout.close()
    dec.wait()
    enc.wait()
    print('  video ->', video, os.path.getsize(video) // 1024, 'KB')

    lines = []
    for i, sc in enumerate(scenes):
        s = COVER_SEC + rel_starts[i] + 0.2
        e = COVER_SEC + rel_ends[i] - 0.1
        if i + 1 < len(scenes):
            e = min(e, COVER_SEC + rel_starts[i + 1] + 0.2)
        lines.append(f'{i + 1}\n{fmt_srt(max(0, s))} --> {fmt_srt(max(s + 1, e))}\n{sc["caption"]}\n')
    with open(os.path.join(out_dir, f'{name}-字幕.srt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))

    plan = {
        'name': marks.get('name'), 'title': cfg.get('cover', {}).get('title', look.brand),
        'subtitle': cfg.get('cover', {}).get('subtitle', ''), 'fps': FPS,
        'durationSec': round(total_sec, 1),
        'cover': {'title': look.brand, 'subtitle': cfg.get('cover', {}).get('subtitle', ''), 'durationSec': COVER_SEC},
        'narration': os.path.getsize(audio) > 0,
        'source': 'WeChat DevTools simulator / miniprogram-automator + ffmpeg ddagrab',
        'scenes': [{'chapter': s['chapter'], 'caption': s['caption'],
                    'start': round(COVER_SEC + rel_starts[i] + 0.2, 2),
                    'end': round(COVER_SEC + rel_ends[i] - 0.1, 2)} for i, s in enumerate(scenes)],
    }
    with open(os.path.join(out_dir, f'{name}-演示脚本.json'), 'w', encoding='utf-8') as f:
        json.dump(plan, f, ensure_ascii=False, indent=2)
    print(f'  srt / cover / plan written; total {round(total_sec, 1)}s')


if __name__ == '__main__':
    main()
