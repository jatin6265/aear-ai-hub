#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUEUE_FILE="$ROOT_DIR/worker/src/lib/queue.ts"
MJS_FILE="$ROOT_DIR/worker/connector-worker.mjs"
CONTRACT_FILE="$ROOT_DIR/worker/contracts/runtime-contracts.ts"
AI_CONFIG_FILE="$ROOT_DIR/worker/src/lib/ai-config.ts"

[[ -f "$QUEUE_FILE" ]] || { echo "Missing queue file: $QUEUE_FILE"; exit 1; }
[[ -f "$MJS_FILE" ]] || { echo "Missing worker runtime file: $MJS_FILE"; exit 1; }
[[ -f "$CONTRACT_FILE" ]] || { echo "Missing runtime contract file: $CONTRACT_FILE"; exit 1; }
[[ -f "$AI_CONFIG_FILE" ]] || { echo "Missing AI config file: $AI_CONFIG_FILE"; exit 1; }

required_queues=(
  "connector-sync"
  "agent-runtime"
)

for queue_name in "${required_queues[@]}"; do
  if ! rg -q "['\"]${queue_name}['\"]" "$QUEUE_FILE"; then
    echo "Queue missing from worker/src/lib/queue.ts: $queue_name"
    exit 1
  fi
  if ! rg -q "${queue_name}" "$CONTRACT_FILE"; then
    echo "Queue missing from worker/contracts/runtime-contracts.ts: $queue_name"
    exit 1
  fi
  if ! rg -q "${queue_name}" "$MJS_FILE"; then
    echo "Queue missing from worker/connector-worker.mjs: $queue_name"
    exit 1
  fi
done

# Webhook runtime parity: queue.ts defines webhook queue, MJS runtime uses webhook callback pipeline.
if ! rg -q "webhook-delivery" "$QUEUE_FILE"; then
  echo "Queue missing from worker/src/lib/queue.ts: webhook-delivery"
  exit 1
fi
if ! rg -q "webhook-delivery" "$CONTRACT_FILE"; then
  echo "Queue missing from worker/contracts/runtime-contracts.ts: webhook-delivery"
  exit 1
fi
if ! rg -q "webhook-delivery-worker-callback" "$MJS_FILE"; then
  echo "Webhook callback pipeline missing from worker/connector-worker.mjs"
  exit 1
fi

# Validate core status enums referenced by connector runtime.
status_tokens=("queued" "running" "success" "error" "dead_letter")
for token in "${status_tokens[@]}"; do
  if ! rg -q "['\"]${token}['\"]" "$MJS_FILE"; then
    echo "Status token missing from worker/connector-worker.mjs: $token"
    exit 1
  fi
  if ! rg -q "['\"]${token}['\"]" "$CONTRACT_FILE"; then
    echo "Status token missing from worker/contracts/runtime-contracts.ts: $token"
    exit 1
  fi
done

# Ensure backoff functions remain present in production runtime.
for fn in retryDelaySeconds callbackRetryDelayMs; do
  if ! rg -q "function ${fn}\(" "$MJS_FILE"; then
    echo "Required runtime backoff function missing: ${fn}"
    exit 1
  fi
done

if ! rg -q "text-embedding-3-small" "$MJS_FILE"; then
  echo "Embedding model contract missing from worker/connector-worker.mjs"
  exit 1
fi
if ! rg -q "text-embedding-3-small" "$CONTRACT_FILE"; then
  echo "Embedding model contract missing from worker/contracts/runtime-contracts.ts"
  exit 1
fi
if ! rg -q "text-embedding-3-small" "$AI_CONFIG_FILE"; then
  echo "Embedding model contract missing from worker/src/lib/ai-config.ts"
  exit 1
fi

echo "Worker runtime drift verification passed"
