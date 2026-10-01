"""v3.15.4: выдачи админки переживают траты в РЕАЛЬНОМ формате нового клиента.

Сценарии:
 A) Новый сервер: клиент в дельт-режиме НЕ шлёт абсолютную валюту (только d*).
    — idle-синк (heartbeat) подхватывает выдачу;
    — траты после выдачи учитываются (grant + spend = итог);
    — ответы содержат маркер apiVersion: 3.
 B) Мок СТАРОГО сервера (merge только по абсолютному значению, d* игнорирует):
    — новый клиент (без abs в дельт-режиме) НЕ затирает выдачу (сервер держит prev);
    — известное ограничение: траты старый сервер не записывает (возврат при синке) —
      именно для этого в админ-UI есть баннер (apiVersion отсутствует).
"""
import json, threading, time, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = "http://localhost:8081"
ADMIN = "echo-admin"
OLD_PORT = 8091

def req(base, method, path, body=None, tok=None, admin=False):
    headers = {"content-type": "application/json"}
    if tok: headers["authorization"] = f"Bearer {tok}"
    if admin: headers["x-admin-key"] = ADMIN
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as e:
        try: return e.code, json.load(e)
        except Exception: return e.code, {}

ok = 0; fail = 0
def check(name, cond, extra=""):
    global ok, fail
    if cond: ok += 1; print(f"  PASS  {name} {extra}")
    else: fail += 1; print(f"  FAIL  {name} {extra}")

# =====================================================================
print("=== A. Новый сервер: формат нового клиента (без abs в дельт-режиме) ===")
# =====================================================================
login_ = f"v3154{int(time.time()) % 100000}"
s, j = req(BASE, "POST", "/api/auth/register", {"login": login_, "password": "test1234"})
check("register", s == 200, f"pid={j.get('pid')}")
pid = j.get("pid"); tok = j.get("accessToken")

# A1. Первый синк (нет lastSynced): абсолют, без дельт — формат нового клиента
s, j = req(BASE, "POST", "/api/profile",
           {"pid": pid, "nick": login_, "shards": 1000, "gems": 100, "mmr": 1000, "wins": 0, "losses": 0, "freeOpens": 2, "bpXp": 0}, tok=tok)
prof = j.get("profile", {})
check("first sync (abs, no d)", s == 200 and prof.get("shards") == 1000, f"shards={prof.get('shards')}")
check("apiVersion:3 in profile resp", j.get("apiVersion") == 3, f"got {j.get('apiVersion')}")

def srv():
    s, j = req(BASE, "GET", f"/api/profile?pid={pid}", tok=tok)
    return j

# A2. Админ выдаёт +500
s, j = req(BASE, "POST", "/api/admin/adjust", {"login": login_, "shards": 1500}, admin=True)
check("admin grant +500", s == 200 and srv().get("shards") == 1500, f"server={srv().get('shards')}")

# A3. Idle-синк heartbeat: клиент локально ещё 1000, lastSynced=1000.
#     ФОРМАТ НОВОГО КЛИЕНТА: shards НЕ ПЕРЕДАЁТСЯ, только dShards=0.
s, j = req(BASE, "POST", "/api/profile",
           {"pid": pid, "nick": login_, "dShards": 0, "dGems": 0, "dMmr": 0, "dWins": 0, "dLosses": 0, "dFreeOpens": 0, "dBpXp": 0}, tok=tok)
resp_sh = j.get("profile", {}).get("shards")
# клиент: local = 1000 + (resp - atSend=1000)
client_local = 1000 + (resp_sh - 1000)
check("idle sync: server keeps 1500", srv().get("shards") == 1500, f"server={srv().get('shards')}")
check("idle sync: client picks up grant (1500)", client_local == 1500, f"client={client_local}")
last_synced = resp_sh  # клиент фиксирует базу

# A4. Игрок тратит 300 (бустер): локально 1200. Синк: dShards=-300, abs НЕ шлём.
s, j = req(BASE, "POST", "/api/profile",
           {"pid": pid, "nick": login_, "dShards": -300}, tok=tok)
resp_sh = j.get("profile", {}).get("shards")
client_local = 1200 + (resp_sh - 1200)
check("spend: server 1200 (1500-300)", srv().get("shards") == 1200, f"server={srv().get('shards')}")
check("spend: client 1200 (grant survived spend)", client_local == 1200, f"client={client_local}")
last_synced = resp_sh

# A5. Повторный no-op синк (applied=false → цикл не должен продолжаться):
#     дельта 0, abs не шлём. Сервер не меняется.
s, j = req(BASE, "POST", "/api/profile", {"pid": pid, "nick": login_, "dShards": 0}, tok=tok)
check("no-op sync stable at 1200", srv().get("shards") == 1200 and j.get("profile", {}).get("shards") == 1200,
      f"server={srv().get('shards')}")

