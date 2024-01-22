FROM node:20 as build-stage
WORKDIR /app
COPY ./ /app/
RUN npm ci 
RUN npm run build

FROM nginxinc/nginx-unprivileged:1-alpine
COPY --from=build-stage /app/dist /usr/share/nginx/html
RUN apk --no-cache add bash

