'use strict';
const app=document.querySelector('#app'),dialog=document.querySelector('#dialog'),toaster=document.querySelector('#toaster');
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const id=()=>crypto.randomUUID(),pause=ms=>new Promise(r=>setTimeout(r,ms));
const dateLocal=d=>{const x=d||new Date();return [x.getFullYear(),String(x.getMonth()+1).padStart(2,'0'),String(x.getDate()).padStart(2,'0')].join('-')};
const hour=iso=>new Date(iso).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
const fmtDate=iso=>new Date(iso+'T12:00:00').toLocaleDateString('ru-RU',{day:'numeric',month:'short'});
const hours=mins=>`${Math.floor(Number(mins||0)/60)} ч ${Math.round(Number(mins||0)%60)} мин`;
const $=s=>document.querySelector(s);
let token=localStorage.getItem('tk_session')||'',person=JSON.parse(localStorage.getItem('tk_user')||'null'),snapshot=null,tab='home';
let bridge=null,bridgeOrigin='',ready=false,readyPromise=null,readyResolve=null,pending=new Map(),scanner=null,stream=null,scanBusy=false,lastSelfAt=0,lastCorrections=null;
let apiUrl=String(localStorage.getItem('tk_api_url')||'').trim();
let lastInvalidServerScanAt=0;
let networkCount=0,networkTime=0,networkInterval=null;
function netStart(action){
 networkCount++;if(networkCount!==1)return;
 networkTime=Date.now();
 let bar=document.querySelector('#netState');
 if(!bar){bar=document.createElement('div');bar.id='netState';bar.setAttribute('role','status');bar.setAttribute('aria-live','polite');bar.innerHTML='<span class="netCircle" aria-hidden="true"></span><span id="netText"></span>';document.body.appendChild(bar)}
 bar.hidden=false;document.querySelector('#netText').textContent=action||'Подключаемся…';
 clearInterval(networkInterval);networkInterval=setInterval(()=>{const t=document.querySelector('#netText');if(t&&Date.now()-networkTime>8500)t.textContent='Сервер отвечает медленно. Ожидаем…'},1300);
}
function netEnd(){networkCount=Math.max(0,networkCount-1);if(!networkCount){clearInterval(networkInterval);const b=document.querySelector('#netState');if(b)b.hidden=true}}


