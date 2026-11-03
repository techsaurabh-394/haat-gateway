"""Records scripts/site/explainer.html to site/media/explainer.mp4/.webm (needs playwright, Google Chrome, ffmpeg)."""
import os, glob, shutil, subprocess
from playwright.sync_api import sync_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
M = os.path.join(ROOT, 'site', 'media'); os.makedirs(M, exist_ok=True)
SRC = 'file://' + os.path.join(ROOT, 'scripts', 'site', 'explainer.html') + '#manual'
shutil.rmtree('/tmp/rec2', ignore_errors=True)
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome')
    ctx = b.new_context(viewport={'width': 1280, 'height': 810}, record_video_dir='/tmp/rec2', record_video_size={'width': 1280, 'height': 810})
    pg = ctx.new_page(); errs = []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(SRC); pg.wait_for_timeout(400)
    pg.screenshot(path='/tmp/ex_first.png')
    pg.evaluate('window.__start()')
    pg.wait_for_function('window.__done', timeout=120000); pg.wait_for_timeout(600)
    pg.screenshot(path='/tmp/ex_last.png')
    dur = pg.evaluate('window.__done'); ctx.close(); b.close()
    print('duration ms', dur, 'console errors', errs)
v = glob.glob('/tmp/rec2/*.webm')[0]
shutil.copy(v, os.path.join(M, 'explainer.webm'))
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', v, '-vf', 'crop=1280:720:0:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-movflags', '+faststart', os.path.join(M, 'explainer.mp4')], check=True)
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '30', '-i', os.path.join(M, 'explainer.mp4'), '-frames:v', '1', os.path.join(M, 'explainer-poster.png')], check=True)
print('ok')
