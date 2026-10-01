"""v3.15: админка видит онлайн-игроков, друзья с реальным статусом, рубашки крупнее, сцена светлее, круга нет."""
import asyncio, json, urllib.request
from playwright.async_api import async_playwright

BASE = "http://localhost:8081"

def api(path, body=None, tok=None, key=None):
    req = urllib.request.Request(BASE + path, method="POST" if body is not None else "GET",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json", **({"authorization": f"Bearer {tok}"} if tok else {}), **({"x-admin-key": key} if key else {})})
    return json.load(urllib.request.urlopen(req))

def ensure_acct(login):
    try:
        r = api("/api/auth/login", {"login": login, "password": "test1234"})
    except Exception:
        r = api("/api/auth/register", {"login": login, "password": "test1234"})
    return r["accessToken"]

async def main():
    out = {"errors": [], "checks": {}}

    # --- серверная подготовка: carol + dave в сети, dave — друг carol ---
    tc = ensure_acct("carol"); td = ensure_acct("dave")
    api("/api/presence", {"status": "online"}, tok=tc)
    api("/api/presence", {"status": "online"}, tok=td)
    try: api("/api/friends/request", {"to": "dave"}, tok=tc)
    except Exception: pass
    try: api("/api/friends/accept", {"from": "carol"}, tok=td)
    except Exception: pass
    fr = api("/api/friends", None, tok=tc)["friends"]
    out["checks"]["friend_dave_status"] = next((f["status"] for f in fr if f["login"] == "dave"), None)

    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 1600, "height": 900})
        pg.on("pageerror", lambda e: out["errors"].append(str(e)))
        await pg.add_init_script("window.EC_NO_AUTH_GATE=true")
        await pg.goto("http://localhost:5173/")
        await pg.wait_for_timeout(900)
        await pg.evaluate("(()=>{const m=JSON.parse(localStorage.getItem('ec_meta_v1')||'{}');m.tutDone=true;localStorage.setItem('ec_meta_v1',JSON.stringify(m))})()")
        await pg.reload(); await pg.wait_for_timeout(1600)

        # --- админка: carol должна быть 🟢 (presence обновлён выше, окно 70с) ---
        await pg.evaluate("document.getElementById('btnAdminMenu')?.click() || document.getElementById('btnAdmin')?.click()")
        await pg.wait_for_timeout(400)
        await pg.evaluate("() => { const i = document.getElementById('adminPass'); if (i) { i.value = 'admin'; document.getElementById('btnAdminLogin')?.click(); } }")
        await pg.wait_for_timeout(500)
        await pg.evaluate("[...document.querySelectorAll('#adminTabs .admTab')].find(t=>t.dataset.tab==='users')?.click()")
        await pg.wait_for_timeout(1800)
        carol_row = await pg.evaluate("""() => {
            const tr = [...document.querySelectorAll('#adminBody tr')].find(r => r.textContent.includes('carol'));
            return tr ? tr.innerHTML : '';
        }""")
        out["checks"]["admin_carol_row_online"] = "🟢" in carol_row and "в сети" in carol_row
        out["checks"]["admin_srv_count"] = await pg.evaluate("""() => {
            const t = document.getElementById('adminBody').textContent;
            const m = t.match(/сервер: (\\d+) игроков/); return m ? Number(m[1]) : 0;
        }""")
        await pg.screenshot(path="/home/user/shots/v315_admin.png")
        await pg.evaluate("document.getElementById('btnAdminClose')?.click()")
        await pg.wait_for_timeout(300)

        # --- бой: светлая сцена, без круга, рубашки крупнее ---
        await pg.evaluate("document.getElementById('btnPlay')?.click()")
        await pg.wait_for_timeout(900)
        await pg.evaluate("document.getElementById('btnMullConfirm')?.click()")
        await pg.wait_for_timeout(1400)
        await pg.evaluate("""() => {
            const B = window.__battle, e = B.engine;
            for (const sd of [0, 1]) {
                const pl = e.p(sd);
                const ids = pl.deck.filter(id => { const c = e.db.get(id); return c && c.type === 'Creature'; }).slice(0, 3);
                for (const id of ids) e.summon(sd, e.db.get(id));
            }
            e.p(1).hand = ['x','x','x','x','x'];
            B.renderAll();
        }""")
        await pg.wait_for_timeout(700)
        out["checks"]["geo"] = await pg.evaluate("""() => {
            const back = document.querySelector('#enemyBacks .cardback');
            const cs = back ? getComputedStyle(back) : null;
            const after = getComputedStyle(document.getElementById('battle'), '::after');
            const medal = document.querySelector('#playerHero .medal');
            return { backW: cs && cs.width, backH: cs && cs.height,
                     circleDisplay: after.display,
                     medalCx: medal ? medal.getBoundingClientRect().x + medal.getBoundingClientRect().width/2 : null };
        }""")
        await pg.screenshot(path="/home/user/shots/v315_battle.png")

        # --- магазин: вкладка СЛЕЕВС (рубашки крупнее) ---
        await pg.evaluate("document.getElementById('battle').classList.add('hidden'); document.getElementById('menu')?.classList.remove('hidden')")
        await pg.wait_for_timeout(300)
        await pg.evaluate("document.getElementById('btnShop')?.click()")
        await pg.wait_for_timeout(900)
        await pg.evaluate("""() => { [...document.querySelectorAll('button, .shopTab, [data-tab]')].find(el => /^SLEEVES$/i.test(el.textContent.trim()))?.click(); }""")
        await pg.wait_for_timeout(700)
        await pg.screenshot(path="/home/user/shots/v315_shop_sleeves.png")

        print(json.dumps(out, ensure_ascii=False, indent=1))
        await b.close()

asyncio.run(main())