function toast(text){toaster.innerHTML=`<div class="toast">${esc(text)}</div>`;setTimeout(()=>toaster.innerHTML='',5200)}
function errorMessage(e){return String(e&&e.message||e||'Ошибка связи')}
function disconnect(message){ready=false;if(readyResolve){readyResolve(false);readyResolve=null;}for(const [key,job]of pending){clearTimeout(job.timer);netEnd();job.reject(new Error(message||'Нет связи с сервером'))}pending.clear();}
function apiValid(url){return /^https:\/\/script\.google\.com\/macros\/s\/[-\w]+\/exec(?:\?.*)?$/.test(url||'')}
function initBridge(){if(!apiValid(apiUrl)){ready=false;return Promise.resolve(false)}if(ready)return Promise.resolve(true);if(readyPromise)return readyPromise;
 netStart('Соединяемся с Apps Script…');const nonce=id();const frame=document.createElement('iframe');frame.style.cssText='position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none';frame.setAttribute('aria-hidden','true');
 frame.src=apiUrl.split('?')[0]+'?view=bridge&bridgeNonce='+encodeURIComponent(nonce);
 document.querySelector('#bridgeContainer').replaceChildren(frame);
 readyPromise=new Promise(resolve=>{readyResolve=resolve;const timer=setTimeout(()=>{if(!ready){window.removeEventListener('message',onready);disconnect('Не удалось подключиться к Apps Script. Проверьте URL, доступ «Все» и разрешение встраивания.');readyPromise=null;netEnd();resolve(false)}},18000);
  const onready=event=>{if(event.data?.type!=='TK_READY'||event.data?.nonce!==nonce)return;
   if(!/^https:\/\/([\w-]+\.)*googleusercontent\.com$/.test(event.origin)&&event.origin!=='https://script.google.com')return;
   bridge=event.source;bridgeOrigin=event.origin;ready=true;clearTimeout(timer);netEnd();readyResolve=null;window.removeEventListener('message',onready);resolve(true);
  };window.addEventListener('message',onready);
 });return readyPromise;
}
window.addEventListener('message',event=>{if(!ready||event.source!==bridge||event.origin!==bridgeOrigin||event.data?.type!=='TK_REPLY')return;
 const job=pending.get(event.data.id);if(!job)return;clearTimeout(job.timer);pending.delete(event.data.id);netEnd();
 const response=event.data.response;if(response?.ok)job.resolve(response.data);else job.reject(new Error(response?.error||'Ошибка сервера'));
});
async function once(op,args={},requestId=id()){
 netStart(op==='login'?'Проверяем ID и PIN…':op==='clock'?'Сохраняем отметку…':op==='corrections'?'Загружаем заявки…':op==='self'?'Обновляем график и часы…':'Отправляем запрос…');let connected;try{connected=await initBridge()}catch(e){netEnd();throw e}if(!connected){netEnd();throw new Error('Нет соединения с сервером Apps Script')}
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);netEnd();reject(new Error('Превышено время ответа. Проверьте состояние отметки перед повтором.'))},30000);pending.set(requestId,{resolve,reject,timer});
  bridge.postMessage({type:'TK_REQUEST',id:requestId,request:{op,args,token,requestId}},bridgeOrigin);
 });
}
async function call(op,args={},retryBusy=false){const requestId=id();for(let tries=0;tries<(retryBusy?3:1);tries++){
 try{return await once(op,args,requestId)}catch(e){const message=errorMessage(e);if(!retryBusy||tries===2||!/BUSY|занят|too many scripts|слишком много|simultaneous/i.test(message))throw e;await pause(1100*(tries+1));}}
}
const dbPromise=new Promise(resolve=>{if(!window.indexedDB){resolve(null);return}const req=indexedDB.open('timekeeper-cache',1);req.onupgradeneeded=()=>req.result.createObjectStore('kv');req.onsuccess=()=>resolve(req.result);req.onerror=()=>resolve(null)});
async function kvGet(key){const db=await dbPromise;if(!db)return null;return new Promise(resolve=>{const r=db.transaction('kv','readonly').objectStore('kv').get(key);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>resolve(null)})}
async function kvSet(key,value){const db=await dbPromise;if(!db)return;return new Promise(resolve=>{const t=db.transaction('kv','readwrite');t.objectStore('kv').put(value,key);t.oncomplete=resolve;t.onerror=resolve})}

