/**
 * marketplaceToolExecutor.ts
 *
 * Dispatches HTTP calls for marketplace integration tools.
 * Retrieves credentials from tenant_integration_installs.config or api_connections.
 * Routes by handler_key prefix (e.g. 'slack.send_message', 'github.create_issue').
 */

import { getSupabaseService } from '../lib/supabase';

type Args = Record<string, unknown>;
type HttpResult = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function executeMarketplaceTool(
  handlerKey: string,
  args: Args,
  tenantId: string,
): Promise<unknown> {
  const [provider, ...rest] = handlerKey.split('.');
  const method = rest.join('.');

  switch (provider) {
    case 'slack': {
      const token = await getIntegrationToken(tenantId, 'slack', ['access_token', 'bot_token', 'token']);
      return dispatchSlack(method, args, token);
    }
    case 'github': {
      const token = await getIntegrationToken(tenantId, 'github', ['access_token', 'token', 'api_token']);
      return dispatchGitHub(method, args, token);
    }
    case 'jira': {
      const config = await getIntegrationConfig(tenantId, 'jira');
      return dispatchJira(method, args, config);
    }
    case 'hubspot': {
      const token = await getIntegrationToken(tenantId, 'hubspot', ['access_token', 'token', 'api_key']);
      return dispatchHubSpot(method, args, token);
    }
    case 'notion': {
      const token = await getIntegrationToken(tenantId, 'notion', ['access_token', 'token', 'integration_token', 'notionToken']);
      return dispatchNotion(method, args, token);
    }
    case 'gdrive':
    case 'google_drive': {
      const token = await getIntegrationToken(tenantId, 'google_drive', ['access_token', 'token']);
      return dispatchGoogleDrive(method, args, token);
    }
    default:
      throw new Error(`No marketplace executor for provider: ${provider} (handler: ${handlerKey})`);
  }
}

// ---------------------------------------------------------------------------
// Credential retrieval
// ---------------------------------------------------------------------------

async function getIntegrationConfig(tenantId: string, integrationCode: string): Promise<Record<string, unknown>> {
  const supabase = getSupabaseService();

  // 1. Try tenant_integration_installs first (marketplace installs)
  const { data: install } = await supabase.getClient()
    .from('tenant_integration_installs')
    .select('config, integration_id')
    .eq('tenant_id', tenantId)
    .eq('status', 'installed')
    .filter(
      'integration_id',
      'in',
      `(SELECT id FROM integration_catalog WHERE code = '${integrationCode}' AND is_active = true)`,
    )
    .maybeSingle();

  if (install?.config && typeof install.config === 'object') {
    return install.config as Record<string, unknown>;
  }

  // 2. Fall back to api_connections (connector sync config)
  const { data: conn } = await supabase.getClient()
    .from('api_connections')
    .select('connection_config')
    .eq('tenant_id', tenantId)
    .ilike('connection_type', integrationCode)
    .eq('status', 'active')
    .maybeSingle();

  if (conn?.connection_config && typeof conn.connection_config === 'object') {
    return conn.connection_config as Record<string, unknown>;
  }

  throw new Error(
    `No credentials found for integration "${integrationCode}" in tenant ${tenantId}. ` +
    `Please install and configure the integration in the Marketplace.`,
  );
}

