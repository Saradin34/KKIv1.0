import asyncio,sys
from playwright.async_api import async_playwright
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch();pg=await b.new_page(viewport={'width':390,'height':844})
    await pg.add_init_script("window.EC_NO_AUTH_GATE=true")
    await pg.goto('http://localhost:5173');await pg.wait_for_timeout(600)
    await pg.evaluate("(()=>{const m=JSON.parse(localStorage.getItem('ec_meta_v1')||'{}');m.tutDone=true;localStorage.setItem('ec_meta_v1',JSON.stringify(m))})()")
    await pg.reload();await pg.wait_for_timeout(1200)
    await pg.evaluate(f"window.ecNavigate('{sys.argv[1]}')");await pg.wait_for_timeout(800)
    print(await pg.evaluate("""(sel)=>{const out=[];const W=innerWidth;document.querySelectorAll(sel+' *').forEach(e=>{const r=e.getBoundingClientRect();if(r.width>W+2||r.right>W+4){out.push(e.tagName+'#'+e.id+'.'+[...e.classList].join('.')+' w='+Math.round(r.width)+' r='+Math.round(r.right))}});return out.slice(0,25).join('\\n')}""",sys.argv[2]))
    await b.close()
asyncio.run(main())
