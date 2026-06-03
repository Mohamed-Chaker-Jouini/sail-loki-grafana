# ── Stage 1: build React frontend ─────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /app

RUN npm config set proxy http://10.93.144.53:8080 && \
    npm config set https-proxy http://10.93.144.53:8080 && \
    npm config set strict-ssl false

COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Python backend ────────────────────────────────────────────────────
FROM python:3.12-slim
WORKDIR /app

ENV http_proxy=http://10.93.144.53:8080
ENV https_proxy=http://10.93.144.53:8080
ENV no_proxy=localhost,127.0.0.1,10.202.52.0/24

RUN apt-get update && apt-get install -y --no-install-recommends \
    libxml2-dev libxslt-dev gcc \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./backend/
COPY --from=frontend-builder /app/dist ./backend/static

ENV http_proxy=
ENV https_proxy=
ENV no_proxy=

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8880"]