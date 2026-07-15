ARG BASE_IMAGE=ghcr.io/junhaoliao/metrics:latest
FROM ${BASE_IMAGE}

ENV PUPPETEER_SKIP_DOWNLOAD=true

# Reuse the previously published system layer while replacing the application completely.
RUN rm -rf /metrics
COPY . /metrics
WORKDIR /metrics

RUN chmod +x /metrics/source/app/action/index.mjs \
  && npm ci \
  && npm run build
