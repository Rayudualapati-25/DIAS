# DIAS backend for the multi-VM testbed (runs on M4).
# The same image also runs the ledger seed and the load generators.
FROM node:22-bookworm-slim
WORKDIR /app
COPY backend/package.json backend/package-lock.json backend/
RUN cd backend && npm ci --omit=dev --no-audit --no-fund
COPY backend/src backend/src
COPY chaincode/crimerecords/lib chaincode/crimerecords/lib
COPY policies/lib policies/lib
COPY policies/reference-oracle policies/reference-oracle
COPY policies/dias-governance-policy-v1.json policies/dias-governance-policy-v1.json
COPY frontend frontend
COPY testbed/seed testbed/seed
COPY testbed/load testbed/load
COPY testbed/reuse testbed/reuse
COPY scripts/dias scripts/dias
EXPOSE 3001
CMD ["node", "backend/src/server.js"]
