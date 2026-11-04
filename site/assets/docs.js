/* Haat docs: nav state, mobile drawer, sidebar filter, copy buttons, TOC scrollspy */
(()=>{
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const nav=$('.nav');
const upd=()=>nav&&nav.classList.toggle('scrolled',scrollY>8);
addEventListener('scroll',upd,{passive:true});upd();

/* drawer */
const side=$('#side'),btn=$('.side-btn'),scrim=$('.scrim');
const setOpen=o=>{if(!side)return;side.classList.toggle('open',o);if(btn)btn.setAttribute('aria-expanded',o);if(scrim)scrim.hidden=!o};
if(btn)btn.onclick=()=>setOpen(!side.classList.contains('open'));
if(scrim)scrim.onclick=()=>setOpen(false);
addEventListener('keydown',e=>{if(e.key==='Escape')setOpen(false)});
const cur=$('.side a.on');if(cur&&side)cur.scrollIntoView({block:'nearest'});

/* filter */
const q=$('#q');
if(q&&side){
  const links=$$('a[data-k]',side),heads=$$('h5',side);
  const empty=document.createElement('div');empty.className='empty';empty.textContent='No matching pages';empty.hidden=true;q.closest('label').after(empty);
  q.addEventListener('input',()=>{const v=q.value.trim().toLowerCase();let n=0;
    links.forEach(a=>{const m=!v||a.dataset.k.includes(v);a.classList.toggle('hide',!m);if(m)n++});
    heads.forEach(h=>{let el=h.nextElementSibling,any=false;while(el&&el.tagName==='A'){if(!el.classList.contains('hide'))any=true;el=el.nextElementSibling}h.style.display=any?'':'none'});
    empty.hidden=n>0});
  q.addEventListener('keydown',e=>{if(e.key==='Enter'){const f=links.find(a=>!a.classList.contains('hide'));if(f)location.href=f.href}});
  addEventListener('keydown',e=>{if(e.key==='/'&&document.activeElement!==q&&!/input|textarea/i.test(document.activeElement.tagName)){e.preventDefault();if(innerWidth<=900)setOpen(true);q.focus()}});
}

/* copy */
$$('.code').forEach(c=>{const b=$('.copy',c),pre=$('pre',c);if(!b||!pre)return;
  b.onclick=async()=>{try{await navigator.clipboard.writeText(pre.innerText);b.textContent='Copied'}catch{b.textContent='Select + copy'}setTimeout(()=>b.textContent='Copy',1500)}});

/* scrollspy */
const toc=$$('.toc a[href^="#"]').filter(a=>a.getAttribute('href')!=='#top');
if(toc.length){
  const map=new Map(toc.map(a=>[decodeURIComponent(a.getAttribute('href').slice(1)),a]));
  const hs=[...map.keys()].map(id=>document.getElementById(id)).filter(Boolean);
  const spy=()=>{let act=hs[0];for(const h of hs){if(h.getBoundingClientRect().top<120)act=h;else break}
    toc.forEach(a=>a.classList.remove('on'));const a=act&&map.get(act.id);if(a)a.classList.add('on')};
  addEventListener('scroll',spy,{passive:true});spy();
}
})();
