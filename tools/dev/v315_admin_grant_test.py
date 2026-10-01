"""v3.15.3: выдачи админки (монеты/гемы/рейтинг) сохраняются у игрока
и не затираются его локальным синком профиля (дельта-модель)."""
import json, urllib.request, urllib.error, time

BASE = "http://localhost:8081"
ADMIN = "echo-admin"

def req(method, path, body=None, tok=None, admin=False):
    headers = {"content-type": "application/json"}
    if tok: headers["authorization"] = f"Bearer {tok}"
    if admin: headers["x-admin-key"] = ADMIN
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as e:
        try: return e.code, json.load(e)
        except Exception: return e.code, {}

def login(l, p):
    s, j = req("POST", "/api/auth/login", {"login": l, "password": p})
    return s, j

def register(l, p):
    s, j = req("POST", "/api/auth/register", {"login": l, "password": p})
    return s, j

ok = 0; fail = 0
def check(name, cond, extra=""):
    global ok, fail
    if cond: ok += 1; print(f"  PASS  {name} {extra}")
    else: fail += 1; print(f"  FAIL  {name} {extra}")

login_ = f"grant{int(time.time()) % 100000}"
s, j = register(login_, "test1234")
check("register", s == 200, f"pid={j.get('pid')}")
pid = j.get("pid"); tok = j.get("accessToken")

# 1) первичный синк клиента: абсолютные значения (нет lastSynced)
s, j = req("POST", "/api/profile", {"pid": pid, "nick": login_, "shards": 1000, "gems": 100, "mmr": 1000, "wins": 0, "losses": 0}, tok=tok)
check("first sync (abs)", s == 200, f"shards={j.get('profile', {}).get('shards')}")

def srv_shards():
    s, j = req("GET", f"/api/profile?pid={pid}", tok=tok)
    return j.get("shards")

check("server shards=1000", srv_shards() == 1000, f"got {srv_shards()}")

# 2) АДМИН выдаёт +500 монет (как в UI: u.shards + 500)
s, j = req("POST", "/api/admin/adjust", {"login": login_, "shards": 1500}, admin=True)
check("admin grant +500", s == 200, f"server={srv_shards()}")
check("server shards=1500 after grant", srv_shards() == 1500, f"got {srv_shards()}")

# 3) КЛИЕНТ (локально всё ещё 1000, lastSynced=1000) синчится БЕЗ трат: dShards=0, abs=1000 (старое)
s, j = req("POST", "/api/profile", {"pid": pid, "nick": login_, "shards": 1000, "dShards": 0, "gems": 100, "dGems": 0, "mmr": 1000, "dMmr": 0}, tok=tok)
check("client sync (stale abs=1000, d=0)", s == 200, f"resp_shards={j.get('profile', {}).get('shards')}")
got = srv_shards()
check("GRANT SURVIVED client sync (still 1500, not 1000)", got == 1500, f"got {got}")
check("response echoes 1500 to client", j.get("profile", {}).get("shards") == 1500)

# 4) Клиент тратит 300: локально 1200, lastSynced=1500 -> dShards=-300
s, j = req("POST", "/api/profile", {"pid": pid, "nick": login_, "shards": 1200, "dShards": -300}, tok=tok)
got = srv_shards()
check("spend -300 -> server 1200", got == 1200, f"got {got}")

# 5) Повторный синк без изменений: dShards=0
s, j = req("POST", "/api/profile", {"pid": pid, "nick": login_, "shards": 1200, "dShards": 0}, tok=tok)
check("no-op sync keeps 1200", srv_shards() == 1200, f"got {srv_shards()}")

# 6) АДМИН выдаёт гемы и рейтинг; клиент синцит старыми абс-значениями
s, j = req("POST", "/api/admin/adjust", {"login": login_, "gems": 150, "mmr": 1600}, admin=True)
check("admin grant gems/mmr", s == 200)
s, j = req("POST", "/api/profile", {"pid": pid, "nick": login_, "gems": 100, "dGems": 0, "mmr": 1000, "dMmr": 0}, tok=tok)
s2, prof = req("GET", f"/api/profile?pid={pid}", tok=tok)
check("gems grant survived (150)", prof.get("gems") == 150, f"got {prof.get('gems')}")
check("mmr grant survived (1600)", prof.get("mmr") == 1600, f"got {prof.get('mmr')}")

# 7) Клиент «уходит» и тратит монеты, потом возвращается (синк с дельтой от lastSynced=1200)
#    локально: 1200 - 500 = 700, dShards = -500
s, j = req("POST", "/api/profile", {"pid": pid, "nick": login_, "shards": 700, "dShards": -500}, tok=tok)
check("offline spend -500 -> 700", srv_shards() == 700, f"got {srv_shards()}")

# 8) РЕГИСТРАЦИЯ/ВОХОД с нуля: pullProfile читает актуальные значения
s, prof = req("GET", f"/api/profile?pid={pid}", tok=tok)
check("pullProfile sees final state (700/150/1600)",
      prof.get("shards") == 700 and prof.get("gems") == 150 and prof.get("mmr") == 1600,
      f"got {prof.get('shards')}/{prof.get('gems')}/{prof.get('mmr')}")

print(f"\n=== ИТОГ: {ok} PASS / {fail} FAIL ===")
