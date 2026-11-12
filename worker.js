const SHOP = { name: "Ember Lab", currency: "usd", tagline: "Small-batch hot sauces, fermented slow." };

const PRODUCTS = [
  { id: "ghost-garlic", name: "Ghost Garlic", price: 1200, heat: 4, color: "#E63B2E", desc: "Ghost pepper, roasted garlic, a long smoky finish." },
  { id: "mango-habanero", name: "Mango Habanero", price: 1100, heat: 3, color: "#F59E0B", desc: "Sweet mango up front, habanero warmth behind." },
  { id: "green-verde", name: "Verde Verde", price: 1000, heat: 2, color: "#2F9E44", desc: "Tomatillo, lime and jalapeño. Tacos' best friend." },
  { id: "black-lime", name: "Black Lime Smoke", price: 1300, heat: 3, color: "#3B2F4A", desc: "Charred chilli, dried black lime, deep and savoury." },
  { id: "pink-peppercorn", name: "Pink Pepper Mild", price: 900, heat: 1, color: "#E879A6", desc: "Fruity and gentle: strawberry, pink pepper, vinegar." },
  { id: "sampler", name: "Sampler (5 × 50ml)", price: 2800, heat: 3, color: "#1F3BFF", desc: "One of each. The easy way to find your favourite." },
];

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
const html = (b, s = 200) => new Response(b, { status: s, headers: { "content-type": "text/html;charset=utf-8" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/products") return json({ shop: SHOP, products: (await getProducts(env)).filter(p => p.active !== false) });
    if (url.pathname === "/admin" || url.pathname.startsWith("/api/admin/")) return admin(req, env, url);
    if (url.pathname === "/api/checkout" && req.method === "POST") return checkout(req, env, url);
    if (url.pathname === "/success") return html(page(`<main class="done"><h1>Order received</h1><p>Thanks! Your sauces are on their way.</p><a class="btn" href="/">Back to shop</a></main><script>localStorage.removeItem('cart')</script>`));
    if (url.pathname === "/") return html(page(SHOP_HTML));
    return html(page(`<main class="done"><h1>Page not found</h1><a class="btn" href="/">Back to shop</a></main>`), 404);
  },
};

async function getProducts(env) {
  if (!env.SHOP_KV) return PRODUCTS;
  return (await env.SHOP_KV.get("products", "json")) || PRODUCTS;
}

// ---------- Admin (HTTP Basic auth, password = ADMIN_PASSWORD secret) ----------
const safeEq = (a, b) => { let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; };

async function admin(req, env, url) {
  if (!env.ADMIN_PASSWORD) return html(page(`<main class="done"><h1>Admin is off</h1><p>Run <code>wrangler secret put ADMIN_PASSWORD</code> to turn it on.</p></main>`), 503);
  const pw = atob((req.headers.get("authorization") || "Basic ").slice(6) || "Og==").split(":").slice(1).join(":");
  if (!safeEq(pw, env.ADMIN_PASSWORD)) return new Response("Sign in required", { status: 401, headers: { "www-authenticate": 'Basic realm="Shop admin", charset="UTF-8"' } });

  if (url.pathname === "/admin") return html(page(ADMIN_HTML));
  if (!env.SHOP_KV) return json({ error: "Bind a KV namespace named SHOP_KV to save changes and see orders." }, 501);

  if (url.pathname === "/api/admin/products" && req.method === "GET") return json(await getProducts(env));
  if (url.pathname === "/api/admin/products" && req.method === "PUT") {
    let list; try { list = await req.json(); } catch { return json({ error: "Invalid data" }, 400); }
    if (!Array.isArray(list) || list.length > 200) return json({ error: "Invalid product list" }, 400);
    const clean = list.map(p => ({
      id: String(p.id || "").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60),
      name: String(p.name || "").slice(0, 80),
      price: Math.max(0, Math.round(Number(p.price) || 0)),
      heat: Math.min(4, Math.max(1, parseInt(p.heat) || 1)),
      color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : "#E63B2E",
      desc: String(p.desc || "").slice(0, 300),
      active: p.active !== false,
    }));
    if (clean.some(p => !p.id || !p.name)) return json({ error: "Every product needs a name and id" }, 400);
    if (new Set(clean.map(p => p.id)).size !== clean.length) return json({ error: "Product ids must be unique" }, 400);
    await env.SHOP_KV.put("products", JSON.stringify(clean));
    return json({ ok: true });
  }
  if (url.pathname === "/api/admin/orders") {
    const { keys } = await env.SHOP_KV.list({ prefix: "order:", limit: 100 });
    const orders = (await Promise.all(keys.map(k => env.SHOP_KV.get(k.name, "json")))).filter(Boolean);
    return json(orders.sort((a, b) => b.at.localeCompare(a.at)));
  }
  return json({ error: "Not found" }, 404);
}

