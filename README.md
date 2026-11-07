# NightWatch
**Team Members:**
- Ron Shaked
- Arav Sharma
- Samer Megla
- Pablo Nguyen

HackUTD ZeroDay — EOG "Beat the Shutdown": produced-water operations console with simulation, incident detection, a Nemotron agent, and Capital One Nessie payments.

```text
frontend/                    Next.js (Pablo)
backend/app/main.py          FastAPI entrypoint (Ron)
backend/app/contracts.py     Shared Pydantic contracts (Ron; agreed by all)
backend/app/simulation/      SimPy engine (Ron)
backend/app/detection/       Incident detection (Ron)
backend/app/planning/        Forecasts + fleet planning (Ron)
backend/app/agent/           Nemotron tool loop (Arav)
backend/app/finance/         Nessie adapter (Samer)
backend/app/workflows/       Approval -> payment -> dispatch (Samer + Ron)
data/                        EOG input folders (network.json, ops.json, telemetry.csv)
```

## Run

```bash
# backend
cd backend && cp .env.example .env && uv sync
uv run uvicorn app.main:app --reload

# frontend
cd frontend && cp .env.example .env.local && npm install
npm run dev
```
