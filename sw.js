var CACHE='alora-v10';
var URLS=['./'];

self.addEventListener('install',function(e){
e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(URLS)}).then(function(){return self.skipWaiting()}));
});

self.addEventListener('activate',function(e){
e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==CACHE}).map(function(k){return caches.delete(k)}))}).then(function(){return self.clients.claim()}));
});

self.addEventListener('fetch',function(e){
if(e.request.method!=='GET')return;
var url=e.request.url;
if(url.includes('api.anthropic.com')||url.includes('firebaseio.com')||url.includes('googleapis.com')||url.includes('gstatic.com'))return;
e.respondWith(caches.match(e.request).then(function(cached){
if(cached)return cached;
return fetch(e.request).then(function(r){
if(r&&r.status===200){var rc=r.clone();caches.open(CACHE).then(function(c){c.put(e.request,rc)})}
return r;
}).catch(function(){
if(e.request.destination==='document')return caches.match('./');
});
}));
});

self.addEventListener('sync',function(e){
if(e.tag==='alora-sync'){e.waitUntil(self.clients.matchAll().then(function(cls){cls.forEach(function(c){c.postMessage({type:'sync-ready'})})}))}
});

self.addEventListener('push',function(e){
var data=e.data?e.data.json():{title:'Alora',body:'New update'};
e.waitUntil(self.registration.showNotification(data.title||'Alora',{body:data.body||'',data:data.data||{}}));
});

self.addEventListener('notificationclick',function(e){
e.notification.close();
e.waitUntil(clients.matchAll({type:'window'}).then(function(cls){if(cls.length)cls[0].focus();else clients.openWindow('./')}));
});
