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
let apiUrl=String(GAS_WEB_APP_URL||localStorage.getItem('tk_api_url')||'').trim();

function toast(text){toaster.innerHTML=`<div class="toast">${esc(text)}</div>`;setTimeout(()=>toaster.innerHTML='',5200)}
function errorMessage(e){return String(e&&e.message||e||'Ошибка связи')}
function disconnect(message){ready=false;if(readyResolve){readyResolve(false);readyResolve=null;}for(const [key,job]of pending){clearTimeout(job.timer);job.reject(new Error(message||'Нет связи с сервером'))}pending.clear();}
function apiValid(url){return /^https:\/\/script\.google\.com\/macros\/s\/[-\w]+\/exec(?:\?.*)?$/.test(url||'')}
function initBridge(){if(!apiValid(apiUrl)){ready=false;return Promise.resolve(false)}if(ready)return Promise.resolve(true);if(readyPromise)return readyPromise;
 const nonce=id();const frame=document.createElement('iframe');frame.style.cssText='position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none';frame.setAttribute('aria-hidden','true');
 frame.src=apiUrl.split('?')[0]+'?view=bridge&bridgeNonce='+encodeURIComponent(nonce);
 document.querySelector('#bridgeContainer').replaceChildren(frame);
 readyPromise=new Promise(resolve=>{readyResolve=resolve;const timer=setTimeout(()=>{if(!ready){window.removeEventListener('message',onready);disconnect('Не удалось подключиться к Apps Script. Проверьте URL, доступ «Все» и разрешение встраивания.');readyPromise=null;resolve(false)}},18000);
  const onready=event=>{if(event.data?.type!=='TK_READY'||event.data?.nonce!==nonce)return;
   if(!/^https:\/\/([\w-]+\.)*googleusercontent\.com$/.test(event.origin)&&event.origin!=='https://script.google.com')return;
   bridge=event.source;bridgeOrigin=event.origin;ready=true;clearTimeout(timer);readyResolve=null;window.removeEventListener('message',onready);resolve(true);
  };window.addEventListener('message',onready);
 });return readyPromise;
}
window.addEventListener('message',event=>{if(!ready||event.source!==bridge||event.origin!==bridgeOrigin||event.data?.type!=='TK_REPLY')return;
 const job=pending.get(event.data.id);if(!job)return;clearTimeout(job.timer);pending.delete(event.data.id);
 const response=event.data.response;if(response?.ok)job.resolve(response.data);else job.reject(new Error(response?.error||'Ошибка сервера'));
});
async function once(op,args={},requestId=id()){
 const connected=await initBridge();if(!connected)throw new Error('Нет соединения с сервером Apps Script');
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('Превышено время ответа. Проверьте состояние отметки перед повтором.'))},30000);pending.set(requestId,{resolve,reject,timer});
  bridge.postMessage({type:'TK_REQUEST',id:requestId,request:{op,args,token,requestId}},bridgeOrigin);
 });
}
async function call(op,args={},retryBusy=false){const requestId=id();for(let tries=0;tries<(retryBusy?3:1);tries++){
 try{return await once(op,args,requestId)}catch(e){const message=errorMessage(e);if(!retryBusy||tries===2||!/BUSY|занят|too many scripts|слишком много|simultaneous/i.test(message))throw e;await pause(1100*(tries+1));}}
}
const dbPromise=new Promise(resolve=>{if(!window.indexedDB){resolve(null);return}const req=indexedDB.open('timekeeper-cache',1);req.onupgradeneeded=()=>req.result.createObjectStore('kv');req.onsuccess=()=>resolve(req.result);req.onerror=()=>resolve(null)});
async function kvGet(key){const db=await dbPromise;if(!db)return null;return new Promise(resolve=>{const r=db.transaction('kv','readonly').objectStore('kv').get(key);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>resolve(null)})}
async function kvSet(key,value){const db=await dbPromise;if(!db)return;return new Promise(resolve=>{const t=db.transaction('kv','readwrite');t.objectStore('kv').put(value,key);t.oncomplete=resolve;t.onerror=resolve})}
function loginScreen(){app.innerHTML=`<div class="login"><div class="logoIcon">◈</div><div><p style="color:#5e77a1;font-weight:750;letter-spacing:2px;font-size:12px">РАБОЧЕЕ ВРЕМЯ</p><h1>TimeKeeper</h1><p class="muted" style="margin-top:10px">Отмечайте начало и конец смены, следите за графиком и часами.</p></div><form id="login"><div class="field"><label>Ваш ID</label><input class="input" name="id" inputmode="numeric" placeholder="Введите ID" required></div><div class="field"><label>PIN-код</label><input class="input" name="pin" type="password" inputmode="numeric" placeholder="••••••" minlength="6" required></div><button class="btn">Войти</button></form><button class="link" id="seturl">⚙ Адрес сервера</button><div class="notice">Для отметки QR необходимо подключение к интернету. Расписание и история доступны из локального кеша.</div></div>`;
 $('#login').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;b.textContent='Проверяем…';try{const r=await call('login',Object.fromEntries(new FormData(e.target)));token=r.token;person=r.user;localStorage.setItem('tk_session',token);localStorage.setItem('tk_user',JSON.stringify(person));lastSelfAt=0;tab='home';await refreshSelf(true);render()}catch(err){toast(errorMessage(err));b.disabled=false;b.textContent='Войти'}};
 $('#seturl').onclick=()=>{showDialog('Адрес сервера',`<form id="urlForm"><div class="field"><label>Google Apps Script /exec URL</label><input class="input" name="url" value="${esc(apiUrl)}" placeholder="https://script.google.com/macros/s/.../exec" required></div><button class="btn" style="width:100%">Сохранить</button></form>`);$('#urlForm').onsubmit=e=>{e.preventDefault();const next=e.target.elements.url.value.trim();if(!apiValid(next)){toast('Укажите адрес опубликованного Web App, оканчивающийся на /exec');return}apiUrl=next;localStorage.setItem('tk_api_url',next);ready=false;readyPromise=null;closeDialog();toast('Адрес сохранен')}};
}
function showDialog(title,body){dialog.innerHTML=`<div class="overlay" id="backdrop"><div class="dialog"><div class="row" style="margin-bottom:20px"><h2>${esc(title)}</h2><button class="link" id="dismiss">Закрыть</button></div>${body}</div></div>`;$('#dismiss').onclick=closeDialog;$('#backdrop').onclick=e=>{if(e.target.id==='backdrop')closeDialog()}}
function closeDialog(){dialog.innerHTML=''}
async function refreshSelf(force=false){if(!person)return;if(!force&&snapshot&&Date.now()-lastSelfAt<10*60000)return;
 if(!navigator.onLine){if(!snapshot)snapshot=await kvGet('self_'+person.id);return}
 try{const incoming=await call('self');snapshot=incoming;lastSelfAt=Date.now();await kvSet('self_'+person.id,incoming)}catch(e){if(!snapshot)snapshot=await kvGet('self_'+person.id);if(/Сессия|вход|учетная запись/i.test(errorMessage(e))){logoutLocal();toast('Войдите снова');return;}toast('Работаем с сохраненными данными: '+errorMessage(e))}
}
function render(){if(!person){loginScreen();return}const initials=person.fio.trim().split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase();
 app.innerHTML=`<div class="app"><header class="head"><div class="top"><div><p class="small">УЧЕТ РАБОЧЕГО ВРЕМЕНИ</p><b style="font-size:18px">TimeKeeper</b></div><button class="avatar" id="profile" style="color:white;border:0">${esc(initials)}</button></div><p class="small">Здравствуйте,</p><h1>${esc(person.fio)}</h1></header><main class="main"><div id="content"></div></main><nav class="tabbar">${[['home','⌂','Главная'],['schedule','▦','График'],['history','◷','История'],['requests','✎','Заявки']].map(([t,icon,txt])=>`<button data-tab="${t}" class="${t===tab?'active':''}"><span class="sym">${icon}</span>${txt}</button>`).join('')}</nav></div>`;
 $('#profile').onclick=()=>showDialog('Профиль',`<p><b>${esc(person.fio)}</b></p><p class="muted small">ID: ${esc(person.id)}</p><div style="margin-top:20px"><button class="btn outline" id="logout" style="width:100%">Выйти из приложения</button></div>`); // attach after dialog creation
 $('#profile').addEventListener('click',()=>{$('#logout').onclick=async()=>{try{await call('logout')}catch(e){}logoutLocal();closeDialog();loginScreen()}});
 document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=async()=>{tab=b.dataset.tab;render();if(tab==='requests'&&!lastCorrections)await loadCorrections()});drawContent();
}
function logoutLocal(){person=null;token='';snapshot=null;lastCorrections=null;lastSelfAt=0;localStorage.removeItem('tk_session');localStorage.removeItem('tk_user')}
function drawContent(){const target=$('#content');if(!target)return;if(!snapshot){target.innerHTML='<div class="skeleton">Нет данных. Проверьте подключение к интернету.</div>';return}
 target.innerHTML={home:homeView,schedule:scheduleView,history:historyView,requests:requestView}[tab]();
 const sc=$('#scanBtn');if(sc)sc.onclick=startScan;const upd=$('#update');if(upd)upd.onclick=async()=>{upd.disabled=true;if(tab==='requests'){lastCorrections=null;await loadCorrections();}else{await refreshSelf(true);render()}upd.disabled=false};const make=$('#newRequest');if(make)make.onclick=newCorrection;
}
function homeView(){const online=navigator.onLine;const open=snapshot.open;const mins=snapshot.summary?.minutes||0;const next=(snapshot.week||[]).find(x=>x.work);
 return `<section class="over"><div class="card"><div class="row"><span class="muted small">Статус смены</span><span class="chip ${open?'':'off'}">${open?'● На смене':'○ Вне смены'}</span></div><h2 style="font-size:24px;margin-top:12px">${open?'Смена началась в '+hour(open.in_at):'Отметьте приход по QR'}</h2><p class="muted small" style="margin:8px 0 20px">${open?'При уходе отсканируйте QR еще раз':'Подойдите к экрану QR на рабочем месте'}</p><button class="btn primaryAction" id="scanBtn" ${!online?'disabled':''}><span class="scanIcon">▦</span><span style="flex:1">${open?'Отметить уход':'Сканировать QR'}<div style="font-size:12px;opacity:.85;font-weight:400">Камера телефона</div></span><span>›</span></button></div></section>
 <div class="section row"><h2>Мой месяц</h2><button class="link" id="update">Обновить ↻</button></div><div class="grid"><div class="card"><p class="small muted">Отработано</p><div class="stat">${(Number(mins)/60).toFixed(1)}<small style="font-size:13px"> ч</small></div></div><div class="card"><p class="small muted">Закрыто смен</p><div class="stat">${snapshot.summary?.days||0}</div></div></div>
 <div class="section"><h2>Ближайшая смена</h2></div><div class="card">${next?`<div class="row"><div><b>${fmtDate(next.date)}</b><p class="small muted">${esc(next.schedule||'Рабочий день')}</p></div><span class="chip">${esc(next.start)} — ${esc(next.end)}</span></div>`:'<p class="muted">Рабочие дни не запланированы</p>'}</div>
 <p class="small muted" style="margin:18px 3px"><span class="dot ${online?'':'offline'}"></span>${online?'Подключение доступно':'Нет сети — отметка QR недоступна'} · История сохранена на устройстве</p>`;}