function parseServerUrl(raw){
 try{
  const value=String(raw||'').trim().replace(/^TK_SERVER[|:]/i,'').trim();
  const u=new URL(value);
  if(u.protocol!=='https:'||u.hostname!=='script.google.com'||u.port||u.username||u.password||
     !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec\/?$/.test(u.pathname))return '';
  return u.origin+u.pathname.replace(/\/$/,'');
 }catch(e){return ''}
}
function serverSetupScreen(){
 app.innerHTML='<div class="login"><div class="logoIcon">◈</div><div><p style="color:#5e77a1;font-weight:750;letter-spacing:2px;font-size:12px">ПЕРВОЕ ПОДКЛЮЧЕНИЕ</p><h1>Подключить сервер</h1><p class="muted" style="margin-top:10px">Отсканируйте QR-код с адресом Google Apps Script. Это требуется только один раз на устройстве.</p></div><button class="btn" id="scanServer">▦ Сканировать QR сервера</button><form id="serverSetupForm"><div class="field"><label>Или вставьте URL сервера вручную</label><input class="input" name="url" type="url" inputmode="url" autocapitalize="off" autocomplete="off" placeholder="https://script.google.com/macros/s/.../exec" required></div><button class="btn outline" style="width:100%">Сохранить адрес</button></form><div class="notice">Адрес сохранится на этом телефоне и не будет запрашиваться при следующем запуске или выходе из аккаунта.</div></div>';
 $('#scanServer').onclick=()=>startScan('server');
 $('#serverSetupForm').onsubmit=e=>{e.preventDefault();applyServer(e.target.elements.url.value)};
}
function openServerSettings(){
 showDialog('Подключение к серверу','<p class="muted small" style="margin-bottom:14px">Текущий сервер:</p><p class="small" style="overflow-wrap:anywhere;margin-bottom:18px">'+esc(apiUrl||'Не настроен')+'</p><button class="btn" id="changeServerQr" style="width:100%;margin-bottom:16px">▦ Сканировать QR нового сервера</button><form id="changeServerForm"><div class="field"><label>Или введите URL /exec</label><input class="input" name="url" type="url" inputmode="url" autocapitalize="off" value="'+esc(apiUrl)+'" required></div><button class="btn outline" style="width:100%">Сохранить адрес</button></form><p class="muted small" style="margin-top:13px">При смене сервера потребуется снова войти по ID и PIN.</p>');
 $('#changeServerQr').onclick=()=>{closeDialog();startScan('server')};
 $('#changeServerForm').onsubmit=e=>{e.preventDefault();applyServer(e.target.elements.url.value)};
}
function applyServer(raw){
 const next=parseServerUrl(raw);
 if(!next){toast('Неверный QR: нужен HTTPS-адрес Google Apps Script, оканчивающийся на /exec');return false}
 const changed=apiUrl!==next;
 if(changed){
  disconnect('Адрес сервера изменен');readyPromise=null;bridge=null;bridgeOrigin='';
  document.querySelector('#bridgeContainer').replaceChildren();
  logoutLocal();
 }
 apiUrl=next;
 try{localStorage.setItem('tk_api_url',next)}catch(e){toast('Не удалось сохранить адрес на устройстве: проверьте настройки браузера');return false}
 closeDialog();
 if(person&&!changed)render();else loginScreen();
 initBridge();
 toast('Адрес сервера сохранен. Повторно сканировать QR не нужно.');
 return true;
}

