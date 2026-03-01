-- Enrich integration_catalog with full tool definitions for the top 6 integrations,
-- and register them in tool_registry so the agent engine can discover them per tenant.

-- Update Slack tool templates
UPDATE public.integration_catalog
SET tool_templates = '[
  {
    "name": "slack_send_message",
    "handler_key": "slack.send_message",
    "tool_type": "http_call",
    "risk_level": "medium",
    "is_write_action": true,
    "description": "Send a message to a Slack channel",
    "input_schema": {
      "type": "object",
      "required": ["channel", "text"],
      "properties": {
        "channel": { "type": "string", "description": "Channel ID or name (e.g. #general)" },
        "text": { "type": "string", "description": "Message text to send" },
        "thread_ts": { "type": "string", "description": "Thread timestamp to reply in a thread" }
      }
    }
  },
  {
    "name": "slack_list_channels",
    "handler_key": "slack.list_channels",
    "tool_type": "http_call",
    "risk_level": "low",
    "is_write_action": false,
    "description": "List public channels in the Slack workspace",
    "input_schema": {
      "type": "object",
      "properties": {
        "limit": { "type": "integer", "description": "Max channels to return (default 100)" }
      }
    }
  },
  {
    "name": "slack_get_channel_history",
    "handler_key": "slack.get_channel_history",
    "tool_type": "http_call",
    "risk_level": "low",
    "is_write_action": false,
    "description": "Retrieve recent messages from a Slack channel",
    "input_schema": {
      "type": "object",
      "required": ["channel"],
      "properties": {
        "channel": { "type": "string", "description": "Channel ID" },
        "limit": { "type": "integer", "description": "Number of messages (default 20)" }
      }
    }
  }
]'::jsonb
WHERE code = 'slack';

-- Update GitHub tool templates
UPDATE public.integration_catalog
SET tool_templates = '[
  {
    "name": "github_list_repos",
    "handler_key": "github.list_repos",
    "tool_type": "http_call",
    "risk_level": "low",
    "is_write_action": false,
    "description": "List repositories for the authenticated user or org",
    "input_schema": {
      "type": "object",
      "properties": {
        "org": { "type": "string", "description": "Organization name (optional)" },
        "per_page": { "type": "integer", "description": "Results per page (default 30)" }
      }
    }
  },
  {
    "name": "github_create_issue",
    "handler_key": "github.create_issue",
    "tool_type": "http_call",
    "risk_level": "medium",
    "is_write_action": true,
    "description": "Create a new issue in a GitHub repository",
    "input_schema": {
      "type": "object",
      "required": ["owner", "repo", "title"],
      "properties": {
        "owner": { "type": "string", "description": "Repository owner" },
        "repo": { "type": "string", "description": "Repository name" },
        "title": { "type": "string", "description": "Issue title" },
        "body": { "type": "string", "description": "Issue body (markdown)" },
        "labels": { "type": "array", "items": { "type": "string" }, "description": "Labels to apply" }
      }
    }
  },
  {
    "name": "github_get_pull_requests",
    "handler_key": "github.get_pull_requests",
    "tool_type": "http_call",
    "risk_level": "low",
    "is_write_action": false,
    "description": "List pull requests for a repository",
    "input_schema": {
      "type": "object",
      "required": ["owner", "repo"],
      "properties": {
        "owner": { "type": "string", "description": "Repository owner" },
        "repo": { "type": "string", "description": "Repository name" },
        "state": { "type": "string", "enum": ["open", "closed", "all"], "description": "PR state filter" }
      }
    }
  }
]'::jsonb
WHERE code = 'github';

-- Insert GitHub if not present (it may not be in catalog yet)
INSERT INTO public.integration_catalog (
  code, display_name, category, summary, connection_type, access_tier,
  rating, reviews_count, installed_count, featured, auth_type,
  tool_templates, supported_auth, docs_url, config_schema, is_active
)
VALUES (
  'github', 'GitHub', 'Ticketing',
  'List repos, create issues, and track pull requests via AI-governed actions.',
  'oauth', 'free', 4.80, 58, 1620, true, 'oauth2',
  '[{"name":"github_list_repos","handler_key":"github.list_repos","tool_type":"http_call","risk_level":"low","is_write_action":false}]'::jsonb,
  ARRAY['oauth2','api_token']::text[],
  'https://docs.github.com/en/rest',
  '{"required":["token"],"type":"object"}'::jsonb,
  true
)
ON CONFLICT (code) DO NOTHING;