function scheduleView(){return `<div class="section row"><h2>Мой график на 14 дней</h2><button class="link" id="update">↻</button></div><div class="card">${(snapshot.week||[]).map(s=>`<div class="day"><div class="dayDate"><b>${s.date.slice(-2)}</b><span>${new Date(s.date+'T12:00:00').toLocaleDateString('ru-RU',{weekday:'short'})}</span></div><div style="flex:1"><b>${s.work?'Рабочий день':'Выходной'}</b><p class="small muted">${s.work?esc(s.start)+' — '+esc(s.end):'Без смены'}</p></div><span class="chip ${s.work?'':'off'}">${s.work?'Смена':'Выходной'}</span></div>`).join('')||'<div class="empty">График не назначен</div>'}</div>`;}
function historyView(){return `<div class="section row"><h2>Отработанные смены</h2><button class="link" id="update">↻</button></div><div class="card">${(snapshot.history||[]).map(s=>`<div class="day"><div class="dayDate"><b>${String(s.date).slice(-2)}</b><span>${new Date(s.date+'T12:00:00').toLocaleDateString('ru-RU',{month:'short'})}</span></div><div style="flex:1"><b>${hour(s.in_at)} — ${hour(s.out_at)}</b><p class="small muted">${s.source==='SCAN'?'QR-отметки':'Корректировка'} · ${esc(s.date)}</p></div><b>${hours(s.minutes)}</b></div>`).join('')||'<div class="empty">Закрытых смен пока нет</div>'}</div><p class="small muted" style="padding:13px">Показаны последние 40 дней. Данные обновляются при входе и по кнопке.</p>`;}
function requestView(){return `<div class="section row"><h2>Корректировки</h2><button class="link" id="update">↻</button></div><div class="card"><p class="muted small">Забыли отметить приход или уход? Подайте заявку — руководитель получит ее на рассмотрение.</p><button class="btn" id="newRequest" style="width:100%;margin-top:15px">+ Новая заявка</button></div><div class="section"><h2>Мои заявки</h2></div><div class="card">${!lastCorrections?'<div class="empty">Загружаем заявки…</div>':lastCorrections.map(r=>`<div class="day"><div style="flex:1"><b>${esc(r.date)}</b><p class="small muted">${esc(r.reason)}</p><p class="small muted">${hour(r.proposed_in)} — ${hour(r.proposed_out)}</p></div><span class="chip ${r.status==='APPROVED'?'':'off'}">${({PENDING:'Ожидает',APPROVED:'Принята',REJECTED:'Отклонена'})[r.status]||r.status}</span></div>`).join('')||'<div class="empty">Заявок пока нет</div>'}</div>`;}
async function loadCorrections(){if(!navigator.onLine){toast('Нет сети, заявки не обновлены');return}try{lastCorrections=await call('corrections');if(tab==='requests')drawContent()}catch(e){toast(errorMessage(e))}}
function newCorrection(){const day=dateLocal();showDialog('Заявка на корректировку',`<form id="correctionForm"><div class="field"><label>Дата смены</label><input type="date" class="input" name="date" value="${day}" required max="${day}"></div><div class="field"><label>Фактический приход</label><input type="datetime-local" class="input" name="start" value="${day}T09:00" required></div><div class="field"><label>Фактический уход</label><input type="datetime-local" class="input" name="end" value="${day}T18:00" required></div><div class="field"><label>Причина (обязательно)</label><textarea name="reason" rows="3" class="input" minlength="5" maxlength="500" placeholder="Например, забыл отсканировать QR при уходе" required></textarea></div><button class="btn" style="width:100%">Отправить заявку</button></form>`);
 $('#correctionForm').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;b.textContent='Отправляем…';const f=Object.fromEntries(new FormData(e.target));try{f.start=new Date(f.start).toISOString();f.end=new Date(f.end).toISOString();await call('correction',f,true);closeDialog();toast('Заявка отправлена');lastCorrections=null;await loadCorrections()}catch(ex){toast(errorMessage(ex));b.disabled=false;b.textContent='Отправить заявку'}};
}
let qrLibraryPromise=null;
function loadQrLibrary(){if(typeof window.jsQR==='function')return Promise.resolve();if(qrLibraryPromise)return qrLibraryPromise;
 qrLibraryPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';script.onload=()=>typeof window.jsQR==='function'?resolve():reject(new Error('Библиотека QR недоступна'));script.onerror=()=>reject(new Error('Не загрузилась библиотека QR-сканирования'));document.head.append(script)});return qrLibraryPromise;
}
async function startScan(){if(!navigator.onLine){toast('Для сканирования требуется сеть');return}if(scanBusy)return;
 try{stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});}catch(e){toast('Доступ к камере не получен. Разрешите использование камеры в браузере.');return}
 document.body.insertAdjacentHTML('beforeend',`<div class="viewer" id="scanner"><div class="viewbar"><b style="font-size:19px">Сканирование QR</b><button class="btn outline" id="stopScan">Закрыть</button></div><p style="color:#b0c6e2;text-align:center">Наведите камеру на QR-код рабочего места</p><video autoplay muted playsinline id="video"></video><div class="notice" style="background:#293b55;color:#c7dcfb">После сканирования дождитесь подтверждения записи на сервере.</div></div>`);
 $('#stopScan').onclick=stopScan;const video=$('#video');video.srcObject=stream;try{await video.play()}catch(e){stopScan();toast('Не удалось запустить камеру');return}
 const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});let detector=null;
 if(window.BarcodeDetector){try{detector=new BarcodeDetector({formats:['qr_code']})}catch(e){}}
 if(!detector&&typeof window.jsQR!=='function'){try{await loadQrLibrary()}catch(e){stopScan();toast(errorMessage(e));return}}
 let iterating=false;
 scanner=setInterval(async()=>{if(iterating||!document.querySelector('#scanner')||video.readyState<2||scanBusy)return;iterating=true;
 try{let code='';if(detector){try{const found=await detector.detect(video);code=found[0]?.rawValue||'';}catch(e){detector=null;try{await loadQrLibrary()}catch(ex){stopScan();toast(errorMessage(ex));return}}}else{
 const ratio=Math.min(1,900/video.videoWidth);canvas.width=Math.floor(video.videoWidth*ratio);canvas.height=Math.floor(video.videoHeight*ratio);ctx.drawImage(video,0,0,canvas.width,canvas.height);const img=ctx.getImageData(0,0,canvas.width,canvas.height);code=window.jsQR(img.data,canvas.width,canvas.height,{inversionAttempts:'dontInvert'})?.data||'';}
 if(code&&(code.startsWith('AT1|')||code.startsWith('AT0|'))){scanBusy=true;stopScan();await sendClock(code);}}
 catch(e){}finally{iterating=false}},260);
}
function stopScan(){if(scanner){clearInterval(scanner);scanner=null}if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}$('#scanner')?.remove()}
async function sendClock(qr){showDialog('Подтверждение',`<div style="text-align:center;padding:18px"><div style="font-size:45px;margin-bottom:12px">◷</div><h2>Сохраняем отметку…</h2><p class="muted small" style="margin-top:10px">Не закрывайте приложение до ответа сервера.</p></div>`);
 try{const result=await call('clock',{qr},true);closeDialog();showDialog(result.kind==='IN'?'Приход зафиксирован':result.kind==='OUT'?'Уход зафиксирован':'Отметка уже учтена',`<div style="text-align:center;padding:18px"><div style="font-size:60px;color:#149366">✓</div><h1>${esc(result.time||'Готово')}</h1><p class="muted" style="margin-top:12px">${esc(result.message||'Отметка сохранена')}</p><button class="btn" id="ack" style="margin-top:23px;width:100%">Продолжить</button></div>`);$('#ack').onclick=closeDialog;await refreshSelf(true);render();}
 catch(e){closeDialog();showDialog('Не удалось подтвердить',`<p>${esc(errorMessage(e))}</p><p class="muted small" style="margin-top:10px">Проверьте историю или статус смены перед новым сканированием, чтобы не сделать лишнюю отметку.</p><button class="btn" style="width:100%;margin-top:20px" id="retryClose">Понятно</button>`);$('#retryClose').onclick=async()=>{closeDialog();await refreshSelf(true);render()}}
 finally{scanBusy=false}
}
async function boot(){if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
 if(!person){loginScreen();initBridge();return}
 snapshot=await kvGet('self_'+person.id);render();await initBridge();if(ready){await refreshSelf(true);render()}else if(!snapshot)toast('Не удалось установить связь с Apps Script. Проверьте настройки сервера.');
 window.addEventListener('online',async()=>{await refreshSelf(true);render()});
}
boot();
