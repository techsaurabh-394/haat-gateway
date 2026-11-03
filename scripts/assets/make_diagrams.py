"""Generates the explanatory SVG diagrams in assets/. Run: python3 scripts/assets/make_diagrams.py
Hand-edit this file, not the SVGs, so all diagrams keep one style system."""
from pathlib import Path
from html import escape
OUT = Path(__file__).resolve().parents[2] / "assets"

STYLE = """
  <style>
    :root { --bg:#ffffff; --ink:#1c2033; --muted:#5b6178; --indigo:#26346f; --marigold:#efa00b; --leaf:#2e7a4b; --teal:#13707f; --card:#f3f5fb; --line:#c9cee0; --on:#ffffff; --red:#b3372f; }
    @media (prefers-color-scheme: dark) {
      :root { --bg:#141831; --ink:#e9ecf7; --muted:#a6acc6; --indigo:#8fa2ec; --marigold:#f5b437; --leaf:#5cc489; --teal:#4fc0cf; --card:#1e2344; --line:#3a4170; --on:#0f1430; --red:#ef8178; }
    }
    .bg{fill:var(--bg)} .h{font:600 26px "Iowan Old Style","Palatino Linotype",Georgia,serif;fill:var(--ink)}
    .t{font:600 15px "Segoe UI","Helvetica Neue",Arial,sans-serif;fill:var(--ink)}
    .s{font:400 13px "Segoe UI","Helvetica Neue",Arial,sans-serif;fill:var(--muted)}
    .m{font:400 13px ui-monospace,"Cascadia Code",Menlo,Consolas,monospace;fill:var(--ink)}
    .card{fill:var(--card);stroke:var(--line);stroke-width:1.5}
    .life{stroke:var(--line);stroke-width:2;stroke-dasharray:4 6}
    .arrow{stroke:var(--teal);stroke-width:2.2;fill:none;marker-end:url(#ah)}
    .arrow.back{stroke:var(--indigo);stroke-dasharray:6 5;marker-end:url(#ahb)}
    .arrow.human{stroke:var(--marigold);marker-end:url(#ahm)}
    .arrow.bad{stroke:var(--red);marker-end:url(#ahr)}
    .gate{fill:none;stroke:var(--marigold);stroke-width:2.5}
    .pill{fill:var(--indigo)} .pilltxt{font:600 13px "Segoe UI",Arial,sans-serif;fill:var(--on)}
    .good{fill:var(--leaf)} .warn{fill:var(--marigold)} .teal{fill:var(--teal)}
  </style>
  <defs>
    <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10z" style="fill:var(--teal)"/></marker>
    <marker id="ahb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10z" style="fill:var(--indigo)"/></marker>
    <marker id="ahm" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10z" style="fill:var(--marigold)"/></marker>
    <marker id="ahr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10z" style="fill:var(--red)"/></marker>
  </defs>"""