function loginScreen(){app.innerHTML=`<div class="login"><div class="logoIcon">◈</div><div><p style="color:#5e77a1;font-weight:750;letter-spacing:2px;font-size:12px">РАБОЧЕЕ ВРЕМЯ</p><h1>TimeKeeper</h1><p class="muted" style="margin-top:10px">Отмечайте начало и конец смены, следите за графиком и часами.</p></div><form id="login"><div class="field"><label>Ваш ID</label><input class="input" name="id" inputmode="numeric" placeholder="Введите ID" required></div><div class="field"><label>PIN-код</label><input class="input" name="pin" type="password" inputmode="numeric" placeholder="••••••" minlength="6" required></div><button class="btn">Войти</button></form><button class="link" id="seturl">⚙ Адрес сервера</button><div class="notice">Для отметки QR необходимо подключение к интернету. Расписание и история доступны из локального кеша.</div></div>`;
 $('#login').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;b.textContent='Проверяем…';try{const r=await call('login',Object.fromEntries(new FormData(e.target)));token=r.token;person=r.user;localStorage.setItem('tk_session',token);localStorage.setItem('tk_user',JSON.stringify(person));lastSelfAt=0;tab='home';await refreshSelf(true);render()}catch(err){toast(errorMessage(err));b.disabled=false;b.textContent='Войти'}};
 $('#seturl').onclick=openServerSettings;
}
function showDialog(title,body){dialog.innerHTML=`<div class="overlay" id="backdrop"><div class="dialog"><div class="row" style="margin-bottom:20px"><h2>${esc(title)}</h2><button class="link" id="dismiss">Закрыть</button></div>${body}</div></div>`;$('#dismiss').onclick=closeDialog;$('#backdrop').onclick=e=>{if(e.target.id==='backdrop')closeDialog()}}
function closeDialog(){dialog.innerHTML=''}
async function refreshSelf(force=false){if(!person)return;if(!force&&snapshot&&Date.now()-lastSelfAt<10*60000)return;
 if(!navigator.onLine){if(!snapshot)snapshot=await kvGet('self_'+apiUrl+'_'+person.id);return}
 try{const incoming=await call('self');snapshot=incoming;lastSelfAt=Date.now();await kvSet('self_'+apiUrl+'_'+person.id,incoming)}catch(e){if(!snapshot)snapshot=await kvGet('self_'+apiUrl+'_'+person.id);if(/Сессия|вход|учетная запись/i.test(errorMessage(e))){logoutLocal();toast('Войдите снова');return;}toast('Работаем с сохраненными данными: '+errorMessage(e))}
}
function render(){if(!person){loginScreen();return}const initials=person.fio.trim().split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase();
 app.innerHTML=`<div class="app"><header class="head"><div class="top"><div><p class="small">УЧЕТ РАБОЧЕГО ВРЕМЕНИ</p><b style="font-size:18px">TimeKeeper</b></div><button class="avatar" id="profile" style="color:white;border:0">${esc(initials)}</button></div><p class="small">Здравствуйте,</p><h1>${esc(person.fio)}</h1></header><main class="main"><div id="content"></div></main><nav class="tabbar" aria-label="Основное меню">${[['home','⌂','Главная'],['schedule','▦','График']].map(([t,icon,txt])=>`<button data-tab="${t}" class="${t===tab?'active':''}"><span class="sym">${icon}</span>${txt}</button>`).join('')}<button id="scanNav" class="scanNav" aria-label="Сканировать QR для прихода или ухода"><span class="scanNavIcon">▦</span><span>QR</span></button>${[['history','◷','История'],['requests','✎','Заявки']].map(([t,icon,txt])=>`<button data-tab="${t}" class="${t===tab?'active':''}"><span class="sym">${icon}</span>${txt}</button>`).join('')}</nav></div>`;
 $('#profile').onclick=()=>showDialog('Профиль',`<p><b>${esc(person.fio)}</b></p><p class="muted small">ID: ${esc(person.id)}</p><div style="margin-top:20px"><button class="btn ghost" id="changeServer" style="width:100%;margin-bottom:10px">⚙ Сменить сервер</button><button class="btn outline" id="logout" style="width:100%">Выйти из приложения</button></div>`); // attach after dialog creation
 $('#profile').addEventListener('click',()=>{$('#changeServer').onclick=()=>{closeDialog();openServerSettings()};$('#logout').onclick=async()=>{try{await call('logout')}catch(e){}logoutLocal();closeDialog();loginScreen()}});
 $('#scanNav').onclick=()=>startScan();
 document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=async()=>{tab=b.dataset.tab;render();if(tab==='requests'&&!lastCorrections)await loadCorrections()});drawContent();
}
function logoutLocal(){person=null;token='';snapshot=null;lastCorrections=null;lastSelfAt=0;localStorage.removeItem('tk_session');localStorage.removeItem('tk_user')}
function drawContent(){const target=$('#content');if(!target)return;if(!snapshot){target.innerHTML='<div class="skeleton">Нет данных. Проверьте подключение к интернету.</div>';return}
 target.innerHTML={home:homeView,schedule:scheduleView,history:historyView,requests:requestView}[tab]();
 const sc=$('#scanBtn');if(sc)sc.onclick=startScan;const upd=$('#update');if(upd)upd.onclick=async()=>{upd.disabled=true;if(tab==='requests'){lastCorrections=null;await loadCorrections();}else{await refreshSelf(true);render()}upd.disabled=false};const make=$('#newRequest');if(make)make.onclick=newCorrection;
}

