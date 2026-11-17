/* Painel autenticado: regras, simulador, contadores e erros da Meta. */
var metaAutomationRules_ = [];
var metaAutomationConfig_ = {};
var metaAutomationEditing_ = '';
var metaAutomationMedia_ = { instagram:null, facebook:null };
var metaAutomationMediaAfter_ = { instagram:'', facebook:'' };
var metaAutomationSelectedIds_ = new Set();
var metaAutomationPreviewClicks_ = 0;
var metaAutomationDragStep_ = '';
var metaAutomationVisual_ = { orientation:'vertical', positions:{}, disconnected:[], zoom:1, panX:0, panY:0, selected:0, connecting:0 };
var metaAutomationPointer_ = null;
var metaAutomationViewport_ = null;
var metaAutomationStatus_ = null;
var metaAutomationMenu_ = null;
function metaAutomationCloseMenu_() { if(metaAutomationMenu_){metaAutomationMenu_.remove();metaAutomationMenu_=null;} }
function metaAutomationContext_(event, actions) {
  event.preventDefault(); metaAutomationCloseMenu_();
  var menu=document.createElement('div'); menu.className='meta-auto-context'; menu.setAttribute('role','menu');
  actions.forEach(function(item){var button=document.createElement('button');button.type='button';button.textContent=item[0];button.addEventListener('click',function(){metaAutomationCloseMenu_();item[1]();});menu.append(button);});
  document.body.append(menu);metaAutomationMenu_=menu;
  menu.style.left=Math.min(event.clientX,window.innerWidth-menu.offsetWidth-8)+'px';
  menu.style.top=Math.min(event.clientY,window.innerHeight-menu.offsetHeight-8)+'px';
  menu.querySelector('button')?.focus();
}
function metaAutomationToggleCondition_(enabled) {
  if(metaAutomationField_('meta-auto-channel').value!=='instagram') {metaAutomationStatus_.textContent='No Facebook, a checagem de seguidor não se aplica.';return;}
  metaAutomationVisual_.conditionEnabled=enabled;
  metaAutomationVisual_.disconnected=[];
  metaAutomationSyncCondition_(); metaAutomationDrawConnections_(); metaAutomationUpdateToolbar_();
}
function metaAutomationField_(id) { return document.getElementById(id); }
function metaAutomationList_(value) { return String(value || '').split(/[,\n]/).map(function(v) { return v.trim(); }).filter(Boolean); }
function metaAutomationPostIds_() {
  return [...new Set([...metaAutomationSelectedIds_, ...metaAutomationList_(metaAutomationField_('meta-auto-posts').value)])];
}
function metaAutomationHydrateSelection_() {
  var items = metaAutomationMedia_[metaAutomationField_('meta-auto-channel').value] || [];
  var manual = new Set(metaAutomationList_(metaAutomationField_('meta-auto-posts').value));
  items.forEach(function(item){ if (manual.delete(item.id)) metaAutomationSelectedIds_.add(item.id); });
  metaAutomationField_('meta-auto-posts').value = [...manual].join(', ');
}
function metaAutomationScopeChanged() {
  var specific = metaAutomationField_('meta-auto-specific').checked;
  metaAutomationField_('meta-auto-media-picker').hidden = !specific;
  if (specific && metaAutomationMedia_[metaAutomationField_('meta-auto-channel').value]) {
    metaAutomationHydrateSelection_(); metaAutomationRenderMedia_();
  }
  metaAutomationTargetSummary_(); metaAutomationDrawConnections_();
  if (specific && !metaAutomationMedia_[metaAutomationField_('meta-auto-channel').value]) loadMetaAutomationMedia();
}
function metaAutomationTargetSummary_() {
  var count = metaAutomationField_('meta-auto-specific').checked ? metaAutomationPostIds_().length : 0;
  metaAutomationField_('meta-auto-target-summary').textContent = count ? count + ' publicação(ões) selecionada(s)' :
    metaAutomationField_('meta-auto-specific').checked ? 'Selecione ao menos uma publicação' : 'Todos os posts e Reels';
}
function metaAutomationRenderChips_() {
  var target = metaAutomationField_('meta-auto-keyword-chips'); target.replaceChildren();
  metaAutomationList_(metaAutomationField_('meta-auto-keywords').value).slice(0, 20).forEach(function(word) {
    var chip = document.createElement('span'); chip.className = 'meta-auto-chip'; chip.textContent = '# ' + word; target.append(chip);
  });
}
function metaAutomationPreviewReset() {
  metaAutomationPreviewClicks_ = 0;
  metaAutomationField_('meta-auto-preview-follow').classList.remove('show');
  metaAutomationField_('meta-auto-preview-link').classList.remove('show');
  metaAutomationField_('meta-auto-preview-button').disabled = false;
  metaAutomationPreview_();
}
function metaAutomationPreviewTap() {
  var needsFollow = metaAutomationField_('meta-auto-channel').value === 'instagram' && metaAutomationField_('meta-auto-follow').checked;
  metaAutomationPreviewClicks_++;
  if (needsFollow && metaAutomationPreviewClicks_ === 1) {
    metaAutomationField_('meta-auto-preview-follow').classList.add('show');
    metaAutomationField_('meta-auto-preview-button').textContent = 'Já segui · tocar de novo';
  } else {
    metaAutomationField_('meta-auto-preview-link').classList.add('show');
    metaAutomationField_('meta-auto-preview-button').disabled = true;
  }
}
function metaAutomationPreview_() {
  var channel = metaAutomationField_('meta-auto-channel').value;
  var keyword = metaAutomationList_(metaAutomationField_('meta-auto-keywords').value)[0] || 'tutorial';
  var reply = metaAutomationField_('meta-auto-public').value.split('\n').map(function(v){ return v.trim(); }).filter(Boolean)[0] || 'Te mandei uma mensagem!';
  var dm = metaAutomationField_('meta-auto-dm').value.trim() || 'Toque no botão para receber o material.';
  var label = metaAutomationField_('meta-auto-button').value.trim() || 'Receber link';
  var link = metaAutomationField_('meta-auto-link').value.trim() || 'https://blog.example.com/...';
  metaAutomationField_('meta-auto-preview-account').textContent = channel === 'instagram' ? 'blog.example.com' : 'Lazy Labs';
  metaAutomationField_('meta-auto-preview-comment').firstChild.textContent = '“Quero ' + keyword + '” ';
  metaAutomationField_('meta-auto-preview-public').textContent = reply;
  metaAutomationField_('meta-auto-preview-dm').textContent = dm;
  metaAutomationField_('meta-auto-preview-button').textContent = metaAutomationPreviewClicks_ === 1 && channel === 'instagram' && metaAutomationField_('meta-auto-follow').checked ? 'Já segui · tocar de novo' : label;
  metaAutomationField_('meta-auto-preview-link').textContent = dm + '\n' + link;
  metaAutomationField_('meta-auto-condition-description').textContent = channel === 'facebook' ? 'No Facebook, o link é liberado após o toque.' : 'Se a pessoa seguir a conta, libera o link.';
}
function metaAutomationDefaultPositions_(orientation) {
  var result = {};
  var y=65, canvas=metaAutomationField_('meta-auto-canvas');
  var origin=metaAutomationViewport_ && metaAutomationViewport_.clientWidth < 440 ? 18 : 120;
  var visibleIndex=0, skipCondition=metaAutomationField_('meta-auto-channel').value==='facebook' || metaAutomationVisual_.conditionEnabled===false;
  for (var step=1; step<=6; step++) {
    var node=canvas.querySelector('[data-step="'+step+'"]');
    result[step] = orientation === 'horizontal' ? { x:origin+visibleIndex*390, y:180 } : { x:origin, y:y };
    if (step===5 && skipCondition) continue;
    visibleIndex++;
    y += Math.max(300,(node ? node.offsetHeight : 240)+78);
  }
  return result;
}
function metaAutomationApplyLayout_(order, saved) {
  var canvas = metaAutomationField_('meta-auto-canvas');
  (order || [1,2,3,4,5,6]).forEach(function(step) {
    var node = canvas.querySelector('[data-step="' + step + '"]'); if (node) canvas.append(node);
  });
  var orientation = saved && saved.orientation === 'horizontal' ? 'horizontal' : 'vertical';
  metaAutomationVisual_.conditionEnabled = metaAutomationField_('meta-auto-channel').value === 'instagram' && (!saved || saved.conditionEnabled !== false);
  metaAutomationSyncCondition_();
  var positions = metaAutomationDefaultPositions_(orientation);
  if (saved && saved.positions) Object.keys(positions).forEach(function(step) {
    var point = saved.positions[step];
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) positions[step] = { x:point.x, y:point.y };
  });
  metaAutomationVisual_.orientation = orientation;
  metaAutomationVisual_.positions = positions;
  metaAutomationVisual_.disconnected = [];
  metaAutomationVisual_.connecting = 0;
  metaAutomationPlaceNodes_();
  metaAutomationUpdateToolbar_();
  requestAnimationFrame(metaAutomationDrawConnections_);
}
function metaAutomationSyncCondition_() {
  var node=metaAutomationField_('meta-auto-canvas').querySelector('[data-step="5"]');
  if (node) node.hidden=!metaAutomationVisual_.conditionEnabled;
  if (!metaAutomationVisual_.conditionEnabled) metaAutomationField_('meta-auto-follow').checked=false;
}
function metaAutomationSequence_() {
  return metaAutomationVisual_.conditionEnabled ? [1,2,3,4,5,6] : [1,2,3,4,6];
}
function metaAutomationEdges_() {
  var sequence=metaAutomationSequence_(), result=[];
  for(var i=0;i<sequence.length-1;i++) result.push([sequence[i],sequence[i+1]]);
  return result;
}
function metaAutomationPlaceNodes_() {
  var canvas = metaAutomationField_('meta-auto-canvas');
  canvas.querySelectorAll('.meta-auto-node').forEach(function(node) {
    var point = metaAutomationVisual_.positions[node.dataset.step]; if (!point) return;
    node.style.left = point.x + 'px'; node.style.top = point.y + 'px';
  });
}
function metaAutomationTransform_() {
  var canvas = metaAutomationField_('meta-auto-canvas');
  canvas.style.transform = 'translate(' + metaAutomationVisual_.panX + 'px,' + metaAutomationVisual_.panY + 'px) scale(' + metaAutomationVisual_.zoom + ')';
  metaAutomationUpdateToolbar_();
}
function metaAutomationZoom_(factor, clientX, clientY) {
  var rect = metaAutomationViewport_.getBoundingClientRect();
  var cx = clientX == null ? rect.width/2 : clientX-rect.left;
  var cy = clientY == null ? rect.height/2 : clientY-rect.top;
  var old = metaAutomationVisual_.zoom;
  var next = Math.max(.15, Math.min(1.7, Math.round(old*factor*100)/100));
  metaAutomationVisual_.panX = cx-(cx-metaAutomationVisual_.panX)*next/old;
  metaAutomationVisual_.panY = cy-(cy-metaAutomationVisual_.panY)*next/old;
  metaAutomationVisual_.zoom = next;
  metaAutomationTransform_();
}
function metaAutomationFit_() {
  var nodes = [...metaAutomationField_('meta-auto-canvas').querySelectorAll('.meta-auto-node:not([hidden])')];
  var points = nodes.map(function(node) { var p=metaAutomationVisual_.positions[node.dataset.step]; return { x:p.x,y:p.y,w:node.offsetWidth,h:node.offsetHeight }; });
  if (!points.length) return;
  var minX=Math.min.apply(null,points.map(function(p){return p.x;})), minY=Math.min.apply(null,points.map(function(p){return p.y;}));
  var maxX=Math.max.apply(null,points.map(function(p){return p.x+p.w;})), maxY=Math.max.apply(null,points.map(function(p){return p.y+p.h;}));
  var width=metaAutomationViewport_.clientWidth, height=metaAutomationViewport_.clientHeight;
  var zoom=Math.max(.15,Math.min(1.3,Math.min((width-80)/(maxX-minX),(height-80)/(maxY-minY))));
  metaAutomationVisual_.zoom=zoom;
  metaAutomationVisual_.panX=(width-(maxX-minX)*zoom)/2-minX*zoom;
  metaAutomationVisual_.panY=(height-(maxY-minY)*zoom)/2-minY*zoom;
  metaAutomationTransform_();
}
function metaAutomationOrientation_(orientation) {
  if (orientation === metaAutomationVisual_.orientation) return;
  metaAutomationVisual_.orientation=orientation;
  metaAutomationVisual_.positions=metaAutomationDefaultPositions_(orientation);
  metaAutomationVisual_.zoom=1; metaAutomationVisual_.panX=0; metaAutomationVisual_.panY=0;
  metaAutomationPlaceNodes_(); metaAutomationDrawConnections_(); metaAutomationTransform_();
}
function metaAutomationExpanded_() {
  var shell=metaAutomationField_('meta-auto-canvas').closest('.meta-auto-canvas-shell');
  var expanded=shell.classList.toggle('is-expanded');
  document.body.classList.toggle('meta-auto-immersive',expanded);
  metaAutomationUpdateToolbar_();
  requestAnimationFrame(metaAutomationDrawConnections_);
}
function metaAutomationUpdateToolbar_() {
  if (!metaAutomationStatus_) return;
  var missing=metaAutomationVisual_.disconnected.length;
  metaAutomationStatus_.textContent = Math.round(metaAutomationVisual_.zoom*100) + '% · ' + (missing ? missing+' conexão(ões) pendente(s)' : metaAutomationSequence_().length+' blocos · '+metaAutomationEdges_().length+' conexões ativas') + ' · execução 01 → 06';
  var shell=metaAutomationField_('meta-auto-canvas').closest('.meta-auto-canvas-shell');
  var expand=shell.querySelector('[data-auto-tool="expand"]'); if (expand) expand.textContent=shell.classList.contains('is-expanded') ? 'Sair da tela cheia' : 'Expandir canvas';
  shell.querySelectorAll('[data-auto-layout]').forEach(function(button) { button.setAttribute('aria-pressed',button.dataset.autoLayout===metaAutomationVisual_.orientation?'true':'false'); });
}
function metaAutomationSelect_(step) {
  metaAutomationVisual_.selected=step;
  metaAutomationField_('meta-auto-canvas').querySelectorAll('.meta-auto-node').forEach(function(node){node.classList.toggle('is-selected',Number(node.dataset.step)===step);});
}
function metaAutomationPort_(step, side) {
  if (side === 'out') { metaAutomationVisual_.connecting=step; metaAutomationStatus_.textContent='Arraste ou selecione uma entrada válida para conectar 0'+step+'.'; return; }
  var from=metaAutomationVisual_.connecting;
  if (!metaAutomationEdges_().some(function(edge){return edge[0]===from&&edge[1]===step;})) { metaAutomationStatus_.textContent='Esta ligação mudaria a ordem de execução. Use a próxima etapa do fluxo.'; return; }
  metaAutomationVisual_.disconnected=metaAutomationVisual_.disconnected.filter(function(n){return n!==from;});
  metaAutomationVisual_.connecting=0;
  metaAutomationDrawConnections_(); metaAutomationUpdateToolbar_();
}
function metaAutomationDrawConnections_() {
  var canvas = metaAutomationField_('meta-auto-canvas'); var svg = metaAutomationField_('meta-auto-connections');
  if (!canvas || !svg) return;
  var nodes=[...canvas.querySelectorAll('.meta-auto-node:not([hidden])')];
  var xs=nodes.map(function(n){return metaAutomationVisual_.positions[n.dataset.step]?.x || 0;});
  var ys=nodes.map(function(n){return metaAutomationVisual_.positions[n.dataset.step]?.y || 0;});
  var minX=Math.min.apply(null,xs)-100, minY=Math.min.apply(null,ys)-100;
  var maxX=Math.max.apply(null,nodes.map(function(n){return (metaAutomationVisual_.positions[n.dataset.step]?.x || 0)+n.offsetWidth+100;}));
  var maxY=Math.max.apply(null,nodes.map(function(n){return (metaAutomationVisual_.positions[n.dataset.step]?.y || 0)+n.offsetHeight+100;}));
  svg.style.left=minX+'px';svg.style.top=minY+'px';svg.style.width=(maxX-minX)+'px';svg.style.height=(maxY-minY)+'px';
  svg.setAttribute('viewBox',minX+' '+minY+' '+(maxX-minX)+' '+(maxY-minY));
  svg.replaceChildren();
  var ns = 'http://www.w3.org/2000/svg';
  for (var edge of metaAutomationEdges_()) {
    var step=edge[0], next=edge[1];
    if (metaAutomationVisual_.disconnected.includes(step)) continue;
    var a=canvas.querySelector('[data-step="'+step+'"]'), b=canvas.querySelector('[data-step="'+next+'"]');
    var pa=metaAutomationVisual_.positions[step], pb=metaAutomationVisual_.positions[next];
    if (!a || !b || !pa || !pb) continue;
    var horizontal=metaAutomationVisual_.orientation==='horizontal';
    var x1=pa.x+(horizontal?a.offsetWidth: a.offsetWidth/2), y1=pa.y+(horizontal?a.offsetHeight/2:a.offsetHeight);
    var x2=pb.x+(horizontal?0:b.offsetWidth/2), y2=pb.y+(horizontal?b.offsetHeight/2:0);
    var bend=horizontal?Math.max(45,Math.abs(x2-x1)*.5):Math.max(45,Math.abs(y2-y1)*.5);
    var d=horizontal?'M '+x1+' '+y1+' C '+(x1+bend)+' '+y1+', '+(x2-bend)+' '+y2+', '+x2+' '+y2
      :'M '+x1+' '+y1+' C '+x1+' '+(y1+bend)+', '+x2+' '+(y2-bend)+', '+x2+' '+y2;
    var path=document.createElementNS(ns,'path'); path.setAttribute('d',d); path.classList.add('meta-auto-edge'); svg.append(path);
    var hit=document.createElementNS(ns,'path'); hit.setAttribute('d',d); hit.classList.add('meta-auto-edge-hit'); hit.setAttribute('tabindex','0');
    hit.setAttribute('role','button'); hit.setAttribute('aria-label','Desconectar blocos 0'+step+' e 0'+next);
    hit.addEventListener('click',function(edge){return function(){metaAutomationVisual_.disconnected.push(edge);metaAutomationDrawConnections_();metaAutomationUpdateToolbar_();};}(step));
    hit.addEventListener('contextmenu',function(edge,nextStep){return function(event){metaAutomationContext_(event,[['Desconectar 0'+edge+' → 0'+nextStep,function(){metaAutomationVisual_.disconnected.push(edge);metaAutomationDrawConnections_();metaAutomationUpdateToolbar_();}]]);};}(step,next));
    hit.addEventListener('keydown',function(event){if(event.key==='Enter'||event.key===' '){event.preventDefault();event.currentTarget.click();}});
    svg.append(hit);
  }
}
function metaAutomationRenderMedia_() {
  var channel = metaAutomationField_('meta-auto-channel').value;
  var items = metaAutomationMedia_[channel] || [];
  var query = metaAutomationField_('meta-auto-media-search').value.trim().toLowerCase();
  var grid = metaAutomationField_('meta-auto-media-grid'); grid.replaceChildren();
  items.filter(function(item){ return !query || (item.caption + ' ' + item.id).toLowerCase().includes(query); }).forEach(function(item) {
    var button = document.createElement('button'); button.type = 'button'; button.className = 'meta-auto-media-card';
    button.setAttribute('aria-pressed', metaAutomationSelectedIds_.has(item.id) ? 'true' : 'false');
    button.setAttribute('aria-label', (metaAutomationSelectedIds_.has(item.id) ? 'Remover ' : 'Selecionar ') + (item.caption || item.id));
    if (item.image) { var img = document.createElement('img'); img.src = item.image; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; button.append(img); }
    else { var placeholder = document.createElement('div'); placeholder.className = 'meta-auto-media-placeholder'; placeholder.textContent = item.type || 'PUBLICAÇÃO'; button.append(placeholder); }
    var title = document.createElement('span'); title.textContent = item.caption || item.type || item.id;
    var stats = document.createElement('small'); stats.textContent = (item.comments || 0) + ' comentários · ' + (item.likes || 0) + ' curtidas';
    button.append(title, stats);
    button.addEventListener('click', function() {
      if (metaAutomationSelectedIds_.has(item.id)) metaAutomationSelectedIds_.delete(item.id);
      else metaAutomationSelectedIds_.add(item.id);
      button.setAttribute('aria-pressed', metaAutomationSelectedIds_.has(item.id) ? 'true' : 'false');
      metaAutomationTargetSummary_();
    });
    grid.append(button);
  });
  if (!grid.childElementCount) grid.textContent = items.length ? 'Nenhuma publicação corresponde à busca.' : 'Nenhuma publicação encontrada.';
  requestAnimationFrame(metaAutomationDrawConnections_);
}
async function loadMetaAutomationMedia(more) {
  var channel = metaAutomationField_('meta-auto-channel').value;
  var status = metaAutomationField_('meta-auto-media-status'); status.textContent = 'Buscando publicações…';
  var button = metaAutomationField_('meta-auto-load-media'); button.disabled = true;
  try {
    var after = more ? metaAutomationMediaAfter_[channel] : '';
    if (more && !after) return;
    var url = '/api/meta/automations?action=media&channel=' + encodeURIComponent(channel) + (after ? '&after=' + encodeURIComponent(after) : '');
    var data = await fbFetch_(url, { method:'GET' });
    if (!data || !data.ok) throw new Error((data && data.message) || 'Não foi possível buscar as publicações.');
    if (channel !== metaAutomationField_('meta-auto-channel').value) return;
    var previous = more ? (metaAutomationMedia_[channel] || []) : [];
    metaAutomationMedia_[channel] = [...new Map([...previous, ...(data.items || [])].map(function(item){ return [item.id,item]; })).values()];
    metaAutomationMediaAfter_[channel] = data.nextAfter || '';
    metaAutomationField_('meta-auto-more-media').hidden = !metaAutomationMediaAfter_[channel];
    metaAutomationHydrateSelection_();
    status.textContent = metaAutomationMedia_[channel].length + ' publicações carregadas. A busca filtra as carregadas; carregue mais para ampliar. Visualizações podem não estar disponíveis.';
    metaAutomationRenderMedia_(); metaAutomationTargetSummary_();
  } catch (error) { status.textContent = error.message || 'Falha ao carregar publicações.'; }
  finally { button.disabled = false; }
}
function metaAutomationChannelChanged() {
  var ig = metaAutomationField_('meta-auto-channel').value === 'instagram';
  metaAutomationField_('meta-auto-facebook-note').hidden=ig;
  var conditionChip=document.querySelector('.meta-auto-palette-chip[data-step="5"]');if(conditionChip)conditionChip.hidden=!ig;
  metaAutomationField_('meta-auto-follow').disabled = !ig;
  metaAutomationField_('meta-auto-follow').closest('label').style.opacity = ig ? '1' : '.55';
  metaAutomationVisual_.conditionEnabled=ig;
  metaAutomationVisual_.disconnected=[];
  metaAutomationSyncCondition_();
  metaAutomationDrawConnections_(); metaAutomationUpdateToolbar_();
  metaAutomationSelectedIds_.clear();
  metaAutomationField_('meta-auto-posts').value = '';
  metaAutomationField_('meta-auto-media-grid').replaceChildren();
  metaAutomationField_('meta-auto-media-status').textContent = 'As publicações são buscadas com segurança no servidor.';
  metaAutomationField_('meta-auto-more-media').hidden = !metaAutomationMediaAfter_[metaAutomationField_('meta-auto-channel').value];
  var configured = !!metaAutomationConfig_[metaAutomationField_('meta-auto-channel').value];
  var state = metaAutomationField_('meta-auto-account-state');
  state.textContent = configured ? '● ID da conta configurado' : '● Configure o ID da conta em Publicação nas redes';
  state.classList.toggle('error', !configured);
  metaAutomationScopeChanged(); metaAutomationPreviewReset();
}
function clearMetaAutomation() {
  metaAutomationEditing_ = '';
  metaAutomationSelectedIds_.clear();
  ['meta-auto-posts','meta-auto-keywords','meta-auto-public','meta-auto-dm','meta-auto-link'].forEach(function(id) { metaAutomationField_(id).value = ''; });
  metaAutomationField_('meta-auto-button').value = 'Receber link';
  metaAutomationField_('meta-auto-enabled').checked = false;
  metaAutomationField_('meta-auto-follow').checked = true;
  metaAutomationField_('meta-auto-all').checked = true;
  metaAutomationApplyLayout_([1,2,3,4,5,6]);
  metaAutomationVisual_.zoom=1; metaAutomationVisual_.panX=0; metaAutomationVisual_.panY=0;
  metaAutomationTransform_(); metaAutomationSelect_(0);
  metaAutomationScopeChanged(); metaAutomationRenderChips_(); metaAutomationPreviewReset();
  metaAutomationField_('msg-meta-auto').textContent = '';
}
function editMetaAutomation(id) {
  var rule = metaAutomationRules_.find(function(item) { return item.id === id; });
  if (!rule) return;
  metaAutomationEditing_ = id;
  metaAutomationField_('meta-auto-channel').value = rule.channel;
  metaAutomationChannelChanged();
  metaAutomationField_('meta-auto-posts').value = (rule.postIds || []).join(', ');
  metaAutomationField_((rule.postIds || []).length ? 'meta-auto-specific' : 'meta-auto-all').checked = true;
  metaAutomationScopeChanged();
  metaAutomationField_('meta-auto-keywords').value = (rule.keywords || []).join(', ');
  metaAutomationField_('meta-auto-public').value = (rule.publicReplies || []).join('\n');
  metaAutomationField_('meta-auto-dm').value = rule.dmText || '';
  metaAutomationField_('meta-auto-button').value = rule.buttonLabel || '';
  metaAutomationField_('meta-auto-link').value = rule.link || '';
  metaAutomationField_('meta-auto-follow').checked = !!rule.requireFollow;
  metaAutomationField_('meta-auto-enabled').checked = !!rule.active;
  metaAutomationApplyLayout_(rule.nodeOrder, rule.visualLayout);
  metaAutomationVisual_.zoom=1; metaAutomationVisual_.panX=0; metaAutomationVisual_.panY=0; metaAutomationTransform_();
  metaAutomationRenderChips_(); metaAutomationPreviewReset(); metaAutomationTargetSummary_();
  metaAutomationField_('msg-meta-auto').textContent = 'Editando ' + id;
  metaAutomationField_('meta-auto-studio').scrollIntoView({ behavior:'smooth', block:'start' });
}
function metaAutomationButton_(label, fn) {
  var button = document.createElement('button');
  button.type = 'button'; button.className = 'btn-settings secondary'; button.textContent = label;
  button.addEventListener('click', fn); return button;
}
function renderMetaAutomations() {
  var list = metaAutomationField_('meta-auto-list'); if (!list) return;
  list.replaceChildren();
  metaAutomationRules_.forEach(function(rule) {
    var item = document.createElement('div'); item.className = 'meta-auto-rule';
    var head = document.createElement('div'); head.className = 'meta-auto-rule-head';
    var channel = document.createElement('span'); channel.textContent = rule.channel === 'instagram' ? 'Instagram · @blog.example.com' : 'Facebook · Lazy Labs';
    var badge = document.createElement('span'); badge.className = 'meta-auto-rule-badge' + (rule.active ? '' : ' off'); badge.textContent = rule.active ? '● Ativa' : '○ Desligada'; head.append(channel,badge);
    var summary = document.createElement('small'); summary.textContent = 'Palavras: ' + (rule.keywords || []).join(', ') + '\n' +
      ((rule.postIds || []).length ? rule.postIds.length + ' posts selecionados' : 'Todas as publicações');
    var counts = rule.counts || {};
    var stats = document.createElement('small');
    stats.textContent = 'Comentários ' + (counts.comments || 0) + ' · Directs ' + (counts.directs || 0) +
      ' · Links ' + (counts.links || 0) + ' · Novos seguidores observados ' + (counts.newFollowers || 0) + ' · Erros ' + (counts.errors || 0);
    var actions = document.createElement('div'); actions.className = 'meta-auto-rule-actions';
    actions.append(metaAutomationButton_('Editar', function() { editMetaAutomation(rule.id); }),
      metaAutomationButton_(rule.active ? 'Desligar' : 'Ligar', function() { setMetaAutomationActive_(rule, !rule.active); }),
      metaAutomationButton_('Excluir', function() { deleteMetaAutomation_(rule); }));
    item.append(head, summary, stats, actions); list.append(item);
  });
  if (!metaAutomationRules_.length) list.textContent = 'Nenhuma automação cadastrada. Monte o fluxo acima e salve sua primeira regra.';
  metaAutomationField_('meta-auto-rule-count').textContent = metaAutomationRules_.length;
}
function renderMetaAutomationErrors_(items) {
  var list = metaAutomationField_('meta-auto-errors'); if (!list) return;
  var health = metaAutomationField_('meta-auto-health');
  var latest = items[0];
  health.hidden = !latest;
  if (latest) health.textContent = 'Falha registrada em ' + (latest.stage || 'execução') + (latest.code ? ' · Meta ' + latest.code : '') + ': ' + latest.message + ' · ' + latest.at + '. Abra “Testar e acompanhar” para ver o histórico.';
  list.replaceChildren();
  var title = document.createElement('strong'); title.textContent = 'Erros recentes'; list.append(title);
  if (!items.length) { var empty = document.createElement('span'); empty.textContent = 'Nenhum erro recente.'; list.append(empty); }
  items.forEach(function(item) {
    var row = document.createElement('div'); row.style.overflowWrap = 'anywhere';
    row.textContent = (item.at || '') + ' · ' + (item.stage || '') + ' · ' + (item.message || 'Falha'); list.append(row);
  });
}
async function loadMetaAutomations() {
  try {
    var data = await fbFetch_('/api/meta/automations', { method:'GET' });
    if (!data || !data.ok) throw new Error((data && data.message) || 'Falha ao carregar automações.');
    metaAutomationRules_ = data.rules || []; metaAutomationConfig_ = data.config || {};
    renderMetaAutomations(); renderMetaAutomationErrors_(data.errors || []);
    var configured = !!metaAutomationConfig_[metaAutomationField_('meta-auto-channel').value];
    var state = metaAutomationField_('meta-auto-account-state');
    state.textContent = configured ? '● ID da conta configurado' : '● Configure o ID da conta em Publicação nas redes';
    state.classList.toggle('error', !configured);
  } catch (error) { metaAutomationField_('msg-meta-auto').textContent = error.message || 'Falha ao carregar automações.'; }
}
function metaAutomationBody_() {
  var channel = metaAutomationField_('meta-auto-channel').value;
  return { id:metaAutomationEditing_, channel:channel, accountId:metaAutomationConfig_[channel] || '',
    postIds:metaAutomationField_('meta-auto-specific').checked ? metaAutomationPostIds_() : [],
    nodeOrder:[...metaAutomationField_('meta-auto-canvas').querySelectorAll('.meta-auto-node')].map(function(n){ return Number(n.dataset.step); }),
    visualLayout:{ orientation:metaAutomationVisual_.orientation, positions:metaAutomationVisual_.positions, conditionEnabled:metaAutomationVisual_.conditionEnabled },
    keywords:metaAutomationList_(metaAutomationField_('meta-auto-keywords').value),
    publicReplies:metaAutomationField_('meta-auto-public').value.split('\n').map(function(v) { return v.trim(); }).filter(Boolean),
    dmText:metaAutomationField_('meta-auto-dm').value.trim(), buttonLabel:metaAutomationField_('meta-auto-button').value.trim(),
    link:metaAutomationField_('meta-auto-link').value.trim(), requireFollow:metaAutomationVisual_.conditionEnabled && metaAutomationField_('meta-auto-follow').checked, active:metaAutomationField_('meta-auto-enabled').checked };
}
async function metaAutomationPost_(body) {
  var data = await fbFetch_('/api/meta/automations', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body) });
  if (!data || !data.ok) throw new Error((data && data.message) || 'Falha ao salvar automação.');
  return data;
}
async function saveMetaAutomation() {
  var status = metaAutomationField_('msg-meta-auto');
  try {
    if (metaAutomationVisual_.disconnected.length) throw new Error('Reconecte os blocos obrigatórios antes de salvar. A execução segue 01 → 06.');
    if (metaAutomationField_('meta-auto-specific').checked && !metaAutomationPostIds_().length) throw new Error('Selecione uma publicação ou escolha todas.');
    await metaAutomationPost_(metaAutomationBody_()); clearMetaAutomation(); status.textContent = 'Automação salva.'; await loadMetaAutomations();
  }
  catch (error) { status.textContent = error.message || 'Falha ao salvar automação.'; }
}
async function setMetaAutomationActive_(rule, active) {
  try { await metaAutomationPost_({ ...rule, active:active }); await loadMetaAutomations(); }
  catch (error) { metaAutomationField_('msg-meta-auto').textContent = error.message || 'Falha ao alterar regra.'; }
}
async function deleteMetaAutomation_(rule) {
  if (!confirm('Excluir esta automação? O histórico será preservado.')) return;
  try {
    var data = await fbFetch_('/api/meta/automations?id=' + encodeURIComponent(rule.id), { method:'DELETE' });
    if (!data || !data.ok) throw new Error((data && data.message) || 'Falha ao excluir.');
    await loadMetaAutomations();
  } catch (error) { metaAutomationField_('msg-meta-auto').textContent = error.message || 'Falha ao excluir.'; }
}
async function testMetaAutomation() {
  var channel = metaAutomationField_('meta-auto-channel').value;
  var result = metaAutomationField_('meta-auto-test-result');
  try {
    var data = await metaAutomationPost_({ action:'test', channel:channel, accountId:metaAutomationConfig_[channel] || '',
      postId:metaAutomationField_('meta-auto-test-post').value.trim(), text:metaAutomationField_('meta-auto-test-text').value.trim() });
    result.textContent = data.matched ? ' Regra encontrada: ' + data.matched.id : ' Nenhuma regra ativa encontrada.';
  } catch (error) { result.textContent = ' ' + (error.message || 'Falha no teste.'); }
}
function metaAutomationInit_() {
  var studio = metaAutomationField_('meta-auto-studio'); if (!studio) return;
  ['meta-auto-keywords','meta-auto-public','meta-auto-dm','meta-auto-button','meta-auto-link','meta-auto-follow'].forEach(function(id) {
    var field = metaAutomationField_(id);
    field.addEventListener('input', function() {
      if (id === 'meta-auto-keywords') metaAutomationRenderChips_();
      metaAutomationPreviewReset();
    });
    field.addEventListener('change', metaAutomationPreviewReset);
  });
  metaAutomationField_('meta-auto-posts').addEventListener('input', metaAutomationTargetSummary_);
  metaAutomationField_('meta-auto-media-search').addEventListener('input', metaAutomationRenderMedia_);
  var canvas = metaAutomationField_('meta-auto-canvas');
  var shell=canvas.closest('.meta-auto-canvas-shell');
  var viewport=document.createElement('div'); viewport.className='meta-auto-viewport'; viewport.tabIndex=0;
  viewport.setAttribute('aria-label','Canvas da automação. Arraste o fundo para mover. Use os botões para zoom e orientação.');
  canvas.before(viewport); viewport.append(canvas); metaAutomationViewport_=viewport;
  shell.append(metaAutomationField_('meta-auto-media-picker'));
  shell.querySelector('.meta-auto-canvas-title small').textContent='Arraste os blocos pelo cabeçalho · execução fixa 01 → 06';
  var toolbar=document.createElement('div'); toolbar.className='meta-auto-tools'; toolbar.setAttribute('role','toolbar'); toolbar.setAttribute('aria-label','Ferramentas do canvas');
  function tool(label, title, action, extra) { var button=document.createElement('button'); button.type='button'; button.className='meta-auto-tool'; button.textContent=label; button.title=title; button.setAttribute('aria-label',title); if(extra) button.dataset.autoTool=extra; button.addEventListener('click',action); toolbar.append(button); return button; }
  tool('−','Reduzir zoom',function(){metaAutomationZoom_(1/1.2);});
  tool('+','Aumentar zoom',function(){metaAutomationZoom_(1.2);});
  tool('Ajustar','Ajustar blocos à tela',metaAutomationFit_);
  var vertical=tool('↕ Vertical','Organizar na vertical',function(){metaAutomationOrientation_('vertical');}); vertical.dataset.autoLayout='vertical';
  var horizontal=tool('↔ Horizontal','Organizar na horizontal',function(){metaAutomationOrientation_('horizontal');}); horizontal.dataset.autoLayout='horizontal';
  tool('Condição +/−','Adicionar ou remover a condição de seguir no Instagram',function(){metaAutomationToggleCondition_(!metaAutomationVisual_.conditionEnabled);});
  tool('Expandir canvas','Expandir ou fechar canvas',metaAutomationExpanded_,'expand');
  metaAutomationStatus_=document.createElement('div'); metaAutomationStatus_.className='meta-auto-tool-status'; metaAutomationStatus_.setAttribute('role','status');
  var palette=document.createElement('div');palette.className='meta-auto-palette';palette.setAttribute('aria-label','Blocos disponíveis');
  [['01','Publicação'],['02','Palavra-chave'],['03','Resposta pública'],['04','Mensagem privada'],['05','Condição'],['06','Entregar link']].forEach(function(item){
    var step=Number(item[0]),chip=document.createElement('button');chip.type='button';chip.className='meta-auto-palette-chip';chip.dataset.step=String(step);chip.textContent=item[0]+' '+item[1];chip.draggable=true;
    chip.title='Arraste para reposicionar o bloco no canvas';
    chip.addEventListener('dragstart',function(event){event.dataTransfer.setData('application/x-lazylabs-auto-step',String(step));event.dataTransfer.effectAllowed='move';});
    chip.addEventListener('click',function(){if(step===5&&!metaAutomationVisual_.conditionEnabled)metaAutomationToggleCondition_(true);metaAutomationSelect_(step);metaAutomationStatus_.textContent='Bloco 0'+step+' selecionado. Arraste o chip para posicionar no canvas.';});
    palette.append(chip);
  });
  shell.querySelector('.meta-auto-canvas-title').after(toolbar,palette,metaAutomationStatus_);
  metaAutomationField_('meta-auto-media-picker').classList.add('meta-auto-media-drawer');
  metaAutomationApplyLayout_([1,2,3,4,5,6]);
  canvas.querySelectorAll('.meta-auto-node').forEach(function(node) {
    var step=Number(node.dataset.step), head=node.querySelector('.meta-auto-node-head');
    head.setAttribute('title','Arraste este cabeçalho para mover o bloco');
    node.addEventListener('pointerdown',function(){metaAutomationSelect_(step);});
    node.addEventListener('contextmenu',function(event){
      metaAutomationSelect_(step);
      metaAutomationContext_(event,step===5 ? [['Remover condição',function(){metaAutomationToggleCondition_(false);}]] :
        [['Etapa obrigatória · 0'+step,function(){metaAutomationStatus_.textContent='Esta etapa é necessária para a automação funcionar.';}]]);
    });
    head.addEventListener('pointerdown',function(event){
      if (event.target.closest('button') || event.button!==0) return;
      event.preventDefault(); metaAutomationSelect_(step);
      metaAutomationPointer_={kind:'node',step:step,id:event.pointerId,startX:event.clientX,startY:event.clientY,x:metaAutomationVisual_.positions[step].x,y:metaAutomationVisual_.positions[step].y};
      head.setPointerCapture(event.pointerId); node.classList.add('is-dragging');
    });
    head.addEventListener('pointermove',function(event){
      var drag=metaAutomationPointer_; if(!drag || drag.kind!=='node' || drag.id!==event.pointerId || drag.step!==step) return;
      metaAutomationVisual_.positions[step]={x:Math.max(-100000,Math.min(100000,drag.x+(event.clientX-drag.startX)/metaAutomationVisual_.zoom)),y:Math.max(-100000,Math.min(100000,drag.y+(event.clientY-drag.startY)/metaAutomationVisual_.zoom))};
      metaAutomationPlaceNodes_(); metaAutomationDrawConnections_();
    });
    function endNode(event){if(metaAutomationPointer_ && metaAutomationPointer_.kind==='node' && metaAutomationPointer_.id===event.pointerId){metaAutomationPointer_=null;node.classList.remove('is-dragging');node.classList.add('just-dropped');setTimeout(function(){node.classList.remove('just-dropped');},420);}}
    head.addEventListener('pointerup',endNode); head.addEventListener('pointercancel',endNode);
    if(step>1){var input=document.createElement('button');input.type='button';input.className='meta-auto-port meta-auto-port-in';input.textContent='○';input.title='Conectar entrada 0'+step;input.setAttribute('aria-label',input.title);input.addEventListener('click',function(){metaAutomationPort_(step,'in');});node.append(input);}
    if(step<6){var output=document.createElement('button');output.type='button';output.className='meta-auto-port meta-auto-port-out';output.textContent='●';output.title='Arraste para conectar a saída 0'+step;output.setAttribute('aria-label',output.title);output.addEventListener('click',function(event){if(output.dataset.dragged==='1'){output.dataset.dragged='';return;}metaAutomationPort_(step,'out');});
      output.addEventListener('pointerdown',function(event){
        if(event.button!==0)return;
        var startX=event.clientX,startY=event.clientY,ghost=null;
        function move(pointer){
          if(!ghost && Math.hypot(pointer.clientX-startX,pointer.clientY-startY)<5)return;
          if(!ghost){ghost=document.createElement('div');ghost.className='meta-auto-drag-wire';viewport.append(ghost);output.classList.add('is-connecting');}
          var dx=pointer.clientX-startX,dy=pointer.clientY-startY;
          ghost.style.left=startX+'px';ghost.style.top=startY+'px';ghost.style.width=Math.hypot(dx,dy)+'px';ghost.style.transform='rotate('+Math.atan2(dy,dx)+'rad)';
        }
        function end(pointer){
          document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',end);
          document.removeEventListener('pointercancel',end);
          if(!ghost)return;
          ghost.remove();output.classList.remove('is-connecting');output.dataset.dragged='1';
          var target=document.elementFromPoint(pointer.clientX,pointer.clientY)?.closest('.meta-auto-port-in');
          if(target){metaAutomationVisual_.connecting=step;metaAutomationPort_(Number(target.closest('[data-step]').dataset.step),'in');}
          else metaAutomationStatus_.textContent='Solte a linha numa entrada compatível para conectar.';
          setTimeout(function(){output.dataset.dragged='';},0);
        }
        document.addEventListener('pointermove',move);document.addEventListener('pointerup',end);document.addEventListener('pointercancel',end);
      });node.append(output);}
  });
  viewport.addEventListener('pointerdown',function(event){
    if(event.button!==0 || event.target.closest('.meta-auto-node, .meta-auto-edge-hit')) return;
    event.preventDefault();
    metaAutomationPointer_={kind:'pan',id:event.pointerId,startX:event.clientX,startY:event.clientY,x:metaAutomationVisual_.panX,y:metaAutomationVisual_.panY};
    viewport.setPointerCapture(event.pointerId);viewport.classList.add('is-panning');
  });
  viewport.addEventListener('pointermove',function(event){
    var drag=metaAutomationPointer_;if(!drag||drag.kind!=='pan'||drag.id!==event.pointerId)return;
    metaAutomationVisual_.panX=drag.x+event.clientX-drag.startX;metaAutomationVisual_.panY=drag.y+event.clientY-drag.startY;metaAutomationTransform_();
  });
  function endPan(event){if(metaAutomationPointer_&&metaAutomationPointer_.kind==='pan'&&metaAutomationPointer_.id===event.pointerId){metaAutomationPointer_=null;viewport.classList.remove('is-panning');}}
  viewport.addEventListener('pointerup',endPan);viewport.addEventListener('pointercancel',endPan);
  viewport.addEventListener('dragover',function(event){if([...event.dataTransfer.types].includes('application/x-lazylabs-auto-step')){event.preventDefault();event.dataTransfer.dropEffect='move';}});
  viewport.addEventListener('drop',function(event){
    var step=Number(event.dataTransfer.getData('application/x-lazylabs-auto-step'));
    if(!Number.isInteger(step)||step<1||step>6)return;
    event.preventDefault();if(step===5&&!metaAutomationVisual_.conditionEnabled)metaAutomationToggleCondition_(true);
    var rect=viewport.getBoundingClientRect(),node=canvas.querySelector('[data-step="'+step+'"]');
    metaAutomationVisual_.positions[step]={x:Math.round((event.clientX-rect.left-metaAutomationVisual_.panX)/metaAutomationVisual_.zoom-node.offsetWidth/2),
      y:Math.round((event.clientY-rect.top-metaAutomationVisual_.panY)/metaAutomationVisual_.zoom-node.offsetHeight/2)};
    metaAutomationPlaceNodes_();metaAutomationDrawConnections_();metaAutomationSelect_(step);
  });
  viewport.addEventListener('contextmenu',function(event){
    if(event.target.closest('.meta-auto-node, .meta-auto-edge-hit'))return;
    metaAutomationContext_(event,[['Ajustar à tela',metaAutomationFit_],['Adicionar condição (Instagram)',function(){metaAutomationToggleCondition_(true);}]]);
  });
  document.addEventListener('pointerdown',function(event){if(metaAutomationMenu_&&!metaAutomationMenu_.contains(event.target))metaAutomationCloseMenu_();});
  viewport.addEventListener('wheel',function(event){
    if(event.target.closest('.meta-auto-node, .meta-auto-media-drawer') && !event.ctrlKey) return;
    event.preventDefault();
    if(event.ctrlKey) metaAutomationZoom_(event.deltaY<0?1.1:1/1.1,event.clientX,event.clientY);
    else {metaAutomationVisual_.panX-=event.deltaX;metaAutomationVisual_.panY-=event.deltaY;metaAutomationTransform_();}
  },{passive:false});
  document.addEventListener('keydown',function(event){
    if(event.key==='Escape' && shell.classList.contains('is-expanded')) metaAutomationExpanded_();
  });
  if (window.ResizeObserver) {
    var observer = new ResizeObserver(function(){ requestAnimationFrame(metaAutomationDrawConnections_); });
    observer.observe(viewport);
    canvas.querySelectorAll('.meta-auto-node').forEach(function(node){ observer.observe(node); });
  }
  window.addEventListener('resize', metaAutomationDrawConnections_);
  metaAutomationTransform_();
  metaAutomationChannelChanged(); metaAutomationRenderChips_();
}
metaAutomationInit_();
firebase.auth().onAuthStateChanged(function(user) { if (user) loadMetaAutomations(); });
