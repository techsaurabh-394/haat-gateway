(()=>{
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const base=(document.currentScript&&document.currentScript.src)?document.currentScript.src.replace(/assets\/site\.js.*$/,''):'';

/* reveal on scroll + counters */
const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}}),{threshold:.12});
$$('.reveal').forEach(el=>io.observe(el));
const cio=new IntersectionObserver(es=>es.forEach(e=>{if(!e.isIntersecting)return;cio.unobserve(e.target);const n=+e.target.dataset.n,t0=performance.now();
 (function f(t){const p=Math.min(1,(t-t0)/1200);e.target.textContent=Math.round(n*(1-Math.pow(1-p,3)));if(p<1)requestAnimationFrame(f)})(t0)}),{threshold:.6});
$$('[data-n]').forEach(el=>cio.observe(el));

/* hero typing */
const phrases=['"do kilo aata aur 1 litre doodh"','"मुझे 1 किलो चावल चाहिए"','"இரண்டு கிலோ அரிசி"','"aadha kilo paneer"','"১ কেজি চাল"'];
(async()=>{const el=$('#typing');if(!el)return;let i=0;for(;;){const s=phrases[i++%phrases.length];for(let k=1;k<=s.length;k++){el.textContent=s.slice(0,k);await sleep(55)}await sleep(1500);for(let k=s.length;k>=0;k--){el.textContent=s.slice(0,k);await sleep(22)}await sleep(250)}})();

/* diagram tabs */
$$('#dtabs .chip').forEach(b=>b.onclick=()=>{$$('#dtabs .chip').forEach(x=>x.classList.remove('on'));b.classList.add('on');const im=$('#dimg');im.src='assets/'+b.dataset.i+'.svg';im.alt=b.textContent+' diagram'});

/* languages marquee */
const L=[['हिन्दी','आटा · hindi'],['Hinglish','aata, doodh'],['भोजपुरी','Bhojpuri'],['मराठी','पीठ · Marathi'],['বাংলা','চাল · Bengali'],['தமிழ்','அரிசி · Tamil'],['తెలుగు','బియ్యం · Telugu'],['ગુજરાતી','લોટ · Gujarati'],['ಕನ್ನಡ','ಅಕ್ಕಿ · Kannada'],['മലയാളം','അരി · Malayalam'],['ਪੰਜਾਬੀ','ਆਟਾ · Punjabi'],['ଓଡ଼ିଆ','ଚାଉଳ · Odia']];
const mk=a=>{const h=a.map(([t,s])=>`<div class="lang">${t}<small>${s}</small></div>`).join('');return h+h};
if($('#m1')){$('#m1').innerHTML=mk(L);$('#m2').innerHTML=mk([...L].reverse())}

/* quickstart */
const Q={node:`git clone https://github.com/techsaurabh-394/haat-gateway.git
cd haat-gateway
npm install          # dev tools only; no runtime dependencies
npm run demo         # you approve the order in your terminal
npm run demo -- --yes   # or approve automatically
npm start            # gateway on http://127.0.0.1:8080 + mock network`,
docker:`git clone https://github.com/techsaurabh-394/haat-gateway.git
cd haat-gateway
cp .env.example .env
docker compose up --build`,
test:`npm run check       # typecheck + lint + 126 tests
scripts/conformance/run-official-validator.sh   # official Poppy validator`};
let qk='node';const code=$('#code');
const setQ=k=>{qk=k;if(code)code.textContent=Q[k];$$('[data-q]').forEach(b=>b.classList.toggle('on',b.dataset.q===k))};
$$('[data-q]').forEach(b=>b.onclick=()=>setQ(b.dataset.q));setQ('node');
$('#copy')&&($('#copy').onclick=async e=>{try{await navigator.clipboard.writeText(Q[qk]);e.target.textContent='Copied ✓'}catch{e.target.textContent='Select + copy'}setTimeout(()=>e.target.textContent='Copy',1600)});

/* terminal replay */
(async()=>{const pre=$('#term');if(!pre)return;let txt='';try{txt=await (await fetch(base+'data/demo.txt')).text()}catch{pre.textContent='Run: npm run demo';return}
 const fmt=l=>esc(l).replace(/^(\d\. .*)$/,'<span class="c">$1</span>').replace(/(✔[^<]*)/,'<span class="g">$1</span>').replace(/(asks for your approval:)/,'<span class="y">$1</span>').replace(/^(Done\..*)$/,'<span class="g">$1</span>').replace(/(operation op_.*)$/,'<span class="d">$1</span>');
 const lines=txt.split('\n');let started=false;
 new IntersectionObserver((es,o)=>{if(started||!es[0].isIntersecting)return;started=true;o.disconnect();(async()=>{let out='';for(const l of lines){out+=fmt(l)+'\n';pre.innerHTML=out;pre.scrollTop=pre.scrollHeight;await sleep(/^\d\./.test(l)?500:l.startsWith('   │')?60:110)}})()},{threshold:.3}).observe(pre)})();

