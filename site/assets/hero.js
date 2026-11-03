/* hero v2: phone story, tilt, spotlight */
(()=>{
const chat=document.getElementById('pchat');if(!chat)return;
const hero=document.querySelector('.hero'),ph=document.getElementById('phone'),pl=document.getElementById('pl');
const rm=matchMedia('(prefers-reduced-motion:reduce)').matches;
const sp=document.createElement('div');sp.className='spot';hero.prepend(sp);
if(!rm)hero.addEventListener('mousemove',e=>{
  const r=hero.getBoundingClientRect(),x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;
  sp.style.setProperty('--sx',(e.clientX-r.left)+'px');sp.style.setProperty('--sy',(e.clientY-r.top)+'px');
  hero.style.setProperty('--mx',(x-.5).toFixed(3));hero.style.setProperty('--my',(y-.5).toFixed(3));
  ph.style.setProperty('--tx',(-10+(x-.5)*-16).toFixed(1));ph.style.setProperty('--ty',(5+(y-.5)*-12).toFixed(1));
});
const S=[
 {l:'Hinglish',q:'do kilo aata aur 1 litre doodh',t:['wheat flour · 2 kg','milk · 1 L'],s:'Kashi Kirana · ₹197 · pay on delivery'},
 {l:'हिन्दी',q:'मुझे 1 किलो चावल और आधा किलो पनीर चाहिए',t:['rice · 1 kg','paneer · 500 g'],s:'Ganga Dairy · ₹348 · pay on delivery'},
 {l:'தமிழ்',q:'இரண்டு கிலோ அரிசி',t:['rice · 2 kg'],s:'Assi Sabzi Mandi · ₹126 · pay on delivery'},
 {l:'বাংলা',q:'১ কেজি চাল আর ১২টা ডিম',t:['rice · 1 kg','eggs · 12'],s:'Kashi Kirana · ₹152 · pay on delivery'}];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const add=(c,h)=>{const d=document.createElement('div');d.className='pm '+c;d.innerHTML=h;chat.appendChild(d);while(chat.children.length>4)chat.firstChild.remove();return d};
(async()=>{let i=0;for(;;){
  const s=S[i++%S.length];pl.textContent=s.l;chat.innerHTML='';
  const u=add('u','');for(let k=1;k<=s.q.length;k++){u.textContent=s.q.slice(0,k);await sleep(rm?0:42)}
  await sleep(500);
  const th=add('a','<span class="dots"><i></i><i></i><i></i></span>');await sleep(900);
  th.innerHTML='Understood ✓<br>'+s.t.map(x=>'<span class="tag">'+esc(x)+'</span>').join('');await sleep(1100);
  const g=add('gate','<b>Approve this order?</b>'+esc(s.s)+'<div class="row"><span class="y">YES</span><span class="n">NO</span></div>');await sleep(2200);
  g.querySelector('.y').classList.add('hit');await sleep(500);
  add('ok','✓ Approved · placed once');await sleep(2800);
}})();
})();
