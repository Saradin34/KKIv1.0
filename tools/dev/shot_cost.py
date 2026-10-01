import asyncio
from playwright.async_api import async_playwright
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch();pg=await b.new_page(viewport={'width':1440,'height':860})
    await pg.add_init_script("window.EC_NO_AUTH_GATE=true")
    await pg.goto('http://localhost:5173');await pg.wait_for_timeout(600)
    await pg.evaluate("(()=>{const m=JSON.parse(localStorage.getItem('ec_meta_v1')||'{}');m.tutDone=true;localStorage.setItem('ec_meta_v1',JSON.stringify(m))})()")
    await pg.reload();await pg.wait_for_timeout(1200)
    await pg.evaluate("document.getElementById('tourOverlay')?.classList.add('hidden');document.getElementById('btnPlay').click()")
    await pg.wait_for_timeout(3000)
    await pg.locator('#mulligan .card').first.screenshot(path='shots_c1.png')
    await pg.evaluate("document.getElementById('btnMullSkip')?.click()");await pg.wait_for_timeout(2500)
    await pg.screenshot(path='shots_c2.png',clip={'x':0,'y':620,'width':900,'height':160})
    await b.close()
asyncio.run(main())