# A6. Маркер apiVersion в админ-ответе (для баннера в UI)
s, j = req(BASE, "GET", "/api/admin/users", admin=True)
check("apiVersion:3 in admin/users", j.get("apiVersion") == 3, f"got {j.get('apiVersion')}")

# =====================================================================
print("\n=== B. Мок СТАРОГО сервера (merge по абсолютному, d* игнорируется) ===")
# =====================================================================
# Логика merge старого сервера (до v3.15.3): value = Number(b[key] ?? prev[key] ?? fallback)
old_state = {"shards": None, "gems": None, "mmr": None}

class OldHandler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-headers", "content-type,authorization,x-admin-key")
        self.send_header("access-control-allow-methods", "GET,POST,OPTIONS")
        self.end_headers()
        self.wfile.write(body)
    def do_OPTIONS(self):
        self._send(204, {})
    def do_GET(self):
        if self.path.startswith("/api/admin/users"):
            self._send(200, {"users": [{"login": login_, "pid": pid, "nick": login_, "shards": old_state["shards"] or 0}]})  # НЕТ apiVersion — старый сервер
        elif self.path.startswith("/api/profile?"):
            self._send(200, {"shards": old_state["shards"], "gems": old_state["gems"], "mmr": old_state["mmr"]})
        else:
            self._send(404, {"error": "nf"})
    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        b = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/api/auth/register":
            self._send(200, {"pid": pid, "accessToken": "old-tok", "login": login_}); return
        if self.path == "/api/profile":
            # СТАРЫЙ merge: абсолютное значение, если пришло; иначе prev; иначе дефолт. d* не существует.
            old_state["shards"] = int(b["shards"]) if "shards" in b and b["shards"] is not None else (old_state["shards"] if old_state["shards"] is not None else 1200)
            old_state["gems"] = int(b["gems"]) if "gems" in b and b["gems"] is not None else (old_state["gems"] if old_state["gems"] is not None else 100)
            old_state["mmr"] = int(b["mmr"]) if "mmr" in b and b["mmr"] is not None else (old_state["mmr"] if old_state["mmr"] is not None else 1000)
            self._send(200, {"ok": True, "profile": dict(old_state)})  # НЕТ apiVersion
            return
        if self.path == "/api/admin/adjust":
            if "shards" in b: old_state["shards"] = int(b["shards"])
            self._send(200, {"ok": True}); return
        self._send(404, {"error": "nf"})

srv = ThreadingHTTPServer(("127.0.0.1", OLD_PORT), OldHandler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
time.sleep(0.2)
OB = f"http://127.0.0.1:{OLD_PORT}"

# B1. Первый синк на старый сервер: абсолют (формат первого синка нового клиента)
s, j = req(OB, "POST", "/api/profile", {"pid": pid, "nick": login_, "shards": 1000, "gems": 100, "mmr": 1000})
check("old: first sync abs -> 1000", old_state["shards"] == 1000, f"server={old_state['shards']}")

# B2. Админ выдаёт +500 (старый adjust ставит абсолют)
s, j = req(OB, "POST", "/api/admin/adjust", {"shards": 1500})
check("old: admin grant -> 1500", old_state["shards"] == 1500, f"server={old_state['shards']}")

# B3. Idle-синк нового клиента: shards НЕ передаётся, dShards=0.
#     Старый сервер: b.shards отсутствует -> держит prev=1500. ВЫДАЧА СОХРАНЯЕТСЯ.
s, j = req(OB, "POST", "/api/profile", {"pid": pid, "nick": login_, "dShards": 0})
resp_sh = j.get("profile", {}).get("shards")
client_local = 1000 + (resp_sh - 1000)
check("old: grant NOT clobbered (server 1500)", old_state["shards"] == 1500, f"server={old_state['shards']}")
check("old: client picks up grant (1500)", client_local == 1500, f"client={client_local}")

# B4. Траты 300: клиент локально 1200, синк dShards=-300 без abs.
#     Старый сервер не понимает d* -> держит 1500; клиенту вернётся 1500 (возврат трат —
#     известное ограничение, баннер в админ-UI). Главное: выдача НЕ пропадает и клиент не беднеет.
s, j = req(OB, "POST", "/api/profile", {"pid": pid, "nick": login_, "dShards": -300})
resp_sh = j.get("profile", {}).get("shards")
client_local = 1200 + (resp_sh - 1200)
check("old: grant still on server (1500)", old_state["shards"] == 1500, f"server={old_state['shards']}")
check("old: client not poorer (>=1500)", client_local >= 1500, f"client={client_local}")

# B5. Маркер: старый сервер НЕ возвращает apiVersion -> админ-UI покажет баннер
s, j = req(OB, "GET", "/api/admin/users")
check("old: no apiVersion (UI will warn)", "apiVersion" not in j, f"keys={sorted(j.keys())}")

srv.shutdown()
print(f"\n=== ИТОГ: {ok} PASS / {fail} FAIL ===")
raise SystemExit(1 if fail else 0)
