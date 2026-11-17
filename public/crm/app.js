/* =====================================================================
   LAZY LABS CRM — front (State + srvCall + navegação + render)
   Comunicação: SOMENTE google.script.run.routeClientAction (mesma origem).
   Regras: esc() em todo dado; nunca innerHTML de dado cru sem escapar.
   ===================================================================== */

var State = {
  auth: { token: localStorage.getItem('llCrmToken') || '', user: null, ready: false },
  currentPage: 'dashboard',
  brand: {},
  cache: {}
};

/* ---------- helpers ---------- */
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function $(id){ return document.getElementById(id); }
function money(v){ var n=Number(v)||0; return n.toLocaleString('pt-BR',{style:'currency',currency:'BRL'}); }
function moneyShort(v){ var n=Number(v)||0; if(n>=1000) return 'R$ '+(n/1000).toLocaleString('pt-BR',{maximumFractionDigits:1})+'k'; return money(n); }
function dt(iso){ if(!iso) return '—'; var d=new Date(iso); if(isNaN(d)) return '—'; return d.toLocaleDateString('pt-BR',{day:'2-digit',month:'short'}); }
function firstName(n){ return String(n||'').trim().split(/\s+/)[0]||''; }
function initials(n){ var p=String(n||'').trim().split(/\s+/); return ((p[0]||'')[0]||'')+(p.length>1?(p[p.length-1][0]||''):''); }
function slug(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z]/g,''); }

var toastTimer;
function toast(msg, type){
  var t=$('toast'); t.textContent=msg; t.className='toast show '+(type||'ok');
  clearTimeout(toastTimer); toastTimer=setTimeout(function(){ t.className='toast'; }, 2600);
}

/* ★ ÚNICO modo do front falar com o backend (Firebase Function, mesma origem → sem CORS) */
var CRM_API = '/api/crm';
var EMBED = /[?&]embed=1/.test(location.search);  /* rodando dentro do hub/admin */
function srvCall(action, data){
  var payload = { action: action, data: data||{}, sessionToken: State.auth.token||'' };
  return fetch(CRM_API, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) })
    .then(function(r){ return r.json(); })
    .then(function(res){
      if(res==null) return { success:false, error:'Resposta vazia do servidor.' };
      if(!res.success && res.code==='AUTH_REQUIRED'){ clearAuthSession(); showAuthOverlay('login','Sua sessão expirou. Entre novamente.'); }
      return res;
    })
    .catch(function(err){ return { success:false, error: (err && err.message) ? err.message : 'Falha de conexão.' }; });
}

/* ---------- BRANDING (white-label) ---------- */
function applyBranding(cfg){
  State.brand = cfg||{};
  var primary = cfg.BRAND_PRIMARY || '#00f0ff';
  var accent = cfg.BRAND_ACCENT || '#a855f7';
  var rgb = hexToRgb(primary) || {r:0,g:240,b:255};
  var root = document.documentElement.style;
  root.setProperty('--brand-primary', primary);
  root.setProperty('--brand-accent', accent);
  root.setProperty('--brand-primary-rgb', rgb.r+','+rgb.g+','+rgb.b);
  root.setProperty('--brand-on-primary', contrastColor(rgb));
  var name = cfg.APP_NAME || 'Lazy Labs CRM';
  var tag = cfg.COMPANY_TAGLINE || 'IA & Automação';
  document.title = name;
  ['brandName','authBrandName'].forEach(function(id){ if($(id)) $(id).textContent=name; });
  ['brandTagline','authTagline'].forEach(function(id){ if($(id)) $(id).innerHTML=esc(tag); });
  var logoHtml = cfg.APP_LOGO_URL ? '<img src="'+esc(cfg.APP_LOGO_URL)+'" alt="">' : esc((name[0]||'L'))+'L';
  ['sidebarLogoMark','authLogo'].forEach(function(id){ if($(id)) $(id).innerHTML = cfg.APP_LOGO_URL ? '<img src="'+esc(cfg.APP_LOGO_URL)+'">' : 'LL'; });
  if(cfg.APP_FAVICON_URL){ var l=document.querySelector("link[rel='icon']")||document.createElement('link'); l.rel='icon'; l.href=cfg.APP_FAVICON_URL; document.head.appendChild(l); }
}
function hexToRgb(hex){ var m=/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex||'')); return m?{r:parseInt(m[1],16),g:parseInt(m[2],16),b:parseInt(m[3],16)}:null; }
function contrastColor(rgb){ var yiq=(rgb.r*299+rgb.g*587+rgb.b*114)/1000; return yiq>=150?'#04040c':'#ffffff'; }

