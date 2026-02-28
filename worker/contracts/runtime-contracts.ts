export const WORKER_QUEUE_NAMES = {
  INGESTION: "ingestion-pipeline",
  SYNC: "connector-sync",
  EMBEDDING: "embedding-batch",
  AGENT_RUN: "agent-runtime",
  WEBHOOK: "webhook-delivery",
} as const;

export const CONNECTOR_JOB_STATUSES = [
  "queued",
  "running",
  "success",
  "error",
  "cancelled",
  "dead_letter",
] as const;

export const EMBEDDING_JOB_STATUSES = [
  "queued",
  "running",
  "success",
  "error",
  "cancelled",
  "dead_letter",
] as const;

export const RETRY_BACKOFF = {
  connectorBaseSeconds: 30,
  connectorMaxSeconds: 900,
  callbackBaseMs: 500,
  callbackMaxMs: 15000,
} as const;

export const EMBEDDING_RUNTIME = {
  model: "text-embedding-3-small",
  dimensions: 1536,
  chunkSizeTokens: 512,
  chunkOverlapTokens: 50,
} as const;
