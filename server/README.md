# Node.js Server (Express)

Ein schlanker Express-Server mit:
- Health-Endpoint (`GET /health`)
- API-Namespace (`/api`)
  - `POST /api/echo` (Echo-Endpoint für schnelle Tests)
  - Optionaler Proxy unter `/api/proxy/**` (über PROXY_TARGET konfigurierbar)

## Voraussetzungen
- Node.js >= 18

## Installation