function renderMonthlyProgress_(){
 const s=snapshot.summary||{},minutes=Math.max(0,Number(s.minutes)||0),days=Math.max(0,Number(s.days)||0);
 const norm=typeof s.normMinutes==='number'&&Number.isFinite(s.normMinutes)?Math.max(0,s.normMinutes):NaN;
 const shifts=typeof s.plannedShifts==='number'&&Number.isFinite(s.plannedShifts)?Math.max(0,s.plannedShifts):NaN;
 const number=x=>Number(x).toLocaleString('ru-RU',{maximumFractionDigits:1});
 const makeCard=(title,actual,plan,actualLabel,planLabel,caption,second)=>{
  const known=Number.isFinite(plan),pct=known&&plan>0?Math.max(0,Math.min(100,Math.round(actual/plan*100))):0;
  const badge=known&&plan>0?Math.round(actual/plan*100)+'%':'—';
  return '<div class="card monthMetric"><div class="row"><b>'+title+'</b><span class="monthPct">'+badge+'</span></div>'+
    '<div class="monthNumbers"><strong>'+actualLabel+'</strong><span>из '+(known?planLabel:'—')+'</span></div>'+
    '<div class="monthBar'+(second?' shiftBar':'')+'" role="progressbar" aria-label="'+title+'" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+pct+'"><span style="width:'+pct+'%"></span></div>'+
    '<p class="small muted">'+caption+'</p></div>';
 };
 return '<div class="monthMetrics">'+
  makeCard('Отработанные часы',minutes,norm,number(minutes/60)+' ч',number(norm/60)+' ч',Number.isFinite(norm)?'Норма часов по графику за весь месяц':'Норма появится после обновления Apps Script',false)+
  makeCard('Завершённые смены',days,shifts,days+' смен',shifts+' по плану','Учтены только закрытые смены',true)+
  '</div>';
}
function renderMonthTitle_(){
 const key=String(snapshot.summary&&snapshot.summary.month||dateLocal().slice(0,7));
 if(!/^\d{4}-\d{2}$/.test(key))return 'Текущий месяц';
 return new Date(key+'-01T12:00:00').toLocaleDateString('ru-RU',{month:'long',year:'numeric'});
}

function homeView(){const online=navigator.onLine;const open=snapshot.open;const mins=snapshot.summary?.minutes||0;const next=(snapshot.week||[]).find(x=>x.work);
 return `<section class="over"><div class="card"><div class="row"><span class="muted small">Статус смены</span><span class="chip ${open?'':'off'}">${open?'● На смене':'○ Вне смены'}</span></div><h2 style="font-size:24px;margin-top:12px">${open?'Смена началась в '+hour(open.in_at):'Отметьте приход по QR'}</h2><p class="muted small" style="margin:8px 0 20px">${open?'При уходе отсканируйте QR еще раз':'Подойдите к экрану QR на рабочем месте'}</p><button class="btn primaryAction" id="scanBtn" ${!online?'disabled':''}><span class="scanIcon">▦</span><span style="flex:1">${open?'Отметить уход':'Сканировать QR'}<div style="font-size:12px;opacity:.85;font-weight:400">Камера телефона</div></span><span>›</span></button></div></section>
 <div class="section row"><div><h2>Мой месяц</h2><p class="small muted">${esc(renderMonthTitle_())} · по вашему графику</p></div><button class="link" id="update">Обновить ↻</button></div>
 ${renderMonthlyProgress_()}
 <div class="section"><h2>Ближайшая смена</h2></div><div class="card">${next?`<div class="row"><div><b>${fmtDate(next.date)}</b><p class="small muted">${esc(next.schedule||'Рабочий день')}</p></div><span class="chip">${esc(next.start)} — ${esc(next.end)}</span></div>`:'<p class="muted">Рабочие дни не запланированы</p>'}</div>
 <p class="small muted" style="margin:18px 3px"><span class="dot ${online?'':'offline'}"></span>${online?'Подключение доступно':'Нет сети — отметка QR недоступна'} · История сохранена на устройстве</p>`;}
