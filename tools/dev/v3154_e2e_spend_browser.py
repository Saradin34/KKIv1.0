"""v3.15.4 E2E в браузере: РЕАЛЬНЫЙ сценарий из баг-репорта пользователя.
Один игрок (один контекст, без перезаходов):
  1) входит, кошелёк S0;
  2) админ выдаёт +500 (игрок НИЧЕГО не делает);
  3) ≤35 с — фоновый синк (heartbeat) подхватывает выдачу: кошелёк S0+500;
  4) игрок покупает бустер за 300 → кошелёк S0+500-300;
  5) синк траты: на сервере S0+500-300 (выдача НЕ затёрлась тратой).
"""
import asyncio, json, time, tempfile, urllib.request, urllib.error
from playwright.async_api import async_playwright

BASE_UI = "http://localhost:5173/"
BASE_API = "http://localhost:8081"
ADMIN = "echo-admin"

def api(method, path, body=None, admin=False, tok=None):
    h = {"content-type": "application/json"}
    if admin: h["x-admin-key"] = ADMIN
    if tok: h["authorization"] = f"Bearer {tok}"
    d = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE_API + path, data=d, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=5) as resp: return resp.status, json.load(resp)
    except urllib.error.HTTPError as e:
        try: return e.code, json.load(e)
        except Exception: return e.code, {}

LOGIN = f"spend{int(time.time()) % 100000}"
PASSW = "test1234"

async def wallet(page):
    t = await page.text_content("#shardBal")
    return int(t.strip()) if t and t.strip().isdigit() else None

async def main():
    # регистр + профиль с S0=1000
    s, j = api("POST", "/api/auth/register", {"login": LOGIN, "password": PASSW})
    assert s == 200, f"register {s} {j}"
    pid, tok = j["pid"], j["accessToken"]
    s, j = api("POST", "/api/profile",
               {"pid": pid, "nick": LOGIN, "shards": 1000, "gems": 100, "mmr": 1000, "wins": 0, "losses": 0}, tok=tok)
    assert s == 200, f"first sync {s} {j}"
    S0 = 1000

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(tempfile.mkdtemp(prefix="dev"), headless=True)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        page.set_default_timeout(15000)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        prof_posts = []
        page.on("request", lambda r: prof_posts.append((round(time.time(), 2), (r.post_data or "")[:160]))
               if "8081" in r.url and r.method == "POST" and "/api/profile" in r.url else None)
        await page.goto(BASE_UI)
        await page.wait_for_selector("#authLogin", state="visible", timeout=15000)
        await page.fill("#authLogin", LOGIN)
        await page.fill("#authPass", PASSW)
        await page.click("#authSubmit")
        await page.wait_for_function(
            "() => { const m = document.getElementById('authModal'); return m && (m.classList.contains('hidden') || !m.classList.contains('gate')); }",
            timeout=15000)
        await page.wait_for_function(
            "() => { const b = document.getElementById('shardBal'); return b && b.textContent !== '' && b.textContent !== '0'; }",
            timeout=15000)
        await page.wait_for_timeout(600)

        w0 = await wallet(page)
        assert w0 == S0, f"wallet after login: {w0} != {S0}"
        print(f"1) login: wallet = {w0}")

        # 2) админ выдаёт +500, игрок не действует
        s, j = api("POST", "/api/admin/adjust", {"login": LOGIN, "shards": S0 + 500}, admin=True)
        assert s == 200, f"adjust {s} {j}"
        print("2) admin +500 (player idle)")

        # 3) ждём фоновый синк ≤35 с (heartbeat 30 с)
        w1 = None
        for _ in range(35):
            await page.wait_for_timeout(1000)
            w1 = await wallet(page)
            if w1 == S0 + 500: break
        assert w1 == S0 + 500, f"HEARTBEAT: wallet stayed {w1}, expected {S0 + 500}"
        print(f"3) heartbeat pickup: wallet = {w1} (idle ≤35s)")

        # 4) игрок покупает бустер за 300: открыть магазин -> предложение p1 (gold)
        await page.evaluate("() => { const t = document.getElementById('tourOverlay'); if (t) t.remove(); }")  # обучающий оверлей не по делу теста
        await page.click("button[data-proxy=\"btnShop\"]")
        await page.wait_for_selector("button.buyPackOffer[data-offer=\"p1\"][data-cur=\"gold\"]", state="visible", timeout=15000)
        await page.click("button.buyPackOffer[data-offer=\"p1\"][data-cur=\"gold\"]")
        await page.wait_for_timeout(800)
        w2 = await wallet(page)
        dbg_buy = await page.evaluate("window.__syncDbg ? window.__syncDbg() : null")
        print(f"   syncDbg@buy={dbg_buy}")
        assert w2 == S0 + 500 - 300, f"wallet after buy: {w2}, expected {S0 + 500 - 300}"
        print(f"4) buy pack -300: wallet = {w2}")

        # 5) metaSave от покупки → синк через 1.5 с: на сервере выдача - трата
        #    (v3.16: srv1 обновляем ДО проверки break — раньше при успехе в srv1
        #     оставалось устаревшее значение первого GET, тест падал ложно)
        dbg5 = []
        srv1 = None
        for _ in range(10):
            await page.wait_for_timeout(1000)
            s, j = api("GET", f"/api/profile?pid={pid}", tok=tok)
            srv1 = j["shards"]
            dbg5.append((round(time.time(), 1), srv1, await page.evaluate("window.__syncDbg ? window.__syncDbg() : null")))
            if srv1 == S0 + 500 - 300: break
        if srv1 != S0 + 500 - 300:
            print("   DEBUG profile-POSTs (t, body):")
            for t, b in prof_posts:
                print(f"     {t}  {b}")
            print("   DEBUG step5 (t, server, syncDbg):")
            for row in dbg5:
                print(f"     {row}")
            print("   ERRORS:", errs)
        assert srv1 == S0 + 500 - 300, f"server after spend: {srv1}, expected {S0 + 500 - 300} (grant clobbered!)"
        print(f"5) server after spend = {srv1} (grant survived the spend)")

        # финал: кошелёк всё ещё корректен, повторный синк не сломал
        await page.wait_for_timeout(2500)
        w3 = await wallet(page)
        assert w3 == S0 + 500 - 300, f"wallet after extra sync: {w3}"
        print(f"6) wallet stable = {w3}, errors={errs}")

        await ctx.close()

    print("\n=== PASS: idle-выдача + трата: выдача переживает трату (S0=%d -> +500 -> -300 = %d) ===" % (S0, S0 + 200))

asyncio.run(main())
