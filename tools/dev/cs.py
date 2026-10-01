import asyncio,sys
from playwright.async_api import async_playwright
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch();pg=await b.new_page(viewport={'width':int(sys.argv[3]),'height':844})
    await pg.add_init_script("window.EC_NO_AUTH_GATE=true")
    await pg.goto('http://localhost:5173');await pg.wait_for_timeout(600)
    await pg.evaluate("(()=>{const m=JSON.parse(localStorage.getItem('ec_meta_v1')||'{}');m.tutDone=true;localStorage.setItem('ec_meta_v1',JSON.stringify(m))})()")
    await pg.reload();await pg.wait_for_timeout(1200)
    await pg.evaluate(f"window.ecNavigate('{sys.argv[1]}')");await pg.wait_for_timeout(800)
    print(await pg.evaluate("""(sels)=>sels.split('|').map(s=>{const e=document.querySelector(s);if(!e)return s+' none';const c=getComputedStyle(e),r=e.getBoundingClientRect();return s+': '+[c.display,c.position,c.gridTemplateColumns,c.width,Math.round(r.x),Math.round(r.y),Math.round(r.width),c.getPropertyValue('top'),c.right].join(' ; ')}).join('\\n')""",sys.argv[2]))
    await b.close()
asyncio.run(main())