/* interactive demo */
(async()=>{const chat=$('#chat');if(!chat)return;let data;try{data=await (await fetch(base+'data/searches.json')).json()}catch{chat.innerHTML='<div class="msg bot">Demo data failed to load. Serve this site over http(s).</div>';return}
 const chips=$('#chips'),steps=$$('#steps li'),json=$('#json');let run=0;
 chips.innerHTML=data.map((d,i)=>`<button class="chip${i?'':' on'}" data-i="${i}">${d.lang}</button>`).join('');
 const setStep=n=>steps.forEach((s,i)=>{s.classList.toggle('done',i<n);s.classList.toggle('on',i===n)});
 const add=(cls,html)=>{const d=document.createElement('div');d.className=cls;d.innerHTML=html;chat.appendChild(d);chat.scrollTop=chat.scrollHeight;return d};
 const show=o=>{json.textContent=typeof o==='string'?o:JSON.stringify(o,null,2)};
 async function play(i){const my=++run,d=data[i],ok=()=>my===run;chat.innerHTML='';steps.forEach(s=>s.className='');show('// responses appear here as the demo runs');
  setStep(0);await sleep(300);if(!ok())return;show({protocol_version:'0.3',organization:{name:'Haat (local dev)'},extensions:{operations:'v2'}});await sleep(900);if(!ok())return;
  add('msg me',esc(d.q));setStep(1);show('// Poppy-Session: ES256 delegation verified\n// aud, htm, htu, iat, ath, jti all OK');await sleep(1000);if(!ok())return;
  setStep(2);const und=d.understood||[];add('msg bot','Understood:<br>'+und.map(u=>`<span class="tag">${esc(u.raw)} → <b>${esc(u.term)}</b>${u.quantity?` · ${u.quantity.value} ${u.quantity.unit}`:''}</span>`).join(''));
  show({understood:und});await sleep(1300);if(!ok())return;
  setStep(3);const b=d.basket;let tot=0;
  if(!b||!b.items.length){add('msg bot','Nothing matched on the mock network for this one.');return}
  b.items.forEach(x=>tot+=parseFloat(x.total));const total=tot+25;
  add('msg bot',`${d.offers} offers found. Best single seller: <b>${esc(b.seller)}</b><table class="basket">${b.items.map(x=>`<tr><td>${x.count} × ${esc(x.name)}</td><td>₹${x.total}</td></tr>`).join('')}<tr><td>Delivery</td><td>₹25.00</td></tr></table>${(b.missing||[]).map(m=>`<div class="warn">! ${esc(m.raw)}: ${esc(m.reason)}</div>`).join('')}`);
  show({offers:d.offers,suggested_basket:b});await sleep(1500);if(!ok())return;
  setStep(4);const g=add('gate',`<h4>🔐 ${'Haat asks for your approval'}</h4><p>Order from <b>${esc(b.seller)}</b>. Total <b>₹${total.toFixed(2)}</b>, pay on delivery. Deliver to Saurabh, Lanka, Varanasi 221005.</p><div class="row"><button class="btn sm primary" id="yes">Approve</button><button class="btn sm" id="no">Decline</button></div>`);
  show({status:403,error:'approval_required',operation:{operation_id:'op_…',revision:'…',summary:'Order from '+b.seller+' …'}});
  const ans=await new Promise(r=>{$('#yes',g).onclick=()=>r(true);$('#no',g).onclick=()=>r(false);const t=setInterval(()=>{if(!ok()){clearInterval(t);r(null)}},200);g.addEventListener('x',()=>clearInterval(t))});
  if(ans===null||!ok())return;g.querySelector('.row').remove();
  if(!ans){add('ok no','Declined. Nothing was ordered.<small>No Beckn confirm was ever sent.</small>');setStep(5);steps[5].classList.remove('on');show({approved:false,orders_placed:0});return}
  setStep(5);show('// approval header matches exact revision\n// Beckn confirm → sent once');await sleep(1200);if(!ok())return;
  const id='KKS-'+(1001+i);add('ok',`✓ Order placed: ${id}<small>${esc(b.seller)} · ₹${total.toFixed(2)} · payment on delivery</small>`);
  steps.forEach(s=>{s.className='done'});show({status:201,order_id:id,total:{amount:total.toFixed(2)},payment:{type:'ON-FULFILLMENT'}});await sleep(1400);if(!ok())return;
  add('msg bot','Retrying the same approval (network hiccup)…');await sleep(900);if(!ok())return;add('ok','HTTP 201, same order '+id+'<small>Not placed twice.</small>');show({status:201,order_id:id,replayed:true})}
 chips.onclick=e=>{const c=e.target.closest('.chip');if(!c)return;$$('.chip',chips).forEach(x=>x.classList.remove('on'));c.classList.add('on');play(+c.dataset.i)};
 let started=false;new IntersectionObserver((es,o)=>{if(es[0].isIntersecting&&!started){started=true;o.disconnect();play(0)}},{threshold:.25}).observe(chat)})();
})();
