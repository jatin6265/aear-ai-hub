export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      agent_action_runs: {
        Row: {
          action: string
          action_payload: Json
          action_summary: string | null
          agent_id: string | null
          approval_request_id: string | null
          created_at: string
          error: string | null
          executed_at: string | null
          id: string
          params: Json
          policy_decision: Json
          requested_by: string | null
          resource: string
          reverted_at: string | null
          session_id: string | null
          simulation_preview: Json | null
          status: string
          tenant_id: string
          undo_expires_at: string | null
          updated_at: string
        }
        Insert: {
          action: string
          action_payload?: Json
          action_summary?: string | null
          agent_id?: string | null
          approval_request_id?: string | null
          created_at?: string
          error?: string | null
          executed_at?: string | null
          id?: string
          params?: Json
          policy_decision?: Json
          requested_by?: string | null
          resource: string
          reverted_at?: string | null
          session_id?: string | null
          simulation_preview?: Json | null
          status?: string
          tenant_id: string
          undo_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          action?: string
          action_payload?: Json
          action_summary?: string | null
          agent_id?: string | null
          approval_request_id?: string | null
          created_at?: string
          error?: string | null
          executed_at?: string | null
          id?: string
          params?: Json
          policy_decision?: Json
          requested_by?: string | null
          resource?: string
          reverted_at?: string | null
          session_id?: string | null
          simulation_preview?: Json | null
          status?: string
          tenant_id?: string
          undo_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_action_runs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_action_runs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "ai_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_action_runs_approval_request_id_fkey"
            columns: ["approval_request_id"]
            isOneToOne: false
            referencedRelation: "approval_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_action_runs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "chat_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_action_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_action_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_memory_entries: {
        Row: {
          agent_id: string
          created_at: string
          id: string
          memory_key: string
          memory_type: string
          memory_value: Json
          metadata: Json
          session_id: string | null
          subject_user_id: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          agent_id: string
          created_at?: string
          id?: string
          memory_key: string
          memory_type: string
          memory_value?: Json
          metadata?: Json
          session_id?: string | null
          subject_user_id?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          agent_id?: string
          created_at?: string
          id?: string
          memory_key?: string
          memory_type?: string
          memory_value?: Json
          metadata?: Json
          session_id?: string | null
          subject_user_id?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_memory_entries_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_memory_entries_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "ai_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_memory_entries_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "chat_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_memory_entries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_memory_entries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_raci_bindings: {
        Row: {
          action: string
          agent_id: string
          created_at: string
          id: string
          raci_type: string
          resource: string
          role_name: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          action?: string
          agent_id: string
          created_at?: string
          id?: string
          raci_type: string
          resource?: string
          role_name: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          action?: string
          agent_id?: string
          created_at?: string
          id?: string
          raci_type?: string
          resource?: string
          role_name?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_raci_bindings_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_raci_bindings_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "ai_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_raci_bindings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_raci_bindings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_run_jobs: {
        Row: {
          agent_id: string
          attempt_count: number
          created_at: string
          finished_at: string | null
          id: string
          idempotency_key: string | null
          last_error: string | null
          max_attempts: number
          payload: Json
          priority: number
          queue: string
          result: Json
          run_id: string
          scheduled_at: string
          started_at: string | null
          status: string
          tenant_id: string
          triggered_by: string | null
          updated_at: string
          worker_id: string | null
        }
        Insert: {
          agent_id: string
          attempt_count?: number
          created_at?: string
          finished_at?: string | null
          id?: string
          idempotency_key?: string | null
          last_error?: string | null
          max_attempts?: number
          payload?: Json
          priority?: number
          queue?: string
          result?: Json
          run_id: string
          scheduled_at?: string
          started_at?: string | null
          status?: string
          tenant_id: string
          triggered_by?: string | null
          updated_at?: string
          worker_id?: string | null
        }
        Update: {
          agent_id?: string
          attempt_count?: number
          created_at?: string
          finished_at?: string | null
          id?: string
          idempotency_key?: string | null
          last_error?: string | null
          max_attempts?: number
          payload?: Json
          priority?: number
          queue?: string
          result?: Json
          run_id?: string
          scheduled_at?: string
          started_at?: string | null
          status?: string
          tenant_id?: string
          triggered_by?: string | null
          updated_at?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_run_jobs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_run_jobs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "ai_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_run_jobs_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_run_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_run_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_run_steps: {
        Row: {
          cost_credits: number
          created_at: string
          data: Json
          id: string
          latency_ms: number | null
          run_id: string
          status: string
          step_index: number
          step_type: string
          tenant_id: string
          tool_name: string | null
        }
        Insert: {
          cost_credits?: number
          created_at?: string
          data?: Json
          id?: string
          latency_ms?: number | null
          run_id: string
          status?: string
          step_index: number
          step_type: string
          tenant_id: string
          tool_name?: string | null
        }
        Update: {
          cost_credits?: number
          created_at?: string
          data?: Json
          id?: string
          latency_ms?: number | null
          run_id?: string
          status?: string
          step_index?: number
          step_type?: string
          tenant_id?: string
          tool_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_run_steps_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_run_steps_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_run_steps_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_runs: {
        Row: {
          agent_id: string
          completed_at: string | null
          created_at: string
          error: string | null
          execution_log: Json
          id: string
          input: Json
          input_tokens: number
          output: Json
          output_tokens: number
          queued_at: string
          requested_by: string | null
          reservation_id: string | null
          session_id: string | null
          started_at: string | null
          status: string
          tenant_id: string
          tool_calls: number
          total_cost_credits: number
          trigger_type: string
          updated_at: string
        }
        Insert: {
          agent_id: string
          completed_at?: string | null
          created_at?: string
          error?: string | null
          execution_log?: Json
          id?: string
          input?: Json
          input_tokens?: number
          output?: Json
          output_tokens?: number
          queued_at?: string
          requested_by?: string | null
          reservation_id?: string | null
          session_id?: string | null
          started_at?: string | null
          status?: string
          tenant_id: string
          tool_calls?: number
          total_cost_credits?: number
          trigger_type?: string
          updated_at?: string
        }
        Update: {
          agent_id?: string
          completed_at?: string | null
          created_at?: string
          error?: string | null
          execution_log?: Json
          id?: string
          input?: Json
          input_tokens?: number
          output?: Json
          output_tokens?: number
          queued_at?: string
          requested_by?: string | null
          reservation_id?: string | null
          session_id?: string | null
          started_at?: string | null
          status?: string
          tenant_id?: string
          tool_calls?: number
          total_cost_credits?: number
          trigger_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_runs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_runs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "ai_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_runs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "chat_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_tool_runs: {
        Row: {
          agent_id: string | null
          agent_name: string | null
          created_at: string
          error: string | null
          id: string
          latency_ms: number | null
          message_id: string | null
          risk_level: string | null
          session_id: string | null
          status: string
          tenant_id: string
          tool_input: Json
          tool_name: string
          tool_output: Json
        }
        Insert: {
          agent_id?: string | null
          agent_name?: string | null
          created_at?: string
          error?: string | null
          id?: string
          latency_ms?: number | null
          message_id?: string | null
          risk_level?: string | null
          session_id?: string | null
          status?: string
          tenant_id: string
          tool_input?: Json
          tool_name: string
          tool_output?: Json
        }
        Update: {
          agent_id?: string | null
          agent_name?: string | null
          created_at?: string
          error?: string | null
          id?: string
          latency_ms?: number | null
          message_id?: string | null
          risk_level?: string | null
          session_id?: string | null
          status?: string
          tenant_id?: string
          tool_input?: Json
          tool_name?: string
          tool_output?: Json
        }
        Relationships: [
          {
            foreignKeyName: "agent_tool_runs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_tool_runs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "ai_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_tool_runs_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "chat_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_tool_runs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "chat_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_tool_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_tool_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_tools: {
        Row: {
          agent_id: string
          config: Json
          created_at: string
          enabled: boolean
          endpoint: string
          id: string
          method: string
          name: string
          raci_required: string
          risk_level: string
          tenant_id: string
          updated_at: string
          version: string
        }
        Insert: {
          agent_id: string
          config?: Json
          created_at?: string
          enabled?: boolean
          endpoint: string
          id?: string
          method?: string
          name: string
          raci_required?: string
          risk_level?: string
          tenant_id: string
          updated_at?: string
          version?: string
        }
        Update: {
          agent_id?: string
          config?: Json
          created_at?: string
          enabled?: boolean
          endpoint?: string
          id?: string
          method?: string
          name?: string
          raci_required?: string
          risk_level?: string
          tenant_id?: string
          updated_at?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_tools_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_tools_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "ai_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_tools_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_tools_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agents: {
        Row: {
          avatar_emoji: string | null
          capabilities: string[]
          config: Json
          created_at: string
          created_by: string | null
          description: string | null
          domain: string
          id: string
          is_custom: boolean
          last_regenerated_at: string | null
          lifecycle_reason: string | null
          name: string
          raci_scope: string | null
          schema_fingerprint: string | null
          slug: string
          source_connection_id: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          avatar_emoji?: string | null
          capabilities?: string[]
          config?: Json
          created_at?: string
          created_by?: string | null
          description?: string | null
          domain: string
          id?: string
          is_custom?: boolean
          last_regenerated_at?: string | null
          lifecycle_reason?: string | null
          name: string
          raci_scope?: string | null
          schema_fingerprint?: string | null
          slug: string
          source_connection_id?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          avatar_emoji?: string | null
          capabilities?: string[]
          config?: Json
          created_at?: string
          created_by?: string | null
          description?: string | null
          domain?: string
          id?: string
          is_custom?: boolean
          last_regenerated_at?: string | null
          lifecycle_reason?: string | null
          name?: string
          raci_scope?: string | null
          schema_fingerprint?: string | null
          slug?: string
          source_connection_id?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agents_source_connection_id_fkey"
            columns: ["source_connection_id"]
            isOneToOne: false
            referencedRelation: "api_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      anomaly_insights: {
        Row: {
          confidence_score: number | null
          connection_id: string | null
          context: Json
          created_at: string
          description: string | null
          detected_at: string
          detection_key: string | null
          dismissed_at: string | null
          dismissed_by: string | null
          id: string
          insight_category: string | null
          metric_name: string | null
          metric_previous_value: number | null
          metric_value: number | null
          resolved_at: string | null
          severity: string
          signal_type: string
          status: string
          tenant_id: string
          title: string
          updated_at: string
        }
        Insert: {
          confidence_score?: number | null
          connection_id?: string | null
          context?: Json
          created_at?: string
          description?: string | null
          detected_at?: string
          detection_key?: string | null
          dismissed_at?: string | null
          dismissed_by?: string | null
          id?: string
          insight_category?: string | null
          metric_name?: string | null
          metric_previous_value?: number | null
          metric_value?: number | null
          resolved_at?: string | null
          severity?: string
          signal_type?: string
          status?: string
          tenant_id: string
          title: string
          updated_at?: string
        }
        Update: {
          confidence_score?: number | null
          connection_id?: string | null
          context?: Json
          created_at?: string
          description?: string | null
          detected_at?: string
          detection_key?: string | null
          dismissed_at?: string | null
          dismissed_by?: string | null
          id?: string
          insight_category?: string | null
          metric_name?: string | null
          metric_previous_value?: number | null
          metric_value?: number | null
          resolved_at?: string | null
          severity?: string
          signal_type?: string
          status?: string
          tenant_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "anomaly_insights_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "api_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "anomaly_insights_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "anomaly_insights_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      anomaly_metric_points: {
        Row: {
          actual_value: number | null
          created_at: string
          expected_value: number | null
          forecast_value: number | null
          id: string
          insight_id: string
          is_anomaly: boolean
          lower_band: number | null
          observed_on: string
          tenant_id: string
          upper_band: number | null
        }
        Insert: {
          actual_value?: number | null
          created_at?: string
          expected_value?: number | null
          forecast_value?: number | null
          id?: string
          insight_id: string
          is_anomaly?: boolean
          lower_band?: number | null
          observed_on: string
          tenant_id: string
          upper_band?: number | null
        }
        Update: {
          actual_value?: number | null
          created_at?: string
          expected_value?: number | null
          forecast_value?: number | null
          id?: string
          insight_id?: string
          is_anomaly?: boolean
          lower_band?: number | null
          observed_on?: string
          tenant_id?: string
          upper_band?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "anomaly_metric_points_insight_id_fkey"
            columns: ["insight_id"]
            isOneToOne: false
            referencedRelation: "anomaly_insights"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "anomaly_metric_points_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "anomaly_metric_points_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      anomaly_recommended_actions: {
        Row: {
          action_type: string
          created_at: string
          id: string
          insight_id: string
          prompt: string
          sort_order: number
          tenant_id: string
          title: string
        }
        Insert: {
          action_type?: string
          created_at?: string
          id?: string
          insight_id: string
          prompt: string
          sort_order?: number
          tenant_id: string
          title: string
        }
        Update: {
          action_type?: string
          created_at?: string
          id?: string
          insight_id?: string
          prompt?: string
          sort_order?: number
          tenant_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "anomaly_recommended_actions_insight_id_fkey"
            columns: ["insight_id"]
            isOneToOne: false
            referencedRelation: "anomaly_insights"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "anomaly_recommended_actions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "anomaly_recommended_actions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      anomaly_root_causes: {
        Row: {
          created_at: string
          details: string | null
          factor_name: string
          id: string
          impact_pct: number
          insight_id: string
          sort_order: number
          tenant_id: string
        }
        Insert: {
          created_at?: string
          details?: string | null
          factor_name: string
          id?: string
          impact_pct: number
          insight_id: string
          sort_order?: number
          tenant_id: string
        }
        Update: {
          created_at?: string
          details?: string | null
          factor_name?: string
          id?: string
          impact_pct?: number
          insight_id?: string
          sort_order?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "anomaly_root_causes_insight_id_fkey"
            columns: ["insight_id"]
            isOneToOne: false
            referencedRelation: "anomaly_insights"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "anomaly_root_causes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "anomaly_root_causes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      anomaly_similar_events: {
        Row: {
          created_at: string
          details: string | null
          detected_at: string
          deviation_pct: number | null
          id: string
          insight_id: string | null
          severity: string
          tenant_id: string
          title: string
        }
        Insert: {
          created_at?: string
          details?: string | null
          detected_at: string
          deviation_pct?: number | null
          id?: string
          insight_id?: string | null
          severity?: string
          tenant_id: string
          title: string
        }
        Update: {
          created_at?: string
          details?: string | null
          detected_at?: string
          deviation_pct?: number | null
          id?: string
          insight_id?: string | null
          severity?: string
          tenant_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "anomaly_similar_events_insight_id_fkey"
            columns: ["insight_id"]
            isOneToOne: false
            referencedRelation: "anomaly_insights"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "anomaly_similar_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "anomaly_similar_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      api_connections: {
        Row: {
          analysis_completed_at: string | null
          analysis_started_at: string | null
          auth_type: string
          base_url: string | null
          connection_config: Json
          created_at: string
          embedding_coverage: number
          embeddings_indexed: number
          health: string
          id: string
          is_archived: boolean
          last_error: string | null
          last_synced_at: string | null
          name: string
          next_sync_at: string | null
          queries_today: number
          schema_detected: boolean
          schema_entities_count: number
          schema_tables_count: number
          status: string
          sync_frequency: string
          sync_lag_seconds: number
          tenant_id: string
          type: string
          updated_at: string
        }
        Insert: {
          analysis_completed_at?: string | null
          analysis_started_at?: string | null
          auth_type?: string
          base_url?: string | null
          connection_config?: Json
          created_at?: string
          embedding_coverage?: number
          embeddings_indexed?: number
          health?: string
          id?: string
          is_archived?: boolean
          last_error?: string | null
          last_synced_at?: string | null
          name: string
          next_sync_at?: string | null
          queries_today?: number
          schema_detected?: boolean
          schema_entities_count?: number
          schema_tables_count?: number
          status?: string
          sync_frequency?: string
          sync_lag_seconds?: number
          tenant_id: string
          type: string
          updated_at?: string
        }
        Update: {
          analysis_completed_at?: string | null
          analysis_started_at?: string | null
          auth_type?: string
          base_url?: string | null
          connection_config?: Json
          created_at?: string
          embedding_coverage?: number
          embeddings_indexed?: number
          health?: string
          id?: string
          is_archived?: boolean
          last_error?: string | null
          last_synced_at?: string | null
          name?: string
          next_sync_at?: string | null
          queries_today?: number
          schema_detected?: boolean
          schema_entities_count?: number
          schema_tables_count?: number
          status?: string
          sync_frequency?: string
          sync_lag_seconds?: number
          tenant_id?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_connections_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_connections_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      api_key_usage_events: {
        Row: {
          api_key_id: string
          created_at: string
          endpoint: string
          id: string
          metadata: Json
          method: string
          response_status: number | null
          tenant_id: string
        }
        Insert: {
          api_key_id: string
          created_at?: string
          endpoint: string
          id?: string
          metadata?: Json
          method: string
          response_status?: number | null
          tenant_id: string
        }
        Update: {
          api_key_id?: string
          created_at?: string
          endpoint?: string
          id?: string
          metadata?: Json
          method?: string
          response_status?: number | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_key_usage_events_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_key_usage_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_key_usage_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      api_keys: {
        Row: {
          created_at: string
          created_by: string | null
          environment: string
          expires_at: string | null
          id: string
          key_hash: string
          key_prefix: string
          last_used_at: string | null
          name: string
          revoked_at: string | null
          scopes: string[]
          tenant_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          environment?: string
          expires_at?: string | null
          id?: string
          key_hash: string
          key_prefix: string
          last_used_at?: string | null
          name: string
          revoked_at?: string | null
          scopes?: string[]
          tenant_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          environment?: string
          expires_at?: string | null
          id?: string
          key_hash?: string
          key_prefix?: string
          last_used_at?: string | null
          name?: string
          revoked_at?: string | null
          scopes?: string[]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_keys_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      approval_execution_tokens: {
        Row: {
          approval_request_id: string
          created_at: string
          expires_at: string
          id: string
          issued_by: string | null
          metadata: Json
          revoked_at: string | null
          tenant_id: string
          token_hash: string
          token_prefix: string
          used_at: string | null
        }
        Insert: {
          approval_request_id: string
          created_at?: string
          expires_at: string
          id?: string
          issued_by?: string | null
          metadata?: Json
          revoked_at?: string | null
          tenant_id: string
          token_hash: string
          token_prefix: string
          used_at?: string | null
        }
        Update: {
          approval_request_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          issued_by?: string | null
          metadata?: Json
          revoked_at?: string | null
          tenant_id?: string
          token_hash?: string
          token_prefix?: string
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "approval_execution_tokens_approval_request_id_fkey"
            columns: ["approval_request_id"]
            isOneToOne: false
            referencedRelation: "approval_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_execution_tokens_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_execution_tokens_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      approval_request_decisions: {
        Row: {
          approval_request_id: string
          created_at: string
          decided_at: string
          decision: string
          id: string
          metadata: Json
          reason: string | null
          reviewer_user_id: string
          tenant_id: string
        }
        Insert: {
          approval_request_id: string
          created_at?: string
          decided_at?: string
          decision: string
          id?: string
          metadata?: Json
          reason?: string | null
          reviewer_user_id: string
          tenant_id: string
        }
        Update: {
          approval_request_id?: string
          created_at?: string
          decided_at?: string
          decision?: string
          id?: string
          metadata?: Json
          reason?: string | null
          reviewer_user_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "approval_request_decisions_approval_request_id_fkey"
            columns: ["approval_request_id"]
            isOneToOne: false
            referencedRelation: "approval_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_request_decisions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_request_decisions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      approval_requests: {
        Row: {
          action: string
          action_summary: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          expires_at: string
          id: string
          params: Json | null
          requested_by: string
          required_approvals: number
          resource: string
          risk_level: string | null
          simulation_preview: Json | null
          status: string
          tenant_id: string
        }
        Insert: {
          action: string
          action_summary?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          expires_at?: string
          id?: string
          params?: Json | null
          requested_by: string
          required_approvals?: number
          resource: string
          risk_level?: string | null
          simulation_preview?: Json | null
          status?: string
          tenant_id: string
        }
        Update: {
          action?: string
          action_summary?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          expires_at?: string
          id?: string
          params?: Json | null
          requested_by?: string
          required_approvals?: number
          resource?: string
          risk_level?: string | null
          simulation_preview?: Json | null
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "approval_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          created_at: string
          details: Json | null
          id: string
          resource: string
          risk_level: string | null
          status: string | null
          tenant_id: string
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          details?: Json | null
          id?: string
          resource: string
          risk_level?: string | null
          status?: string | null
          tenant_id: string
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          details?: Json | null
          id?: string
          resource?: string
          risk_level?: string | null
          status?: string | null
          tenant_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_events: {
        Row: {
          created_at: string
          error: string | null
          event_type: string
          id: string
          payload: Json
          processed_at: string | null
          provider: string
          provider_event_id: string
          status: string
          tenant_id: string | null
        }
        Insert: {
          created_at?: string
          error?: string | null
          event_type: string
          id?: string
          payload?: Json
          processed_at?: string | null
          provider?: string
          provider_event_id: string
          status?: string
          tenant_id?: string | null
        }
        Update: {
          created_at?: string
          error?: string | null
          event_type?: string
          id?: string
          payload?: Json
          processed_at?: string | null
          provider?: string
          provider_event_id?: string
          status?: string
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_plan_change_events: {
        Row: {
          billing_cycle: string
          change_type: string
          created_at: string
          due_today_cents: number
          effective_at: string
          from_plan: string
          id: string
          metadata: Json
          next_renewal_amount_cents: number | null
          payment_reference: string | null
          proration_credit_cents: number
          requested_by: string | null
          status: string
          tenant_id: string
          to_plan: string
        }
        Insert: {
          billing_cycle?: string
          change_type?: string
          created_at?: string
          due_today_cents?: number
          effective_at?: string
          from_plan: string
          id?: string
          metadata?: Json
          next_renewal_amount_cents?: number | null
          payment_reference?: string | null
          proration_credit_cents?: number
          requested_by?: string | null
          status?: string
          tenant_id: string
          to_plan: string
        }
        Update: {
          billing_cycle?: string
          change_type?: string
          created_at?: string
          due_today_cents?: number
          effective_at?: string
          from_plan?: string
          id?: string
          metadata?: Json
          next_renewal_amount_cents?: number | null
          payment_reference?: string | null
          proration_credit_cents?: number
          requested_by?: string | null
          status?: string
          tenant_id?: string
          to_plan?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_plan_change_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_plan_change_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_knowledge_runs: {
        Row: {
          confidence: string
          created_at: string
          id: string
          prompt: string
          requested_by: string
          session_id: string
          source_count: number
          sources: Json
          tenant_id: string
        }
        Insert: {
          confidence: string
          created_at?: string
          id?: string
          prompt: string
          requested_by: string
          session_id: string
          source_count?: number
          sources?: Json
          tenant_id: string
        }
        Update: {
          confidence?: string
          created_at?: string
          id?: string
          prompt?: string
          requested_by?: string
          session_id?: string
          source_count?: number
          sources?: Json
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_knowledge_runs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "chat_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_knowledge_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_knowledge_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_message_feedback: {
        Row: {
          created_at: string
          feedback: string
          id: string
          message_id: string
          session_id: string
          tenant_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          feedback: string
          id?: string
          message_id: string
          session_id: string
          tenant_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          feedback?: string
          id?: string
          message_id?: string
          session_id?: string
          tenant_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_message_feedback_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "chat_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_message_feedback_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "chat_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_message_feedback_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_message_feedback_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_messages: {
        Row: {
          content: string
          created_at: string
          id: string
          metadata: Json
          risk_level: string | null
          role: string
          session_id: string
          tool_used: string | null
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          metadata?: Json
          risk_level?: string | null
          role: string
          session_id: string
          tool_used?: string | null
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          metadata?: Json
          risk_level?: string | null
          role?: string
          session_id?: string
          tool_used?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "chat_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_sessions: {
        Row: {
          created_at: string
          id: string
          tenant_id: string
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          tenant_id: string
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          tenant_id?: string
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_sessions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_sessions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_sql_runs: {
        Row: {
          agent: string
          connection_id: string | null
          created_at: string
          error: string | null
          execution_ms: number
          explanation: string | null
          follow_ups: string[]
          id: string
          prompt: string
          requested_by: string
          result_columns: Json
          result_rows: Json
          row_count: number
          session_id: string
          sql_query: string
          success: boolean
          tenant_id: string
        }
        Insert: {
          agent?: string
          connection_id?: string | null
          created_at?: string
          error?: string | null
          execution_ms?: number
          explanation?: string | null
          follow_ups?: string[]
          id?: string
          prompt: string
          requested_by: string
          result_columns?: Json
          result_rows?: Json
          row_count?: number
          session_id: string
          sql_query: string
          success?: boolean
          tenant_id: string
        }
        Update: {
          agent?: string
          connection_id?: string | null
          created_at?: string
          error?: string | null
          execution_ms?: number
          explanation?: string | null
          follow_ups?: string[]
          id?: string
          prompt?: string
          requested_by?: string
          result_columns?: Json
          result_rows?: Json
          row_count?: number
          session_id?: string
          sql_query?: string
          success?: boolean
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_sql_runs_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "api_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_sql_runs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "chat_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_sql_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_sql_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      connection_columns: {
        Row: {
          created_at: string
          data_type: string
          entity_id: string
          id: string
          is_nullable: boolean
          name: string
          position_index: number
          sample_value: string | null
          sensitivity: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          data_type: string
          entity_id: string
          id?: string
          is_nullable?: boolean
          name: string
          position_index?: number
          sample_value?: string | null
          sensitivity?: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          data_type?: string
          entity_id?: string
          id?: string
          is_nullable?: boolean
          name?: string
          position_index?: number
          sample_value?: string | null
          sensitivity?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "connection_columns_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "connection_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connection_columns_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connection_columns_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      connection_entities: {
        Row: {
          connection_id: string
          created_at: string
          description: string | null
          embedding_coverage: number
          entity_group: string
          id: string
          metadata: Json
          name: string
          risk_level: string
          row_count: number
          sensitivity: string
          source_kind: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          connection_id: string
          created_at?: string
          description?: string | null
          embedding_coverage?: number
          entity_group?: string
          id?: string
          metadata?: Json
          name: string
          risk_level?: string
          row_count?: number
          sensitivity?: string
          source_kind?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          connection_id?: string
          created_at?: string
          description?: string | null
          embedding_coverage?: number
          entity_group?: string
          id?: string
          metadata?: Json
          name?: string
          risk_level?: string
          row_count?: number
          sensitivity?: string
          source_kind?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "connection_entities_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "api_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connection_entities_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connection_entities_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      connection_relationships: {
        Row: {
          connection_id: string
          created_at: string
          id: string
          label: string | null
          relation_type: string
          source_entity_id: string
          target_entity_id: string
          tenant_id: string
        }
        Insert: {
          connection_id: string
          created_at?: string
          id?: string
          label?: string | null
          relation_type?: string
          source_entity_id: string
          target_entity_id: string
          tenant_id: string
        }
        Update: {
          connection_id?: string
          created_at?: string
          id?: string
          label?: string | null
          relation_type?: string
          source_entity_id?: string
          target_entity_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "connection_relationships_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "api_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connection_relationships_source_entity_id_fkey"
            columns: ["source_entity_id"]
            isOneToOne: false
            referencedRelation: "connection_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connection_relationships_target_entity_id_fkey"
            columns: ["target_entity_id"]
            isOneToOne: false
            referencedRelation: "connection_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connection_relationships_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connection_relationships_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      connection_sync_runs: {
        Row: {
          connection_id: string
          details: Json
          error_message: string | null
          finished_at: string | null
          id: string
          latency_ms: number | null
          rows_indexed: number | null
          rows_scanned: number | null
          started_at: string
          status: string
          tenant_id: string
          triggered_by: string | null
        }
        Insert: {
          connection_id: string
          details?: Json
          error_message?: string | null
          finished_at?: string | null
          id?: string
          latency_ms?: number | null
          rows_indexed?: number | null
          rows_scanned?: number | null
          started_at?: string
          status?: string
          tenant_id: string
          triggered_by?: string | null
        }
        Update: {
          connection_id?: string
          details?: Json
          error_message?: string | null
          finished_at?: string | null
          id?: string
          latency_ms?: number | null
          rows_indexed?: number | null
          rows_scanned?: number | null
          started_at?: string
          status?: string
          tenant_id?: string
          triggered_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "connection_sync_runs_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "api_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connection_sync_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connection_sync_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      connector_job_attempts: {
        Row: {
          created_at: string
          details: Json
          duration_ms: number | null
          error_message: string | null
          finished_at: string | null
          id: string
          job_id: string
          started_at: string
          status: string
          tenant_id: string
          worker_id: string | null
        }
        Insert: {
          created_at?: string
          details?: Json
          duration_ms?: number | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          job_id: string
          started_at?: string
          status?: string
          tenant_id: string
          worker_id?: string | null
        }
        Update: {
          created_at?: string
          details?: Json
          duration_ms?: number | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          job_id?: string
          started_at?: string
          status?: string
          tenant_id?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "connector_job_attempts_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "connector_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connector_job_attempts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connector_job_attempts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      connector_jobs: {
        Row: {
          attempt_count: number
          connection_id: string
          created_at: string
          finished_at: string | null
          id: string
          idempotency_key: string | null
          job_type: string
          last_error: string | null
          max_attempts: number
          payload: Json
          priority: number
          progress: number
          queue: string
          result: Json
          scheduled_at: string
          started_at: string | null
          status: string
          tenant_id: string
          trigger_reason: string
          triggered_by: string | null
          updated_at: string
          worker_id: string | null
        }
        Insert: {
          attempt_count?: number
          connection_id: string
          created_at?: string
          finished_at?: string | null
          id?: string
          idempotency_key?: string | null
          job_type?: string
          last_error?: string | null
          max_attempts?: number
          payload?: Json
          priority?: number
          progress?: number
          queue?: string
          result?: Json
          scheduled_at?: string
          started_at?: string | null
          status?: string
          tenant_id: string
          trigger_reason?: string
          triggered_by?: string | null
          updated_at?: string
          worker_id?: string | null
        }
        Update: {
          attempt_count?: number
          connection_id?: string
          created_at?: string
          finished_at?: string | null
          id?: string
          idempotency_key?: string | null
          job_type?: string
          last_error?: string | null
          max_attempts?: number
          payload?: Json
          priority?: number
          progress?: number
          queue?: string
          result?: Json
          scheduled_at?: string
          started_at?: string | null
          status?: string
          tenant_id?: string
          trigger_reason?: string
          triggered_by?: string | null
          updated_at?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "connector_jobs_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "api_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connector_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "connector_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      credential_rotations: {
        Row: {
          created_at: string
          credential_id: string
          details: Json
          error: string | null
          expires_at: string | null
          id: string
          rotated_by: string | null
          rotation_type: string
          status: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          credential_id: string
          details?: Json
          error?: string | null
          expires_at?: string | null
          id?: string
          rotated_by?: string | null
          rotation_type?: string
          status?: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          credential_id?: string
          details?: Json
          error?: string | null
          expires_at?: string | null
          id?: string
          rotated_by?: string | null
          rotation_type?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "credential_rotations_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "integration_credentials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credential_rotations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credential_rotations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      credit_ledger: {
        Row: {
          balance_after: number | null
          created_at: string
          created_by: string | null
          credits_delta: number
          details: Json
          id: string
          ledger_type: string
          reservation_key: string
          run_id: string | null
          tenant_id: string
        }
        Insert: {
          balance_after?: number | null
          created_at?: string
          created_by?: string | null
          credits_delta: number
          details?: Json
          id?: string
          ledger_type: string
          reservation_key?: string
          run_id?: string | null
          tenant_id: string
        }
        Update: {
          balance_after?: number | null
          created_at?: string
          created_by?: string | null
          credits_delta?: number
          details?: Json
          id?: string
          ledger_type?: string
          reservation_key?: string
          run_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "credit_ledger_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_ledger_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_ledger_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      custom_agent_specs: {
        Row: {
          agent_id: string
          auto_deploy: boolean
          auto_sync: boolean
          created_at: string
          created_by: string | null
          deployment_notes: string | null
          deployment_status: string
          embedding_model: string
          id: string
          objective: string | null
          orchestrator_model: string
          prompt: string
          rag_enabled: boolean
          source_connection_ids: string[]
          sync_frequency: string
          system_prompt: string | null
          tenant_id: string
          updated_at: string
          vector_index: string
          vector_strategy: string
        }
        Insert: {
          agent_id: string
          auto_deploy?: boolean
          auto_sync?: boolean
          created_at?: string
          created_by?: string | null
          deployment_notes?: string | null
          deployment_status?: string
          embedding_model?: string
          id?: string
          objective?: string | null
          orchestrator_model?: string
          prompt?: string
          rag_enabled?: boolean
          source_connection_ids?: string[]
          sync_frequency?: string
          system_prompt?: string | null
          tenant_id: string
          updated_at?: string
          vector_index?: string
          vector_strategy?: string
        }
        Update: {
          agent_id?: string
          auto_deploy?: boolean
          auto_sync?: boolean
          created_at?: string
          created_by?: string | null
          deployment_notes?: string | null
          deployment_status?: string
          embedding_model?: string
          id?: string
          objective?: string | null
          orchestrator_model?: string
          prompt?: string
          rag_enabled?: boolean
          source_connection_ids?: string[]
          sync_frequency?: string
          system_prompt?: string | null
          tenant_id?: string
          updated_at?: string
          vector_index?: string
          vector_strategy?: string
        }
        Relationships: [
          {
            foreignKeyName: "custom_agent_specs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: true
            referencedRelation: "agents_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "custom_agent_specs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: true
            referencedRelation: "ai_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "custom_agent_specs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "custom_agent_specs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      embedding_jobs: {
        Row: {
          attempt_count: number
          created_at: string
          created_by: string | null
          embedding_model: string
          finished_at: string | null
          id: string
          idempotency_key: string | null
          last_error: string | null
          max_attempts: number
          payload: Json
          priority: number
          result: Json
          scheduled_at: string
          source_id: string
          source_type: string
          started_at: string | null
          status: string
          tenant_id: string
          token_estimate: number | null
          updated_at: string
          vector_dimensions: number
          worker_id: string | null
        }
        Insert: {
          attempt_count?: number
          created_at?: string
          created_by?: string | null
          embedding_model?: string
          finished_at?: string | null
          id?: string
          idempotency_key?: string | null
          last_error?: string | null
          max_attempts?: number
          payload?: Json
          priority?: number
          result?: Json
          scheduled_at?: string
          source_id: string
          source_type: string
          started_at?: string | null
          status?: string
          tenant_id: string
          token_estimate?: number | null
          updated_at?: string
          vector_dimensions?: number
          worker_id?: string | null
        }
        Update: {
          attempt_count?: number
          created_at?: string
          created_by?: string | null
          embedding_model?: string
          finished_at?: string | null
          id?: string
          idempotency_key?: string | null
          last_error?: string | null
          max_attempts?: number
          payload?: Json
          priority?: number
          result?: Json
          scheduled_at?: string
          source_id?: string
          source_type?: string
          started_at?: string | null
          status?: string
          tenant_id?: string
          token_estimate?: number | null
          updated_at?: string
          vector_dimensions?: number
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "embedding_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "embedding_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      guardrails: {
        Row: {
          code: string
          config: Json
          created_at: string
          created_by: string | null
          description: string | null
          enabled: boolean
          id: string
          name: string
          risk_level: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          code: string
          config?: Json
          created_at?: string
          created_by?: string | null
          description?: string | null
          enabled?: boolean
          id?: string
          name: string
          risk_level?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          code?: string
          config?: Json
          created_at?: string
          created_by?: string | null
          description?: string | null
          enabled?: boolean
          id?: string
          name?: string
          risk_level?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "guardrails_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guardrails_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_catalog: {
        Row: {
          access_tier: string
          category: string
          code: string
          config_schema: Json
          connection_type: string
          created_at: string
          display_name: string
          docs_url: string | null
          featured: boolean
          id: string
          installed_count: number
          is_active: boolean
          logo_url: string | null
          rating: number
          reviews_count: number
          summary: string | null
          supported_auth: string[]
          updated_at: string
        }
        Insert: {
          access_tier?: string
          category: string
          code: string
          config_schema?: Json
          connection_type?: string
          created_at?: string
          display_name: string
          docs_url?: string | null
          featured?: boolean
          id?: string
          installed_count?: number
          is_active?: boolean
          logo_url?: string | null
          rating?: number
          reviews_count?: number
          summary?: string | null
          supported_auth?: string[]
          updated_at?: string
        }
        Update: {
          access_tier?: string
          category?: string
          code?: string
          config_schema?: Json
          connection_type?: string
          created_at?: string
          display_name?: string
          docs_url?: string | null
          featured?: boolean
          id?: string
          installed_count?: number
          is_active?: boolean
          logo_url?: string | null
          rating?: number
          reviews_count?: number
          summary?: string | null
          supported_auth?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      integration_credentials: {
        Row: {
          algorithm: string
          auth_tag: string | null
          ciphertext: string
          created_at: string
          created_by: string | null
          credential_ref: string | null
          expires_at: string | null
          id: string
          iv: string
          key_version: string
          label: string
          metadata: Json
          service: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          algorithm?: string
          auth_tag?: string | null
          ciphertext: string
          created_at?: string
          created_by?: string | null
          credential_ref?: string | null
          expires_at?: string | null
          id?: string
          iv: string
          key_version?: string
          label?: string
          metadata?: Json
          service: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          algorithm?: string
          auth_tag?: string | null
          ciphertext?: string
          created_at?: string
          created_by?: string | null
          credential_ref?: string | null
          expires_at?: string | null
          id?: string
          iv?: string
          key_version?: string
          label?: string
          metadata?: Json
          service?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "integration_credentials_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "integration_credentials_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_snapshots: {
        Row: {
          amount_due_cents: number
          amount_paid_cents: number
          created_at: string
          currency: string
          due_at: string | null
          hosted_invoice_url: string | null
          id: string
          invoice_status: string
          invoice_url: string | null
          metadata: Json
          paid_at: string | null
          period_end: string | null
          period_start: string | null
          provider: string
          provider_invoice_id: string
          provider_subscription_id: string | null
          subtotal_cents: number
          tax_cents: number
          tenant_id: string
          total_cents: number
          updated_at: string
        }
        Insert: {
          amount_due_cents?: number
          amount_paid_cents?: number
          created_at?: string
          currency?: string
          due_at?: string | null
          hosted_invoice_url?: string | null
          id?: string
          invoice_status?: string
          invoice_url?: string | null
          metadata?: Json
          paid_at?: string | null
          period_end?: string | null
          period_start?: string | null
          provider?: string
          provider_invoice_id: string
          provider_subscription_id?: string | null
          subtotal_cents?: number
          tax_cents?: number
          tenant_id: string
          total_cents?: number
          updated_at?: string
        }
        Update: {
          amount_due_cents?: number
          amount_paid_cents?: number
          created_at?: string
          currency?: string
          due_at?: string | null
          hosted_invoice_url?: string | null
          id?: string
          invoice_status?: string
          invoice_url?: string | null
          metadata?: Json
          paid_at?: string | null
          period_end?: string | null
          period_start?: string | null
          provider?: string
          provider_invoice_id?: string
          provider_subscription_id?: string | null
          subtotal_cents?: number
          tax_cents?: number
          tenant_id?: string
          total_cents?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_snapshots_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_snapshots_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_document_chunks: {
        Row: {
          chunk_index: number
          content: string
          content_hash: string | null
          content_tsv: unknown
          created_at: string
          document_id: string
          embedded_at: string | null
          embedding: string | null
          embedding_model: string | null
          embedding_state: string
          id: string
          tenant_id: string
          token_count: number
          updated_at: string
        }
        Insert: {
          chunk_index?: number
          content: string
          content_hash?: string | null
          content_tsv?: unknown
          created_at?: string
          document_id: string
          embedded_at?: string | null
          embedding?: string | null
          embedding_model?: string | null
          embedding_state?: string
          id?: string
          tenant_id: string
          token_count?: number
          updated_at?: string
        }
        Update: {
          chunk_index?: number
          content?: string
          content_hash?: string | null
          content_tsv?: unknown
          created_at?: string
          document_id?: string
          embedded_at?: string | null
          embedding?: string | null
          embedding_model?: string | null
          embedding_state?: string
          id?: string
          tenant_id?: string
          token_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_document_chunks_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_document_chunks_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "knowledge_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_document_chunks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_document_chunks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_documents: {
        Row: {
          created_at: string
          excerpt: string | null
          external_url: string | null
          file_name: string
          file_type: string
          id: string
          indexed_at: string | null
          source_type: string
          status: string
          storage_path: string | null
          tenant_id: string
          title: string
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string
          excerpt?: string | null
          external_url?: string | null
          file_name: string
          file_type: string
          id?: string
          indexed_at?: string | null
          source_type?: string
          status?: string
          storage_path?: string | null
          tenant_id: string
          title: string
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string
          excerpt?: string | null
          external_url?: string | null
          file_name?: string
          file_type?: string
          id?: string
          indexed_at?: string | null
          source_type?: string
          status?: string
          storage_path?: string | null
          tenant_id?: string
          title?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_documents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_documents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_channel_settings: {
        Row: {
          created_at: string
          email_address: string | null
          email_enabled: boolean
          in_app_enabled: boolean
          slack_channel: string | null
          slack_enabled: boolean
          slack_workspace: string | null
          tenant_id: string
          updated_at: string
          webhook_enabled: boolean
          webhook_secret: string | null
          webhook_url: string | null
        }
        Insert: {
          created_at?: string
          email_address?: string | null
          email_enabled?: boolean
          in_app_enabled?: boolean
          slack_channel?: string | null
          slack_enabled?: boolean
          slack_workspace?: string | null
          tenant_id: string
          updated_at?: string
          webhook_enabled?: boolean
          webhook_secret?: string | null
          webhook_url?: string | null
        }
        Update: {
          created_at?: string
          email_address?: string | null
          email_enabled?: boolean
          in_app_enabled?: boolean
          slack_channel?: string | null
          slack_enabled?: boolean
          slack_workspace?: string | null
          tenant_id?: string
          updated_at?: string
          webhook_enabled?: boolean
          webhook_secret?: string | null
          webhook_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notification_channel_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_channel_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_digest_settings: {
        Row: {
          created_at: string
          daily_digest_enabled: boolean
          daily_digest_time: string
          tenant_id: string
          timezone: string
          updated_at: string
          weekly_report_day: number
          weekly_report_enabled: boolean
        }
        Insert: {
          created_at?: string
          daily_digest_enabled?: boolean
          daily_digest_time?: string
          tenant_id: string
          timezone?: string
          updated_at?: string
          weekly_report_day?: number
          weekly_report_enabled?: boolean
        }
        Update: {
          created_at?: string
          daily_digest_enabled?: boolean
          daily_digest_time?: string
          tenant_id?: string
          timezone?: string
          updated_at?: string
          weekly_report_day?: number
          weekly_report_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "notification_digest_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_digest_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_type_preferences: {
        Row: {
          created_at: string
          email: boolean
          event_key: string
          event_name: string
          in_app: boolean
          slack: boolean
          sort_order: number
          tenant_id: string
          updated_at: string
          webhook: boolean
        }
        Insert: {
          created_at?: string
          email?: boolean
          event_key: string
          event_name: string
          in_app?: boolean
          slack?: boolean
          sort_order?: number
          tenant_id: string
          updated_at?: string
          webhook?: boolean
        }
        Update: {
          created_at?: string
          email?: boolean
          event_key?: string
          event_name?: string
          in_app?: boolean
          slack?: boolean
          sort_order?: number
          tenant_id?: string
          updated_at?: string
          webhook?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "notification_type_preferences_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_type_preferences_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          id: string
          is_read: boolean
          kind: string
          link: string | null
          metadata: Json
          read_at: string | null
          tenant_id: string
          title: string
          user_id: string | null
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          is_read?: boolean
          kind?: string
          link?: string | null
          metadata?: Json
          read_at?: string | null
          tenant_id: string
          title: string
          user_id?: string | null
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          is_read?: boolean
          kind?: string
          link?: string | null
          metadata?: Json
          read_at?: string | null
          tenant_id?: string
          title?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notifications_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_admin_users: {
        Row: {
          created_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          user_id?: string
        }
        Relationships: []
      }
      platform_infra_incidents: {
        Row: {
          affected_services: string[]
          created_at: string
          created_by: string | null
          description: string
          duration_minutes: number | null
          id: string
          metadata: Json
          resolution: string | null
          resolved_at: string | null
          severity: string
          started_at: string
          status: string
          updated_at: string
        }
        Insert: {
          affected_services?: string[]
          created_at?: string
          created_by?: string | null
          description: string
          duration_minutes?: number | null
          id?: string
          metadata?: Json
          resolution?: string | null
          resolved_at?: string | null
          severity?: string
          started_at?: string
          status?: string
          updated_at?: string
        }
        Update: {
          affected_services?: string[]
          created_at?: string
          created_by?: string | null
          description?: string
          duration_minutes?: number | null
          id?: string
          metadata?: Json
          resolution?: string | null
          resolved_at?: string | null
          severity?: string
          started_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      pricing_comparison_rows: {
        Row: {
          business_value: string
          category: string
          created_at: string
          enterprise_value: string
          feature_key: string
          feature_name: string
          id: string
          pro_value: string
          sort_order: number
          starter_value: string
        }
        Insert: {
          business_value: string
          category: string
          created_at?: string
          enterprise_value: string
          feature_key: string
          feature_name: string
          id?: string
          pro_value: string
          sort_order?: number
          starter_value: string
        }
        Update: {
          business_value?: string
          category?: string
          created_at?: string
          enterprise_value?: string
          feature_key?: string
          feature_name?: string
          id?: string
          pro_value?: string
          sort_order?: number
          starter_value?: string
        }
        Relationships: []
      }
      pricing_faq_items: {
        Row: {
          answer: string
          created_at: string
          id: string
          is_active: boolean
          question: string
          sort_order: number
        }
        Insert: {
          answer: string
          created_at?: string
          id?: string
          is_active?: boolean
          question: string
          sort_order?: number
        }
        Update: {
          answer?: string
          created_at?: string
          id?: string
          is_active?: boolean
          question?: string
          sort_order?: number
        }
        Relationships: []
      }
      pricing_plan_features: {
        Row: {
          created_at: string
          feature_text: string
          id: string
          plan_code: string
          sort_order: number
        }
        Insert: {
          created_at?: string
          feature_text: string
          id?: string
          plan_code: string
          sort_order?: number
        }
        Update: {
          created_at?: string
          feature_text?: string
          id?: string
          plan_code?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "pricing_plan_features_plan_code_fkey"
            columns: ["plan_code"]
            isOneToOne: false
            referencedRelation: "pricing_plans"
            referencedColumns: ["code"]
          },
        ]
      }
      pricing_plans: {
        Row: {
          annual_price_cents: number | null
          badge: string | null
          badge_tone: string
          code: string
          created_at: string
          cta_label: string
          cta_variant: string
          description: string | null
          highlighted: boolean
          id: string
          monthly_price_cents: number | null
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          annual_price_cents?: number | null
          badge?: string | null
          badge_tone?: string
          code: string
          created_at?: string
          cta_label: string
          cta_variant?: string
          description?: string | null
          highlighted?: boolean
          id?: string
          monthly_price_cents?: number | null
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          annual_price_cents?: number | null
          badge?: string | null
          badge_tone?: string
          code?: string
          created_at?: string
          cta_label?: string
          cta_variant?: string
          description?: string | null
          highlighted?: boolean
          id?: string
          monthly_price_cents?: number | null
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          full_name: string | null
          id: string
          last_active_at: string
          role: string
          status: string
          tenant_id: string | null
          terms_accepted_at: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          last_active_at?: string
          role?: string
          status?: string
          tenant_id?: string | null
          terms_accepted_at?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          last_active_at?: string
          role?: string
          status?: string
          tenant_id?: string | null
          terms_accepted_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      raci_matrix: {
        Row: {
          action: string
          id: string
          raci_type: string
          resource: string
          role_name: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          action: string
          id?: string
          raci_type: string
          resource: string
          role_name: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          action?: string
          id?: string
          raci_type?: string
          resource?: string
          role_name?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "raci_matrix_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raci_matrix_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      raci_resources: {
        Row: {
          action: string
          category: string
          created_at: string
          display_order: number
          id: string
          resource_key: string
          resource_label: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          action?: string
          category?: string
          created_at?: string
          display_order?: number
          id?: string
          resource_key: string
          resource_label: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          action?: string
          category?: string
          created_at?: string
          display_order?: number
          id?: string
          resource_key?: string
          resource_label?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "raci_resources_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raci_resources_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      raci_role_members: {
        Row: {
          created_at: string
          id: string
          profile_id: string
          role_id: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          profile_id: string
          role_id: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          profile_id?: string
          role_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "raci_role_members_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raci_role_members_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "users_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raci_role_members_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "raci_roles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raci_role_members_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raci_role_members_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      raci_roles: {
        Row: {
          created_at: string
          description: string | null
          display_name: string
          display_order: number
          icon: string
          id: string
          name: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          display_name: string
          display_order?: number
          icon?: string
          id?: string
          name: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          display_name?: string
          display_order?: number
          icon?: string
          id?: string
          name?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "raci_roles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raci_roles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      retrieval_eval_runs: {
        Row: {
          created_at: string
          created_by: string | null
          expected_source_ids: string[]
          id: string
          metrics: Json
          query: string
          retrieved_source_ids: string[]
          tenant_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expected_source_ids?: string[]
          id?: string
          metrics?: Json
          query: string
          retrieved_source_ids?: string[]
          tenant_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expected_source_ids?: string[]
          id?: string
          metrics?: Json
          query?: string
          retrieved_source_ids?: string[]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "retrieval_eval_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "retrieval_eval_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      risk_matrix_rules: {
        Row: {
          action: string
          created_at: string
          created_by: string | null
          enabled: boolean
          id: string
          overridden_at: string | null
          overridden_by: string | null
          override_justification: string | null
          override_risk_level: string | null
          policy: string
          raci_required: string
          requires_2fa: boolean
          requires_dual_approval: boolean
          resource: string
          risk_level: string
          source_guardrail_code: string | null
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          action: string
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          id?: string
          overridden_at?: string | null
          overridden_by?: string | null
          override_justification?: string | null
          override_risk_level?: string | null
          policy?: string
          raci_required?: string
          requires_2fa?: boolean
          requires_dual_approval?: boolean
          resource: string
          risk_level?: string
          source_guardrail_code?: string | null
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          id?: string
          overridden_at?: string | null
          overridden_by?: string | null
          override_justification?: string | null
          override_risk_level?: string | null
          policy?: string
          raci_required?: string
          requires_2fa?: boolean
          requires_dual_approval?: boolean
          resource?: string
          risk_level?: string
          source_guardrail_code?: string | null
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "risk_matrix_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "risk_matrix_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      risk_rule_override_history: {
        Row: {
          created_at: string
          id: string
          justification: string
          overridden_by: string | null
          override_risk_level: string
          previous_risk_level: string
          risk_rule_id: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          justification: string
          overridden_by?: string | null
          override_risk_level: string
          previous_risk_level: string
          risk_rule_id: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          justification?: string
          overridden_by?: string | null
          override_risk_level?: string
          previous_risk_level?: string
          risk_rule_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "risk_rule_override_history_risk_rule_id_fkey"
            columns: ["risk_rule_id"]
            isOneToOne: false
            referencedRelation: "risk_matrix_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "risk_rule_override_history_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "risk_rule_override_history_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          billing_cycle: string | null
          current_period_end: string | null
          current_period_start: string | null
          id: string
          plan: string
          status: string
          stripe_subscription_id: string | null
          tenant_id: string
          trial_ends_at: string | null
        }
        Insert: {
          billing_cycle?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          plan?: string
          status?: string
          stripe_subscription_id?: string | null
          tenant_id: string
          trial_ends_at?: string | null
        }
        Update: {
          billing_cycle?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          plan?: string
          status?: string
          stripe_subscription_id?: string | null
          tenant_id?: string
          trial_ends_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      team_invitations: {
        Row: {
          accepted_at: string | null
          created_at: string
          custom_message: string | null
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          role: string
          sent_at: string
          status: string
          tenant_id: string
          token: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          custom_message?: string | null
          email: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          role: string
          sent_at?: string
          status?: string
          tenant_id: string
          token: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          custom_message?: string | null
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          role?: string
          sent_at?: string
          status?: string
          tenant_id?: string
          token?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_invitations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_invitations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_admin_report_settings: {
        Row: {
          created_at: string
          report_day_of_week: number
          report_timezone: string
          tenant_id: string
          updated_at: string
          weekly_email_report_enabled: boolean
        }
        Insert: {
          created_at?: string
          report_day_of_week?: number
          report_timezone?: string
          tenant_id: string
          updated_at?: string
          weekly_email_report_enabled?: boolean
        }
        Update: {
          created_at?: string
          report_day_of_week?: number
          report_timezone?: string
          tenant_id?: string
          updated_at?: string
          weekly_email_report_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "tenant_admin_report_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_admin_report_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_billing_profiles: {
        Row: {
          address_line_1: string | null
          address_line_2: string | null
          city: string | null
          company_name: string | null
          country_code: string
          created_at: string
          id: string
          postal_code: string | null
          state_region: string | null
          tax_number: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          address_line_1?: string | null
          address_line_2?: string | null
          city?: string | null
          company_name?: string | null
          country_code?: string
          created_at?: string
          id?: string
          postal_code?: string | null
          state_region?: string | null
          tax_number?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          address_line_1?: string | null
          address_line_2?: string | null
          city?: string | null
          company_name?: string | null
          country_code?: string
          created_at?: string
          id?: string
          postal_code?: string | null
          state_region?: string | null
          tax_number?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_billing_profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_billing_profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_entitlements: {
        Row: {
          capability: string
          created_at: string
          current_usage: number
          hard_limit: number | null
          id: string
          metadata: Json
          reset_at: string | null
          reset_period: string
          soft_limit: number | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          capability: string
          created_at?: string
          current_usage?: number
          hard_limit?: number | null
          id?: string
          metadata?: Json
          reset_at?: string | null
          reset_period?: string
          soft_limit?: number | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          capability?: string
          created_at?: string
          current_usage?: number
          hard_limit?: number | null
          id?: string
          metadata?: Json
          reset_at?: string | null
          reset_period?: string
          soft_limit?: number | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_entitlements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_entitlements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_integration_installs: {
        Row: {
          active_queries_today: number
          config: Json
          created_at: string
          id: string
          installed_at: string
          installed_by: string | null
          integration_id: string
          last_synced_at: string | null
          status: string
          tenant_id: string
          uninstalled_at: string | null
          updated_at: string
        }
        Insert: {
          active_queries_today?: number
          config?: Json
          created_at?: string
          id?: string
          installed_at?: string
          installed_by?: string | null
          integration_id: string
          last_synced_at?: string | null
          status?: string
          tenant_id: string
          uninstalled_at?: string | null
          updated_at?: string
        }
        Update: {
          active_queries_today?: number
          config?: Json
          created_at?: string
          id?: string
          installed_at?: string
          installed_by?: string | null
          integration_id?: string
          last_synced_at?: string | null
          status?: string
          tenant_id?: string
          uninstalled_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_integration_installs_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integration_catalog"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_integration_installs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_integration_installs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_payment_methods: {
        Row: {
          card_brand: string | null
          card_exp_month: number | null
          card_exp_year: number | null
          card_last4: string | null
          created_at: string
          id: string
          is_default: boolean
          metadata: Json
          method_type: string
          provider: string
          provider_payment_method_id: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          card_brand?: string | null
          card_exp_month?: number | null
          card_exp_year?: number | null
          card_last4?: string | null
          created_at?: string
          id?: string
          is_default?: boolean
          metadata?: Json
          method_type?: string
          provider?: string
          provider_payment_method_id?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          card_brand?: string | null
          card_exp_month?: number | null
          card_exp_year?: number | null
          card_last4?: string | null
          created_at?: string
          id?: string
          is_default?: boolean
          metadata?: Json
          method_type?: string
          provider?: string
          provider_payment_method_id?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_payment_methods_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_payment_methods_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          activated_at: string | null
          company_size: string | null
          created_at: string
          credits_balance: number
          credits_last_reset_at: string
          credits_used_total: number
          id: string
          industry: string | null
          logo_url: string | null
          name: string
          onboarding_completed_at: string | null
          onboarding_step: number
          plan: string
          primary_use_case: string | null
          region: string
          slug: string
          status: string
          stripe_customer_id: string | null
          updated_at: string
        }
        Insert: {
          activated_at?: string | null
          company_size?: string | null
          created_at?: string
          credits_balance?: number
          credits_last_reset_at?: string
          credits_used_total?: number
          id?: string
          industry?: string | null
          logo_url?: string | null
          name: string
          onboarding_completed_at?: string | null
          onboarding_step?: number
          plan?: string
          primary_use_case?: string | null
          region?: string
          slug: string
          status?: string
          stripe_customer_id?: string | null
          updated_at?: string
        }
        Update: {
          activated_at?: string | null
          company_size?: string | null
          created_at?: string
          credits_balance?: number
          credits_last_reset_at?: string
          credits_used_total?: number
          id?: string
          industry?: string | null
          logo_url?: string | null
          name?: string
          onboarding_completed_at?: string | null
          onboarding_step?: number
          plan?: string
          primary_use_case?: string | null
          region?: string
          slug?: string
          status?: string
          stripe_customer_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      tool_registry: {
        Row: {
          category: string
          code: string
          created_at: string
          default_config: Json
          description: string | null
          display_name: string
          handler_key: string
          id: string
          input_schema: Json
          is_active: boolean
          is_write_action: boolean
          raci_required: string
          requires_credential_service: string | null
          risk_level: string
          tenant_id: string | null
          updated_at: string
          version: string
        }
        Insert: {
          category?: string
          code: string
          created_at?: string
          default_config?: Json
          description?: string | null
          display_name: string
          handler_key: string
          id?: string
          input_schema?: Json
          is_active?: boolean
          is_write_action?: boolean
          raci_required?: string
          requires_credential_service?: string | null
          risk_level?: string
          tenant_id?: string | null
          updated_at?: string
          version?: string
        }
        Update: {
          category?: string
          code?: string
          created_at?: string
          default_config?: Json
          description?: string | null
          display_name?: string
          handler_key?: string
          id?: string
          input_schema?: Json
          is_active?: boolean
          is_write_action?: boolean
          raci_required?: string
          requires_credential_service?: string | null
          risk_level?: string
          tenant_id?: string | null
          updated_at?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "tool_registry_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tool_registry_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_events: {
        Row: {
          id: string
          metric_type: string
          quantity: number
          recorded_at: string
          tenant_id: string
        }
        Insert: {
          id?: string
          metric_type: string
          quantity: number
          recorded_at?: string
          tenant_id: string
        }
        Update: {
          id?: string
          metric_type?: string
          quantity?: number
          recorded_at?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "usage_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_meter_events: {
        Row: {
          cost_credits: number
          created_at: string
          details: Json
          event_type: string
          id: string
          quantity: number
          run_id: string | null
          tenant_id: string
          unit: string
        }
        Insert: {
          cost_credits?: number
          created_at?: string
          details?: Json
          event_type: string
          id?: string
          quantity?: number
          run_id?: string | null
          tenant_id: string
          unit?: string
        }
        Update: {
          cost_credits?: number
          created_at?: string
          details?: Json
          event_type?: string
          id?: string
          quantity?: number
          run_id?: string | null
          tenant_id?: string
          unit?: string
        }
        Relationships: [
          {
            foreignKeyName: "usage_meter_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_meter_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_meter_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_deliveries: {
        Row: {
          attempt_count: number
          created_at: string
          event_type: string
          finished_at: string | null
          headers: Json
          id: string
          last_error: string | null
          max_attempts: number
          payload: Json
          scheduled_at: string
          signature: string | null
          started_at: string | null
          status: string
          target_url: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          attempt_count?: number
          created_at?: string
          event_type: string
          finished_at?: string | null
          headers?: Json
          id?: string
          last_error?: string | null
          max_attempts?: number
          payload?: Json
          scheduled_at?: string
          signature?: string | null
          started_at?: string | null
          status?: string
          target_url: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          created_at?: string
          event_type?: string
          finished_at?: string | null
          headers?: Json
          id?: string
          last_error?: string | null
          max_attempts?: number
          payload?: Json
          scheduled_at?: string
          signature?: string | null
          started_at?: string | null
          status?: string
          target_url?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_deliveries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "webhook_deliveries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      widget_configs: {
        Row: {
          allowed_origins: string[]
          appearance: Json
          behavior: Json
          created_at: string
          created_by: string | null
          id: string
          name: string
          secret_hash: string | null
          slug: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          allowed_origins?: string[]
          appearance?: Json
          behavior?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          secret_hash?: string | null
          slug: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          allowed_origins?: string[]
          appearance?: Json
          behavior?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          secret_hash?: string | null
          slug?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "widget_configs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "widget_configs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      agents_v: {
        Row: {
          config_json: Json | null
          created_at: string | null
          description: string | null
          id: string | null
          name: string | null
          organization_id: string | null
          status: string | null
          trigger_type: string | null
        }
        Insert: {
          config_json?: Json | null
          created_at?: string | null
          description?: string | null
          id?: string | null
          name?: string | null
          organization_id?: string | null
          status?: string | null
          trigger_type?: never
        }
        Update: {
          config_json?: Json | null
          created_at?: string | null
          description?: string | null
          id?: string | null
          name?: string | null
          organization_id?: string | null
          status?: string | null
          trigger_type?: never
        }
        Relationships: [
          {
            foreignKeyName: "ai_agents_tenant_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_agents_tenant_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      documents_v: {
        Row: {
          chunk_count: number | null
          created_at: string | null
          file_name: string | null
          file_url: string | null
          id: string | null
          organization_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_documents_tenant_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_documents_tenant_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations_v: {
        Row: {
          created_at: string | null
          credits: number | null
          id: string | null
          name: string | null
          plan_type: string | null
          region: string | null
          status: string | null
        }
        Insert: {
          created_at?: string | null
          credits?: number | null
          id?: string | null
          name?: string | null
          plan_type?: string | null
          region?: string | null
          status?: string | null
        }
        Update: {
          created_at?: string | null
          credits?: number | null
          id?: string | null
          name?: string | null
          plan_type?: string | null
          region?: string | null
          status?: string | null
        }
        Relationships: []
      }
      users_v: {
        Row: {
          created_at: string | null
          email: string | null
          id: string | null
          organization_id: string | null
          role: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_tenant_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_tenant_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      accept_team_invitation_token: {
        Args: { p_full_name?: string; p_token: string }
        Returns: Json
      }
      add_raci_role: { Args: { p_role_name: string }; Returns: undefined }
      add_raci_rule_resource: {
        Args: { p_action?: string; p_category?: string; p_resource_key: string }
        Returns: undefined
      }
      agent_slugify: { Args: { p_text: string }; Returns: string }
      agent_template_catalog: { Args: never; Returns: Json }
      apply_plan_change: {
        Args: {
          p_billing_cycle?: string
          p_change_type?: string
          p_payment_reference?: string
          p_target_plan: string
        }
        Returns: Json
      }
      apply_raci_role_template: {
        Args: {
          p_member_ids?: string[]
          p_role_name?: string
          p_template_key: string
        }
        Returns: Json
      }
      bootstrap_connection_schema: {
        Args: { p_connection_id: string }
        Returns: {
          columns_count: number
          entities_count: number
          relationships_count: number
        }[]
      }
      claim_agent_run_jobs: {
        Args: { p_limit?: number; p_queues?: string[]; p_worker_id: string }
        Returns: {
          agent_id: string
          attempt_count: number
          job_id: string
          max_attempts: number
          payload: Json
          queue: string
          run_id: string
          started_at: string
          tenant_id: string
        }[]
      }
      claim_connector_jobs: {
        Args: { p_limit?: number; p_queues?: string[]; p_worker_id: string }
        Returns: {
          attempt_count: number
          connection_id: string
          job_id: string
          job_type: string
          max_attempts: number
          payload: Json
          queue: string
          started_at: string
          tenant_id: string
        }[]
      }
      claim_embedding_jobs: {
        Args: { p_limit?: number; p_worker_id: string }
        Returns: {
          attempt_count: number
          embedding_model: string
          job_id: string
          max_attempts: number
          payload: Json
          source_id: string
          source_type: string
          started_at: string
          tenant_id: string
        }[]
      }
      classify_approval_type: {
        Args: { p_action: string; p_resource: string }
        Returns: string
      }
      clear_agent_memory_entries: {
        Args: { p_agent_id: string; p_memory_type?: string }
        Returns: number
      }
      complete_agent_run_step: {
        Args: {
          p_cost_credits?: number
          p_data?: Json
          p_latency_ms?: number
          p_run_id: string
          p_status?: string
          p_step_type: string
          p_tool_name?: string
        }
        Returns: string
      }
      compute_next_sync_at: {
        Args: { p_base_at?: string; p_sync_frequency?: string }
        Returns: string
      }
      compute_required_approvals: {
        Args: {
          p_action?: string
          p_params?: Json
          p_resource: string
          p_risk_level?: string
          p_tenant_id: string
        }
        Returns: number
      }
      create_api_connection: {
        Args: {
          p_auth_type?: string
          p_base_url?: string
          p_connection_config?: Json
          p_name: string
          p_seed_schema?: boolean
          p_type: string
        }
        Returns: {
          connection_id: string
          status: string
        }[]
      }
      create_api_key: {
        Args: { p_name: string; p_scopes?: string[] }
        Returns: {
          created_at: string
          id: string
          key_prefix: string
          plain_key: string
        }[]
      }
      create_api_key_v2: {
        Args: {
          p_environment?: string
          p_expires_at?: string
          p_name: string
          p_scopes?: string[]
        }
        Returns: {
          created_at: string
          environment: string
          expires_at: string
          id: string
          key_prefix: string
          plain_key: string
          scopes: string[]
        }[]
      }
      create_approval_request: {
        Args: {
          p_action: string
          p_action_summary?: string
          p_expires_minutes?: number
          p_params?: Json
          p_requested_by?: string
          p_resource: string
          p_risk_level?: string
          p_simulation_preview?: Json
          p_tenant_id?: string
        }
        Returns: {
          approved_count: number
          approvers: Json
          id: string
          pending_approvals: number
          rejected_count: number
          required_approvals: number
          status: string
        }[]
      }
      create_custom_agent_from_chat_prompt: {
        Args: { p_prompt: string; p_session_id?: string }
        Returns: Json
      }
      create_embedding_job: {
        Args: {
          p_idempotency_key?: string
          p_payload?: Json
          p_priority?: number
          p_source_id: string
          p_source_type: string
        }
        Returns: {
          job_id: string
          scheduled_at: string
          status: string
        }[]
      }
      create_team_invitations: {
        Args: { p_invites: Json }
        Returns: {
          inserted_count: number
          remaining_slots: number
        }[]
      }
      current_user_can_manage_team: { Args: never; Returns: boolean }
      current_user_is_tenant_admin: { Args: never; Returns: boolean }
      decide_approval_request: {
        Args: { p_decision: string; p_request_id: string }
        Returns: {
          decided_at: string
          status: string
        }[]
      }
      decide_approval_request_queue: {
        Args: { p_decision: string; p_note?: string; p_request_id: string }
        Returns: {
          decided_at: string
          status: string
        }[]
      }
      default_agent_capabilities_for_domain: {
        Args: { p_domain: string }
        Returns: string[]
      }
      default_agent_emoji_for_domain: {
        Args: { p_domain: string }
        Returns: string
      }
      delete_raci_role: {
        Args: { p_force?: boolean; p_role_name: string }
        Returns: number
      }
      derive_agent_domains: {
        Args: { p_force?: boolean; p_tenant_id: string }
        Returns: {
          description: string
          domain: string
          entity_count: number
          entity_groups: string[]
          name: string
          sensitivities: string[]
          slug: string
        }[]
      }
      dismiss_predictive_insight: {
        Args: { p_insight_id: string }
        Returns: Json
      }
      enqueue_agent_run: {
        Args: {
          p_agent_id: string
          p_estimated_credits?: number
          p_idempotency_key?: string
          p_input?: Json
          p_invoked_via?: string
          p_priority?: number
          p_session_id?: string
          p_trigger_type?: string
        }
        Returns: {
          job_id: string
          reservation_id: string
          run_id: string
          status: string
        }[]
      }
      enqueue_connector_sync: {
        Args: {
          p_connection_id: string
          p_idempotency_key?: string
          p_job_type?: string
          p_payload?: Json
          p_priority?: number
          p_trigger_reason?: string
        }
        Returns: {
          job_id: string
          queue: string
          scheduled_at: string
          status: string
        }[]
      }
      enqueue_due_connector_sync_jobs: {
        Args: { p_limit?: number; p_trigger_reason?: string }
        Returns: {
          connection_id: string
          job_id: string
          queue: string
          scheduled_at: string
          sync_frequency: string
          tenant_id: string
        }[]
      }
      enqueue_notification_test_event: { Args: never; Returns: Json }
      ensure_default_agent_raci_bindings: {
        Args: { p_agent_id: string }
        Returns: number
      }
      ensure_default_agent_tools: {
        Args: { p_agent_id: string }
        Returns: number
      }
      ensure_default_widget_config: {
        Args: { p_tenant_id: string }
        Returns: string
      }
      ensure_raci_editor_defaults: { Args: never; Returns: undefined }
      evaluate_action_policy: {
        Args: {
          p_action: string
          p_requires_write?: boolean
          p_resource: string
          p_risk_level?: string
        }
        Returns: {
          allow: boolean
          approval_required: boolean
          matched_rule: Json
          reason: string
        }[]
      }
      execute_tenant_read_sql: {
        Args: { p_connection_id: string; p_limit?: number; p_sql: string }
        Returns: {
          columns: Json
          error: string
          execution_ms: number
          rows: Json
          success: boolean
        }[]
      }
      execute_tenant_sql_governed: {
        Args: {
          p_action?: string
          p_connection_id: string
          p_limit?: number
          p_resource?: string
          p_sql: string
        }
        Returns: {
          approval_required: boolean
          columns: Json
          error: string
          execution_ms: number
          policy_decision: Json
          rows: Json
          success: boolean
        }[]
      }
      finalize_credits: {
        Args: {
          p_actual_credits: number
          p_reservation_id: string
          p_run_id?: string
          p_status?: string
        }
        Returns: Json
      }
      gen_random_uuid: { Args: never; Returns: string }
      get_agent_detail_payload: { Args: { p_agent_id: string }; Returns: Json }
      get_agent_studio_payload: { Args: { p_agent_id?: string }; Returns: Json }
      get_api_keys_management_payload: { Args: never; Returns: Json }
      get_approval_request_state: {
        Args: { p_request_id: string }
        Returns: Json
      }
      get_approval_review_payload: {
        Args: { p_request_id: string }
        Returns: Json
      }
      get_approval_reviewer_for_action: {
        Args: {
          p_action?: string
          p_exclude_user_id?: string
          p_resource: string
          p_tenant_id: string
        }
        Returns: {
          full_name: string
          id: string
          role_name: string
        }[]
      }
      get_approval_reviewers_for_action: {
        Args: {
          p_action?: string
          p_exclude_user_id?: string
          p_resource: string
          p_tenant_id: string
        }
        Returns: {
          full_name: string
          id: string
          role_name: string
        }[]
      }
      get_approvals_queue_payload: {
        Args: {
          p_date_from?: string
          p_date_to?: string
          p_risk_filter?: string
          p_search?: string
          p_status_filter?: string
        }
        Returns: Json
      }
      get_audit_log_full_payload: {
        Args: {
          p_action_type_filter?: string
          p_agent_filter?: string
          p_date_from?: string
          p_date_to?: string
          p_limit?: number
          p_offset?: number
          p_risk_filter?: string
          p_search?: string
          p_status_filter?: string
          p_user_filter?: string
        }
        Returns: Json
      }
      get_billing_invoice_detail: {
        Args: { p_invoice_id: string }
        Returns: Json
      }
      get_billing_invoice_history: { Args: { p_year?: number }; Returns: Json }
      get_billing_upgrade_options: { Args: never; Returns: Json }
      get_chat_context_summary: {
        Args: { p_session_id: string }
        Returns: {
          actions_taken: number
          active_agents: string[]
          queried_source_ids: string[]
          queried_source_names: string[]
        }[]
      }
      get_chat_feedback_map: {
        Args: { p_session_id: string }
        Returns: {
          feedback: string
          message_id: string
        }[]
      }
      get_chat_knowledge_runs: {
        Args: { p_limit?: number; p_session_id: string }
        Returns: {
          confidence: string
          created_at: string
          id: string
          prompt: string
          source_count: number
          sources: Json
        }[]
      }
      get_chat_sessions: {
        Args: { p_limit?: number; p_search?: string }
        Returns: {
          created_at: string
          id: string
          last_message_at: string
          last_message_preview: string
          message_count: number
          title: string
          updated_at: string
        }[]
      }
      get_chat_sql_runs: {
        Args: { p_limit?: number; p_session_id: string }
        Returns: {
          agent: string
          connection_id: string
          created_at: string
          error: string
          execution_ms: number
          explanation: string
          follow_ups: string[]
          id: string
          prompt: string
          row_count: number
          sql_query: string
          success: boolean
        }[]
      }
      get_effective_role_names: {
        Args: { p_tenant_id?: string; p_user_id?: string }
        Returns: string[]
      }
      get_guardrails: {
        Args: never
        Returns: {
          code: string
          config: Json
          description: string
          enabled: boolean
          id: string
          name: string
          risk_level: string
          updated_at: string
        }[]
      }
      get_guardrails_configuration_payload: { Args: never; Returns: Json }
      get_guardrails_risk_dashboard: {
        Args: { p_event_risk_filter?: string }
        Returns: Json
      }
      get_integration_marketplace_payload: {
        Args: {
          p_category?: string
          p_installed_only?: boolean
          p_search?: string
        }
        Returns: Json
      }
      get_knowledge_embedding_health: {
        Args: { p_tenant_id?: string }
        Returns: {
          chunks_total: number
          coverage_pct: number
          documents_total: number
          embedded_chunks: number
          error_chunks: number
          last_embedded_at: string
          pending_chunks: number
          stale_chunks: number
          tenant_id: string
        }[]
      }
      get_knowledge_entities: {
        Args: { p_filter?: string; p_limit?: number; p_query?: string }
        Returns: {
          connection_id: string
          connection_name: string
          description: string
          embedding_coverage: number
          entity_group: string
          entity_id: string
          entity_name: string
          key_fields: string[]
          last_updated: string
          relationship_count: number
          row_count: number
          sensitivity: string
          source_kind: string
        }[]
      }
      get_knowledge_recent_queries: {
        Args: { p_limit?: number }
        Returns: {
          content: string
          created_at: string
          id: string
        }[]
      }
      get_knowledge_stats: {
        Args: never
        Returns: {
          coverage_pct: number
          documents_indexed: number
          embeddings_vectors: number
          storage_gb: number
          total_entities: number
        }[]
      }
      get_nav_counts: {
        Args: never
        Returns: {
          pending_approvals: number
          unread_notifications: number
        }[]
      }
      get_notification_settings_payload: { Args: never; Returns: Json }
      get_onboarding_snapshot: {
        Args: never
        Returns: {
          active_connections: number
          agents_ready: number
          invited_count: number
          onboarding_step: number
          tenant_id: string
          tenant_name: string
          tenant_status: string
        }[]
      }
      get_plan_downgrade_impact: {
        Args: { p_target_plan: string }
        Returns: Json
      }
      get_platform_admin_metrics: {
        Args: never
        Returns: {
          active_tenants: number
          monthly_usage_events: number
          open_approvals: number
          pending_embedding_jobs: number
          queued_connector_jobs: number
          running_connector_jobs: number
          total_connections: number
          total_tenants: number
        }[]
      }
      get_platform_super_admin_infrastructure_health: {
        Args: { p_hours?: number }
        Returns: Json
      }
      get_platform_super_admin_revenue_dashboard: {
        Args: { p_months?: number }
        Returns: Json
      }
      get_platform_super_admin_tenant_quick_view: {
        Args: { p_tenant_id: string }
        Returns: Json
      }
      get_platform_super_admin_tenants: {
        Args: {
          p_created_from?: string
          p_created_to?: string
          p_limit?: number
          p_offset?: number
          p_plan?: string
          p_search?: string
          p_sort_by?: string
          p_sort_dir?: string
          p_status?: string
        }
        Returns: Json
      }
      get_predictive_anomaly_detail: {
        Args: { p_insight_id: string; p_window?: string }
        Returns: Json
      }
      get_predictive_insights_payload: {
        Args: {
          p_include_dismissed?: boolean
          p_source_id?: string
          p_tab?: string
        }
        Returns: Json
      }
      get_public_pricing_payload: {
        Args: { p_billing_interval?: string }
        Returns: Json
      }
      get_raci_editor_payload: { Args: never; Returns: Json }
      get_raci_role_management_payload: { Args: never; Returns: Json }
      get_team_invitation_by_token: { Args: { p_token: string }; Returns: Json }
      get_team_management_payload: {
        Args: {
          p_role_filter?: string
          p_search?: string
          p_status_filter?: string
        }
        Returns: Json
      }
      get_tenant_admin_analytics_payload: {
        Args: { p_date_from?: string; p_date_to?: string }
        Returns: Json
      }
      get_tenant_admin_console_overview: { Args: never; Returns: Json }
      get_tenant_billing_dashboard: {
        Args: { p_window_days?: number }
        Returns: Json
      }
      get_usage_summary: {
        Args: { p_tenant_id?: string; p_window_days?: number }
        Returns: Json
      }
      get_user_bootstrap: {
        Args: never
        Returns: {
          has_connections: boolean
          requires_onboarding: boolean
          role: string
          tenant_id: string
          tenant_name: string
          tenant_plan: string
          tenant_status: string
          terms_accepted: boolean
        }[]
      }
      get_user_tenant_id: { Args: never; Returns: string }
      get_widget_integration_payload: { Args: never; Returns: Json }
      get_workspace_home_metrics: {
        Args: never
        Returns: {
          active_connections: number
          ai_actions_this_week: number
          error_connections: number
          messages_today: number
          messages_yesterday: number
          pending_approvals: number
          syncing_connections: number
          total_connections: number
        }[]
      }
      import_raci_rules_csv_rows: { Args: { p_rows: Json }; Returns: number }
      infer_agent_domain_from_prompt: {
        Args: { p_prompt: string }
        Returns: string
      }
      invite_team_members: {
        Args: { p_custom_message?: string; p_emails: string[]; p_role?: string }
        Returns: Json
      }
      is_platform_admin: { Args: { p_user_id?: string }; Returns: boolean }
      launch_workspace: {
        Args: { p_raci_rules?: Json }
        Returns: {
          applied_rules: number
          seeded_agents: number
          tenant_id: string
          tenant_status: string
        }[]
      }
      list_agent_run_replay: {
        Args: { p_run_id: string }
        Returns: {
          cost_credits: number
          created_at: string
          data: Json
          latency_ms: number
          status: string
          step_index: number
          step_type: string
          tool_name: string
        }[]
      }
      list_agents_dashboard: {
        Args: { p_search?: string; p_status?: string }
        Returns: {
          avatar_emoji: string
          avg_response_ms: number
          capabilities: string[]
          description: string
          domain: string
          id: string
          is_custom: boolean
          lifecycle_reason: string
          name: string
          queries_today: number
          raci_scope: string
          slug: string
          source_connection_id: string
          source_connection_name: string
          status: string
          status_bucket: string
          success_rate: number
          updated_at: string
        }[]
      }
      list_raci_role_templates: { Args: never; Returns: Json }
      manage_team_invitation: {
        Args: { p_action: string; p_invitation_id: string }
        Returns: Json
      }
      normalize_approval_status: { Args: { p_status: string }; Returns: string }
      normalize_sync_frequency: {
        Args: { p_frequency: string }
        Returns: string
      }
      plan_mrr_usd: {
        Args: { p_billing_cycle?: string; p_plan: string }
        Returns: number
      }
      plan_price_cents: {
        Args: { p_billing_cycle?: string; p_plan: string }
        Returns: number
      }
      platform_admin_manage_tenant: {
        Args: { p_action: string; p_tenant_id: string; p_value?: string }
        Returns: Json
      }
      platform_admin_send_retention_email: {
        Args: { p_note?: string; p_tenant_id: string }
        Returns: Json
      }
      platform_admin_start_impersonation: {
        Args: { p_tenant_id: string }
        Returns: Json
      }
      preview_plan_change: {
        Args: { p_billing_cycle?: string; p_target_plan: string }
        Returns: Json
      }
      provision_user_workspace: {
        Args: {
          p_company_name?: string
          p_full_name?: string
          p_terms_accepted?: boolean
        }
        Returns: {
          full_name: string
          role: string
          tenant_id: string
          tenant_name: string
          tenant_plan: string
          tenant_status: string
        }[]
      }
      raci_action_candidates: { Args: { p_action: string }; Returns: string[] }
      raci_default_role_icon: { Args: { p_role_name: string }; Returns: string }
      raci_format_display_name: { Args: { p_name: string }; Returns: string }
      raci_infer_category: { Args: { p_resource_key: string }; Returns: string }
      recompute_connection_runtime_metrics: {
        Args: { p_connection_id?: string }
        Returns: {
          connection_id: string
          embeddings_indexed: number
          schema_detected: boolean
          schema_entities_count: number
        }[]
      }
      reconcile_billing_state: {
        Args: { p_tenant_id: string }
        Returns: {
          plan: string
          subscription_status: string
          tenant_id: string
          tenant_status: string
        }[]
      }
      record_approval_decision: {
        Args: {
          p_decision: string
          p_reason?: string
          p_request_id: string
          p_source?: string
        }
        Returns: {
          approved_count: number
          decided_at: string
          pending_approvals: number
          rejected_count: number
          request_id: string
          required_approvals: number
          reviewer_decision: string
          status: string
        }[]
      }
      record_tool_execution: {
        Args: {
          p_agent_id?: string
          p_cost_credits?: number
          p_error?: string
          p_latency_ms?: number
          p_risk_level?: string
          p_run_id: string
          p_session_id?: string
          p_status: string
          p_tool_input?: Json
          p_tool_name: string
          p_tool_output?: Json
        }
        Returns: string
      }
      recover_stale_connector_jobs: {
        Args: { p_batch?: number; p_stale_minutes?: number }
        Returns: {
          dead_letter_count: number
          requeued_count: number
        }[]
      }
      recover_stale_embedding_jobs: {
        Args: { p_batch?: number; p_stale_minutes?: number }
        Returns: {
          dead_letter_count: number
          requeued_count: number
        }[]
      }
      refresh_predictive_insights: { Args: never; Returns: Json }
      refresh_predictive_insights_for_tenant: {
        Args: { p_force?: boolean; p_tenant_id?: string }
        Returns: Json
      }
      regenerate_agents_for_tenant: {
        Args: { p_force?: boolean; p_tenant_id?: string }
        Returns: {
          seeded: number
          tenant_id: string
          updated: number
        }[]
      }
      remove_team_member: { Args: { p_profile_id: string }; Returns: Json }
      rename_agent: {
        Args: { p_agent_id: string; p_name: string }
        Returns: {
          id: string
          name: string
          updated_at: string
        }[]
      }
      rename_raci_role: {
        Args: { p_new_role_name: string; p_old_role_name: string }
        Returns: undefined
      }
      request_invoice_payment_retry: {
        Args: { p_invoice_id: string }
        Returns: Json
      }
      reserve_credits: {
        Args: {
          p_estimated_credits: number
          p_run_id?: string
          p_tenant_id?: string
        }
        Returns: {
          allowed: boolean
          reason: string
          remaining_balance: number
          reservation_id: string
        }[]
      }
      resolve_tool_definition: {
        Args: { p_agent_id?: string; p_tenant_id?: string; p_tool_name: string }
        Returns: {
          category: string
          code: string
          default_config: Json
          description: string
          display_name: string
          handler_key: string
          id: string
          input_schema: Json
          is_write_action: boolean
          raci_required: string
          requires_credential_service: string
          risk_level: string
          tenant_id: string
          version: string
        }[]
      }
      resolve_user_raci_context: {
        Args: {
          p_action: string
          p_resource: string
          p_tenant_id?: string
          p_user_id?: string
        }
        Returns: {
          can_approve: boolean
          can_execute: boolean
          effective_roles: string[]
          is_consulted: boolean
          matched_raci_type: string
          matched_roles: string[]
          profile_role: string
        }[]
      }
      revoke_api_key: { Args: { p_key_id: string }; Returns: boolean }
      save_guardrails_configuration: {
        Args: {
          p_bulk_update_limit: string
          p_business_end: string
          p_business_hours_lock_enabled: boolean
          p_business_start: string
          p_business_timezone: string
          p_financial_currency: string
          p_financial_limit: number
          p_new_user_days: number
          p_simulation_mode_enabled: boolean
        }
        Returns: Json
      }
      save_notification_channel_settings: {
        Args: {
          p_email_address: string
          p_email_enabled: boolean
          p_slack_channel: string
          p_slack_enabled: boolean
          p_slack_workspace: string
          p_webhook_enabled: boolean
          p_webhook_secret?: string
          p_webhook_url: string
        }
        Returns: Json
      }
      save_notification_digest_settings: {
        Args: {
          p_daily_digest_enabled: boolean
          p_daily_digest_time: string
          p_timezone: string
          p_weekly_report_day: number
          p_weekly_report_enabled: boolean
        }
        Returns: Json
      }
      save_notification_type_preferences: {
        Args: { p_preferences: Json }
        Returns: Json
      }
      save_onboarding_company_setup: {
        Args: {
          p_company_size?: string
          p_industry?: string
          p_logo_url?: string
          p_name: string
          p_primary_use_case?: string
          p_region: string
        }
        Returns: {
          company_size: string
          industry: string
          logo_url: string
          name: string
          onboarding_step: number
          primary_use_case: string
          region: string
          tenant_id: string
        }[]
      }
      save_widget_integration_config: {
        Args: {
          p_access_mode: string
          p_allowed_origins: string[]
          p_button_size: string
          p_enabled_agent_ids: string[]
          p_feature_execute_actions: boolean
          p_feature_request_approvals: boolean
          p_feature_view_reports: boolean
          p_initial_message: string
          p_name: string
          p_position: string
          p_primary_color: string
        }
        Returns: Json
      }
      schedule_knowledge_embedding_reindex: {
        Args: {
          p_document_id?: string
          p_force?: boolean
          p_limit?: number
          p_tenant_id?: string
        }
        Returns: {
          queued_count: number
          scanned_count: number
          stale_count: number
        }[]
      }
      search_knowledge_documents: {
        Args: { p_limit?: number; p_query: string }
        Returns: {
          excerpt: string
          external_url: string
          file_type: string
          id: string
          relevance: number
          source_type: string
          storage_path: string
          title: string
        }[]
      }
      search_knowledge_documents_hybrid: {
        Args: {
          p_lexical_weight?: number
          p_limit?: number
          p_query: string
          p_query_embedding?: string
          p_vector_weight?: number
        }
        Returns: {
          excerpt: string
          external_url: string
          file_type: string
          id: string
          relevance: number
          score_breakdown: Json
          source_type: string
          storage_path: string
          title: string
        }[]
      }
      seed_agents_for_tenant: { Args: { p_tenant_id: string }; Returns: number }
      seed_anomaly_detail_for_insight: {
        Args: { p_force?: boolean; p_insight_id: string }
        Returns: number
      }
      seed_default_guardrails: {
        Args: { p_tenant_id: string }
        Returns: number
      }
      seed_default_risk_matrix: {
        Args: { p_tenant_id: string }
        Returns: number
      }
      seed_guardrails_configuration_defaults: {
        Args: { p_tenant_id: string }
        Returns: number
      }
      seed_notification_preferences: {
        Args: { p_email?: string; p_tenant_id: string }
        Returns: undefined
      }
      seed_predictive_insights_for_tenant: {
        Args: { p_force?: boolean; p_tenant_id: string }
        Returns: number
      }
      seed_public_pricing_catalog: { Args: never; Returns: undefined }
      set_agent_enabled: {
        Args: { p_agent_id: string; p_enabled: boolean }
        Returns: {
          id: string
          status: string
          status_bucket: string
          updated_at: string
        }[]
      }
      set_agent_tool_enabled: {
        Args: { p_enabled: boolean; p_tool_id: string }
        Returns: {
          enabled: boolean
          id: string
          updated_at: string
        }[]
      }
      set_chat_message_feedback: {
        Args: { p_feedback?: string; p_message_id: string }
        Returns: {
          feedback: string
          message_id: string
          updated_at: string
        }[]
      }
      set_connection_next_sync_at: {
        Args: { p_base_at?: string; p_connection_id: string }
        Returns: string
      }
      set_guardrail_enabled: {
        Args: { p_enabled: boolean; p_guardrail_id: string }
        Returns: boolean
      }
      set_integration_install_state: {
        Args: { p_integration_code: string; p_operation?: string }
        Returns: Json
      }
      set_raci_cell: {
        Args: {
          p_action: string
          p_raci_type: string
          p_resource_key: string
          p_role_name: string
        }
        Returns: undefined
      }
      set_risk_rule_override: {
        Args: {
          p_justification: string
          p_override_risk_level: string
          p_rule_id: string
        }
        Returns: Json
      }
      set_team_member_status: {
        Args: { p_profile_id: string; p_status: string }
        Returns: Json
      }
      set_tenant_admin_weekly_report_enabled: {
        Args: { p_enabled: boolean }
        Returns: Json
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      simulate_action_preview: {
        Args: {
          p_action?: string
          p_existing_preview?: Json
          p_params?: Json
          p_resource?: string
          p_risk_level?: string
        }
        Returns: Json
      }
      submit_approval_review_decision: {
        Args: { p_decision: string; p_reason?: string; p_request_id: string }
        Returns: Json
      }
      suggest_custom_agent_blueprint: {
        Args: { p_prompt: string }
        Returns: Json
      }
      sync_custom_agent: { Args: { p_agent_id: string }; Returns: Json }
      sync_frequency_interval: {
        Args: { p_frequency: string }
        Returns: unknown
      }
      team_role_rank: { Args: { p_role: string }; Returns: number }
      tenant_entitlements_check: {
        Args: {
          p_capability: string
          p_requested?: number
          p_tenant_id?: string
        }
        Returns: {
          allowed: boolean
          capability: string
          current_usage: number
          hard_limit: number
          reason: string
          requested: number
          soft_limit: number
        }[]
      }
      test_connection_payload: {
        Args: { p_connection_type: string; p_payload?: Json }
        Returns: {
          latency_ms: number
          message: string
          success: boolean
        }[]
      }
      update_agent_raci_binding_role: {
        Args: { p_binding_id: string; p_role_name: string }
        Returns: {
          id: string
          role_name: string
          updated_at: string
        }[]
      }
      update_predictive_anomaly_status: {
        Args: { p_insight_id: string; p_status: string }
        Returns: Json
      }
      update_team_member_role: {
        Args: { p_profile_id: string; p_role: string }
        Returns: Json
      }
      upsert_custom_agent_studio: {
        Args: {
          p_agent_id?: string
          p_auto_deploy?: boolean
          p_auto_sync?: boolean
          p_avatar_emoji?: string
          p_capabilities?: string[]
          p_deploy_now?: boolean
          p_description?: string
          p_domain?: string
          p_name?: string
          p_objective?: string
          p_prompt?: string
          p_raci_scope?: string
          p_rag_enabled?: boolean
          p_source_connection_ids?: string[]
          p_sync_frequency?: string
          p_system_prompt?: string
          p_vector_strategy?: string
        }
        Returns: Json
      }
      upsert_raci_role_management: {
        Args: {
          p_description?: string
          p_icon?: string
          p_member_ids?: string[]
          p_previous_role_name?: string
          p_role_name: string
        }
        Returns: Json
      }
      validate_raci_matrix_rules: { Args: never; Returns: Json }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
