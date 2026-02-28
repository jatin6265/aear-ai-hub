-- Notification settings backend for /dashboard/settings/notifications

CREATE TABLE IF NOT EXISTS public.notification_channel_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  email_enabled boolean NOT NULL DEFAULT true,
  email_address text,
  slack_enabled boolean NOT NULL DEFAULT false,
  slack_workspace text,
  slack_channel text,
  webhook_enabled boolean NOT NULL DEFAULT false,
  webhook_url text,
  webhook_secret text,
  in_app_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_channel_webhook_url_http
    CHECK (webhook_url IS NULL OR webhook_url ~* '^https?://'),
  CONSTRAINT notification_channel_in_app_always_on
    CHECK (in_app_enabled = true)
);

CREATE TABLE IF NOT EXISTS public.notification_type_preferences (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  event_name text NOT NULL,
  in_app boolean NOT NULL DEFAULT true,
  email boolean NOT NULL DEFAULT true,
  slack boolean NOT NULL DEFAULT false,
  webhook boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_key),
  CONSTRAINT notification_type_event_key_not_blank CHECK (length(trim(event_key)) > 0),
  CONSTRAINT notification_type_in_app_always_on CHECK (in_app = true)
);

CREATE TABLE IF NOT EXISTS public.notification_digest_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  daily_digest_enabled boolean NOT NULL DEFAULT false,
  daily_digest_time time NOT NULL DEFAULT '09:00:00',
  weekly_report_enabled boolean NOT NULL DEFAULT false,
  weekly_report_day integer NOT NULL DEFAULT 1 CHECK (weekly_report_day BETWEEN 0 AND 6),
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.notification_channel_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_type_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_digest_settings ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS notification_type_preferences_tenant_sort_idx
  ON public.notification_type_preferences (tenant_id, sort_order, event_key);

