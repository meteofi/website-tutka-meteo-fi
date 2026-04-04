FROM node:20 as build-stage
ENV NODE_OPTIONS=--openssl-legacy-provider
WORKDIR /app
COPY ./ /app/
RUN npm ci
RUN npm run build

FROM nginxinc/nginx-unprivileged:1-alpine
COPY --from=build-stage /app/dist /usr/share/nginx/html
RUN echo 'server { listen 8080; location / { root /usr/share/nginx/html; try_files $uri $uri/ /index.html; } }' > /etc/nginx/conf.d/default.conf

