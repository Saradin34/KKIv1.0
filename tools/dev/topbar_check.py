#!/usr/bin/env python3
"""v3.10.1: геометрия топбара. python3 tools/dev/topbar_check.py"""
import asyncio
from playwright.async_api import async_playwright

async def page_at(p, w, h):
    pg = await p.chromium.launch() if False else None
    return None

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for W in (1920, 1440, 1280):
            pg = await b.new_page(viewport={'width': W, 'height': 860})
            await pg.add_init_script("window.EC_NO_AUTH_GATE=true")
            await pg.goto('http://localhost:5173/', wait_until='networkidle')
            await pg.wait_for_timeout(500)
            await pg.evaluate("(()=>{const m=JSON.parse(localStorage.getItem('ec_meta_v1')||'{}');m.tutDone=true;localStorage.setItem('ec_meta_v1',JSON.stringify(m))})()")
            await pg.reload(); await pg.wait_for_timeout(1100)
            await pg.evaluate("document.getElementById('tourOverlay')?.classList.add('hidden')")
            r = await pg.evaluate("""() => {
              const cx = el => { const b = el.getBoundingClientRect(); return Math.round(b.x + b.width/2); };
              const logo = document.querySelector('#arenaTopNav .ecLogoPlate');
              const ico = [...document.querySelectorAll('#ecIconNav .ecIco')].map(e => Math.round(e.getBoundingClientRect().x));
              const gaps = ico.slice(1).map((x,i) => x - ico[i]);
              const util = [...document.querySelectorAll('#ecUtilNav .ecIco')].map(e => Math.round(e.getBoundingClientRect().x));
              const wallet = document.getElementById('topWallet').getBoundingClientRect();
              const nav = document.getElementById('arenaTopNav').getBoundingClientRect();
              const lbl = getComputedStyle(document.querySelector('#ecIconNav .ecIcoLbl')).display;
              const ovf = [...document.querySelectorAll('#arenaTopNav *')].some(e => { const b=e.getBoundingClientRect(); return b.right > nav.right + 1; });
              return {W: innerWidth, logoCenter: cx(logo), half: Math.round(innerWidth/2),
                      gapsMin: Math.min(...gaps), gapsMax: Math.max(...gaps), lbl,
                      utilAfterWallet: util.length ? util[0] > wallet.right : null, utilX: util, ovf};
            }""")
            print(W, r)
            await pg.screenshot(path=f'/home/user/shots/tb_{W}.png', clip={'x':0,'y':0,'width':W,'height':70})
            if W == 1440:
                await pg.evaluate("const a=document.getElementById('btnAdmin'); a.style.display='inline-flex'")
                await pg.wait_for_timeout(200)
                await pg.screenshot(path='/home/user/shots/tb_admin.png', clip={'x':0,'y':0,'width':W,'height':70})
            await pg.close()
        # мобилка
        pg = await b.new_page(viewport={'width': 390, 'height': 844})
        await pg.add_init_script("window.EC_NO_AUTH_GATE=true")
        await pg.goto('http://localhost:5173/', wait_until='networkidle')
        await pg.wait_for_timeout(500)
        await pg.evaluate("(()=>{const m=JSON.parse(localStorage.getItem('ec_meta_v1')||'{}');m.tutDone=true;localStorage.setItem('ec_meta_v1',JSON.stringify(m))})()")
        await pg.reload(); await pg.wait_for_timeout(1100)
        await pg.evaluate("document.getElementById('tourOverlay')?.classList.add('hidden')")
        r = await pg.evaluate("""() => ({
          util: getComputedStyle(document.getElementById('ecUtilNav')).display,
          cluster: getComputedStyle(document.getElementById('ecRightCluster')).display,
          walletRight: Math.round(document.getElementById('topWallet').getBoundingClientRect().right),
          vw: innerWidth })""")
        print(390, r)
        await pg.screenshot(path='/home/user/shots/tb_390.png', clip={'x':0,'y':0,'width':390,'height':60})
        await pg.close()
        await b.close()

asyncio.run(main())
