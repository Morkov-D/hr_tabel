const VERSION='timekeeper-shell-v1';
const SHELL=['./','./index.html','./app.js','./config.js','./manifest.webmanifest','./icon.svg','./icon-192.png','./icon-512.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(VERSION).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{const req=event.request;if(req.method!=='GET')return;
 const url=new URL(req.url);if(url.origin!==self.location.origin){if(['cdnjs.cloudflare.com','cdn.jsdelivr.net'].includes(url.hostname)){event.respondWith(caches.open(VERSION).then(async cache=>{const old=await cache.match(req);if(old)return old;const fresh=await fetch(req);if(fresh.ok||fresh.type==='opaque')cache.put(req,fresh.clone());return fresh}));}return;}
 const changing=['index.html','app.js','config.js','sw.js'];
 if(changing.some(x=>url.pathname.endsWith('/'+x))||url.pathname.endsWith('/')){
   event.respondWith(caches.open(VERSION).then(async cache=>{try{const fresh=await fetch(req);if(fresh.ok)cache.put(req,fresh.clone());return fresh}catch(e){return(await cache.match(req))||Response.error()}}));return;
 }
 event.respondWith(caches.match(req).then(cached=>cached||fetch(req)));
});
