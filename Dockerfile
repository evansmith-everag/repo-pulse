# Repo Pulse in a container. Settings and the data cache live in /data; mount a volume there.
# Inside a container the server must listen on all interfaces, so HOST is 0.0.0.0 here; publish the port on
# 127.0.0.1 (or put a proxy in front) rather than exposing it to the world.
#
#   docker build -t repo-pulse .
#   docker run -d --name repo-pulse --restart unless-stopped -e GITHUB_TOKEN=... -p 127.0.0.1:4317:4317 -v repo-pulse-data:/data repo-pulse
#
# REPO_PULSE_CONTAINER tells the server not to update itself in place (the image is the unit of update: pull a newer one).
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV HOST=0.0.0.0 PORT=4317 REPO_PULSE_CONFIG=/data/config.json REPO_PULSE_CACHE=/data/snapshot.json REPO_PULSE_CONTAINER=1
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4317
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s CMD wget -qO- http://127.0.0.1:4317/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