-- Update GitHub tool templates after upsert
UPDATE public.integration_catalog
SET tool_templates = '[
  {
    "name": "github_list_repos",
    "handler_key": "github.list_repos",
    "tool_type": "http_call",
    "risk_level": "low",
    "is_write_action": false,
    "description": "List repositories for the authenticated user or org",
    "input_schema": {"type":"object","properties":{"org":{"type":"string"},"per_page":{"type":"integer"}}}
  },
  {
    "name": "github_create_issue",
    "handler_key": "github.create_issue",
    "tool_type": "http_call",
    "risk_level": "medium",
    "is_write_action": true,
    "description": "Create a new issue in a GitHub repository",
    "input_schema": {"type":"object","required":["owner","repo","title"],"properties":{"owner":{"type":"string"},"repo":{"type":"string"},"title":{"type":"string"},"body":{"type":"string"},"labels":{"type":"array","items":{"type":"string"}}}}
  },
  {
    "name": "github_get_pull_requests",
    "handler_key": "github.get_pull_requests",
    "tool_type": "http_call",
    "risk_level": "low",
    "is_write_action": false,
    "description": "List pull requests for a repository",
    "input_schema": {"type":"object","required":["owner","repo"],"properties":{"owner":{"type":"string"},"repo":{"type":"string"},"state":{"type":"string","enum":["open","closed","all"]}}}
  }
]'::jsonb
WHERE code = 'github';

-- Update Jira tool templates
UPDATE public.integration_catalog
SET tool_templates = '[
  {
    "name": "jira_create_ticket",
    "handler_key": "jira.create_ticket",
    "tool_type": "http_call",
    "risk_level": "medium",
    "is_write_action": true,
    "description": "Create a new Jira issue/ticket",
    "input_schema": {
      "type": "object",
      "required": ["project_key", "summary", "issue_type"],
      "properties": {
        "project_key": { "type": "string", "description": "Jira project key (e.g. OPS)" },
        "summary": { "type": "string", "description": "Issue summary" },
        "issue_type": { "type": "string", "description": "Issue type (Bug, Task, Story, etc.)" },
        "description": { "type": "string", "description": "Issue description (ADF or plain text)" },
        "priority": { "type": "string", "description": "Priority level" },
        "assignee_email": { "type": "string", "description": "Assignee email address" }
      }
    }
  },
  {
    "name": "jira_list_issues",
    "handler_key": "jira.list_issues",
    "tool_type": "http_call",
    "risk_level": "low",
    "is_write_action": false,
    "description": "List Jira issues using JQL query",
    "input_schema": {
      "type": "object",
      "properties": {
        "jql": { "type": "string", "description": "JQL query string (e.g. project=OPS AND status=Open)" },
        "max_results": { "type": "integer", "description": "Max results (default 20)" }
      }
    }
  },
  {
    "name": "jira_update_ticket_status",
    "handler_key": "jira.update_ticket_status",
    "tool_type": "http_call",
    "risk_level": "medium",
    "is_write_action": true,
    "description": "Transition a Jira issue to a new status",
    "input_schema": {
      "type": "object",
      "required": ["issue_key", "transition_name"],
      "properties": {
        "issue_key": { "type": "string", "description": "Jira issue key (e.g. OPS-123)" },
        "transition_name": { "type": "string", "description": "Target status name (e.g. In Progress, Done)" }
      }
    }
  }
]'::jsonb
WHERE code = 'jira';

-- Update HubSpot tool templates
UPDATE public.integration_catalog
SET tool_templates = '[
  {
    "name": "hubspot_create_contact",
    "handler_key": "hubspot.create_contact",
    "tool_type": "http_call",
    "risk_level": "medium",
    "is_write_action": true,
    "description": "Create a new contact in HubSpot CRM",
    "input_schema": {
      "type": "object",
      "required": ["email"],
      "properties": {
        "email": { "type": "string", "description": "Contact email address" },
        "firstname": { "type": "string", "description": "First name" },
        "lastname": { "type": "string", "description": "Last name" },
        "company": { "type": "string", "description": "Company name" },
        "phone": { "type": "string", "description": "Phone number" }
      }
    }
  },
  {
    "name": "hubspot_list_deals",
    "handler_key": "hubspot.list_deals",
    "tool_type": "http_call",
    "risk_level": "low",
    "is_write_action": false,
    "description": "List deals from HubSpot CRM pipeline",
    "input_schema": {
      "type": "object",
      "properties": {
        "limit": { "type": "integer", "description": "Max deals to return (default 20)" },
        "pipeline_id": { "type": "string", "description": "Filter by pipeline ID" }
      }
    }
  },
  {
    "name": "hubspot_update_deal",
    "handler_key": "hubspot.update_deal",
    "tool_type": "http_call",
    "risk_level": "medium",
    "is_write_action": true,
    "description": "Update deal properties in HubSpot",
    "input_schema": {
      "type": "object",
      "required": ["deal_id"],
      "properties": {
        "deal_id": { "type": "string", "description": "HubSpot deal ID" },
        "dealname": { "type": "string", "description": "Deal name" },
        "amount": { "type": "number", "description": "Deal amount" },
        "dealstage": { "type": "string", "description": "Pipeline stage name" },
        "closedate": { "type": "string", "description": "Expected close date (ISO 8601)" }
      }
    }
  }
]'::jsonb
WHERE code = 'hubspot';

