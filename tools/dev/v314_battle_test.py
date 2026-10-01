"""v3.14: живой тест боя — симметрия, оверкил (5-8=-3), конец игры."""
import asyncio, json
from playwright.async_api import async_playwright

async def main():
    out = {"errors": [], "checks": {}}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 1600, "height": 900})
        pg.on("pageerror", lambda e: out["errors"].append(str(e)))
        await pg.add_init_script("window.EC_NO_AUTH_GATE=true")
        await pg.goto("http://localhost:5173/")
        await pg.wait_for_timeout(900)
        await pg.evaluate("(()=>{const m=JSON.parse(localStorage.getItem('ec_meta_v1')||'{}');m.tutDone=true;localStorage.setItem('ec_meta_v1',JSON.stringify(m))})()")
        await pg.reload(); await pg.wait_for_timeout(1600)
        await pg.evaluate("document.getElementById('tourOverlay')?.classList.add('hidden')")

        # меню боя: выбрать противника и сложность, нажать В БОЙ
        await pg.evaluate("""() => {
            const ef = document.getElementById('enemyFaction'); if (ef) ef.value = 'Necrus';
            const df = document.getElementById('difficulty'); if (df) df.value = '0.8';
            document.getElementById('btnPlay')?.click();
        }""")
        ok = await pg.wait_for_timeout(0) is None
        # ждать муллиган
        for _ in range(60):
            shown = await pg.evaluate("!document.getElementById('mulligan').classList.contains('hidden')")
            if shown: break
            await pg.wait_for_timeout(200)
        out["checks"]["mulligan"] = shown
        await pg.evaluate("document.getElementById('btnMullConfirm')?.click()")
        await pg.wait_for_timeout(1200)
        out["checks"]["battle_visible"] = await pg.evaluate("!document.getElementById('battle').classList.contains('hidden')")

        # заполнить обе половины поля существами для снимка симметрии
        await pg.evaluate("""() => {
            const B = window.__battle, e = B.engine;
            for (const sd of [0, 1]) {
                const pl = e.p(sd);
                const ids = pl.deck.filter(id => { const c = e.db.get(id); return c && c.type === 'Creature'; }).slice(0, 3);
                for (const id of ids) e.summon(sd, e.db.get(id));
            }
            B.renderAll();
        }""")
        await pg.wait_for_timeout(700)
        out["checks"]["units_player"] = await pg.evaluate("document.querySelectorAll('#playerBoard .unit').length")
        out["checks"]["units_enemy"] = await pg.evaluate("document.querySelectorAll('#enemyBoard .unit').length")
        await pg.screenshot(path="/home/user/shots/v314_battle_sym.png")

        # геометрия симметрии: медальоны по центру экрана, зоны равной высоты
        geo = await pg.evaluate("""() => {
            const b = id => document.getElementById(id).getBoundingClientRect();
            const med = id => { const m = document.getElementById(id).querySelector('.medalWrap').getBoundingClientRect(); return m.x + m.width/2; };
            return { W: innerWidth, enemyMedalCx: med('enemyHero'), playerMedalCx: med('playerHero'),
                     eZoneH: Math.round(b('enemyBoard').height), pZoneH: Math.round(b('playerBoard').height),
                     eRowH: Math.round(b('enemyHero').height), pRowH: Math.round(b('playerHero').height) };
        }""")
        out["checks"]["geo"] = geo

        # ОВЕРКИЛ: у противника 5 HP, бьём на 8 → показать -3 и завершить игру
        await pg.evaluate("window.__battle.engine.p(1).health = 5; window.__battle.renderAll();")
        await pg.wait_for_timeout(300)
        out["checks"]["hp_before"] = await pg.evaluate("document.getElementById('enemyHp').textContent")
        await pg.evaluate("window.__battle.engine.damageHero(1, 8, { source: 'тест оверкила' })")
        await pg.wait_for_timeout(1600)
        out["checks"]["hp_after"] = await pg.evaluate("document.getElementById('enemyHp').textContent")
        out["checks"]["neg_class"] = await pg.evaluate("document.getElementById('enemyHp').closest('.hbHp').classList.contains('neg')")
        out["checks"]["result"] = await pg.evaluate("String(window.__battle.engine.result)")
        # дать циклу показать оверлей
        for _ in range(40):
            over = await pg.evaluate("!document.getElementById('gameover').classList.contains('hidden')")
            if over: break
            await pg.wait_for_timeout(200)
        out["checks"]["gameover_visible"] = over
        out["checks"]["go_title"] = await pg.evaluate("document.getElementById('goTitle').textContent")
        await pg.screenshot(path="/home/user/shots/v314_overkill.png")

        print(json.dumps(out, ensure_ascii=False, indent=1))
        await b.close()

asyncio.run(main())
