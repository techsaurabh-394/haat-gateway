"""Records the landing page demo to site/media (needs: pip install playwright, Google Chrome, ffmpeg)."""
import sys, subprocess, glob, os, shutil
from playwright.sync_api import sync_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8765/'
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
M = os.path.join(ROOT, 'site', 'media'); os.makedirs(M, exist_ok=True)
shutil.rmtree('/tmp/rec', ignore_errors=True)
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome')
    ctx = b.new_context(viewport={'width': 1280, 'height': 720}, record_video_dir='/tmp/rec', record_video_size={'width': 1280, 'height': 720})
    pg = ctx.new_page(); errs = []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(URL); pg.wait_for_timeout(500)
    pg.screenshot(path=os.path.join(M, 'demo-poster.png'))
    pg.wait_for_timeout(7000)                       # hero animation + typing
    pg.evaluate("document.querySelector('#demo').scrollIntoView({behavior:'smooth'})"); pg.wait_for_timeout(1800)
    pg.wait_for_selector('.gate #yes', timeout=20000); pg.wait_for_timeout(1500)
    pg.click('.gate #yes'); pg.wait_for_timeout(5500)
    pg.click('#chips .chip:nth-child(3)'); pg.wait_for_selector('.gate #yes', timeout=20000); pg.wait_for_timeout(1200)
    pg.click('.gate #yes'); pg.wait_for_timeout(5000)
    pg.evaluate("document.querySelector('#how').scrollIntoView({behavior:'smooth'})"); pg.wait_for_timeout(3500)
    pg.evaluate("document.querySelector('#features').scrollIntoView({behavior:'smooth'})"); pg.wait_for_timeout(3500)
    pg.evaluate("document.querySelector('#languages').scrollIntoView({behavior:'smooth'})"); pg.wait_for_timeout(3500)
    ctx.close(); b.close()
    print('console errors:', errs)
v = glob.glob('/tmp/rec/*.webm')[0]
shutil.copy(v, os.path.join(M, 'demo.webm'))
subprocess.run(['ffmpeg','-y','-loglevel','error','-i',v,'-c:v','libx264','-pix_fmt','yuv420p','-crf','24','-movflags','+faststart',os.path.join(M,'demo.mp4')],check=True)
# GIF for README (first ~22s, 720 wide)
subprocess.run(['ffmpeg','-y','-loglevel','error','-t','24','-i',v,'-vf','fps=10,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',os.path.join(M,'demo.gif')],check=True)
print(os.popen(f'ls -la {M}').read())