/* ---------- AUTH ---------- */
function showAuthOverlay(mode, msg){
  if(EMBED){
    /* dentro do hub não mostramos login: pedimos ao painel para reautenticar (SSO) */
    try{ parent.postMessage({ type:'crm-need-auth' }, '*'); }catch(_){}
    $('appRoot').style.display='none';
    $('authOverlay').classList.add('show');
    switchAuthMode('login');
    setAuthMsg(msg||'Reconectando ao painel…','err');
    return;
  }
  $('appRoot').style.display='none';
  $('authOverlay').classList.add('show');
  switchAuthMode(mode||'login');
  if(msg) setAuthMsg(msg,'err');
}
function hideAuthOverlay(){ $('authOverlay').classList.remove('show'); $('appRoot').style.display='flex'; }
function switchAuthMode(mode){
  $('authLogin').style.display = mode==='login'?'block':'none';
  $('authReset').style.display = mode==='reset'?'block':'none';
  if($('authSetup')) $('authSetup').style.display = mode==='setup'?'block':'none';
  setAuthMsg('','');
}
async function doSetup(){
  var btn=$('setupBtn');
  var nome=$('setupNome').value.trim(), email=$('setupEmail').value.trim(), pass=$('setupPass').value;
  if(!nome||!email||!pass){ setAuthMsg('Preencha todos os campos.','err'); return; }
  if(pass.length<8){ setAuthMsg('A senha deve ter ao menos 8 caracteres.','err'); return; }
  btn.disabled=true; btn.textContent='Criando...';
  var res=await srvCall('setupAdmin',{ nome:nome, email:email, password:pass });
  btn.disabled=false; btn.textContent='Criar conta admin';
  if(!res.success){ setAuthMsg(res.error||'Erro no setup.','err'); return; }
  setAuthMsg('Conta criada! Entre agora.','ok');
  $('loginEmail').value=email;
  setTimeout(function(){ switchAuthMode('login'); }, 1100);
}
function setAuthMsg(msg, type){ var el=$('authMsg'); el.textContent=msg||''; el.className='auth-msg'+(msg?(' '+type):''); }

function clearAuthSession(){ State.auth.token=''; State.auth.user=null; localStorage.removeItem('llCrmToken'); }

async function doLogin(){
  var btn=$('loginBtn'); var email=$('loginEmail').value.trim(); var pass=$('loginPass').value;
  if(!email||!pass){ setAuthMsg('Preencha e-mail e senha.','err'); return; }
  btn.disabled=true; btn.textContent='Entrando...';
  var res=await srvCall('loginUser',{ email:email, password:pass });
  btn.disabled=false; btn.textContent='Entrar';
  if(!res.success){ setAuthMsg(res.error||'Falha no login.','err'); return; }
  State.auth.token=res.data.token; State.auth.user=res.data.user; localStorage.setItem('llCrmToken',res.data.token);
  enterApp();
}

async function doReset(){
  var btn=$('resetBtn');
  if($('resetStep2').style.display==='none'){
    var email=$('resetEmail').value.trim(); if(!email){ setAuthMsg('Informe o e-mail.','err'); return; }
    btn.disabled=true; btn.textContent='Enviando...';
    var res=await srvCall('requestPasswordReset',{ email:email });
    btn.disabled=false; btn.textContent='Redefinir senha';
    setAuthMsg((res.data&&res.data.message)||'Se o e-mail existir, enviamos um código.','ok');
    $('resetStep2').style.display='block';
  } else {
    var email2=$('resetEmail').value.trim(), code=$('resetCode').value.trim(), np=$('resetNew').value;
    btn.disabled=true; btn.textContent='Redefinindo...';
    var r=await srvCall('resetPasswordWithCode',{ email:email2, code:code, newPassword:np });
    btn.disabled=false; btn.textContent='Redefinir senha';
    if(!r.success){ setAuthMsg(r.error||'Erro.','err'); return; }
    setAuthMsg('Senha redefinida! Entre novamente.','ok');
    setTimeout(function(){ switchAuthMode('login'); $('resetStep2').style.display='none'; }, 1400);
  }
}

function enterApp(){
  hideAuthOverlay();
  var u=State.auth.user;
  $('userName').textContent=u.nome||u.email;
  $('userRole').textContent=u.perfil==='admin'?'Administrador':'Membro';
  $('userAv').textContent=(initials(u.nome)||'U').toUpperCase();
  var isAdmin = u.perfil==='admin';
  $('navSettings').style.display=isAdmin?'flex':'none';
  $('adminSec').style.display=isAdmin?'block':'none';
  navigateTo('dashboard');
}