async function getIntegrationToken(
  tenantId: string,
  integrationCode: string,
  tokenFields: string[],
): Promise<string> {
  const config = await getIntegrationConfig(tenantId, integrationCode);

  for (const field of tokenFields) {
    const value = config[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  throw new Error(
    `No API token found for integration "${integrationCode}". ` +
    `Expected one of: ${tokenFields.join(', ')}. Configure credentials in the Marketplace.`,
  );
}

// ---------------------------------------------------------------------------
// Slack dispatcher
// ---------------------------------------------------------------------------

async function dispatchSlack(method: string, args: Args, token: string): Promise<HttpResult> {
  const baseHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json; charset=utf-8',
  };

  switch (method) {
    case 'send_message': {
      const body = {
        channel: String(args.channel ?? ''),
        text: String(args.text ?? ''),
        ...(args.thread_ts ? { thread_ts: String(args.thread_ts) } : {}),
      };
      return slackPost('chat.postMessage', body, baseHeaders);
    }
    case 'list_channels': {
      const limit = Number(args.limit ?? 100);
      return slackGet(`conversations.list?limit=${limit}&types=public_channel`, baseHeaders);
    }
    case 'get_channel_history': {
      const channel = String(args.channel ?? '');
      const limit = Number(args.limit ?? 20);
      return slackGet(`conversations.history?channel=${channel}&limit=${limit}`, baseHeaders);
    }
    default:
      throw new Error(`Unknown Slack method: ${method}`);
  }
}

async function slackGet(path: string, headers: Record<string, string>): Promise<HttpResult> {
  const res = await fetch(`https://slack.com/api/${path}`, { headers });
  const data = await res.json() as { ok: boolean; error?: string } & HttpResult;
  if (!data.ok) throw new Error(`Slack API error: ${data.error ?? 'unknown'}`);
  return data;
}

async function slackPost(path: string, body: unknown, headers: Record<string, string>): Promise<HttpResult> {
  const res = await fetch(`https://slack.com/api/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json() as { ok: boolean; error?: string } & HttpResult;
  if (!data.ok) throw new Error(`Slack API error: ${data.error ?? 'unknown'}`);
  return data;
}

// ---------------------------------------------------------------------------
// GitHub dispatcher
// ---------------------------------------------------------------------------

async function dispatchGitHub(method: string, args: Args, token: string): Promise<HttpResult> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  switch (method) {
    case 'list_repos': {
      const perPage = Number(args.per_page ?? 30);
      const org = args.org ? String(args.org) : null;
      const url = org
        ? `https://api.github.com/orgs/${org}/repos?per_page=${perPage}`
        : `https://api.github.com/user/repos?per_page=${perPage}`;
      return githubGet(url, headers);
    }
    case 'create_issue': {
      const owner = String(args.owner ?? '');
      const repo = String(args.repo ?? '');
      const body: Record<string, unknown> = {
        title: String(args.title ?? ''),
        ...(args.body ? { body: String(args.body) } : {}),
        ...(Array.isArray(args.labels) ? { labels: args.labels } : {}),
      };
      return githubPost(`https://api.github.com/repos/${owner}/${repo}/issues`, body, headers);
    }
    case 'get_pull_requests': {
      const owner = String(args.owner ?? '');
      const repo = String(args.repo ?? '');
      const state = String(args.state ?? 'open');
      return githubGet(
        `https://api.github.com/repos/${owner}/${repo}/pulls?state=${state}`,
        headers,
      );
    }
    default:
      throw new Error(`Unknown GitHub method: ${method}`);
  }
}

async function githubGet(url: string, headers: Record<string, string>): Promise<HttpResult> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${text}`);
  }
  return await res.json() as HttpResult;
}

async function githubPost(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${text}`);
  }
  return await res.json() as HttpResult;
}

// ---------------------------------------------------------------------------
// Jira dispatcher
// ---------------------------------------------------------------------------