DO $$
BEGIN
  IF to_regproc('public.set_updated_at_timestamp') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS notification_channel_settings_set_updated_at ON public.notification_channel_settings;
    CREATE TRIGGER notification_channel_settings_set_updated_at
      BEFORE UPDATE ON public.notification_channel_settings
      FOR EACH ROW
      EXECUTE FUNCTION public.set_updated_at_timestamp();

    DROP TRIGGER IF EXISTS notification_type_preferences_set_updated_at ON public.notification_type_preferences;
    CREATE TRIGGER notification_type_preferences_set_updated_at
      BEFORE UPDATE ON public.notification_type_preferences
      FOR EACH ROW
      EXECUTE FUNCTION public.set_updated_at_timestamp();

    DROP TRIGGER IF EXISTS notification_digest_settings_set_updated_at ON public.notification_digest_settings;
    CREATE TRIGGER notification_digest_settings_set_updated_at
      BEFORE UPDATE ON public.notification_digest_settings
      FOR EACH ROW
      EXECUTE FUNCTION public.set_updated_at_timestamp();
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'notification_channel_settings'
      AND policyname = 'Tenant members can view notification channel settings'
  ) THEN
    CREATE POLICY "Tenant members can view notification channel settings"
      ON public.notification_channel_settings
      FOR SELECT TO authenticated
      USING (tenant_id = public.get_user_tenant_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'notification_type_preferences'
      AND policyname = 'Tenant members can view notification type preferences'
  ) THEN
    CREATE POLICY "Tenant members can view notification type preferences"
      ON public.notification_type_preferences
      FOR SELECT TO authenticated
      USING (tenant_id = public.get_user_tenant_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'notification_digest_settings'
      AND policyname = 'Tenant members can view notification digest settings'
  ) THEN
    CREATE POLICY "Tenant members can view notification digest settings"
      ON public.notification_digest_settings
      FOR SELECT TO authenticated
      USING (tenant_id = public.get_user_tenant_id());
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.seed_notification_preferences(
  p_tenant_id uuid,
  p_email text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.notification_channel_settings (
    tenant_id,
    email_enabled,
    email_address,
    slack_enabled,
    slack_workspace,
    slack_channel,
    webhook_enabled,
    webhook_url,
    webhook_secret,
    in_app_enabled
  )
  VALUES (
    p_tenant_id,
    true,
    NULLIF(trim(COALESCE(p_email, '')), ''),
    false,
    NULL,
    NULL,
    false,
    NULL,
    NULL,
    true
  )
  ON CONFLICT (tenant_id) DO NOTHING;

  INSERT INTO public.notification_digest_settings (
    tenant_id,
    daily_digest_enabled,
    daily_digest_time,
    weekly_report_enabled,
    weekly_report_day,
    timezone
  )
  VALUES (
    p_tenant_id,
    false,
    '09:00:00',
    false,
    1,
    'UTC'
  )
  ON CONFLICT (tenant_id) DO NOTHING;

  INSERT INTO public.notification_type_preferences (
    tenant_id,
    event_key,
    event_name,
    in_app,
    email,
    slack,
    webhook,
    sort_order
  )
  VALUES
    (p_tenant_id, 'approval_request_received', 'Approval Request Received', true, true, true, false, 10),
    (p_tenant_id, 'approval_decided', 'Approval Decided (approved/rejected)', true, true, true, false, 20),
    (p_tenant_id, 'high_risk_action_attempted', 'High Risk Action Attempted', true, true, true, true, 30),
    (p_tenant_id, 'critical_action_blocked', 'Critical Action Blocked', true, true, true, true, 40),
    (p_tenant_id, 'ai_insight_anomaly_detected', 'AI Insight / Anomaly Detected', true, true, false, false, 50),
    (p_tenant_id, 'data_sync_error', 'Data Sync Error', true, true, true, true, 60),
    (p_tenant_id, 'new_team_member_joined', 'New Team Member Joined', true, true, false, false, 70),
    (p_tenant_id, 'plan_limit_warning', 'Plan Limit Warning (80% / 100%)', true, true, true, true, 80),
    (p_tenant_id, 'weekly_summary_report', 'Weekly Summary Report', true, true, false, false, 90)
  ON CONFLICT (tenant_id, event_key) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_notification_settings_payload()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_role text := 'member';
  v_can_manage boolean := false;
  v_email text := '';

  v_channels public.notification_channel_settings%ROWTYPE;
  v_digest public.notification_digest_settings%ROWTYPE;
  v_types jsonb := '[]'::jsonb;

  v_slack_connected boolean := false;
  v_slack_label text := NULL;
  v_slack_last_connected_at timestamptz := NULL;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  SELECT COALESCE(p.role, 'member')
  INTO v_role
  FROM public.profiles p
  WHERE p.id = auth.uid()
    AND p.tenant_id = v_tenant_id
  LIMIT 1;

  v_can_manage := lower(v_role) IN ('owner', 'admin');

  SELECT COALESCE(u.email, '')
  INTO v_email
  FROM auth.users u
  WHERE u.id = auth.uid();

  PERFORM public.seed_notification_preferences(v_tenant_id, v_email);

  SELECT *
  INTO v_channels
  FROM public.notification_channel_settings ncs
  WHERE ncs.tenant_id = v_tenant_id;

  SELECT *
  INTO v_digest
  FROM public.notification_digest_settings nds
  WHERE nds.tenant_id = v_tenant_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'eventKey', ntp.event_key,
        'eventName', ntp.event_name,
        'inApp', ntp.in_app,
        'email', ntp.email,
        'slack', ntp.slack,
        'webhook', ntp.webhook,
        'sortOrder', ntp.sort_order
      )
      ORDER BY ntp.sort_order, ntp.event_name
    ),
    '[]'::jsonb
  )
  INTO v_types
  FROM public.notification_type_preferences ntp
  WHERE ntp.tenant_id = v_tenant_id;

  SELECT true, ic.label, ic.updated_at
  INTO v_slack_connected, v_slack_label, v_slack_last_connected_at
  FROM public.integration_credentials ic
  WHERE ic.tenant_id = v_tenant_id
    AND ic.service = 'slack'
    AND lower(COALESCE(ic.status, 'active')) = 'active'
  ORDER BY ic.updated_at DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'profileRole', lower(v_role),
    'canManage', v_can_manage,
    'channels', jsonb_build_object(
      'emailEnabled', COALESCE(v_channels.email_enabled, true),
      'emailAddress', COALESCE(v_channels.email_address, ''),
      'slackEnabled', COALESCE(v_channels.slack_enabled, false),
      'slackWorkspace', COALESCE(v_channels.slack_workspace, ''),
      'slackChannel', COALESCE(v_channels.slack_channel, ''),
      'webhookEnabled', COALESCE(v_channels.webhook_enabled, false),
      'webhookUrl', COALESCE(v_channels.webhook_url, ''),
      'webhookSecretMasked',
        CASE
          WHEN NULLIF(COALESCE(v_channels.webhook_secret, ''), '') IS NULL THEN ''
          ELSE repeat('•', 8) || right(v_channels.webhook_secret, 4)
        END,
      'inAppEnabled', true
    ),
    'slackIntegration', jsonb_build_object(
      'connected', COALESCE(v_slack_connected, false),
      'label', COALESCE(v_slack_label, ''),
      'lastConnectedAt', v_slack_last_connected_at
    ),
    'notificationTypes', v_types,
    'digest', jsonb_build_object(
      'dailyDigestEnabled', COALESCE(v_digest.daily_digest_enabled, false),
      'dailyDigestTime', COALESCE(to_char(v_digest.daily_digest_time, 'HH24:MI'), '09:00'),
      'weeklyReportEnabled', COALESCE(v_digest.weekly_report_enabled, false),
      'weeklyReportDay', COALESCE(v_digest.weekly_report_day, 1),
      'timezone', COALESCE(v_digest.timezone, 'UTC')
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.save_notification_channel_settings(
  p_email_enabled boolean,
  p_email_address text,
  p_slack_enabled boolean,
  p_slack_workspace text,
  p_slack_channel text,
  p_webhook_enabled boolean,
  p_webhook_url text,
  p_webhook_secret text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_role text := 'member';
  v_channels public.notification_channel_settings%ROWTYPE;

  v_email text := NULLIF(trim(COALESCE(p_email_address, '')), '');
  v_workspace text := NULLIF(trim(COALESCE(p_slack_workspace, '')), '');
  v_channel text := NULLIF(trim(COALESCE(p_slack_channel, '')), '');
  v_webhook_url text := NULLIF(trim(COALESCE(p_webhook_url, '')), '');
  v_secret_input text := NULLIF(trim(COALESCE(p_webhook_secret, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  SELECT COALESCE(p.role, 'member')
  INTO v_role
  FROM public.profiles p
  WHERE p.id = auth.uid()
    AND p.tenant_id = v_tenant_id
  LIMIT 1;

  IF lower(v_role) NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only owner/admin can update notification channels';
  END IF;

  PERFORM public.seed_notification_preferences(v_tenant_id, p_email_address);

  IF COALESCE(p_webhook_enabled, false) AND v_webhook_url IS NULL THEN
    RAISE EXCEPTION 'Webhook URL is required when webhook is enabled';
  END IF;

  IF v_webhook_url IS NOT NULL AND v_webhook_url !~* '^https?://' THEN
    RAISE EXCEPTION 'Webhook URL must start with http:// or https://';
  END IF;

  UPDATE public.notification_channel_settings ncs
  SET
    email_enabled = COALESCE(p_email_enabled, ncs.email_enabled),
    email_address = COALESCE(v_email, ncs.email_address),
    slack_enabled = COALESCE(p_slack_enabled, ncs.slack_enabled),
    slack_workspace = COALESCE(v_workspace, ncs.slack_workspace),
    slack_channel = COALESCE(v_channel, ncs.slack_channel),
    webhook_enabled = COALESCE(p_webhook_enabled, ncs.webhook_enabled),
    webhook_url = COALESCE(v_webhook_url, ncs.webhook_url),
    webhook_secret = CASE WHEN v_secret_input IS NULL THEN ncs.webhook_secret ELSE v_secret_input END,
    in_app_enabled = true,
    updated_at = now()
  WHERE ncs.tenant_id = v_tenant_id
  RETURNING * INTO v_channels;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'notification.channels.update',
    'notification_settings',
    'success',
    jsonb_build_object(
      'emailEnabled', COALESCE(p_email_enabled, v_channels.email_enabled),
      'slackEnabled', COALESCE(p_slack_enabled, v_channels.slack_enabled),
      'webhookEnabled', COALESCE(p_webhook_enabled, v_channels.webhook_enabled)
    )
  );

  RETURN jsonb_build_object(
    'emailEnabled', COALESCE(v_channels.email_enabled, true),
    'emailAddress', COALESCE(v_channels.email_address, ''),
    'slackEnabled', COALESCE(v_channels.slack_enabled, false),
    'slackWorkspace', COALESCE(v_channels.slack_workspace, ''),
    'slackChannel', COALESCE(v_channels.slack_channel, ''),
    'webhookEnabled', COALESCE(v_channels.webhook_enabled, false),
    'webhookUrl', COALESCE(v_channels.webhook_url, ''),
    'webhookSecretMasked',
      CASE
        WHEN NULLIF(COALESCE(v_channels.webhook_secret, ''), '') IS NULL THEN ''
        ELSE repeat('•', 8) || right(v_channels.webhook_secret, 4)
      END,
    'inAppEnabled', true
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.save_notification_type_preferences(p_preferences jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_role text := 'member';
  v_updated integer := 0;
  v_item jsonb;
  v_event_key text;
  v_email boolean;
  v_slack boolean;
  v_webhook boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  SELECT COALESCE(p.role, 'member')
  INTO v_role
  FROM public.profiles p
  WHERE p.id = auth.uid()
    AND p.tenant_id = v_tenant_id
  LIMIT 1;

  IF lower(v_role) NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only owner/admin can update notification type preferences';
  END IF;

  IF p_preferences IS NULL OR jsonb_typeof(p_preferences) <> 'array' THEN
    RAISE EXCEPTION 'Preferences payload must be a JSON array';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_preferences)
  LOOP
    v_event_key := lower(trim(COALESCE(v_item->>'eventKey', '')));
    IF v_event_key = '' THEN
      CONTINUE;
    END IF;

    v_email := CASE
      WHEN v_item ? 'email' THEN COALESCE((v_item->>'email')::boolean, false)
      ELSE NULL
    END;

    v_slack := CASE
      WHEN v_item ? 'slack' THEN COALESCE((v_item->>'slack')::boolean, false)
      ELSE NULL
    END;

    v_webhook := CASE
      WHEN v_item ? 'webhook' THEN COALESCE((v_item->>'webhook')::boolean, false)
      ELSE NULL
    END;

    UPDATE public.notification_type_preferences ntp
    SET
      email = COALESCE(v_email, ntp.email),
      slack = COALESCE(v_slack, ntp.slack),
      webhook = COALESCE(v_webhook, ntp.webhook),
      in_app = true,
      updated_at = now()
    WHERE ntp.tenant_id = v_tenant_id
      AND ntp.event_key = v_event_key;

    IF FOUND THEN
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'notification.types.update',
    'notification_settings',
    'success',
    jsonb_build_object('updatedCount', v_updated)
  );

  RETURN jsonb_build_object('updatedCount', v_updated);
END;
$$;

CREATE OR REPLACE FUNCTION public.save_notification_digest_settings(
  p_daily_digest_enabled boolean,
  p_daily_digest_time time,
  p_weekly_report_enabled boolean,
  p_weekly_report_day integer,
  p_timezone text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_role text := 'member';
  v_digest public.notification_digest_settings%ROWTYPE;
  v_timezone text := NULLIF(trim(COALESCE(p_timezone, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  SELECT COALESCE(p.role, 'member')
  INTO v_role
  FROM public.profiles p
  WHERE p.id = auth.uid()
    AND p.tenant_id = v_tenant_id
  LIMIT 1;

  IF lower(v_role) NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only owner/admin can update digest settings';
  END IF;

  PERFORM public.seed_notification_preferences(v_tenant_id, NULL);

  IF p_weekly_report_day IS NOT NULL AND (p_weekly_report_day < 0 OR p_weekly_report_day > 6) THEN
    RAISE EXCEPTION 'weeklyReportDay must be between 0 and 6';
  END IF;

  UPDATE public.notification_digest_settings nds
  SET
    daily_digest_enabled = COALESCE(p_daily_digest_enabled, nds.daily_digest_enabled),
    daily_digest_time = COALESCE(p_daily_digest_time, nds.daily_digest_time),
    weekly_report_enabled = COALESCE(p_weekly_report_enabled, nds.weekly_report_enabled),
    weekly_report_day = COALESCE(p_weekly_report_day, nds.weekly_report_day),
    timezone = COALESCE(v_timezone, nds.timezone),
    updated_at = now()
  WHERE nds.tenant_id = v_tenant_id
  RETURNING * INTO v_digest;

  IF to_regclass('public.tenant_admin_report_settings') IS NOT NULL THEN
    INSERT INTO public.tenant_admin_report_settings (
      tenant_id,
      weekly_email_report_enabled,
      report_timezone,
      report_day_of_week
    )
    VALUES (
      v_tenant_id,
      COALESCE(v_digest.weekly_report_enabled, false),
      COALESCE(v_digest.timezone, 'UTC'),
      COALESCE(v_digest.weekly_report_day, 1)
    )
    ON CONFLICT (tenant_id)
    DO UPDATE SET
      weekly_email_report_enabled = EXCLUDED.weekly_email_report_enabled,
      report_timezone = EXCLUDED.report_timezone,
      report_day_of_week = EXCLUDED.report_day_of_week,
      updated_at = now();
  END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'notification.digest.update',
    'notification_settings',
    'success',
    jsonb_build_object(
      'dailyDigestEnabled', COALESCE(v_digest.daily_digest_enabled, false),
      'weeklyReportEnabled', COALESCE(v_digest.weekly_report_enabled, false),
      'weeklyReportDay', COALESCE(v_digest.weekly_report_day, 1),
      'timezone', COALESCE(v_digest.timezone, 'UTC')
    )
  );

  RETURN jsonb_build_object(
    'dailyDigestEnabled', COALESCE(v_digest.daily_digest_enabled, false),
    'dailyDigestTime', COALESCE(to_char(v_digest.daily_digest_time, 'HH24:MI'), '09:00'),
    'weeklyReportEnabled', COALESCE(v_digest.weekly_report_enabled, false),
    'weeklyReportDay', COALESCE(v_digest.weekly_report_day, 1),
    'timezone', COALESCE(v_digest.timezone, 'UTC')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_notification_test_event()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_role text := 'member';
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  SELECT COALESCE(p.role, 'member')
  INTO v_role
  FROM public.profiles p
  WHERE p.id = auth.uid()
    AND p.tenant_id = v_tenant_id
  LIMIT 1;

  IF lower(v_role) NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only owner/admin can send test notifications';
  END IF;

  PERFORM public.seed_notification_preferences(v_tenant_id, NULL);

  INSERT INTO public.notifications (
    tenant_id,
    user_id,
    title,
    body,
    kind,
    metadata
  )
  VALUES (
    v_tenant_id,
    auth.uid(),
    'Test notification from OpsAI',
    'This is a sample in-app notification generated from Notification Preferences.',
    'test_notification',
    jsonb_build_object('source', 'settings.notifications', 'sentAt', now())
  );

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'notification.test.send',
    'notification_settings',
    'success',
    jsonb_build_object('channels', ARRAY['in_app', 'email', 'slack', 'webhook'])
  );

  RETURN jsonb_build_object('queued', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.seed_notification_preferences(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_notification_settings_payload() TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_notification_channel_settings(boolean, text, boolean, text, text, boolean, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_notification_type_preferences(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_notification_digest_settings(boolean, time, boolean, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_notification_test_event() TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'notification_channel_settings'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.notification_channel_settings';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'notification_type_preferences'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.notification_type_preferences';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'notification_digest_settings'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.notification_digest_settings';
  END IF;
END;
$$;
