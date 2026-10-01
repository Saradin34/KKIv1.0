#!/usr/bin/env python3
"""v3.10: проверка навигации значками. Использование: python3 tools/dev/nav_test.py"""
import asyncio, sys
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        # --- десктоп 1440: клики по значкам ---
        pg = await b.new_page(viewport={'width': 1440, 'height': 860})
        await pg.add_init_script("window.EC_NO_AUTH_GATE=true")
        await pg.add_init_script("window.EC_NO_AUTH_GATE=true")
        await pg.goto('http://localhost:5173/', wait_until='networkidle')
        await pg.wait_for_timeout(600)
        await pg.evaluate("(()=>{const m=JSON.parse(localStorage.getItem('ec_meta_v1')||'{}');m.tutDone=true;localStorage.setItem('ec_meta_v1',JSON.stringify(m))})()")
        await pg.reload(); await pg.wait_for_timeout(1200)
        await pg.evaluate("document.getElementById('tourOverlay')?.classList.add('hidden')")
        res = []
        async def click(sel):
            el = pg.locator(sel)
            if await el.count() == 0: return f'{sel}: НЕТ'
            await el.first.click()
            await pg.wait_for_timeout(450)
            route = await pg.evaluate("document.body.dataset.appRoute||''")
            vis = await pg.evaluate("""() => {
              const q=s=>{const n=document.querySelector(s);return !!n && getComputedStyle(n).display!=='none' && !n.classList.contains('hidden')};
              return {qn:q('#ecQuickNav'), mn:q('#menuNav'), burger:q('#btnBurger'), icons:q('#ecIconNav')};
            }""")
            return f'{sel} -> route="{route}" vis={vis}'
        res.append(await click('#ecIconNav .ecIco[data-route="store"]'))
        res.append(await click('#ecIconNav .ecIco[data-proxy="btnCollection"]'))
        res.append(await click('#ecIconNav .ecIco[data-route="events"]'))
        res.append(await click('#ecIconNav .ecIco[data-proxy="btnBP"]'))
        res.append(await click('#ecIconNav .ecIco[data-route="home"]'))
        act = await pg.evaluate("Array.from(document.querySelectorAll('#ecIconNav .ecIco.active')).map(x=>x.dataset.route||x.dataset.proxy).join(',')")
        res.append(f'active после home: {act}')
        print('\n'.join(res))
        await pg.screenshot(path='/home/user/shots/nav_1440.png', clip={'x':0,'y':0,'width':1440,'height':70})
        await pg.close()
        # --- 1280: подписи скрыты ---
        pg = await b.new_page(viewport={'width': 1280, 'height': 800})
        await pg.add_init_script("window.EC_NO_AUTH_GATE=true")
        await pg.goto('http://localhost:5173/', wait_until='networkidle')
        await pg.wait_for_timeout(500)
        await pg.evaluate("(()=>{const m=JSON.parse(localStorage.getItem('ec_meta_v1')||'{}');m.tutDone=true;localStorage.setItem('ec_meta_v1',JSON.stringify(m))})()")
        await pg.reload(); await pg.wait_for_timeout(900)
        await pg.evaluate("document.getElementById('tourOverlay')?.classList.add('hidden')")
        st = await pg.evaluate("""() => {
          const l=document.querySelector('#ecIconNav .ecIco .ecIcoLbl');
          const q=getComputedStyle(document.getElementById('ecQuickNav')).display;
          return {lbl: l?getComputedStyle(l).display:'none', qn:q};
        }""")
        print('1280:', st)
        await pg.screenshot(path='/home/user/shots/nav_1280.png', clip={'x':0,'y':0,'width':1280,'height':70})
        await pg.close()
        # --- 1024: бургер + drawer с новыми пунктами ---
        pg = await b.new_page(viewport={'width': 1024, 'height': 768})
        await pg.add_init_script("window.EC_NO_AUTH_GATE=true")
        await pg.goto('http://localhost:5173/', wait_until='networkidle')
        await pg.wait_for_timeout(500)
        await pg.evaluate("(()=>{const m=JSON.parse(localStorage.getItem('ec_meta_v1')||'{}');m.tutDone=true;localStorage.setItem('ec_meta_v1',JSON.stringify(m))})()")
        await pg.reload(); await pg.wait_for_timeout(900)
        await pg.evaluate("document.getElementById('tourOverlay')?.classList.add('hidden')")
        st = await pg.evaluate("""() => {
          const d=getComputedStyle(document.getElementById('ecIconNav')).display;
          const bk=getComputedStyle(document.getElementById('btnBurger')).display;
          return {icons:d, burger:bk};
        }""")
        print('1024:', st)
        await pg.click('#btnBurger')
        await pg.wait_for_timeout(400)
        await pg.screenshot(path='/home/user/shots/drawer_1024.png')
        # клик по новому пункту drawer
        await pg.click('#ecDrawer [data-route="events"]')
        await pg.wait_for_timeout(500)
        r = await pg.evaluate("document.body.dataset.appRoute")
        dr = await pg.evaluate("document.getElementById('arenaTopNav').classList.contains('ecOpen')")
        print('1024 drawer events -> route=', r, 'drawerOpen=', dr)
        await pg.close()
        await b.close()

asyncio.run(main())