async function dispatchJira(method: string, args: Args, config: Record<string, unknown>): Promise<HttpResult> {
  const baseUrl = String(config.base_url ?? config.instance_url ?? '').replace(/\/$/, '');
  const email = String(config.email ?? config.username ?? '');
  const apiToken = String(config.api_token ?? config.token ?? config.password ?? '');
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  const headers = {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  if (!baseUrl) throw new Error('Jira base URL not configured');

  switch (method) {
    case 'list_issues': {
      const jql = String(args.jql ?? '');
      const maxResults = Number(args.max_results ?? 20);
      const qs = new URLSearchParams({ jql, maxResults: String(maxResults) });
      return jiraGet(`${baseUrl}/rest/api/3/search?${qs.toString()}`, headers);
    }
    case 'create_ticket': {
      const body = {
        fields: {
          project: { key: String(args.project_key ?? '') },
          summary: String(args.summary ?? ''),
          issuetype: { name: String(args.issue_type ?? 'Task') },
          ...(args.description ? { description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: String(args.description) }] }] } } : {}),
          ...(args.priority ? { priority: { name: String(args.priority) } } : {}),
        },
      };
      return jiraPost(`${baseUrl}/rest/api/3/issue`, body, headers);
    }
    case 'update_ticket_status': {
      const issueKey = String(args.issue_key ?? '');
      const transitionName = String(args.transition_name ?? '');

      // First get available transitions
      const transRes = await jiraGet(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, headers);
      const transitions = Array.isArray(transRes.transitions) ? transRes.transitions as Array<{ id: string; name: string }> : [];
      const match = transitions.find((t) => t.name.toLowerCase() === transitionName.toLowerCase());
      if (!match) {
        throw new Error(`Jira transition "${transitionName}" not found. Available: ${transitions.map((t) => t.name).join(', ')}`);
      }
      return jiraPost(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, { transition: { id: match.id } }, headers);
    }
    default:
      throw new Error(`Unknown Jira method: ${method}`);
  }
}

async function jiraGet(url: string, headers: Record<string, string>): Promise<HttpResult> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira API error ${res.status}: ${text}`);
  }
  return await res.json() as HttpResult;
}

async function jiraPost(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira API error ${res.status}: ${text}`);
  }
  // Some Jira endpoints return 204 No Content
  if (res.status === 204) return { ok: true };
  return await res.json() as HttpResult;
}

// ---------------------------------------------------------------------------
// HubSpot dispatcher
// ---------------------------------------------------------------------------

async function dispatchHubSpot(method: string, args: Args, token: string): Promise<HttpResult> {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  switch (method) {
    case 'create_contact': {
      const properties: Record<string, string> = {};
      if (args.email) properties.email = String(args.email);
      if (args.firstname) properties.firstname = String(args.firstname);
      if (args.lastname) properties.lastname = String(args.lastname);
      if (args.company) properties.company = String(args.company);
      if (args.phone) properties.phone = String(args.phone);
      return hubspotPost('https://api.hubapi.com/crm/v3/objects/contacts', { properties }, headers);
    }
    case 'list_deals': {
      const limit = Number(args.limit ?? 20);
      const qs = new URLSearchParams({ limit: String(limit) });
      if (args.pipeline_id) qs.set('pipelineId', String(args.pipeline_id));
      return hubspotGet(`https://api.hubapi.com/crm/v3/objects/deals?${qs.toString()}`, headers);
    }
    case 'update_deal': {
      const dealId = String(args.deal_id ?? '');
      const properties: Record<string, string> = {};
      if (args.dealname) properties.dealname = String(args.dealname);
      if (args.amount) properties.amount = String(args.amount);
      if (args.dealstage) properties.dealstage = String(args.dealstage);
      if (args.closedate) properties.closedate = String(args.closedate);
      return hubspotPatch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, { properties }, headers);
    }
    default:
      throw new Error(`Unknown HubSpot method: ${method}`);
  }
}

async function hubspotGet(url: string, headers: Record<string, string>): Promise<HttpResult> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot API error ${res.status}: ${text}`);
  }
  return await res.json() as HttpResult;
}

async function hubspotPost(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResult> {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot API error ${res.status}: ${text}`);
  }
  return await res.json() as HttpResult;
}

