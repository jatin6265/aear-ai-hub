import 'dotenv/config';
import { getSupabaseService } from './lib/supabase';
import { sleep } from './lib/utils';
import { PostgresConnector } from './connectors/postgres';
// Import other connectors...

import { startIngestionWorker } from './workers/ingestionWorker';
import { getAgentLoop } from './runtime/agentLoop';

async function main() {
  console.log('OpsAI Worker starting...');
  
  const supabase = getSupabaseService();
  
  try {
    await supabase.validateConnectivity();
    console.log('Connected to Supabase.');
  } catch (err) {
    console.error('Failed to connect to Supabase:', err);
    process.exit(1);
  }

  // Start Background Workers
  startIngestionWorker();
  console.log('Ingestion worker started.');

  // Main loop for polling (Legacy mode until Bull is fully wired)
  while (true) {
    try {
      // 1. Recover stale jobs
      await supabase.rpc('recover_stale_connector_jobs', {
        p_stale_minutes: 20,
        p_batch: 50
      });

      // 2. Check for due syncs
      const { data: jobs, error } = await supabase.rpc('enqueue_due_connector_sync_jobs', {
        p_limit: 10,
        p_trigger_reason: 'worker_scheduler'
      });

      const jobList = Array.isArray(jobs) ? jobs : [];
      if (!error && jobList.length > 0) {
        console.log(`Processing ${jobList.length} sync jobs...`);
        for (const job of jobList) {
          await processJob(job as { connection_id: string });
        }
      }

      // 3. Process Agent Runs
      const { data: agentRuns, error: agentError } = await supabase.getClient()
        .from('agent_runs')
        .select('id')
        .eq('status', 'queued')
        .limit(5);

      if (!agentError && agentRuns && agentRuns.length > 0) {
        console.log(`Processing ${agentRuns.length} agent runs...`);
        const agentLoop = getAgentLoop();
        for (const run of agentRuns) {
          // Mark as running first
          await supabase.getClient().from('agent_runs').update({ status: 'running', started_at: new Date().toISOString() }).eq('id', run.id);
          await agentLoop.runTurn(run.id);
        }
      }

    } catch (err) {
      console.error('Error in main loop:', err);
    }
    
    await sleep(5000); // Poll every 5s
  }
}

import { ConnectorFactory } from './connectors/factory';

async function processJob(job: { connection_id: string }) {
  const supabase = getSupabaseService();
  console.log(`Starting job for connection: ${job.connection_id}`);
  
  try {
    // 1. Fetch connection details
    const { data: connection, error: fetchError } = await supabase.getClient()
      .from('api_connections')
      .select('*')
      .eq('id', job.connection_id)
      .single();

    if (fetchError || !connection) {
      throw new Error(`Failed to fetch connection: ${fetchError?.message || 'Not found'}`);
    }

    // 2. Mark run as running
    const { data: run, error: runError } = await supabase.getClient()
      .from('connector_sync_runs')
      .insert({
        connection_id: job.connection_id,
        status: 'running',
        started_at: new Date().toISOString()
      })
      .select()
      .single();

    if (runError) throw runError;

    // 3. Instantiate connector
    const connector = ConnectorFactory.createConnector(
      connection.id,
      connection.connection_type,
      connection.connection_config as Record<string, unknown>
    );

    // 4. Execute Discovery (Standard for now)
    const discoveryResult = await connector.discoverSchema();

    // 5. Update connection with new schema and status
    await supabase.getClient()
      .from('api_connections')
      .update({
        last_sync_at: new Date().toISOString(),
        sync_status: 'healthy',
        schema_tables_count: discoveryResult.schemaTablesCount,
        schema_entities_count: discoveryResult.schemaEntitiesCount
      })
      .eq('id', job.connection_id);

    // 6. Mark run as success
    await supabase.getClient()
      .from('connector_sync_runs')
      .update({
        status: 'success',
        finished_at: new Date().toISOString(),
        rows_processed: 0, // Discovery doesn't sync rows yet
        metadata: { discoveryResult }
      })
      .eq('id', run.id);

    console.log(`Job success for connection: ${job.connection_id}`);

  } catch (err) {
    console.error(`Job failed for connection: ${job.connection_id}:`, err);
    // Mark as failed
    await supabase.getClient()
      .from('connector_sync_runs')
      .insert({
        connection_id: job.connection_id,
        status: 'error',
        error_message: String(err),
        finished_at: new Date().toISOString()
      });
  }
}

main().catch(console.error);
