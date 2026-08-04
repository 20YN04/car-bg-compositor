# Gepoorte thumbnail-service (car-bg-compositor).
# Draait de HTTP-service uit src/server.ts; de pipeline zelf start per taak
# als kindproces. Zie INTEGRATIE.md voor het contract en de envs.
FROM node:22-slim

# sharp heeft libvips-runtime nodig; slim-image mist die
RUN apt-get update && apt-get install -y --no-install-recommends libvips42 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm i -D tsx typescript
COPY src ./src
COPY assets ./assets

# in/, out/ en cache/ zijn werkdata — mount ze als volume zodat een
# herstart geen goedgekeurde beelden of cache weggooit
VOLUME ["/app/in", "/app/out", "/app/cache"]

ENV PORT=8801
EXPOSE 8801
CMD ["npx", "tsx", "src/server.ts"]