/* ---------- NAVEGAÇÃO SPA ---------- */
var PAGE_META = {
  dashboard:{ title:'Dashboard', sub:'Visão geral do funil comercial', action:null },
  leads:{ title:'Leads', sub:'Base de contatos e oportunidades', action:{label:'Novo lead', fn:function(){ openLeadDrawer(null); }} },
  pipeline:{ title:'Pipeline', sub:'Oportunidades por etapa', action:{label:'Nova oportunidade', fn:function(){ openDealDrawer(null); }} },
  settings:{ title:'Configurações', sub:'Marca, identidade e equipe', action:null }
};
var LOADERS = { dashboard:loadDashboard, leads:function(){ loadLeads({}); }, pipeline:loadPipeline, settings:loadSettings };

function initNavigation(){
  document.querySelectorAll('.nav-btn[data-page]').forEach(function(b){ b.addEventListener('click', function(){ navigateTo(b.dataset.page); closeSidebar(); }); });
  $('menuToggle').addEventListener('click', function(){ $('sidebar').classList.toggle('open'); });
}
function closeSidebar(){ $('sidebar').classList.remove('open'); }
function navigateTo(page){
  State.currentPage=page;
  document.querySelectorAll('.nav-btn[data-page]').forEach(function(b){ b.classList.toggle('active', b.dataset.page===page); });
  document.querySelectorAll('.page').forEach(function(p){ p.classList.remove('active'); });
  var el=$('page-'+page); if(el) el.classList.add('active');
  var meta=PAGE_META[page]||{};
  $('topTitle').textContent=meta.title||''; $('topSub').textContent=meta.sub||'';
  var pa=$('primaryAction');
  if(meta.action){ pa.style.display='inline-flex'; pa.innerHTML='<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'+esc(meta.action.label); pa.onclick=meta.action.fn; }
  else pa.style.display='none';
  if(LOADERS[page]) LOADERS[page]();
}

/* ---------- DRAWER ---------- */
function openDrawer(title, bodyHtml, footHtml){
  $('drawerTitle').textContent=title; $('drawerBody').innerHTML=bodyHtml; $('drawerFoot').innerHTML=footHtml||'';
  $('scrim').classList.add('open'); $('drawer').classList.add('open');
}
function closeDrawer(){ $('scrim').classList.remove('open'); $('drawer').classList.remove('open'); }

/* ===================== DASHBOARD ===================== */
function skeletonGrid(n){ var h=''; for(var i=0;i<n;i++) h+='<div class="card kpi"><div class="skeleton" style="height:70px"></div></div>'; return '<div class="grid kpis">'+h+'</div>'; }
async function loadDashboard(){
  var root=$('page-dashboard'); root.innerHTML=skeletonGrid(4);
  var res=await srvCall('getDashboard',{});
  if(!res.success){ root.innerHTML='<div class="empty">'+esc(res.error)+'</div>'; return; }
  var k=res.data.kpis;
  var kpis=[
    {lbl:'Leads totais', val:k.totalLeads, cls:'cy', sub:'+'+k.leadsNovosMes+' este mês'},
    {lbl:'Leads quentes', val:k.leadsQuentes, cls:'pu', sub:'prontos para abordar'},
    {lbl:'Oport. abertas', val:k.oportAbertas, cls:'am', sub:moneyShort(k.valorPipeline)+' em jogo'},
    {lbl:'Ganhas no mês', val:k.ganhasMes, cls:'gn', sub:money(k.valorGanhoMes)}
  ];
  var html='<div class="grid kpis">'+kpis.map(function(x){
    return '<div class="card kpi"><div class="lbl">'+esc(x.lbl)+'</div><div class="val '+x.cls+'">'+x.val+'</div><div class="sub">'+esc(x.sub)+'</div></div>';
  }).join('')+'</div>';

  var maxF=Math.max.apply(null,res.data.funnel.map(function(f){return f.total;}).concat([1]));
  html+='<div class="section-h"><h2>Funil por etapa</h2></div><div class="card" style="padding:20px">';
  if(res.data.funnel.length){
    html+=res.data.funnel.map(function(f){
      return '<div class="funnel-row"><div class="funnel-lbl">'+esc(f.etapa)+'</div><div class="funnel-bar" style="width:'+Math.max(8,(f.total/maxF*100))+'%">'+f.total+'</div></div>';
    }).join('');
  } else html+='<div style="color:var(--tx3);font-size:13px">Sem oportunidades ainda.</div>';
  html+='</div>';

  html+='<div class="section-h"><h2>Leads recentes</h2><button class="btn btn-sm btn-ghost" onclick="navigateTo(\'leads\')">Ver todos</button></div>';
  html+='<div class="card tbl-wrap"><table><thead><tr><th>Nome</th><th>Empresa</th><th>Status</th><th>Temp.</th><th>Entrada</th></tr></thead><tbody>';
  if(res.data.recentes.length){
    html+=res.data.recentes.map(function(l){
      return '<tr onclick="openLeadById(\''+esc(l.id)+'\')"><td class="cell-name">'+esc(l.nome)+'</td><td class="cell-mut">'+esc(l.empresa||'—')+'</td><td>'+statusBadge(l.status)+'</td><td>'+tempBadge(l.temperatura)+'</td><td class="cell-mut">'+dt(l.criadoEm)+'</td></tr>';
    }).join('');
  } else html+='<tr><td colspan="5"><div class="empty">Nenhum lead ainda. Cadastre o primeiro.</div></td></tr>';
  html+='</tbody></table></div>';
  root.innerHTML=html;
}
function statusBadge(s){ return '<span class="badge b-'+slug(s)+'">'+esc(s||'Novo')+'</span>'; }
function tempBadge(t){ var c=slug(t)||'frio'; return '<span class="temp t-'+c+'"><span class="dot"></span>'+esc(t||'Frio')+'</span>'; }