def svg(w, h, title, desc, body, extra_style=""):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-labelledby="t d">
  <title id="t">{escape(title)}</title>
  <desc id="d">{escape(desc)}</desc>{STYLE}{extra_style}
  <rect class="bg" width="{w}" height="{h}"/>
{body}
</svg>
'''

def text(x, y, s, cls="s", anchor="start"):
    return f'  <text class="{cls}" x="{x}" y="{y}" text-anchor="{anchor}">{escape(s)}</text>\n'

def card(x, y, w, h, title, sub=None, rx=12):
    out = f'  <rect class="card" x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}"/>\n' + text(x + 14, y + 24, title, "t")
    if sub:
        for i, line in enumerate(sub if isinstance(sub, list) else [sub]):
            out += text(x + 14, y + 44 + i * 18, line, "s")
    return out

# ---------------------------------------------------------------- order flow (animated)
def order_flow():
    W, H = 1100, 820
    cols = {"agent": 130, "haat": 420, "bg": 690, "seller": 960}
    names = {"agent": ("Personal agent", "acts for the User"), "haat": ("Haat gateway", "Poppy Company + ONDC buyer app"), "bg": ("Registry / Beckn gateway", "lookup and search fan-out"), "seller": ("ONDC seller (BPP)", "e.g. Assi Sabzi Mandi")}
    body = text(40, 50, "One order, end to end", "h")
    body += text(40, 76, "Poppy on the left, Beckn on the right. The order is placed only after the person's yes, and only once.", "s")
    for k, x in cols.items():
        body += f'  <rect class="card" x="{x-110}" y="100" width="220" height="56" rx="12"/>\n' + text(x, 124, names[k][0], "t", "middle") + text(x, 144, names[k][1], "s", "middle")
        body += f'  <line class="life" x1="{x}" y1="156" x2="{x}" y2="{H-30}"/>\n'
    steps = [
        ("agent", "haat", "GET /.well-known/poppy.json", ""),
        ("agent", "haat", "GET /api/v1/search?q=2 kilo aata", "Session JWT on every request"),
        ("haat", "bg", "search (Ed25519-signed)", "one per item"),
        ("bg", "seller", "forward to sellers in std:0542", ""),
        ("seller", "haat", "on_search: catalog", "back"),
        ("agent", "haat", "POST /api/v1/orders (cart)", ""),
        ("haat", "seller", "select, then init", "price, stock, delivery, payment"),
        ("haat", "agent", "403 approval_required + summary", "back"),
        ("agent", "agent", "Person reads the summary and says yes", "human"),
        ("agent", "haat", "same POST + Poppy-Approval", ""),
        ("haat", "seller", "confirm", "exactly once"),
        ("haat", "agent", "201 order KKS-1001", "retry returns the same order"),
    ]
    y = 200
    css = "\n  <style>\n    .st{opacity:.18;animation:step 14s infinite}\n    @keyframes step{0%{opacity:.18}3%{opacity:1}100%{opacity:1}}\n"
    for i, (a, b, label, note) in enumerate(steps):
        delay = i * 1.0
        css += f"    .s{i}{{animation-delay:{delay}s}}\n"
        back = note == "back" or (x_is_back := cols[b] < cols[a])
        cls = "arrow back" if back else ("arrow human" if note == "human" else "arrow")
        g = f'  <g class="st s{i}">\n'
        if a == b:
            x = cols[a]
            g += f'    <rect x="{x-10}" y="{y-16}" width="20" height="32" rx="4" style="fill:var(--marigold)"/>\n'
            g += text(x + 24, y + 5, label, "t")
        else:
            x1, x2 = cols[a], cols[b]
            d = 1 if x2 > x1 else -1
            g += f'    <line class="{cls}" x1="{x1 + d*6}" y1="{y}" x2="{x2 - d*8}" y2="{y}"/>\n'
            lx = (x1 + x2) / 2
            g += text(lx, y - 8, label, "m", "middle")
            if note and note not in ("back", "human"):
                g += text(lx, y + 18, note, "s", "middle")
        g += f'    <text class="s" x="22" y="{y+5}">{i+1}</text>\n  </g>\n'
        body += g
        y += 52
    css += "    @media (prefers-reduced-motion: reduce){.st{animation:none;opacity:1}}\n  </style>"
    # approval gate band around steps 8-10
    top = 200 + 7 * 52 - 27
    bottom = 200 + 10 * 52 + 29
    body += f'  <rect class="gate" x="44" y="{top}" width="{W-70}" height="{bottom-top}" rx="14"/>\n'
    body += text(W - 40, bottom - 8, "Operations extension v2: exact terms, at most once", "s", "end")
    return svg(W, H, "Order sequence", "Sequence of Poppy and Beckn messages from discovery to a confirmed order, with the human approval step highlighted.", body, css)

# ---------------------------------------------------------------- architecture
def architecture():
    W, H = 1100, 730
    b = text(40, 50, "Architecture", "h")
    b += text(40, 76, "One gateway, two protocols. Personal agents never see Beckn keys; sellers never see agent keys.", "s")
    b += card(40, 120, 220, 440, "Personal agents", ["any Poppy client,", "e.g. Meta Muse (demo)", "", "client metadata + JWKS", "delegated keys per User", "Session JWT per request", "", "shows summaries,", "asks the person,", "sends Poppy-Approval", "", "signs in with PKCE"])
    # gateway
    b += f'  <rect class="card" x="310" y="110" width="480" height="560" rx="16" style="stroke:var(--marigold);stroke-width:2.5"/>\n'
    b += text(330, 140, "Haat gateway", "t") + text(450, 140, "src/", "s")
    layers = [
        ("Poppy layer", "src/poppy", ["discovery: poppy.json, OpenAPI", "session.ts: Session JWT, ES256/PS384 delegations", "operations.ts: approval gate, at most once", "conversations.ts: events, cursors, SSE"], "--teal"),
        ("Commerce", "src/commerce, src/lexicon", ["normalize.ts: Hinglish + Hindi to terms", "basket.ts: pack sizes, single seller", "service.ts: quote, confirm, status, cancel", "assistant.ts: rule-based Company Agent"], "--marigold"),
        ("Sign-in + storage", "src/oauth, src/store", ["server.ts: PKCE, client assertions, tokens", "kv.ts: SQLite or bounded memory, caps"], "--leaf"),
        ("Beckn buyer app + ONDC", "src/beckn, src/ondc", ["signing.ts: Ed25519 + BLAKE2b-512", "bap.ts: async calls, callback matching", "onboarding.ts: subscribe, on_subscribe"], "--indigo"),
    ]
    y = 160
    for name, path, lines, color in layers:
        h = 42 + 20 * len(lines)
        b += f'  <rect x="330" y="{y}" width="440" height="{h}" rx="10" class="card"/>\n  <rect x="330" y="{y}" width="6" height="{h}" rx="3" style="fill:var({color})"/>\n'
        b += text(348, y + 22, name, "t") + text(760, y + 22, path, "s", "end")
        for i, l in enumerate(lines):
            b += text(348, y + 44 + i * 20, l, "s")
        y += h + 14
    b += card(840, 120, 220, 110, "Registry", ["who is who: keys + URLs", "signing_public_key lookup"])
    b += card(840, 250, 220, 90, "Beckn gateway (BG)", ["fans search out to sellers"])
    b += card(840, 360, 220, 140, "Sellers (BPP)", ["kirana, dairy, sabzi", "answer on_search,", "on_select, on_init,", "on_confirm, ..."])
    b += f'  <line class="arrow" x1="262" y1="300" x2="306" y2="300"/>\n' + text(284, 290, "Poppy", "s", "middle")
    b += f'  <line class="arrow" x1="792" y1="300" x2="836" y2="300"/>\n' + text(814, 290, "Beckn", "s", "middle")
    b += f'  <line class="arrow back" x1="838" y1="430" x2="794" y2="430"/>\n' + text(816, 450, "on_*", "s", "middle")
    b += text(40, 705, "Local development replaces the right column with mock-network/: a registry, a BG and three Varanasi sellers.", "s")
    return svg(W, H, "Architecture", "Personal agents talk Poppy to the Haat gateway, which talks signed Beckn to the ONDC registry, gateway and sellers.", b)

# ---------------------------------------------------------------- approval gate
def gate():
    W, H = 1100, 470
    b = text(40, 50, "The approval gate", "h")
    b += text(40, 76, "Every order and cancellation passes through it. Approval covers one exact revision; the action runs at most once.", "s")
    nodes = {
        "req": (60, 150, 190, "Request arrives", ["no approval yet"]),
        "ask": (320, 150, 230, "approval_required", ["quote: select + init", "operation_id + revision"]),
        "perf": (630, 150, 190, "performing", ["Beckn confirm"]),
        "done": (890, 150, 170, "performed", ["result stored,", "replayed on retry"]),
    }
    for k, (x, y, w, t, sub) in nodes.items():
        b += card(x, y, w, 64 + 18 * (len(sub) - 1), t, sub)
    b += f'  <line class="arrow" x1="252" y1="182" x2="316" y2="182"/>\n'
    b += f'  <line class="arrow human" x1="552" y1="182" x2="626" y2="182"/>\n' + text(589, 170, "person: yes", "s", "middle")
    b += f'  <line class="arrow" x1="822" y1="182" x2="886" y2="182"/>\n'
    # loops
    b += f'  <path class="arrow bad" d="M 435 236 C 435 300 360 300 360 240"/>\n' + text(300, 318, "changed cart, expired, or another Session's", "s") + text(300, 336, "approval: nothing runs, new revision", "s")
    b += f'  <path class="arrow back" d="M 725 216 C 725 300 500 330 470 240"/>\n' + text(560, 372, "seller says no: back to approvable", "s")
    b += f'  <path class="arrow back" d="M 760 216 C 820 290 860 290 900 290"/>\n' + text(905, 288, "outcome unknown:", "s") + text(905, 306, "503 + Retry-After,", "s") + text(905, 324, "never 'failed'", "s")
    b += f'  <path class="arrow back" d="M 1000 218 C 1000 260 960 260 960 222"/>\n' + text(940, 250, "same approval again", "s", "end")
    b += text(40, 430, "Spec: Personal Agent Protocol draft 0.3, Operations extension version 2, sections 3 to 7. Code: src/poppy/operations.ts. Tests: test/operations.test.ts.", "s")
    return svg(W, H, "Approval gate state machine", "States of an operation from request to approval to a single performed action, with the paths for changed terms, failures and unknown outcomes.", b)

# ---------------------------------------------------------------- hinglish pipeline
def pipeline():
    W, H = 1100, 400
    b = text(40, 50, "From how people type to what sellers sell", "h")
    b += text(40, 76, "Data-driven: every word list lives in packs/<domain>/lexicon.json, so adding a language is a pull request with no code.", "s")
    cols = [
        ("You type", ['"do kilo aata aur', '1 litre doodh"']),
        ("Split + quantities", ["[do kilo] aata", "[1 litre] doodh", "split on aur / और"]),
        ("Phonetic key", ["aata, atta: ata", "doodh, dudh: dud", "दूध stays दूध"]),
        ("Lexicon term", ["wheat flour, 2000 g", "milk, 1000 ml"]),
        ("Basket", ["2 × Atta 1 kg", "1 × Milk 1 L", "one seller, least waste"]),
    ]
    x = 40
    for i, (t, lines) in enumerate(cols):
        w = 188
        b += f'  <rect class="card" x="{x}" y="120" width="{w}" height="170" rx="12"/>\n'
        b += f'  <rect x="{x}" y="120" width="{w}" height="6" rx="3" style="fill:var({["--indigo","--teal","--teal","--marigold","--leaf"][i]})"/>\n'
        b += text(x + 14, 152, t, "t")
        for j, l in enumerate(lines):
            b += text(x + 14, 182 + j * 24, l, "m" if i < 3 else "s")
        if i < len(cols) - 1:
            b += f'  <line class="arrow" x1="{x + w + 4}" y1="205" x2="{x + w + 24}" y2="205"/>\n'
        x += w + 28
    b += text(40, 330, "Known limits: English loanwords, regional spellings not yet in the lexicon, and look-alike words. A test pins every fixed case,", "s")
    b += text(40, 350, "e.g. 'makhana' (fox nuts) must never match 'makhan' (butter).", "s")
    return svg(W, H, "Hinglish pipeline", "A request typed in Hinglish is split into items, quantities are extracted, spelling variants are matched with a phonetic key and a lexicon, and a single-seller basket is built.", b)

for name, fn in [("order-flow.svg", order_flow), ("architecture.svg", architecture), ("approval-gate.svg", gate), ("hinglish-pipeline.svg", pipeline)]:
    (OUT / name).write_text(fn(), encoding="utf-8")
    print("wrote", name)
