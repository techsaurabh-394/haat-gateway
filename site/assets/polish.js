/* polish v1: scroll progress, nav state, pointer glow on cards */
(()=>{
const bar=document.createElement('div');bar.className='progress';bar.setAttribute('aria-hidden','true');document.body.prepend(bar);
const nav=document.querySelector('.nav');
const upd=()=>{
  const h=document.documentElement,max=h.scrollHeight-innerHeight;
  bar.style.setProperty('--p',max>0?(scrollY/max).toFixed(4):0);
  if(nav)nav.classList.toggle('scrolled',scrollY>8);
};
addEventListener('scroll',upd,{passive:true});addEventListener('resize',upd);upd();
document.querySelectorAll('.feat').forEach(c=>c.addEventListener('pointermove',e=>{
  const r=c.getBoundingClientRect();
  c.style.setProperty('--gx',(e.clientX-r.left)+'px');c.style.setProperty('--gy',(e.clientY-r.top)+'px');
}));
})();