/* ===================== LEADS ===================== */
var LEAD_FILTERS = { q:'', status:'', temperatura:'', fonte:'' };
async function loadLeads(extra){
  Object.assign(LEAD_FILTERS, extra||{});
  var root=$('page-leads');
  if(!root.dataset.init){
    root.innerHTML =
      '<div class="toolbar">'
      + '<div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><input id="leadSearch" placeholder="Buscar por nome, e-mail, empresa..."></div>'
      + '<div class="chips" id="leadStatusChips"></div>'
      + '<button class="btn btn-sm" id="leadImportBtn" title="Puxar leads do formulário de diagnóstico"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Importar do formulário</button>'
      + '</div><div id="leadList"></div>';
    root.dataset.init='1';
    $('leadSearch').addEventListener('input', debounce(function(e){ LEAD_FILTERS.q=e.target.value; renderLeadList(); }, 250));
    $('leadImportBtn').addEventListener('click', importFromForm);
  }
  var res=await srvCall('getLeads', LEAD_FILTERS);
  if(!res.success){ $('leadList').innerHTML='<div class="empty">'+esc(res.error)+'</div>'; return; }
  State.cache.leads=res.data.leads; State.cache.leadStatus=res.data.statusOptions;
  buildStatusChips(res.data.statusOptions);
  renderLeadList();
}
function buildStatusChips(opts){
  var el=$('leadStatusChips'); if(!el) return;
  var all=[''].concat(opts);
  el.innerHTML=all.map(function(s){
    return '<button class="chip'+(LEAD_FILTERS.status===s?' active':'')+'" data-st="'+esc(s)+'">'+(s?esc(s):'Todos')+'</button>';
  }).join('');
  el.querySelectorAll('.chip').forEach(function(c){ c.onclick=function(){ LEAD_FILTERS.status=c.dataset.st; loadLeads({}); }; });
}
function renderLeadList(){
  var leads=(State.cache.leads||[]).filter(function(l){
    if(!LEAD_FILTERS.q) return true;
    var blob=(l.nome+' '+l.email+' '+l.empresa+' '+l.telefone).toLowerCase();
    return blob.indexOf(LEAD_FILTERS.q.toLowerCase())!==-1;
  });
  if(!leads.length){ $('leadList').innerHTML='<div class="card"><div class="empty"><svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg><div>Nenhum lead encontrado.</div></div></div>'; return; }
  var html='<div class="card tbl-wrap"><table><thead><tr><th>Nome</th><th>Contato</th><th>Empresa</th><th>Fonte</th><th>Status</th><th>Temp.</th><th>Valor est.</th></tr></thead><tbody>';
  html+=leads.map(function(l){
    return '<tr onclick="openLeadDrawer(State.cache.leads.find(function(x){return x.id===\''+esc(l.id)+'\'}))">'
      +'<td class="cell-name">'+esc(l.nome)+'</td>'
      +'<td class="cell-mut">'+esc(l.email||l.telefone||'—')+'</td>'
      +'<td class="cell-mut">'+esc(l.empresa||'—')+'</td>'
      +'<td class="cell-mut">'+esc(l.fonte||'—')+'</td>'
      +'<td>'+statusBadge(l.status)+'</td>'
      +'<td>'+tempBadge(l.temperatura)+'</td>'
      +'<td class="cell-mut">'+(l.valorEstimado?money(l.valorEstimado):'—')+'</td></tr>';
  }).join('');
  html+='</tbody></table></div>';
  $('leadList').innerHTML=html;
}
async function importFromForm(){
  var btn=$('leadImportBtn'); var html=btn?btn.innerHTML:'';
  if(btn){ btn.disabled=true; btn.textContent='Importando…'; }
  var res=await srvCall('importLeads',{});
  if(btn){ btn.disabled=false; btn.innerHTML=html; }
  if(!res.success){ toast(res.error||'Falha ao importar','err'); return; }
  toast((res.data.imported||0)+' de '+(res.data.total||0)+' lead(s) sincronizados','ok');
  loadLeads({});
}
function openLeadById(id){ srvCall('getLead',{id:id}).then(function(r){ if(r.success) openLeadDrawer(r.data); }); }
function openLeadDrawer(lead){
  var l=lead||{};
  var statusOpts=(State.cache.leadStatus||['Novo','Contatado','Qualificado','Em negociação','Cliente','Perdido']);
  var temps=['Frio','Morno','Quente'];
  var body=''
    +'<input type="hidden" id="ldId" value="'+esc(l.id||'')+'">'
    +'<div class="field"><label>Nome *</label><input id="ldNome" value="'+esc(l.nome||'')+'"></div>'
    +'<div class="row2"><div class="field"><label>Telefone</label><input id="ldTel" value="'+esc(l.telefone||'')+'"></div>'
    +'<div class="field"><label>E-mail</label><input id="ldEmail" value="'+esc(l.email||'')+'"></div></div>'
    +'<div class="row2"><div class="field"><label>Empresa</label><input id="ldEmp" value="'+esc(l.empresa||'')+'"></div>'
    +'<div class="field"><label>Cargo</label><input id="ldCargo" value="'+esc(l.cargo||'')+'"></div></div>'
    +'<div class="row2"><div class="field"><label>Status</label><select id="ldStatus">'+statusOpts.map(function(s){return '<option'+(l.status===s?' selected':'')+'>'+esc(s)+'</option>';}).join('')+'</select></div>'
    +'<div class="field"><label>Temperatura</label><select id="ldTemp">'+temps.map(function(s){return '<option'+(l.temperatura===s?' selected':'')+'>'+esc(s)+'</option>';}).join('')+'</select></div></div>'
    +'<div class="row2"><div class="field"><label>Fonte</label><input id="ldFonte" value="'+esc(l.fonte||'Manual')+'"></div>'
    +'<div class="field"><label>Valor estimado (R$)</label><input id="ldValor" type="number" value="'+esc(l.valorEstimado||'')+'"></div></div>'
    +'<div class="field"><label>Observações</label><textarea id="ldObs">'+esc(l.observacoes||'')+'</textarea></div>';
  var foot='';
  if(l.id){
    foot+='<button class="btn btn-ghost btn-sm" onclick="convertLeadAction(\''+esc(l.id)+'\')"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="20 6 9 17 4 12"/></svg>Converter</button>';
    foot+='<button class="btn btn-danger btn-sm" onclick="deleteLeadAction(\''+esc(l.id)+'\')">Excluir</button>';
  }
  foot+='<button class="btn btn-primary" onclick="saveLead()">Salvar</button>';
  openDrawer(l.id?'Editar lead':'Novo lead', body, foot);
}
async function saveLead(){
  var p={
    id:$('ldId').value, nome:$('ldNome').value, telefone:$('ldTel').value, email:$('ldEmail').value,
    empresa:$('ldEmp').value, cargo:$('ldCargo').value, status:$('ldStatus').value, temperatura:$('ldTemp').value,
    fonte:$('ldFonte').value, valorEstimado:$('ldValor').value, observacoes:$('ldObs').value
  };
  if(!p.nome.trim()){ toast('Informe o nome.','err'); return; }
  var res=await srvCall(p.id?'updateLead':'createLead', p);
  if(!res.success){ toast(res.error,'err'); return; }
  toast(p.id?'Lead atualizado':'Lead criado','ok'); closeDrawer(); loadLeads({});
}
async function deleteLeadAction(id){
  if(!confirm('Excluir este lead?')) return;
  var res=await srvCall('deleteLead',{id:id});
  if(!res.success){ toast(res.error,'err'); return; }
  toast('Lead excluído','ok'); closeDrawer(); loadLeads({});
}
async function convertLeadAction(id){
  var res=await srvCall('convertLead',{id:id});
  if(!res.success){ toast(res.error,'err'); return; }
  toast('Lead convertido em oportunidade','ok'); closeDrawer();
}