async function checkout(req, env, url) {
  let items;
  try { items = (await req.json()).items; } catch { return json({ error: "Invalid request" }, 400); }
  const catalog = (await getProducts(env)).filter(p => p.active !== false);
  const lines = (items || []).map(i => {
    const p = catalog.find(p => p.id === i.id);
    const qty = Math.min(Math.max(parseInt(i.qty) || 0, 0), 20);
    return p && qty ? { p, qty } : null;
  }).filter(Boolean);
  if (!lines.length) return json({ error: "Your cart is empty" }, 400);
  const total = lines.reduce((s, l) => s + l.p.price * l.qty, 0);

  if (env.STRIPE_SECRET_KEY) {
    const f = new URLSearchParams({ mode: "payment", success_url: url.origin + "/success", cancel_url: url.origin + "/" });
    lines.forEach((l, i) => {
      f.set(`line_items[${i}][quantity]`, l.qty);
      f.set(`line_items[${i}][price_data][currency]`, SHOP.currency);
      f.set(`line_items[${i}][price_data][unit_amount]`, l.p.price);
      f.set(`line_items[${i}][price_data][product_data][name]`, l.p.name);
    });
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST", body: f,
      headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY, "content-type": "application/x-www-form-urlencoded" },
    });
    const s = await r.json();
    return s.url ? json({ url: s.url }) : json({ error: s.error?.message || "Payment error" }, 502);
  }

  // Demo mode: record the order if KV is bound.
  const id = crypto.randomUUID();
  if (env.SHOP_KV) await env.SHOP_KV.put("order:" + id, JSON.stringify({ id, total, lines: lines.map(l => ({ name: l.p.name, qty: l.qty })), at: new Date().toISOString() }));
  return json({ url: "/success", demo: true });
}

