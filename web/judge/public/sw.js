/* Cache only a neutral offline explanation. Never cache sessions, cases, receipts,
 * API data, release provenance, or application navigations. No background writes. */
const CACHE='ordertruth-offline-v1';
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.add(new Request('/offline.html',{cache:'reload',credentials:'omit'}))));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('ordertruth-offline-')&&key!==CACHE).map(key=>caches.delete(key)))));});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname==='/api'||url.pathname.startsWith('/api/')||request.mode!=='navigate')return;
 event.respondWith(fetch(request).catch(async()=>{const cached=await caches.match('/offline.html');return cached??new Response('OrderTruth requires a live connection. Reconnect to view cases and receipts.',{status:503,headers:{'content-type':'text/plain'}});}));
});
