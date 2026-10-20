// Divyajivan service worker
// Cache name is bumped on every meaningful change so old caches (which may
// hold stale app code or cross-origin responses) are purged on activate.
const CACHE_NAME='dj-v3';

// App shell — same-origin only. './' resolves to the SW scope, so this works
// both at a domain root and under a GitHub Pages subpath (/Divyajivan-App-v2/).
const ASSETS=['./','index.html','offline.html','manifest.json','logo.webp','icon-192.png','icon-512.png'];

self.addEventListener('install',e=>{
  // Precache best-effort: one missing asset must not abort the whole install.
  e.waitUntil(caches.open(CACHE_NAME).then(c=>Promise.allSettled(ASSETS.map(a=>c.add(a)))));
  self.skipWaiting();
});

self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return;

  // Only ever touch SAME-ORIGIN requests. Cross-origin responses — CDN scripts,
  // Google Fonts, and especially the Supabase REST API (private medical data) —
  // are left entirely to the browser and NEVER written to the cache.
  let url;
  try{url=new URL(req.url);}catch(_){return;}
  if(url.origin!==self.location.origin)return;

  // HTML navigations: network-first so a returning user always gets fresh app
  // code when online; fall back to cache, then the offline page.
  if(req.mode==='navigate'){
    e.respondWith(
      fetch(req).then(res=>{
        const clone=res.clone();
        caches.open(CACHE_NAME).then(c=>c.put(req,clone)).catch(()=>{});
        return res;
      }).catch(()=>caches.match(req).then(r=>r||caches.match('index.html')).then(r=>r||caches.match('offline.html')))
    );
    return;
  }

  // Other same-origin GETs (icons, logo, manifest): network-first, cache only
  // successful basic responses so a flaky network can't poison the cache.
  e.respondWith(
    fetch(req).then(res=>{
      if(res&&res.ok&&res.type==='basic'){
        const clone=res.clone();
        caches.open(CACHE_NAME).then(c=>c.put(req,clone)).catch(()=>{});
      }
      return res;
    }).catch(()=>caches.match(req))
  );
});

self.addEventListener('message',e=>{
  if(e.data&&e.data.type==='SKIP_WAITING')self.skipWaiting();
});
