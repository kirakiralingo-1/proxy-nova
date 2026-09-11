importScripts("/scram/scramjet.all.js");

self.onfetch = (event) => {
  const { client, request } = event;
  if (client && request.mode !== "navigate") {
    event.respondWith(scramjet.handleFetch(request, client));
  }
};   