async function hubspotPatch(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResult> {
  const res = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot API error ${res.status}: ${text}`);
  }
  return await res.json() as HttpResult;
}

// ---------------------------------------------------------------------------
// Notion dispatcher
// ---------------------------------------------------------------------------

async function dispatchNotion(method: string, args: Args, token: string): Promise<HttpResult> {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28',
  };

  switch (method) {
    case 'search_pages': {
      const body: Record<string, unknown> = {};
      if (args.query) body.query = String(args.query);
      if (args.filter_type) body.filter = { property: 'object', value: String(args.filter_type) };
      if (args.page_size) body.page_size = Number(args.page_size);
      return notionPost('https://api.notion.com/v1/search', body, headers);
    }
    case 'get_database': {
      const dbId = String(args.database_id ?? '');
      const pageSize = Number(args.page_size ?? 20);
      const body = { page_size: pageSize };
      return notionPost(`https://api.notion.com/v1/databases/${dbId}/query`, body, headers);
    }
    case 'create_page': {
      const parentId = String(args.parent_id ?? '');
      const parentType = String(args.parent_type ?? 'page_id');
      const title = String(args.title ?? '');
      const body: Record<string, unknown> = {
        parent: { [parentType]: parentId },
        properties: {
          title: {
            title: [{ type: 'text', text: { content: title } }],
          },
        },
      };
      if (args.content) {
        body.children = [{
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: String(args.content) } }] },
        }];
      }
      return notionPost('https://api.notion.com/v1/pages', body, headers);
    }
    default:
      throw new Error(`Unknown Notion method: ${method}`);
  }
}

async function notionPost(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResult> {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API error ${res.status}: ${text}`);
  }
  return await res.json() as HttpResult;
}

// ---------------------------------------------------------------------------
// Google Drive dispatcher
// ---------------------------------------------------------------------------

async function dispatchGoogleDrive(method: string, args: Args, token: string): Promise<HttpResult> {
  const headers = {
    Authorization: `Bearer ${token}`,
  };

  switch (method) {
    case 'list_files': {
      const qs = new URLSearchParams({
        fields: 'files(id,name,mimeType,modifiedTime,size)',
        pageSize: String(Number(args.page_size ?? 20)),
      });
      if (args.query) qs.set('q', String(args.query));
      if (args.folder_id) qs.set('q', `'${String(args.folder_id)}' in parents${args.query ? ` and ${String(args.query)}` : ''}`);
      return driveGet(`https://www.googleapis.com/drive/v3/files?${qs.toString()}`, headers);
    }
    case 'get_file_content': {
      const fileId = String(args.file_id ?? '');
      const exportMime = String(args.export_mime_type ?? 'text/plain');
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`,
        { headers },
      );
      if (!res.ok) {
        // Try direct download as fallback
        const res2 = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
          { headers },
        );
        if (!res2.ok) {
          const text = await res2.text();
          throw new Error(`Google Drive API error ${res2.status}: ${text}`);
        }
        const content = await res2.text();
        return { content, fileId };
      }
      const content = await res.text();
      return { content, fileId };
    }
    case 'upload_file': {
      const name = String(args.name ?? 'untitled');
      const content = String(args.content ?? '');
      const mimeType = String(args.mime_type ?? 'text/plain');

      // Multipart upload
      const boundary = `opsai_boundary_${Date.now()}`;
      const metadata: Record<string, unknown> = { name, mimeType };
      if (args.folder_id) metadata.parents = [String(args.folder_id)];

      const multipartBody = [
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify(metadata),
        `--${boundary}`,
        `Content-Type: ${mimeType}`,
        '',
        content,
        `--${boundary}--`,
      ].join('\r\n');

      const res = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
        {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': `multipart/related; boundary=${boundary}`,
          },
          body: multipartBody,
        },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Google Drive upload error ${res.status}: ${text}`);
      }
      return await res.json() as HttpResult;
    }
    default:
      throw new Error(`Unknown Google Drive method: ${method}`);
  }
}

async function driveGet(url: string, headers: Record<string, string>): Promise<HttpResult> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Drive API error ${res.status}: ${text}`);
  }
  return await res.json() as HttpResult;
}