/* ===================== PIPELINE (kanban) ===================== */
async function loadPipeline(){
  var root=$('page-pipeline'); root.innerHTML='<div class="card" style="padding:24px"><div class="skeleton" style="height:200px"></div></div>';
  var pRes=await srvCall('getPipelines',{});
  if(!pRes.success){ root.innerHTML='<div class="empty">'+esc(pRes.error)+'</div>'; return; }
  var pipe=(pRes.data.pipelines||[])[0];
  if(!pipe){ root.innerHTML='<div class="empty">Nenhum pipeline configurado.</div>'; return; }
  State.cache.pipe=pipe;
  var dRes=await srvCall('getDeals',{ pipeline:pipe.nome });
  var deals=(dRes.success?dRes.data.deals:[])||[];
  State.cache.deals=deals;
  renderKanban(pipe, deals);
}
function renderKanban(pipe, deals){
  var byEtapa={}; pipe.etapas.forEach(function(e){ byEtapa[e]=[]; });
  deals.forEach(function(d){ if(!byEtapa[d.etapa]) byEtapa[d.etapa]=[]; byEtapa[d.etapa].push(d); });
  var html='<div class="kanban">';
  pipe.etapas.forEach(function(et){
    var list=byEtapa[et]||[]; var sum=list.reduce(function(a,d){return a+(d.valor||0);},0);
    html+='<div class="kcol" data-etapa="'+esc(et)+'" ondragover="kanbanOver(event,this)" ondragleave="this.classList.remove(\'drop\')" ondrop="kanbanDrop(event,this)">';
    html+='<div class="kcol-h"><b>'+esc(et)+'</b><span class="cnt">'+list.length+'</span></div>';
    html+=sum?'<div class="kcol-sum">'+moneyShort(sum)+'</div>':'';
    list.forEach(function(d){
      html+='<div class="kcard" draggable="true" data-id="'+esc(d.id)+'" ondragstart="kanbanDrag(event,this)" ondragend="this.classList.remove(\'dragging\')" onclick="openDealDrawer(State.cache.deals.find(function(x){return x.id===\''+esc(d.id)+'\'}))">'
        +'<b>'+esc(d.nome)+'</b><div class="meta"><span>'+esc(firstName(d.responsavel)||'—')+'</span><span class="val">'+(d.valor?moneyShort(d.valor):'—')+'</span></div></div>';
    });
    html+='</div>';
  });
  html+='</div>';
  $('page-pipeline').innerHTML=html;
}
var dragId=null;
function kanbanDrag(e,el){ dragId=el.dataset.id; el.classList.add('dragging'); try{ e.dataTransfer.setData('text/plain',dragId); e.dataTransfer.effectAllowed='move'; }catch(_){} }
function kanbanOver(e,col){ e.preventDefault(); col.classList.add('drop'); }
async function kanbanDrop(e,col){
  e.preventDefault(); col.classList.remove('drop');
  var etapa=col.dataset.etapa; var id=dragId; dragId=null;
  if(!id) return;
  var deal=(State.cache.deals||[]).find(function(x){return x.id===id;});
  if(deal && deal.etapa===etapa) return;
  if(deal){ deal.etapa=etapa; renderKanban(State.cache.pipe, State.cache.deals); }
  var res=await srvCall('moveDeal',{ id:id, etapa:etapa });
  if(!res.success){ toast(res.error,'err'); loadPipeline(); } else toast('Movido para '+etapa,'ok');
}
function openDealDrawer(deal){
  var d=deal||{}; var pipe=State.cache.pipe||{etapas:['Novo']};
  var body=''
    +'<input type="hidden" id="dlId" value="'+esc(d.id||'')+'">'
    +'<div class="field"><label>Nome da oportunidade *</label><input id="dlNome" value="'+esc(d.nome||'')+'"></div>'
    +'<div class="row2"><div class="field"><label>Etapa</label><select id="dlEtapa">'+pipe.etapas.map(function(e){return '<option'+(d.etapa===e?' selected':'')+'>'+esc(e)+'</option>';}).join('')+'</select></div>'
    +'<div class="field"><label>Valor (R$)</label><input id="dlValor" type="number" value="'+esc(d.valor||'')+'"></div></div>'
    +'<div class="row2"><div class="field"><label>Responsável</label><input id="dlResp" value="'+esc(d.responsavel||(State.auth.user&&State.auth.user.nome)||'')+'"></div>'
    +'<div class="field"><label>Previsão</label><input id="dlPrev" type="date" value="'+esc((d.previsao||'').slice(0,10))+'"></div></div>'
    +'<div class="field"><label>Observações</label><textarea id="dlObs">'+esc(d.observacoes||'')+'</textarea></div>';
  var foot='';
  if(d.id) foot+='<button class="btn btn-danger btn-sm" onclick="deleteDealAction(\''+esc(d.id)+'\')">Excluir</button>';
  foot+='<button class="btn btn-primary" onclick="saveDeal()">Salvar</button>';
  openDrawer(d.id?'Editar oportunidade':'Nova oportunidade', body, foot);
}
async function saveDeal(){
  var p={ id:$('dlId').value, nome:$('dlNome').value, etapa:$('dlEtapa').value, valor:$('dlValor').value,
    responsavel:$('dlResp').value, previsao:$('dlPrev').value, observacoes:$('dlObs').value,
    pipeline:(State.cache.pipe&&State.cache.pipe.nome)||'Comercial' };
  if(!p.nome.trim()){ toast('Informe o nome.','err'); return; }
  var res=await srvCall(p.id?'updateDeal':'createDeal', p);
  if(!res.success){ toast(res.error,'err'); return; }
  if(p.id && p.etapa) await srvCall('moveDeal',{id:p.id,etapa:p.etapa});
  toast('Oportunidade salva','ok'); closeDrawer(); loadPipeline();
}
async function deleteDealAction(id){
  if(!confirm('Excluir esta oportunidade?')) return;
  var res=await srvCall('deleteDeal',{id:id});
  if(!res.success){ toast(res.error,'err'); return; }
  toast('Excluída','ok'); closeDrawer(); loadPipeline();
}

