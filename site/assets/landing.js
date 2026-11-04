/* Haat landing: nav, mobile menu, hero console story, install copy */
(()=>{
const $=(s,r=document)=>r.querySelector(s);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const rm=matchMedia('(prefers-reduced-motion:reduce)').matches;

/* nav */
const nav=$('.nav');
const upd=()=>nav&&nav.classList.toggle('scrolled',scrollY>8);
addEventListener('scroll',upd,{passive:true});upd();
const mb=$('.menu');
if(mb)mb.onclick=()=>{const o=nav.classList.toggle('open');mb.setAttribute('aria-expanded',o)};
document.querySelectorAll('.nav nav a').forEach(a=>a.addEventListener('click',()=>nav.classList.remove('open')));

/* install copy */
const ins=$('#install');
if(ins)ins.onclick=async()=>{const lab=ins.querySelector('.lab');try{await navigator.clipboard.writeText(ins.dataset.cmd);lab.textContent='Copied to clipboard'}catch{lab.textContent=ins.dataset.cmd}setTimeout(()=>lab.textContent=ins.dataset.cmd,1800)};

/* hero console */
const chat=$('#pchat'),pl=$('#pl'),trace=[...document.querySelectorAll('#trace li')],ft=$('#tfoot');
if(!chat)return;
const ICON_SHIELD='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
const ICON_CHECK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const S=[
 {l:'Hinglish',q:'do kilo aata aur 1 litre doodh',t:['wheat flour · 2 kg','milk · 1 L'],seller:'Kashi Kirana Store',amt:'₹197',o:9},
 {l:'हिन्दी',q:'मुझे 1 किलो चावल और आधा किलो पनीर चाहिए',t:['rice · 1 kg','paneer · 500 g'],seller:'Ganga Dairy',amt:'₹348',o:7},
 {l:'தமிழ்',q:'இரண்டு கிலோ அரிசி',t:['rice · 2 kg'],seller:'Assi Sabzi Mandi',amt:'₹126',o:5},
 {l:'বাংলা',q:'১ কেজি চাল আর ১২টা ডিম',t:['rice · 1 kg','eggs · 12'],seller:'Kashi Kirana Store',amt:'₹152',o:8}];
const add=(c,h)=>{const d=document.createElement('div');d.className='pm '+c;d.innerHTML=h;chat.appendChild(d);while(chat.children.length>4)chat.firstChild.remove();return d};
const step=n=>trace.forEach((li,i)=>{li.classList.toggle('done',i<n);li.classList.toggle('on',i===n)});
const setText=(sel,t)=>{const e=$(sel);if(e)e.textContent=t};
let visible=true;
new IntersectionObserver(es=>{visible=es[0].isIntersecting},{threshold:0}).observe(chat);
(async()=>{let i=0,orderN=1001;for(;;){
  while(!visible)await sleep(400);
  const s=S[i++%S.length];pl.textContent=s.l;chat.innerHTML='';step(-1);
  setText('#t-lex',s.t.join(', '));setText('#t-off',s.o+' offers · 3 sellers');setText('#t-sum',s.seller+' · '+s.amt);
  if(ft)ft.innerHTML='session <b>ps_'+(Math.random().toString(36).slice(2,8))+'</b><span>latency <b>'+(38+Math.floor(Math.random()*30))+' ms</b></span>';
  step(0);await sleep(500);step(1);
  const u=add('u','');for(let k=1;k<=s.q.length;k++){u.textContent=s.q.slice(0,k);await sleep(rm?0:38)}
  await sleep(350);step(2);
  const th=add('a','<span class="dots"><i></i><i></i><i></i></span>');await sleep(800);
  th.innerHTML='Understood:<br>'+s.t.map(x=>'<span class="chip-s">'+esc(x)+'</span>').join('');
  await sleep(700);step(3);await sleep(900);step(4);
  const g=add('gate','<div class="gt">'+ICON_SHIELD+'Approve this order?</div><div class="gs">'+esc(s.seller)+' · '+s.amt+' · pay on delivery</div><div class="row"><span class="y">Approve</span><span class="n">Decline</span></div>');
  await sleep(2200);g.querySelector('.y').classList.add('hit');await sleep(450);
  step(5);await sleep(400);
  add('okm',ICON_CHECK+'Order HK-'+(orderN++)+' placed once');
  trace.forEach(li=>{li.classList.remove('on');li.classList.add('done')});
  await sleep(3200);
}})();
})();
