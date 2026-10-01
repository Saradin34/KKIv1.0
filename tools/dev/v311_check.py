#!/usr/bin/env python3
"""v3.11: скриншоты новых разделов. python3 tools/dev/v311_check.py"""
import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        await pg.add_init_script("window.EC_NO_AUTH_GATE=true")
        await pg.goto('http://localhost:5173/', wait_until='networkidle')
        await pg.wait_for_timeout(600)
        await pg.evaluate("""(()=>{const m=JSON.parse(localStorage.getItem('ec_meta_v1')||'{}');m.tutDone=true;localStorage.setItem('ec_meta_v1',JSON.stringify(m));localStorage.setItem('ec_admin_v1','1')})()""")
        await pg.reload(); await pg.wait_for_timeout(1300)
        await pg.evaluate("document.getElementById('tourOverlay')?.classList.add('hidden')")
        # магазин: наборы
        await pg.evaluate("window.ecNavigate('store')")
        await pg.wait_for_timeout(900)
        await pg.click('button.stab[data-stab="bundles"]')
        await pg.wait_for_timeout(700)
        await pg.screenshot(path='/home/user/shots/v311_sets.png')
        # косметика с бонусами
        await pg.click('button.stab[data-stab="cosm"]')
        await pg.wait_for_timeout(700)
        await pg.screenshot(path='/home/user/shots/v311_cosm.png')
        # админка: игроки
        await pg.click('#btnAdmin')
        await pg.wait_for_timeout(600)
        await pg.click('.admTab[data-tab="users"]')
        await pg.wait_for_timeout(600)
        await pg.screenshot(path='/home/user/shots/v311_admin.png')
        # скроллбар в коллекции
        await pg.evaluate("document.getElementById('adminModal')?.classList.add('hidden')")
        await pg.evaluate("window.ecNavigate('collection')")
        await pg.wait_for_timeout(1200)
        await pg.evaluate("document.querySelector('#collection .collectionScroll, #colScroll')?.scrollBy(0,300) || window.scrollBy(0,300)")
        await pg.wait_for_timeout(400)
        await pg.screenshot(path='/home/user/shots/v311_coll.png')
        await b.close()
        print('shots done')

asyncio.run(main())