/* ===================== SETTINGS (admin) ===================== */
async function loadSettings(){
  var root=$('page-settings');
  if(State.auth.user.perfil!=='admin'){ root.innerHTML='<div class="empty">Acesso restrito a administradores.</div>'; return; }
  root.innerHTML='<div class="card" style="padding:24px"><div class="skeleton" style="height:160px"></div></div>';
  var res=await srvCall('getSettings',{});
  if(!res.success){ root.innerHTML='<div class="empty">'+esc(res.error)+'</div>'; return; }
  var c=res.data.config;
  var html='<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">';
  html+='<div class="card" style="padding:22px"><div class="section-h" style="margin:0 0 14px"><h2>Marca / White-label</h2></div>'
    +'<div class="field"><label>Nome do app</label><input id="cfgName" value="'+esc(c.APP_NAME||'')+'"></div>'
    +'<div class="field"><label>Tagline</label><input id="cfgTag" value="'+esc(c.COMPANY_TAGLINE||'')+'"></div>'
    +'<div class="field"><label>URL do logo</label><input id="cfgLogo" value="'+esc(c.APP_LOGO_URL||'')+'" placeholder="https://..."></div>'
    +'<div class="row2"><div class="field"><label>Cor primária</label><input id="cfgPrim" value="'+esc(c.BRAND_PRIMARY||'#00f0ff')+'"></div>'
    +'<div class="field"><label>Cor de destaque</label><input id="cfgAcc" value="'+esc(c.BRAND_ACCENT||'#a855f7')+'"></div></div>'
    +'<div class="field"><label>WhatsApp padrão</label><input id="cfgWa" value="'+esc(c.WHATSAPP_DEFAULT||'')+'" placeholder="5554..."></div>'
    +'<button class="btn btn-primary" onclick="saveSettingsAction()" style="margin-top:6px">Salvar identidade</button></div>';
  html+='<div class="card" style="padding:22px"><div class="section-h" style="margin:0 0 14px"><h2>Equipe</h2><button class="btn btn-sm" onclick="openUserDrawer(null)">+ Convidar</button></div><div id="usersList"><div class="skeleton" style="height:80px"></div></div></div>';
  html+='</div>';
  root.innerHTML=html;
  loadUsers();
}
async function saveSettingsAction(){
  var cfg={ APP_NAME:$('cfgName').value, COMPANY_TAGLINE:$('cfgTag').value, APP_LOGO_URL:$('cfgLogo').value,
    BRAND_PRIMARY:$('cfgPrim').value, BRAND_ACCENT:$('cfgAcc').value, WHATSAPP_DEFAULT:$('cfgWa').value };
  var res=await srvCall('saveSettings',{config:cfg});
  if(!res.success){ toast(res.error,'err'); return; }
  applyBranding(Object.assign({}, State.brand, cfg));
  toast('Identidade salva','ok');
}
async function loadUsers(){
  var res=await srvCall('getUsers',{});
  if(!res.success){ $('usersList').innerHTML='<div style="color:var(--tx3);font-size:13px">'+esc(res.error)+'</div>'; return; }
  State.cache.users=res.data.users;
  $('usersList').innerHTML=res.data.users.map(function(u){
    return '<div style="display:flex;align-items:center;gap:11px;padding:11px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="openUserDrawer(State.cache.users.find(function(x){return x.id===\''+esc(u.id)+'\'}))">'
      +'<div class="user-av" style="width:34px;height:34px">'+esc((initials(u.nome)||'U').toUpperCase())+'</div>'
      +'<div style="flex:1;min-width:0"><b style="font-size:13.5px;display:block">'+esc(u.nome)+'</b><span style="font-family:var(--fm);font-size:11px;color:var(--tx3)">'+esc(u.email)+'</span></div>'
      +'<span class="badge '+(u.perfil==='admin'?'b-cliente':'b-novo')+'">'+esc(u.perfil)+'</span>'
      +(u.ativo?'':'<span class="badge b-perdido">inativo</span>')+'</div>';
  }).join('')||'<div style="color:var(--tx3);font-size:13px">Sem usuários.</div>';
}
function openUserDrawer(user){
  var u=user||{};
  var body=''
    +'<input type="hidden" id="usId" value="'+esc(u.id||'')+'">'
    +'<div class="field"><label>Nome *</label><input id="usNome" value="'+esc(u.nome||'')+'"></div>'
    +'<div class="field"><label>E-mail *</label><input id="usEmail" value="'+esc(u.email||'')+'" '+(u.id?'disabled':'')+'></div>'
    +'<div class="row2"><div class="field"><label>Perfil</label><select id="usPerfil"><option value="membro"'+(u.perfil==='membro'?' selected':'')+'>Membro</option><option value="admin"'+(u.perfil==='admin'?' selected':'')+'>Admin</option></select></div>'
    +'<div class="field"><label>Ativo</label><select id="usAtivo"><option value="1"'+(u.ativo!==false?' selected':'')+'>Sim</option><option value="0"'+(u.ativo===false?' selected':'')+'>Não</option></select></div></div>'
    +'<div class="field"><label>Telegram ID</label><input id="usTg" value="'+esc(u.telegramId||'')+'"></div>'
    +(u.id?'<div class="field"><label>Resetar senha (opcional)</label><input id="usPass" type="text" placeholder="nova senha (mín. 8)"></div>':'');
  var foot='<button class="btn btn-primary" onclick="saveUser()">'+(u.id?'Salvar':'Convidar')+'</button>';
  openDrawer(u.id?'Editar usuário':'Convidar usuário', body, foot);
}
async function saveUser(){
  var id=$('usId').value;
  if(id){
    var res=await srvCall('updateUser',{ id:id, nome:$('usNome').value, perfil:$('usPerfil').value, ativo:$('usAtivo').value==='1', telegramId:$('usTg').value, newPassword:($('usPass')?$('usPass').value:'') });
    if(!res.success){ toast(res.error,'err'); return; }
    toast('Usuário atualizado','ok');
  } else {
    var r=await srvCall('inviteUser',{ nome:$('usNome').value, email:$('usEmail').value, perfil:$('usPerfil').value, telegramId:$('usTg').value });
    if(!r.success){ toast(r.error,'err'); return; }
    toast('Convite enviado (senha temp: '+(r.data.tempPassword||'')+')','ok');
  }
  closeDrawer(); loadUsers();
}

