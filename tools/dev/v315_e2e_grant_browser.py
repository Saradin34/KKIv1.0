"""v3.15.3 E2E в браузере: игрок видит выдачу админки после (пере)входа.
Устройство 1 входит -> кошелёк S0. Админ выдаёт +500.
Устройство 2 (свежий контекст) входит -> кошелёк должен быть S0+500."""
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

LOGIN = f"e2e{int(time.time()) % 100000}"
PASSW = "test1234"

async def login_and_read_wallet(b: async_playwright, ctx_idx: int) -> tuple:
    ctx = await b.chromium.launch_persistent_context(tempfile.mkdtemp(prefix="dev"), headless=True)
    page = ctx.pages[0] if ctx.pages else await ctx.new_page()
    page.set_default_timeout(15000)
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    await page.goto(BASE_UI)
    # дождаться авторизационного гейта
    await page.wait_for_selector("#authLogin", state="visible", timeout=15000)
    await page.fill("#authLogin", LOGIN)
    await page.fill("#authPass", PASSW)
    await page.click("#authSubmit")
    # гейт исчез (войшли)
    await page.wait_for_function(
        "() => { const m = document.getElementById('authModal'); return m && (m.classList.contains('hidden') || !m.classList.contains('gate')); }",
        timeout=15000)
    # кошелёк заполнен
    await page.wait_for_function("() => { const b = document.getElementById('shardBal'); return b && b.textContent !== '' && b.textContent !== '0'; }", timeout=15000)
    await page.wait_for_timeout(600)
    wallet = await page.text_content("#shardBal")
    # дубль: и в бустер-инвентаре
    wal2 = await page.text_content("#boosterShardBal")
    return int(wallet.strip()), int(wal2.strip()) if wal2 and wal2.strip() else None, errs, ctx

async def main():
    # 1) регистр + первичный синк (shards=1000)
    s, j = api("POST", "/api/auth/register", {"login": LOGIN, "password": PASSW})
    assert s == 200, f"register {s} {j}"
    pid, tok = j["pid"], j["accessToken"]
    s, j = api("POST", "/api/profile",
               {"pid": pid, "nick": LOGIN, "shards": 1000, "gems": 100, "mmr": 1000, "wins": 0, "losses": 0},
               tok=tok)
    assert s == 200, f"first sync {s} {j}"
    s, j = api("GET", f"/api/profile?pid={pid}", tok=tok)
    assert s == 200, f"get {s} {j}"
    s0_srv = j["shards"]
    print(f"server initial shards = {s0_srv} (pid={pid})")

    async with async_playwright() as p:
        # устройство 1
        w1, w1b, e1, ctx1 = await login_and_read_wallet(p, 1)
        print(f"DEVICE1 wallet = {w1} (booster {w1b})  errors={e1}")
        await ctx1.close()

        # 2) админ выдаёт +500
        s, j = api("POST", "/api/admin/adjust", {"login": LOGIN, "shards": s0_srv + 500}, admin=True)
        assert s == 200, f"adjust {s} {j}"
        s, j = api("GET", f"/api/profile?pid={pid}", tok=tok)
        srv_after = j["shards"]
        print(f"server after admin +500 = {srv_after}")

        # устройство 2 (свежий контекст = новое устройство)
        w2, w2b, e2, ctx2 = await login_and_read_wallet(p, 2)
        print(f"DEVICE2 wallet = {w2} (booster {w2b})  errors={e2}")
        await ctx2.close()

    ok = (w1 == s0_srv) and (w2 == s0_srv + 500) and not e1 and not e2
    print("\n=== " + ("PASS: игрок видит выдачу админа (S0=%d -> S1=%d), 0 ошибок JS" % (w1, w2) if ok
                     else "FAIL (S0=%d, srv0=%d, S1=%d, srv1=%d, err1=%s, err2=%s)" % (w1, s0_srv, w2, srv_after, e1, e2)) + " ===")

asyncio.run(main())
