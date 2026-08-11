import { buildAutomationDashboardModel, setAutomationEnabledState } from './automation-dashboard.js';
import { setAutomationRuleEnabled } from './automation-rule-model.js';
import { renderRecurringActivityPanel } from './recurring-finance-ui.js';
import { automationViewMarkup, renderAutomationModel, renderAutomationRecovery } from './automation-dashboard-render.js';

let state=null, started=false, refreshing=false, queued=false;
const RETURN='onestep.automation.return';

function boot(){
  const shell=document.getElementById('appShell');
  if(!shell||!window.financeAPI?.loadState)return;
  if(!shell.hidden){queueMicrotask(start);return;}
  const observer=new MutationObserver(()=>{if(!shell.hidden){observer.disconnect();queueMicrotask(start);}});
  observer.observe(shell,{attributes:true,attributeFilter:['hidden']});
}
function start(){
  if(started)return; started=true; ensureSurface();
  document.addEventListener('click',onClick,true); document.addEventListener('change',onChange,true);
  const restore=sessionStorage.getItem(RETURN)==='1'; sessionStorage.removeItem(RETURN);
  if(restore) activate(false); refresh();
}
function ensureSurface(){ensureNav();ensureView();ensureDashboardCard();}
function ensureNav(){
  if(document.querySelector('.nav-button[data-view="automation"]'))return;
  const nav=document.querySelector('.sidebar nav'); if(!nav)return;
  const b=document.createElement('button'); b.className='nav-button'; b.type='button'; b.dataset.view='automation'; b.setAttribute('aria-label','Automation');
  b.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 5 13h6l-1 9 9-12h-6z"/></svg><span class="nav-label">Automation <span id="automationNavCount" class="nav-count" aria-label="0 automation items need review" hidden>0</span></span>';
  nav.insertBefore(b,nav.querySelector('[data-view="guide"]')||nav.querySelector('[data-view="settings"]')||null);
}
function ensureView(){
  if(document.getElementById('view-automation'))return;
  const s=document.createElement('section'); s.id='view-automation'; s.className='view automation-view'; s.hidden=true; s.setAttribute('aria-labelledby','viewTitle'); s.innerHTML=automationViewMarkup();
  const guide=document.getElementById('view-guide'); if(guide)guide.before(s); else document.querySelector('.main-content')?.append(s);
}
function ensureDashboardCard(){
  if(document.getElementById('dashboardAutomationStatus'))return;
  const modules=document.getElementById('dashboardModules'); if(!modules)return;
  const card=document.createElement('article'); card.id='dashboardAutomationStatus'; card.className='dashboard-module automation-dashboard-status';
  card.innerHTML='<div class="dashboard-module-heading"><div><p class="eyebrow">AUTOMATION</p><h2 id="dashboardAutomationTitle">Automation</h2></div><span id="dashboardAutomationBadge" class="badge">Loading</span></div><p id="dashboardAutomationText" class="muted">Checking local automation state…</p><button class="secondary-button" type="button" data-automation-open>Open Automation</button>';
  modules.append(card);
}
async function refresh(message=''){
  if(refreshing){queued=true;return;} refreshing=true;
  try{
    ensureSurface(); const loaded=await window.financeAPI.loadState();
    if(loaded?.status!=='normal'||!loaded.state){renderAutomationRecovery();return;}
    state=loaded.state; const model=buildAutomationDashboardModel(state,new Date()); renderAutomationModel(model,message); attention(model.reviewCount);
  }catch{setStatus('Automation could not be refreshed. No financial information was changed.');}
  finally{refreshing=false;if(queued){queued=false;refresh();}}
}
function attention(value){const n=document.getElementById('automationNavCount');if(!n)return;n.textContent=String(value);n.hidden=value===0;n.setAttribute('aria-label',`${value} automation item${value===1?'':'s'} need review`);}
function activate(doRefresh=true){
  ensureSurface(); document.querySelectorAll('.nav-button').forEach((b)=>b.classList.toggle('active',b.dataset.view==='automation'));
  document.querySelectorAll('.view').forEach((v)=>{const active=v.id==='view-automation';v.classList.toggle('active',active);v.hidden=!active;});
  setText('viewEyebrow','SEE IT · UNDERSTAND IT · CONTROL IT'); setText('viewTitle','Automation'); if(doRefresh)refresh();
}
async function onChange(event){if(event.target?.id==='automationMasterToggle')await saveGlobal(event.target.checked,event.target);}
async function onClick(event){
  const open=event.target.closest('[data-automation-open],.nav-button[data-view="automation"]'); if(open){event.preventDefault();event.stopImmediatePropagation();activate();return;}
  const route=event.target.closest('[data-automation-route]'); if(route){event.preventDefault();await routeTo(route.dataset.automationRoute);return;}
  const edit=event.target.closest('[data-automation-rule-open]'); if(edit){event.preventDefault();await routeToRule(edit.dataset.automationRuleOpen,false);return;}
  const toggle=event.target.closest('[data-automation-rule-toggle]'); if(toggle){event.preventDefault();const enable=toggle.dataset.automationRuleEnable==='true';if(enable)await routeToRule(toggle.dataset.automationRuleToggle,true);else await pauseRule(toggle.dataset.automationRuleToggle,toggle);}
}
async function saveGlobal(enabled,control){
  control.disabled=true; setStatus(enabled?'Resuming automation…':'Pausing automation…');
  try{const latest=await latestNormal();const saved=await window.financeAPI.saveState(setAutomationEnabledState(latest,enabled));if(['blocked','conflict'].includes(saved?.status))throw new Error(saved.message||'Automation state could not be saved safely.');sessionStorage.setItem(RETURN,'1');window.location.reload();}
  catch(error){control.disabled=false;await refresh(error?.message||'Automation state could not be changed safely.');}
}
async function pauseRule(id,button){
  button.disabled=true; setStatus('Pausing rule…');
  try{const latest=await latestNormal();const saved=await window.financeAPI.saveState(setAutomationRuleEnabled(latest,id,false,new Date()));if(['blocked','conflict'].includes(saved?.status))throw new Error(saved.message||'That rule could not be saved safely.');sessionStorage.setItem(RETURN,'1');window.location.reload();}
  catch(error){button.disabled=false;await refresh(error?.message||'That rule could not be changed safely.');}
}
async function latestNormal(){const loaded=await window.financeAPI.loadState();if(loaded?.status!=='normal'||!loaded.state)throw new Error('Automation controls are unavailable while data recovery protections are active.');return loaded.state;}
async function routeTo(route){
  if(route==='review'){document.querySelector('.nav-button[data-view="review"]')?.click();return;}
  if(route==='recurring'){document.querySelector('.nav-button[data-view="transactions"]')?.click();if(state)renderRecurringActivityPanel(state);queueMicrotask(()=>focus(document.getElementById('recurringActivityPanel')));return;}
  document.querySelector('.nav-button[data-view="settings"]')?.click(); if(state)renderRecurringActivityPanel(state);
  const target=route==='rules'?document.getElementById('automationRulesSettings'):route==='reminders'?document.getElementById('financialRemindersSettings'):document.getElementById('automationHistorySettings'); queueMicrotask(()=>focus(target));
}
async function routeToRule(id,activation){
  await routeTo('rules'); queueMicrotask(()=>{const selector=activation?'[data-automation-toggle]':'[data-automation-edit]';const b=[...document.querySelectorAll(selector)].find((x)=>String(activation?x.dataset.automationToggle:x.dataset.automationEdit)===String(id));if(!b)return;focus(b);b.click();});
}
function focus(target){target?.scrollIntoView?.({block:'center',behavior:'smooth'});(target?.matches?.('button,input,select,textarea,[tabindex]')?target:target?.querySelector?.('button,input,select,textarea,[tabindex]'))?.focus?.({preventScroll:true});}
function setStatus(value){setText('automationStatus',value||'');}
function setText(id,value){const node=document.getElementById(id);if(node)node.textContent=value;}

if(typeof window!=='undefined'&&typeof document!=='undefined'){if(document.readyState==='loading')window.addEventListener('DOMContentLoaded',boot,{once:true});else boot();}
