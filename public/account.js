/* Runs after the store script, so it can use $, cart, PRODUCTS, money, toast, setCart, renderCart from index.html */
const GOOGLE_CLIENT_ID='YOUR_GOOGLE_CLIENT_ID'; // paste your Google OAuth Web client ID here
const api=async(p,body,method)=>{
  const r=await fetch(p,{method:method||(body?'POST':'GET'),credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error((d.details&&d.details[0])||d.error||'Something went wrong');
  return d;
};
let me=null,mode='register';
const F=$('#authForm'),PF=$('#payForm');
const TXT={register:['Create your account','Create account'],login:['Welcome back','Sign in'],forgot:['Reset your password','Send reset link'],reset:['Choose a new password','Save password']};

function setMode(m){
  mode=m;$('#authTitle').textContent=TXT[m][0];$('#authSubmit').textContent=TXT[m][1];
  F.querySelectorAll('.reg').forEach(e=>e.hidden=m!=='register');
  F.password.parentElement.hidden=m==='forgot';F.email.parentElement.hidden=m==='reset';
  $('#forgot').hidden=m!=='login';$('#gbtn').hidden=m==='forgot'||m==='reset';
  $('#toggleMode').textContent=m==='register'?'I already have an account':'Create a new account';
  $('#authErr').textContent='';
}
function paint(){
  $('#acctBtn').textContent=me?'My orders':'Sign in';
  $('#account').hidden=!!me;
}
F.onsubmit=async e=>{
  e.preventDefault();const v=Object.fromEntries(new FormData(F)),err=$('#authErr');err.textContent='';
  try{
    if(mode==='register')me=await api('/api/auth/register',{name:v.name,email:v.email,phone:v.phone,password:v.password,terms:!!v.terms});
    else if(mode==='login')me=await api('/api/auth/login',{email:v.email,password:v.password});
    else if(mode==='forgot'){await api('/api/auth/forgot',{email:v.email});err.textContent='If that email has an account, a reset link is on its way.';return}
    else{await api('/api/auth/reset',{token:new URLSearchParams(location.search).get('reset'),password:v.password});history.replaceState(null,'','/');setMode('login');err.textContent='Password updated. Sign in with it.';return}
    F.reset();paint();toast('Welcome, '+me.name.split(' ')[0]);
  }catch(x){err.textContent=x.message}
};
$('#toggleMode').onclick=e=>{e.preventDefault();setMode(mode==='register'?'login':'register')};
$('#forgot').onclick=e=>{e.preventDefault();setMode('forgot')};

/* ---- Google sign-in ---- */
window.addEventListener('load',()=>{
  if(!window.google||GOOGLE_CLIENT_ID.startsWith('YOUR_'))return;
  google.accounts.id.initialize({client_id:GOOGLE_CLIENT_ID,callback:async r=>{
    try{me=await api('/api/auth/google',{credential:r.credential});paint()}catch(x){$('#authErr').textContent=x.message}}});
  google.accounts.id.renderButton($('#gbtn'),{theme:'outline',size:'large',text:'signin_with',width:280});
});

/* ---- dashboard ---- */
async function openDash(){
  const t=await api('/api/transactions');
  $('#who').textContent=me.name+' · '+me.email;
  $('#txBody').replaceChildren(...t.map(x=>{ // textContent only, so nothing can inject HTML
    const r=document.createElement('tr');
    [x.tranId,x.method,x.currency+' '+x.amount,x.status,new Date(x.createdAt).toLocaleDateString()].forEach(v=>{const c=document.createElement('td');c.textContent=v;r.append(c)});
    return r}));
  $('#txEmpty').hidden=!!t.length;$('#dash').showModal();
}
$('#acctBtn').onclick=()=>me?openDash().catch(x=>toast(x.message)):(setMode('login'),$('#account').scrollIntoView({behavior:'smooth'}));
$('#logout').onclick=async()=>{await api('/api/auth/logout',{});me=null;paint();$('#dash').close()};

/* ---- checkout ---- */
const total=()=>Object.entries(cart).reduce((s,[id,q])=>s+PRODUCTS.find(p=>p.id==id).price*q,0);
$('#checkout').onclick=()=>{ // CHECKOUT: opens the payment dialog (replaces the old placeholder)
  if(!me){setCart(false);setMode('login');$('#account').scrollIntoView({behavior:'smooth'});toast('Sign in to check out');return}
  setCart(false);$('#payTotal').textContent=money(total());$('#payErr').textContent='';$('#pay').showModal();
};
PF.onchange=()=>{const m=PF.method.value;$('#manual').hidden=!(m==='bank'||m==='mfs');$('#bankBox').hidden=m!=='bank';$('#mfsBox').hidden=m!=='mfs'};
PF.onsubmit=async e=>{
  e.preventDefault();const m=PF.method.value,err=$('#payErr');err.textContent='';
  const items=Object.entries(cart).map(([id,qty])=>({id:+id,qty}));
  try{
    if(m==='ssl'||m==='stripe'){location.href=(await api('/api/pay/'+(m==='ssl'?'sslcommerz':'stripe')+'/init',{items})).url;return}
    const fd=new FormData();fd.append('items',JSON.stringify(items));fd.append('method',m==='bank'?'BANK_PAYONEER':'MFS_MANUAL');
    fd.append('reference',PF.reference.value);if(PF.proof.files[0])fd.append('proof',PF.proof.files[0]);
    const r=await fetch('/api/pay/manual',{method:'POST',body:fd,credentials:'same-origin'});
    const d=await r.json();if(!r.ok)throw new Error((d.details&&d.details[0])||d.error);
    cart={};renderCart();$('#pay').close();PF.reset();toast('Proof received. We will confirm your payment soon.');
  }catch(x){err.textContent=x.message}
};

/* ---- legal links + dialog close ---- */
document.addEventListener('click',e=>{
  const l=e.target.closest('[data-legal]');
  if(l){e.preventDefault();$('#legal').querySelectorAll('details').forEach(d=>d.open=d.id===l.dataset.legal);$('#legal').showModal()}
  if(e.target.closest('[data-close]'))e.target.closest('dialog').close();
});

/* ---- start-up: restore session, payment result, reset link ---- */
setMode('register');
api('/api/me').then(u=>{me=u;paint()}).catch(()=>{});
const q=new URLSearchParams(location.search);
if(q.get('pay')){toast({success:'Payment received. Thank you!',failed:'Payment failed. You have not been charged.',cancelled:'Payment cancelled.'}[q.get('pay')]||'');history.replaceState(null,'','/')}
if(q.get('reset')){setMode('reset');setTimeout(()=>$('#account').scrollIntoView(),300)}