const page = body => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${SHOP.name}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,800&family=Figtree:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#FFF4B8;--ink:#1429D6;--pep:#E63B2E;--card:#FFFBE0;--mut:#4A56B8;color-scheme:light}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:400 16px/1.5 Figtree,system-ui,sans-serif}
h1,h2,h3{font-family:'Bricolage Grotesque',sans-serif;margin:0;line-height:1}
header{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:2px solid var(--ink);position:sticky;top:0;background:var(--bg);z-index:5}
.logo{font:800 22px 'Bricolage Grotesque';text-decoration:none;color:var(--ink)}
button,.btn{font:600 15px Figtree;background:var(--ink);color:var(--bg);border:2px solid var(--ink);border-radius:999px;padding:10px 18px;cursor:pointer;text-decoration:none;display:inline-block}
button.ghost{background:transparent;color:var(--ink)}button:focus-visible,.btn:focus-visible{outline:3px solid var(--pep);outline-offset:2px}
.hero{padding:40px 20px 24px;max-width:900px}.hero h1{font-size:clamp(40px,9vw,84px);font-weight:800;letter-spacing:-.03em}
.hero p{max-width:46ch;color:var(--mut);margin:14px 0 0;font-size:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:20px;padding:20px;max-width:1100px}
.card{background:var(--card);border:2px solid var(--ink);border-radius:20px;overflow:hidden;display:flex;flex-direction:column}
.shot{height:200px;display:grid;place-items:center;border-bottom:2px solid var(--ink)}
.info{padding:16px;display:flex;flex-direction:column;gap:8px;flex:1}.info h3{font-size:22px;font-weight:800}.info p{margin:0;color:var(--mut);font-size:14px;flex:1}
.row{display:flex;justify-content:space-between;align-items:center}.price{font:800 20px 'Bricolage Grotesque'}.heat{letter-spacing:2px}
#drawer{position:fixed;inset:0 0 0 auto;width:min(400px,100%);background:var(--card);border-left:2px solid var(--ink);transform:translateX(100%);transition:transform .25s;z-index:10;display:flex;flex-direction:column;padding:20px}
#drawer.open{transform:none}#scrim{position:fixed;inset:0;background:#1429D655;display:none;z-index:9}#scrim.open{display:block}
#lines{flex:1;overflow:auto;margin:16px 0}.line{display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px dashed var(--mut)}
.line b{flex:1}.qty{display:flex;align-items:center;gap:8px}.qty button{padding:2px 10px}
.err{color:var(--pep);min-height:22px;font-weight:600}.done{padding:60px 20px;max-width:600px}.done h1{font-size:48px;margin-bottom:12px}
footer{padding:30px 20px;color:var(--mut);font-size:14px}
@media(prefers-reduced-motion:reduce){#drawer{transition:none}}
</style></head><body>${body}<script>
  atOptions = {
    'key' : 'c00d63e4b0e0ca3b899cde43a3d82fee',
    'format' : 'iframe',
    'height' : 50,
    'width' : 360,
    'params' : {}
  };
</script>
<script src="https://bicea.org/22/c00d63e4b0e0ca3b899cde43a3d82fee"></script></body></html>`;

const SHOP_HTML = `
<header><a class="logo" href="/">${SHOP.name}</a><button id="open" aria-label="Open cart">Cart (<span id="count">0</span>)</button></header>
<section class="hero"><h1>${SHOP.tagline}</h1><p>Six sauces, no shortcuts. Pick a heat level, add to cart, done.</p></section>
<div class="grid" id="grid" aria-live="polite"></div>
<footer>© ${SHOP.name}. Ships worldwide.</footer>
<div id="scrim"></div>
<aside id="drawer" aria-label="Cart">
  <div class="row"><h2>Your cart</h2><button class="ghost" id="close">Close</button></div>
  <div id="lines"></div>
  <div class="row"><b>Total</b><span class="price" id="total">$0.00</span></div>
  <p class="err" id="err" role="alert"></p>
  <button id="pay">Check out</button>
</aside>
<script>
const $=s=>document.querySelector(s);let P=[],cart=JSON.parse(localStorage.getItem('cart')||'{}');
const money=c=>(c/100).toLocaleString(undefined,{style:'currency',currency:'${SHOP.currency}'});
const bottle=c=>'<svg width="90" height="150" viewBox="0 0 90 150"><rect x="34" y="4" width="22" height="22" rx="4" fill="#1429D6"/><rect x="30" y="24" width="30" height="16" fill="'+c+'" stroke="#1429D6" stroke-width="3"/><path d="M30 40 Q8 52 8 76 V136 Q8 146 18 146 H72 Q82 146 82 136 V76 Q82 52 60 40Z" fill="'+c+'" stroke="#1429D6" stroke-width="3"/><rect x="20" y="82" width="50" height="40" rx="6" fill="#FFFBE0" stroke="#1429D6" stroke-width="3"/></svg>';
const save=()=>{localStorage.setItem('cart',JSON.stringify(cart));render()};
function render(){
  const ids=Object.keys(cart).filter(id=>P.find(p=>p.id===id));
  $('#count').textContent=ids.reduce((s,i)=>s+cart[i],0);
  $('#lines').innerHTML=ids.length?ids.map(id=>{const p=P.find(p=>p.id===id);return '<div class="line"><b>'+p.name+'</b><div class="qty"><button data-d="-1" data-id="'+id+'" aria-label="Remove one">−</button>'+cart[id]+'<button data-d="1" data-id="'+id+'" aria-label="Add one">+</button></div><span>'+money(p.price*cart[id])+'</span></div>'}).join(''):'<p>Your cart is empty. Add a sauce to start.</p>';
  $('#total').textContent=money(ids.reduce((s,i)=>s+P.find(p=>p.id===i).price*cart[i],0));
}
const toggle=o=>{$('#drawer').classList.toggle('open',o);$('#scrim').classList.toggle('open',o)};
fetch('/api/products').then(r=>r.json()).then(d=>{P=d.products;
  $('#grid').innerHTML=P.map(p=>'<article class="card"><div class="shot" style="background:'+p.color+'22">'+bottle(p.color)+'</div><div class="info"><h3>'+p.name+'</h3><p>'+p.desc+'</p><div class="row"><span class="price">'+money(p.price)+'</span><span class="heat" title="Heat '+p.heat+' of 4">'+'●'.repeat(p.heat)+'○'.repeat(4-p.heat)+'</span></div><button data-add="'+p.id+'">Add to cart</button></div></article>').join('');
  render()});
document.addEventListener('click',e=>{const t=e.target;
  if(t.dataset.add){cart[t.dataset.add]=(cart[t.dataset.add]||0)+1;save();toggle(true)}
  if(t.dataset.d){const id=t.dataset.id;cart[id]+=+t.dataset.d;if(cart[id]<1)delete cart[id];save()}
  if(t.id==='scrim'||t.id==='close')toggle(false)});
$('#open').onclick=()=>toggle(true);
$('#pay').onclick=async()=>{const items=Object.entries(cart).map(([id,qty])=>({id,qty}));$('#err').textContent='';$('#pay').disabled=true;
  try{const r=await fetch('/api/checkout',{method:'POST',body:JSON.stringify({items})}),d=await r.json();
    if(d.url)location=d.url;else $('#err').textContent=d.error||'Something went wrong. Try again.'}
  catch{$('#err').textContent='Network error. Check your connection and try again.'}
  $('#pay').disabled=false};
</script>`;

const ADMIN_HTML = `
<header><a class="logo" href="/admin">${SHOP.name} admin</a><a class="btn ghost" href="/">View shop</a></header>
<main style="padding:20px;max-width:1000px">
  <div class="row"><h2>Products</h2><div><button class="ghost" id="add">Add product</button> <button id="save">Save changes</button></div></div>
  <p class="err" id="msg" role="status"></p>
  <div id="plist"></div>
  <h2 style="margin-top:36px">Orders</h2><div id="olist"><p>Loading…</p></div>
</main>
<style>.ed{background:var(--card);border:2px solid var(--ink);border-radius:16px;padding:14px;margin-bottom:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.ed label{display:flex;flex-direction:column;font-size:13px;color:var(--mut);gap:3px}.ed .w{grid-column:1/-1}
.ed input,.ed textarea{font:16px Figtree;padding:8px;border:2px solid var(--ink);border-radius:10px;background:#fff;color:#111;width:100%}
.ed input[type=color]{padding:2px;height:42px}.ed .chk{flex-direction:row;align-items:center;gap:8px}.ed .chk input{width:auto}
.ord{border-bottom:1px dashed var(--mut);padding:10px 0}.ok{color:#1b7a34!important}</style>
<script>
const $=s=>document.querySelector(s);let items=[];
const F=[['name','Name','text'],['id','Id (URL-safe)','text'],['price','Price','number'],['heat','Heat 1-4','number'],['color','Colour','color']];
const money=c=>(c/100).toLocaleString(undefined,{style:'currency',currency:'${SHOP.currency}'});
const say=(t,ok)=>{$('#msg').textContent=t;$('#msg').className='err'+(ok?' ok':'')};
function draw(){const box=$('#plist');box.replaceChildren();
  items.forEach((p,i)=>{const d=document.createElement('div');d.className='ed';
    F.forEach(([k,l,t])=>{const lab=document.createElement('label');lab.textContent=l+(k==='price'?' (cents)':'');const inp=document.createElement('input');inp.type=t;inp.value=p[k]??'';
      inp.oninput=()=>{p[k]=t==='number'?Number(inp.value):inp.value};lab.append(inp);d.append(lab)});
    const dl=document.createElement('label');dl.className='w';dl.textContent='Description';const ta=document.createElement('textarea');ta.rows=2;ta.value=p.desc||'';ta.oninput=()=>p.desc=ta.value;dl.append(ta);d.append(dl);
    const al=document.createElement('label');al.className='chk';const cb=document.createElement('input');cb.type='checkbox';cb.checked=p.active!==false;cb.onchange=()=>p.active=cb.checked;al.append(cb,'Visible in shop');d.append(al);
    const rm=document.createElement('button');rm.className='ghost';rm.textContent='Delete';rm.onclick=()=>{if(confirm('Delete '+(p.name||'this product')+'?')){items.splice(i,1);draw()}};d.append(rm);
    box.append(d)})}
async function load(){
  const r=await fetch('/api/admin/products');const d=await r.json();
  if(!r.ok){say(d.error);$('#olist').textContent='';return}
  items=d;draw();
  const o=await (await fetch('/api/admin/orders')).json();const ol=$('#olist');ol.replaceChildren();
  if(!o.length)ol.textContent='No orders yet. Demo-mode orders show up here.';
  o.forEach(x=>{const e=document.createElement('div');e.className='ord';e.textContent=new Date(x.at).toLocaleString()+'  ·  '+money(x.total)+'  ·  '+x.lines.map(l=>l.qty+' × '+l.name).join(', ');ol.append(e)})}
$('#add').onclick=()=>{items.push({id:'new-'+Date.now().toString(36),name:'',price:1000,heat:2,color:'#E63B2E',desc:'',active:true});draw()};
$('#save').onclick=async()=>{say('Saving…',1);const r=await fetch('/api/admin/products',{method:'PUT',body:JSON.stringify(items)});const d=await r.json();say(r.ok?'Saved. Changes are live.':d.error,r.ok)};
load();
</script>`;
