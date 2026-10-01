import asyncio,sys
from playwright.async_api import async_playwright
W,H=int(sys.argv[1]),int(sys.argv[2]); routes=sys.argv[3].split(',')
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch();pg=await b.new_page(viewport={'width':W,'height':H})
    errs=[];pg.on('pageerror',lambda e:errs.append(str(e)))
    await pg.add_init_script("window.EC_NO_AUTH_GATE=true")
    await pg.goto('http://localhost:5173');await pg.wait_for_timeout(600)
    await pg.evaluate("(()=>{const m=JSON.parse(localStorage.getItem('ec_meta_v1')||'{}');m.tutDone=true;localStorage.setItem('ec_meta_v1',JSON.stringify(m))})()")
    await pg.reload();await pg.wait_for_timeout(1300)
    await pg.evaluate("document.getElementById('tourOverlay')?.classList.add('hidden')")
    for r in routes:
      if r=='friends': await pg.evaluate("document.getElementById('btnFriends').click()")
      else: await pg.evaluate(f"window.ecNavigate('{r}')")
      await pg.wait_for_timeout(1300)
      await pg.screenshot(path=f'/home/user/shots/{r}_{W}.png')
      if r=='friends': await pg.evaluate("document.getElementById('btnFriends').click()")
    print(errs[:3]); await b.close()
asyncio.run(main())