/* ---------- utils ---------- */
function debounce(fn,ms){ var t; return function(){ var a=arguments,c=this; clearTimeout(t); t=setTimeout(function(){ fn.apply(c,a); }, ms); }; }

/* ---------- BOOT ---------- */
async function bootstrapAuth(){
  if(EMBED){
    State.auth.token = localStorage.getItem('llCrmToken') || State.auth.token;
    if(State.auth.token){
      var r=await srvCall('getCurrentSession',{ sessionToken: State.auth.token });
      if(r.success){ State.auth.user=r.data.user; enterApp(); return; }
      clearAuthSession();
    }
    showAuthOverlay('login','Conectando ao painel…');
    return;
  }
  var st=await srvCall('setupStatus',{});
  if(st.success && st.data && !st.data.configured){ showAuthOverlay('setup'); return; }
  if(!State.auth.token){ showAuthOverlay('login'); return; }
  var res=await srvCall('getCurrentSession',{ sessionToken: State.auth.token });
  if(res.success){ State.auth.user=res.data.user; enterApp(); }
  else { clearAuthSession(); showAuthOverlay('login'); }
}
document.addEventListener('DOMContentLoaded', async function(){
  initNavigation();
  $('loginBtn').addEventListener('click', doLogin);
  $('loginPass').addEventListener('keydown', function(e){ if(e.key==='Enter') doLogin(); });
  $('resetBtn').addEventListener('click', doReset);
  if($('setupBtn')) $('setupBtn').addEventListener('click', doSetup);
  document.querySelectorAll('[data-auth]').forEach(function(el){ el.addEventListener('click', function(){ switchAuthMode(el.dataset.auth); }); });
  $('drawerClose').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);
  if(EMBED){ var uc=$('userChip'); if(uc){ uc.style.cursor='default'; var cv=uc.querySelector('svg'); if(cv) cv.style.display='none'; } }
  else { $('userChip').addEventListener('click', async function(){ if(confirm('Sair da conta?')){ await srvCall('logoutUser',{sessionToken:State.auth.token}); clearAuthSession(); location.reload(); } }); }

  var boot=await srvCall('getPublicBootstrapData',{});
  if(boot.success) applyBranding(boot.data);
  await bootstrapAuth();
});
