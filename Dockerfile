FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY ASKIIES.html /usr/share/nginx/html/index.html
COPY terrain-engine.js /usr/share/nginx/html/terrain-engine.js
COPY plane-engine.js /usr/share/nginx/html/plane-engine.js
COPY mp-client.js /usr/share/nginx/html/mp-client.js
# Cache-busting: Cloudflare forces a 4 h browser cache on .js files, so each script link gets a
# ?v=<content hash>. A new build changes the URL and every browser fetches the new code at once.
RUN cd /usr/share/nginx/html && for f in mp-client.js terrain-engine.js plane-engine.js; do \
      h=$(md5sum "$f" | cut -c1-10); sed -i "s#src=\"$f\"#src=\"$f?v=$h\"#" index.html; done && \
    grep -o 'src="[a-z-]*\.js?v=[0-9a-f]*"' index.html
EXPOSE 80
