#!/usr/bin/env python3
"""v3.12: матрица переходов значков навигации. python3 tools/dev/nav_matrix.py"""
import asyncio
from playwright.async_api import async_playwright
ROUTES=[('home','btnNavHome'),('collection','btnCollection'),('decks','btnNavDecks'),('packs','btnBoosters'),('store','btnShop'),('events',''),('campaign','btnCampaign'),('online','btnNavMulti'),('mastery','btnBP'),('quests','btnNavQuests'),('rules','btnRules')]
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch()
        pg=await b.new_page(viewport={'width':1440,'height':860})
        await pg.add_init_script("window.EC_NO_AUTH_GATE=true")
        await pg.goto('http://localhost:5173/',wait_until='networkidle'); await pg.wait_for_timeout(600)
        await pg.evaluate("(()=>{const m=JSON.parse(localStorage.getItem('ec_meta_v1')||'{}');m.tutDone=true;localStorage.setItem('ec_meta_v1',JSON.stringify(m))})()")
        await pg.reload(); await pg.wait_for_timeout(1200)
        await pg.evaluate("document.getElementById('tourOverlay')?.classList.add('hidden')")
        bad=[]
        for src,_ in ROUTES:
            await pg.evaluate(f"window.ecNavigate('{src}')"); await pg.wait_for_timeout(450)
            row=[]
            for dst,px in ROUTES:
                sel=f'#ecIconNav .ecIco[data-route="{dst}"]' if not px else f'#ecIconNav .ecIco[data-proxy="{px}"]'
                r=await pg.evaluate("""(sel)=>{
                  const el=document.querySelector(sel); if(!el) return 'NOEL';
                  const b=el.getBoundingClientRect();
                  const hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);
                  if(!hit||(hit!==el&&!el.contains(hit))) return 'BLOCK:'+(hit?(hit.id||hit.className||hit.tagName):'null');
                  el.click(); return 'OK';
                }""",sel)
                await pg.wait_for_timeout(220)
                vis=await pg.evaluate("""()=>{const v=id=>{const n=document.getElementById(id);return n&&!n.classList.contains('hidden')};
                  return v('campaignModal')?'camp':v('onlineModal')?'onl':(v('bpModal')||v('bpScreen'))?'bp':v('profileModal')?'prof':document.body.dataset.appRoute}""")
                expect={'campaign':'camp','online':'onl','mastery':'bp','quests':'prof'}.get(dst,dst); ok=expect in vis
                if not ok or r!='OK': bad.append(f'{src}->{dst}:{r}->{vis}')
                row.append(f'{dst}{"." if ok else "X"}')
            print(src.ljust(11), ''.join(row))
        print('BAD:', bad if bad else 'нет')
        await b.close()
asyncio.run(main())