function scheduleView(){return `<div class="section row"><h2>Мой график на 30 дней</h2><button class="link" id="update">↻</button></div><div class="card">${(snapshot.week||[]).map(s=>`<div class="day"><div class="dayDate"><b>${s.date.slice(-2)}</b><span>${new Date(s.date+'T12:00:00').toLocaleDateString('ru-RU',{weekday:'short'})}</span></div><div style="flex:1"><b>${s.work?'Рабочий день':'Выходной'}</b><p class="small muted">${s.work?esc(s.start)+' — '+esc(s.end):'Без смены'}</p></div><span class="chip ${s.work?'':'off'}">${s.work?'Смена':'Выходной'}</span></div>`).join('')||'<div class="empty">График не назначен</div>'}</div>${(snapshot.week||[]).length<30?'<p class="notice" style="margin-top:12px">Для 30 дней обновите серверный Code.gs и опубликуйте новую версию Apps Script.</p>':''}`;}
function historyView(){return `<div class="section row"><h2>Отработанные смены</h2><button class="link" id="update">↻</button></div><div class="card">${(snapshot.history||[]).map(s=>`<div class="day"><div class="dayDate"><b>${String(s.date).slice(-2)}</b><span>${new Date(s.date+'T12:00:00').toLocaleDateString('ru-RU',{month:'short'})}</span></div><div style="flex:1"><b>${hour(s.in_at)} — ${hour(s.out_at)}</b><p class="small muted">${s.source==='AUTO_PENDING'?'Уход не отмечен · ждёт проверки':s.source==='SCAN_REVIEW'?'Подработка · ждёт подтверждения':s.source==='SCAN'?'QR-отметки':'Корректировка'} · ${esc(s.date)}</p></div><b>${hours(s.minutes)}</b></div>`).join('')||'<div class="empty">Закрытых смен пока нет</div>'}</div><p class="small muted" style="padding:13px">Показаны последние 40 дней. Данные обновляются при входе и по кнопке.</p>`;}
function requestView(){return `<div class="section row"><h2>Заявки на корректировку</h2><button class="link" id="update">↻</button></div><div class="card"><p class="muted small">Забыли отметить приход или уход? Подайте заявку — руководитель получит её на рассмотрение. Здесь появятся решение и комментарий.</p><button class="btn" id="newRequest" style="width:100%;margin-top:15px">+ Новая заявка</button></div><div class="section"><h2>Мои заявки</h2></div><div class="card">${!lastCorrections?'<div class="loadingLine"><span class="netCircle"></span> Загружаем заявки…</div>':lastCorrections.filter(r=>Boolean(r.proposed_in)).map(r=>`<div class="day"><div style="flex:1"><b>${esc(r.date)}</b><p class="small muted">${esc(String(r.reason).replace(/^\[(?:ПРОПУСК|ПОДРАБОТКА)\]\s*/,''))}</p><p class="small muted">${r.proposed_in?hour(r.proposed_in)+' — '+hour(r.proposed_out):'Объяснение пропуска'}</p></div><span class="chip ${r.status==='APPROVED'?'':'off'}">${({PENDING:'Ожидает решения',APPROVED:'Принята',REJECTED:'Отклонена'})[r.status]||esc(r.status)}</span></div>${r.status==='REJECTED'?`<div class="decisionNote rejectedNote"><b>Причина отклонения</b><p>${esc(r.comment||'Руководитель не указал комментарий к этой заявке.')}</p>${r.reviewed_at?`<span class="small muted">Рассмотрено: ${new Date(r.reviewed_at).toLocaleDateString('ru-RU')}</span>`:''}</div>`:r.status==='APPROVED'&&r.comment?`<div class="decisionNote"><b>Комментарий руководителя</b><p>${esc(r.comment)}</p></div>`:''}`).join('')||'<div class="empty">Заявок пока нет</div>'}</div>`;}
async function loadCorrections(){if(!navigator.onLine){toast('Нет сети, заявки не обновлены');return}try{lastCorrections=await call('corrections');if(tab==='requests')drawContent()}catch(e){toast(errorMessage(e))}}
function newCorrection(requestedDate,originalStart){const day=typeof requestedDate==='string'?requestedDate:dateLocal();const proposedStart=originalStart?new Date(originalStart).toLocaleString('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).replace(' ','T'):day+'T09:00';showDialog('Заявка на корректировку',`<form id="correctionForm"><div class="field"><label>Дата смены</label><input type="date" class="input" name="date" value="${day}" required max="${day}"></div><div class="field"><label>Фактический приход</label><input type="datetime-local" class="input" name="start" value="${proposedStart}" required></div><div class="field"><label>Фактический уход</label><input type="datetime-local" class="input" name="end" value="${day}T18:00" required></div><div class="field"><label>Причина (обязательно)</label><textarea name="reason" rows="3" class="input" minlength="5" maxlength="500" placeholder="Например, забыл отсканировать QR при уходе" required></textarea></div><button class="btn" style="width:100%">Отправить заявку</button></form>`);
 $('#correctionForm').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;b.textContent='Отправляем…';const f=Object.fromEntries(new FormData(e.target));try{f.start=new Date(f.start).toISOString();f.end=new Date(f.end).toISOString();await call('correction',f,true);closeDialog();toast('Заявка отправлена');lastCorrections=null;await loadCorrections()}catch(ex){toast(errorMessage(ex));b.disabled=false;b.textContent='Отправить заявку'}};
}
let qrLibraryPromise=null;
function loadQrLibrary(){if(typeof window.jsQR==='function')return Promise.resolve();if(qrLibraryPromise)return qrLibraryPromise;
 qrLibraryPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';script.onload=()=>typeof window.jsQR==='function'?resolve():reject(new Error('Библиотека QR недоступна'));script.onerror=()=>reject(new Error('Не загрузилась библиотека QR-сканирования'));document.head.append(script)});return qrLibraryPromise;
}
async function startScan(mode='clock'){const serverMode=mode==='server';if(!serverMode&&!navigator.onLine){toast('Для сканирования требуется сеть');return}if(scanBusy||scanner)return;
 try{stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});}catch(e){toast('Доступ к камере не получен. Разрешите использование камеры в браузере.');return}
 document.body.insertAdjacentHTML('beforeend',`<div class="viewer" id="scanner"><div class="viewbar"><b style="font-size:19px">Сканирование QR</b><button class="btn outline" id="stopScan">Закрыть</button></div><p style="color:#b0c6e2;text-align:center">${serverMode?'Наведите камеру на QR-код с URL сервера':'Наведите камеру на QR-код рабочего места'}</p><video autoplay muted playsinline id="video"></video><div class="notice" style="background:#293b55;color:#c7dcfb">${serverMode?'В QR должен быть адрес опубликованного Google Apps Script /exec.':'После сканирования дождитесь подтверждения записи на сервере.'}</div></div>`);
 $('#stopScan').onclick=stopScan;const video=$('#video');video.srcObject=stream;try{await video.play()}catch(e){stopScan();toast('Не удалось запустить камеру');return}
 const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});let detector=null;
 if(window.BarcodeDetector){try{detector=new BarcodeDetector({formats:['qr_code']})}catch(e){}}
 if(!detector&&typeof window.jsQR!=='function'){try{await loadQrLibrary()}catch(e){stopScan();toast(errorMessage(e));return}}
 let iterating=false;
 scanner=setInterval(async()=>{if(iterating||!document.querySelector('#scanner')||video.readyState<2||scanBusy)return;iterating=true;
 try{let code='';if(detector){try{const found=await detector.detect(video);code=found[0]?.rawValue||'';}catch(e){detector=null;try{await loadQrLibrary()}catch(ex){stopScan();toast(errorMessage(ex));return}}}else{
 const ratio=Math.min(1,900/video.videoWidth);canvas.width=Math.floor(video.videoWidth*ratio);canvas.height=Math.floor(video.videoHeight*ratio);ctx.drawImage(video,0,0,canvas.width,canvas.height);const img=ctx.getImageData(0,0,canvas.width,canvas.height);code=window.jsQR(img.data,canvas.width,canvas.height,{inversionAttempts:'dontInvert'})?.data||'';}
 if(code){
  if(serverMode){
   const url=parseServerUrl(code);
   if(url){scanBusy=true;stopScan();applyServer(url);scanBusy=false}
   else if(Date.now()-lastInvalidServerScanAt>4500){lastInvalidServerScanAt=Date.now();toast('Это не QR сервера. Отсканируйте код с адресом Apps Script /exec.')}
  }else if(code.startsWith('AT1|')||code.startsWith('AT0|')){scanBusy=true;stopScan();await sendClock(code)}
 }}
 catch(e){}finally{iterating=false}},260);
}
function stopScan(){if(scanner){clearInterval(scanner);scanner=null}if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}$('#scanner')?.remove()}
async function sendClock(qr){showDialog('Подтверждение',`<div style="text-align:center;padding:18px"><div style="font-size:45px;margin-bottom:12px">◷</div><h2>Сохраняем отметку…</h2><p class="muted small" style="margin-top:10px">Не закрывайте приложение до ответа сервера.</p></div>`);
 try{const result=await call('clock',{qr},true);closeDialog();showDialog(result.kind==='IN'?'Приход зафиксирован':result.kind==='OUT'?'Уход зафиксирован':result.kind==='AUTO_PENDING'?'Предыдущая смена требует проверки':'Отметка уже учтена',`<div style="text-align:center;padding:18px"><div style="font-size:60px;color:${result.kind==='AUTO_PENDING'?'#c37b10':'#149366'}">${result.kind==='AUTO_PENDING'?'!':'✓'}</div><h1>${esc(result.time||'Готово')}</h1><p class="muted" style="margin-top:12px">${esc(result.message||'Отметка сохранена')}</p>${result.kind==='AUTO_PENDING'?'<button class="btn ghost" id="requestOvertime" style="margin-top:20px;width:100%">Указать фактическое время ухода</button>':''}<button class="btn" id="ack" style="margin-top:12px;width:100%">Продолжить</button></div>`);$('#ack').onclick=closeDialog;if(result.kind==='AUTO_PENDING')$('#requestOvertime').onclick=()=>{closeDialog();newCorrection(result.date,result.in_at)};await refreshSelf(true);render();}
 catch(e){closeDialog();showDialog('Не удалось подтвердить',`<p>${esc(errorMessage(e))}</p><p class="muted small" style="margin-top:10px">Проверьте историю или статус смены перед новым сканированием, чтобы не сделать лишнюю отметку.</p><button class="btn" style="width:100%;margin-top:20px" id="retryClose">Понятно</button>`);$('#retryClose').onclick=async()=>{closeDialog();await refreshSelf(true);render()}}
 finally{scanBusy=false}
}
async function boot(){if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
 if(!apiValid(apiUrl)){serverSetupScreen();return}
 if(!person){loginScreen();initBridge();return}
 netStart('Загружаем приложение…');try{snapshot=await kvGet('self_'+apiUrl+'_'+person.id);}finally{netEnd()}render();await initBridge();if(ready){await refreshSelf(true);render()}else if(!snapshot)toast('Не удалось установить связь с Apps Script. Проверьте настройки сервера.');
 window.addEventListener('online',async()=>{await refreshSelf(true);render()});
}
boot();
