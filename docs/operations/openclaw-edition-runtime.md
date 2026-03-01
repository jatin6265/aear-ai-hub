# OpenClaw Edition Runtime Notes

## Scope

This repository keeps the existing Phase-1 OpsAI contracts and adds an OpenClaw-first runtime seam in worker services.

## Runtime Selection

- `AGENT_RUNTIME_ENGINE=openclaw`:
  - Uses `worker/src/services/agent-core/openclawRpcEngine.ts`
  - Executes via `OPENCLAW_RPC_COMMAND` (default `openclaw agent --mode rpc --json`)
  - Uses iterative planning with local governed tool callbacks:
    1. OpenClaw returns next-step JSON (`tool_calls` or `final`)
    2. Worker executes requested tools through OpsAI governance wrapper
    3. Tool results are injected into next OpenClaw turn until final answer
- `AGENT_RUNTIME_ENGINE=openai`:
  - Uses `worker/src/services/agent-core/openaiEngine.ts`

## Strict Cutover

- `OPENCLAW_STRICT=true`:
  - OpenClaw failures fail the run (no compatibility fallback).
- `OPENCLAW_STRICT=false`:
  - If OpenClaw RPC fails, runtime falls back to OpenAI engine for Phase-1 continuity.

## Governance Path

All tool execution in the new service layer flows through:

1. `evaluate_action_policy_service` (tenant + user scoped)
2. Approval request creation for HIGH/CRITICAL actions
3. Immutable audit logging (`audit_logs` insert-only)

Files:
- `worker/src/services/governance/policy.ts`
- `worker/src/services/governance/wrapper.ts`
- `supabase/migrations/20260228143000_openclaw_governance_runtime.sql`

## Hybrid Memory Path

Hybrid context assembly is in:
- `worker/src/services/memory/builder.ts`

It combines:
- semantic retrieval (`hybrid_search`)
- structured entity hints (`schema_entities`)
- event timeline (`context_events`)
- RACI context (`resolve_user_raci_context`)

## Agent Loop Wiring

`worker/src/runtime/agentLoop.ts` now delegates execution to:
- `OpsAIAgent` (`worker/src/services/agent-core/opsaiAgent.ts`)

This keeps existing `agent_runs` flow while enabling OpenClaw mode.

## Chat Runtime Cutover

`chat-execute` now supports queue-first runtime dispatch:

1. Resolve tenant agent (`agentId` override supported)
2. Resolve connection (`connectionId` override supported)
3. Enqueue `agent_runs` via `enqueue_agent_run`
4. Poll worker-owned run status
5. Return worker-produced assistant output + step/tool traces

Controls:
- `CHAT_EXECUTION_MODE=agent_runtime` (default behavior)
- `CHAT_EXECUTION_MODE=direct` (legacy edge direct path)
- `CHAT_RUNTIME_STRICT=true` (default): runtime dispatch failure returns explicit error and does not fall back to direct synthesis
- `CHAT_RUNTIME_STRICT=false`: runtime dispatch failure can fall back to direct compat path

## OpenClaw Callback Bridge Controls

- `OPENCLAW_RPC_METHODS` (optional): comma-separated fallback methods to try, default `agent.run,agent`
- `OPENCLAW_TURN_TIMEOUT_MS` (optional): per-turn timeout passed to OpenClaw `agent` RPC mode
- `OPENCLAW_STRICT`:
  - `false` (default): if OpenClaw engine fails, fallback to OpenAI engine
  - `true`: no fallback, hard fail on OpenClaw runtime errors

## Smoke Test

Run a governed end-to-end callback smoke test:

```bash
npm run backend:smoke-openclaw-bridge
```

What it validates:
- OpenClaw RPC turn execution
- governed tool callback (`governanceWrappedExecute`)
- audit log persistence for the governed tool call
