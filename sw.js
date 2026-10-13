const CACHE_NAME='dj-v2';
const ASSETS=['/','index.html','offline.html','logo.webp','icon-192.png','icon-512.png'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  if(e.request.mode==='navigate'){
    e.respondWith(
      fetch(e.request).then(res=>{
        const clone=res.clone();
        caches.open(CACHE_NAME).then(c=>c.put(e.request,clone));
        return res;
      }).catch(()=>caches.match(e.request).then(r=>r||caches.match('offline.html')))
    );
    return;
  }
  e.respondWith(
    fetch(e.request).then(res=>{
      const clone=res.clone();
      caches.open(CACHE_NAME).then(c=>c.put(e.request,clone));
      return res;
    }).catch(()=>caches.match(e.request))
  );
});

self.addEventListener('message',e=>{
  if(e.data&&e.data.type==='SKIP_WAITING')self.skipWaiting();
});