-- Update Notion tool templates
UPDATE public.integration_catalog
SET tool_templates = '[
  {
    "name": "notion_create_page",
    "handler_key": "notion.create_page",
    "tool_type": "http_call",
    "risk_level": "medium",
    "is_write_action": true,
    "description": "Create a new page in a Notion database or as a child of another page",
    "input_schema": {
      "type": "object",
      "required": ["parent_id", "title"],
      "properties": {
        "parent_id": { "type": "string", "description": "Parent page or database ID" },
        "parent_type": { "type": "string", "enum": ["page_id", "database_id"], "description": "Type of parent" },
        "title": { "type": "string", "description": "Page title" },
        "content": { "type": "string", "description": "Page content (plain text)" }
      }
    }
  },
  {
    "name": "notion_search_pages",
    "handler_key": "notion.search_pages",
    "tool_type": "http_call",
    "risk_level": "low",
    "is_write_action": false,
    "description": "Search pages and databases in Notion",
    "input_schema": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "Search query" },
        "filter_type": { "type": "string", "enum": ["page", "database"], "description": "Filter by object type" },
        "page_size": { "type": "integer", "description": "Results per page (default 10)" }
      }
    }
  },
  {
    "name": "notion_get_database",
    "handler_key": "notion.get_database",
    "tool_type": "http_call",
    "risk_level": "low",
    "is_write_action": false,
    "description": "Retrieve a Notion database schema and recent entries",
    "input_schema": {
      "type": "object",
      "required": ["database_id"],
      "properties": {
        "database_id": { "type": "string", "description": "Notion database ID" },
        "page_size": { "type": "integer", "description": "Max rows to return (default 20)" }
      }
    }
  }
]'::jsonb
WHERE code = 'notion';

-- Update Google Drive tool templates
UPDATE public.integration_catalog
SET tool_templates = '[
  {
    "name": "gdrive_list_files",
    "handler_key": "gdrive.list_files",
    "tool_type": "http_call",
    "risk_level": "low",
    "is_write_action": false,
    "description": "List files in Google Drive",
    "input_schema": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "Drive search query (e.g. mimeType=''application/pdf'')" },
        "page_size": { "type": "integer", "description": "Max files to return (default 20)" },
        "folder_id": { "type": "string", "description": "Restrict to a specific folder ID" }
      }
    }
  },
  {
    "name": "gdrive_get_file_content",
    "handler_key": "gdrive.get_file_content",
    "tool_type": "http_call",
    "risk_level": "low",
    "is_write_action": false,
    "description": "Retrieve the text content of a Google Doc or file",
    "input_schema": {
      "type": "object",
      "required": ["file_id"],
      "properties": {
        "file_id": { "type": "string", "description": "Google Drive file ID" },
        "export_mime_type": { "type": "string", "description": "MIME type for export (default text/plain)" }
      }
    }
  },
  {
    "name": "gdrive_upload_file",
    "handler_key": "gdrive.upload_file",
    "tool_type": "http_call",
    "risk_level": "medium",
    "is_write_action": true,
    "description": "Upload or create a file in Google Drive",
    "input_schema": {
      "type": "object",
      "required": ["name", "content"],
      "properties": {
        "name": { "type": "string", "description": "File name" },
        "content": { "type": "string", "description": "Text content for the file" },
        "mime_type": { "type": "string", "description": "MIME type (default text/plain)" },
        "folder_id": { "type": "string", "description": "Parent folder ID" }
      }
    }
  }
]'::jsonb
WHERE code = 'google_drive';

-- Note: tool_registry rows for marketplace tools are NOT inserted here.
-- The worker's loadTenantTools reads tool_templates from integration_catalog
-- for each installed integration and builds RuntimeTool objects dynamically.
-- This avoids the tenant_id FK constraint and keeps catalog data in one place.
