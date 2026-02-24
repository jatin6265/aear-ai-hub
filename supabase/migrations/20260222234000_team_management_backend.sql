-- Team management backend completion: members lifecycle, invitation controls, and payload RPC.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS last_active_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'profiles_status_check'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_status_check
      CHECK (status IN ('active', 'suspended', 'removed'));
  END IF;
END;
$$;

ALTER TABLE public.team_invitations
  ADD COLUMN IF NOT EXISTS custom_message text;

CREATE INDEX IF NOT EXISTS profiles_tenant_status_role_idx
  ON public.profiles (tenant_id, status, role, updated_at DESC);

CREATE OR REPLACE FUNCTION public.team_role_rank(p_role text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(COALESCE(p_role, ''))
    WHEN 'owner' THEN 100
    WHEN 'admin' THEN 80
    WHEN 'manager' THEN 60
    WHEN 'member' THEN 40
    WHEN 'viewer' THEN 20
    ELSE 0
  END;
$$;

CREATE OR REPLACE FUNCTION public.current_user_can_manage_team()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.tenant_id = public.get_user_tenant_id()
      AND COALESCE(p.status, 'active') = 'active'
      AND lower(COALESCE(p.role, '')) IN ('owner', 'admin', 'manager')
  );
$$;

CREATE OR REPLACE FUNCTION public.get_team_management_payload(
  p_search text DEFAULT NULL,
  p_role_filter text DEFAULT NULL,
  p_status_filter text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_plan text := 'starter';
  v_seat_limit integer;
  v_used integer := 0;
  v_members jsonb := '[]'::jsonb;
  v_invitations jsonb := '[]'::jsonb;
  v_member_count integer := 0;
  v_invited_count integer := 0;
  v_search text := NULLIF(trim(COALESCE(p_search, '')), '');
  v_role text := NULLIF(lower(trim(COALESCE(p_role_filter, ''))), '');
  v_status text := NULLIF(lower(trim(COALESCE(p_status_filter, ''))), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  IF v_role = 'all' THEN
    v_role := NULL;
  END IF;

  IF v_status = 'all' THEN
    v_status := NULL;
  END IF;

  SELECT COALESCE(t.plan, 'starter')
  INTO v_plan
  FROM public.tenants t
  WHERE t.id = v_tenant_id;

  v_seat_limit := CASE lower(v_plan)
    WHEN 'starter' THEN 25
    WHEN 'pro' THEN 100
    ELSE NULL
  END;

  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'name', COALESCE(NULLIF(trim(p.full_name), ''), split_part(COALESCE(u.email, ''), '@', 1), 'Unknown User'),
          'email', COALESCE(u.email, ''),
          'role', lower(COALESCE(p.role, 'member')),
          'status', COALESCE(p.status, 'active'),
          'lastActiveAt', p.last_active_at,
          'avatarUrl', p.avatar_url,
          'isCurrentUser', p.id = auth.uid()
        )
        ORDER BY public.team_role_rank(p.role) DESC, lower(COALESCE(p.full_name, u.email, '')) ASC
      ),
      '[]'::jsonb
    ),
    COUNT(*)::integer
  INTO v_members, v_member_count
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE p.tenant_id = v_tenant_id
    AND COALESCE(p.status, 'active') <> 'removed'
    AND (
      v_search IS NULL
      OR COALESCE(p.full_name, '') ILIKE ('%' || v_search || '%')
      OR COALESCE(u.email, '') ILIKE ('%' || v_search || '%')
    )
    AND (
      v_role IS NULL
      OR lower(COALESCE(p.role, 'member')) = v_role
    )
    AND (
      v_status IS NULL
      OR (v_status IN ('active', 'suspended') AND COALESCE(p.status, 'active') = v_status)
    );

  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', ti.id,
          'email', ti.email,
          'role', lower(ti.role),
          'status', ti.status,
          'invitedAt', ti.created_at,
          'sentAt', ti.sent_at,
          'expiresAt', ti.expires_at,
          'customMessage', ti.custom_message
        )
        ORDER BY ti.created_at DESC
      ),
      '[]'::jsonb
    ),
    COUNT(*)::integer
  INTO v_invitations, v_invited_count
  FROM public.team_invitations ti
  WHERE ti.tenant_id = v_tenant_id
    AND ti.status IN ('pending', 'sent')
    AND (
      v_search IS NULL
      OR ti.email ILIKE ('%' || v_search || '%')
    )
    AND (
      v_role IS NULL
      OR lower(ti.role) = v_role
    )
    AND (
      v_status IS NULL
      OR v_status = 'invited'
    );

  SELECT
    COUNT(*)::integer
    + (
      SELECT COUNT(*)::integer
      FROM public.team_invitations ti
      WHERE ti.tenant_id = v_tenant_id
        AND ti.status IN ('pending', 'sent')
    )
  INTO v_used
  FROM public.profiles p
  WHERE p.tenant_id = v_tenant_id
    AND COALESCE(p.status, 'active') <> 'removed';

  RETURN jsonb_build_object(
    'members', v_members,
    'invitations', v_invitations,
    'summary', jsonb_build_object(
      'memberCount', v_member_count,
      'invitationCount', v_invited_count,
      'totalCount', v_member_count + v_invited_count
    ),
    'seats', jsonb_build_object(
      'plan', lower(v_plan),
      'used', v_used,
      'limit', v_seat_limit,
      'remaining', CASE WHEN v_seat_limit IS NULL THEN NULL ELSE GREATEST(v_seat_limit - v_used, 0) END,
      'nearLimit', CASE
        WHEN v_seat_limit IS NULL THEN false
        WHEN v_seat_limit = 0 THEN false
        ELSE (v_used::numeric / v_seat_limit::numeric) >= 0.72
      END
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.invite_team_members(
  p_emails text[],
  p_role text DEFAULT 'member',
  p_custom_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_actor_role text;
  v_normalized_role text := lower(trim(COALESCE(p_role, 'member')));
  v_emails text[];
  v_payload jsonb;
  v_inserted integer := 0;
  v_remaining integer := 0;
  v_plan text := 'starter';
  v_limit integer;
  v_used integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant found for authenticated user';
  END IF;

  SELECT lower(COALESCE(p.role, 'member'))
  INTO v_actor_role
  FROM public.profiles p
  WHERE p.id = auth.uid()
    AND p.tenant_id = v_tenant_id;

  IF v_actor_role NOT IN ('owner', 'admin', 'manager') THEN
    RAISE EXCEPTION 'Insufficient permissions to invite members';
  END IF;

  IF v_normalized_role NOT IN ('admin', 'manager', 'member', 'viewer') THEN
    v_normalized_role := 'member';
  END IF;

  SELECT ARRAY_AGG(email)
  INTO v_emails
  FROM (
    SELECT DISTINCT lower(trim(value)) AS email
    FROM unnest(COALESCE(p_emails, ARRAY[]::text[])) AS value
    WHERE trim(COALESCE(value, '')) <> ''
      AND lower(trim(value)) ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$'
    LIMIT 50
  ) normalized;

  IF v_emails IS NULL OR array_length(v_emails, 1) IS NULL THEN
    RAISE EXCEPTION 'Provide at least one valid email address';
  END IF;

  SELECT jsonb_agg(jsonb_build_object('email', email, 'role', v_normalized_role))
  INTO v_payload
  FROM unnest(v_emails) AS email;

  SELECT inserted_count, remaining_slots
  INTO v_inserted, v_remaining
  FROM public.create_team_invitations(v_payload)
  LIMIT 1;

  UPDATE public.team_invitations ti
  SET custom_message = NULLIF(left(trim(COALESCE(p_custom_message, '')), 500), '')
  WHERE ti.tenant_id = v_tenant_id
    AND lower(ti.email) = ANY(v_emails)
    AND ti.status IN ('pending', 'sent');

  SELECT COALESCE(t.plan, 'starter')
  INTO v_plan
  FROM public.tenants t
  WHERE t.id = v_tenant_id;

  v_limit := CASE lower(v_plan)
    WHEN 'starter' THEN 25
    WHEN 'pro' THEN 100
    ELSE NULL
  END;

  SELECT
    COUNT(*)::integer
    + (
      SELECT COUNT(*)::integer
      FROM public.team_invitations ti
      WHERE ti.tenant_id = v_tenant_id
        AND ti.status IN ('pending', 'sent')
    )
  INTO v_used
  FROM public.profiles p
  WHERE p.tenant_id = v_tenant_id
    AND COALESCE(p.status, 'active') <> 'removed';

  RETURN jsonb_build_object(
    'insertedCount', COALESCE(v_inserted, 0),
    'remainingSlots', COALESCE(v_remaining, 0),
    'seats', jsonb_build_object(
      'plan', lower(v_plan),
      'used', v_used,
      'limit', v_limit,
      'remaining', CASE WHEN v_limit IS NULL THEN NULL ELSE GREATEST(v_limit - v_used, 0) END
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.update_team_member_role(
  p_profile_id uuid,
  p_role text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_actor_role text;
  v_actor_rank integer;
  v_target_role text;
  v_target_status text;
  v_target_rank integer;
  v_new_role text := lower(trim(COALESCE(p_role, '')));
  v_new_rank integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_profile_id IS NULL THEN
    RAISE EXCEPTION 'profileId is required';
  END IF;

  IF v_new_role NOT IN ('admin', 'manager', 'member', 'viewer') THEN
    RAISE EXCEPTION 'Invalid role';
  END IF;

  SELECT lower(COALESCE(role, 'member'))
  INTO v_actor_role
  FROM public.profiles
  WHERE id = auth.uid()
    AND tenant_id = v_tenant_id
    AND COALESCE(status, 'active') = 'active';

  IF v_actor_role NOT IN ('owner', 'admin', 'manager') THEN
    RAISE EXCEPTION 'Insufficient permissions to update roles';
  END IF;

  IF p_profile_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot change your own role';
  END IF;

  SELECT lower(COALESCE(role, 'member')), COALESCE(status, 'active')
  INTO v_target_role, v_target_status
  FROM public.profiles
  WHERE id = p_profile_id
    AND tenant_id = v_tenant_id;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Team member not found';
  END IF;

  IF v_target_status = 'removed' THEN
    RAISE EXCEPTION 'Team member is already removed';
  END IF;

  v_actor_rank := public.team_role_rank(v_actor_role);
  v_target_rank := public.team_role_rank(v_target_role);
  v_new_rank := public.team_role_rank(v_new_role);

  IF v_actor_role <> 'owner' AND v_target_rank >= v_actor_rank THEN
    RAISE EXCEPTION 'Cannot modify a member with equal or higher role';
  END IF;

  IF v_actor_role <> 'owner' AND v_new_rank >= v_actor_rank THEN
    RAISE EXCEPTION 'Cannot assign a role equal to or higher than your role';
  END IF;

  UPDATE public.profiles
  SET role = v_new_role
  WHERE id = p_profile_id
    AND tenant_id = v_tenant_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'team.member.role.updated',
    'profiles',
    'success',
    jsonb_build_object('profileId', p_profile_id, 'role', v_new_role)
  );

  RETURN jsonb_build_object('id', p_profile_id, 'role', v_new_role);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_team_member_status(
  p_profile_id uuid,
  p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_actor_role text;
  v_actor_rank integer;
  v_target_role text;
  v_target_rank integer;
  v_next_status text := lower(trim(COALESCE(p_status, '')));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_profile_id IS NULL THEN
    RAISE EXCEPTION 'profileId is required';
  END IF;

  IF v_next_status NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;

  SELECT lower(COALESCE(role, 'member'))
  INTO v_actor_role
  FROM public.profiles
  WHERE id = auth.uid()
    AND tenant_id = v_tenant_id
    AND COALESCE(status, 'active') = 'active';

  IF v_actor_role NOT IN ('owner', 'admin', 'manager') THEN
    RAISE EXCEPTION 'Insufficient permissions to update member status';
  END IF;

  IF p_profile_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot change your own status';
  END IF;

  SELECT lower(COALESCE(role, 'member'))
  INTO v_target_role
  FROM public.profiles
  WHERE id = p_profile_id
    AND tenant_id = v_tenant_id
    AND COALESCE(status, 'active') <> 'removed';

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Team member not found';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Owner status cannot be changed';
  END IF;

  v_actor_rank := public.team_role_rank(v_actor_role);
  v_target_rank := public.team_role_rank(v_target_role);

  IF v_actor_role <> 'owner' AND v_target_rank >= v_actor_rank THEN
    RAISE EXCEPTION 'Cannot modify a member with equal or higher role';
  END IF;

  UPDATE public.profiles
  SET status = v_next_status
  WHERE id = p_profile_id
    AND tenant_id = v_tenant_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'team.member.status.updated',
    'profiles',
    'success',
    jsonb_build_object('profileId', p_profile_id, 'status', v_next_status)
  );

  RETURN jsonb_build_object('id', p_profile_id, 'status', v_next_status);
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_team_member(
  p_profile_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_actor_role text;
  v_actor_rank integer;
  v_target_role text;
  v_target_rank integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_profile_id IS NULL THEN
    RAISE EXCEPTION 'profileId is required';
  END IF;

  SELECT lower(COALESCE(role, 'member'))
  INTO v_actor_role
  FROM public.profiles
  WHERE id = auth.uid()
    AND tenant_id = v_tenant_id
    AND COALESCE(status, 'active') = 'active';

  IF v_actor_role NOT IN ('owner', 'admin', 'manager') THEN
    RAISE EXCEPTION 'Insufficient permissions to remove members';
  END IF;

  IF p_profile_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot remove yourself';
  END IF;

  SELECT lower(COALESCE(role, 'member'))
  INTO v_target_role
  FROM public.profiles
  WHERE id = p_profile_id
    AND tenant_id = v_tenant_id
    AND COALESCE(status, 'active') <> 'removed';

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Team member not found';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Owner cannot be removed';
  END IF;

  v_actor_rank := public.team_role_rank(v_actor_role);
  v_target_rank := public.team_role_rank(v_target_role);

  IF v_actor_role <> 'owner' AND v_target_rank >= v_actor_rank THEN
    RAISE EXCEPTION 'Cannot remove a member with equal or higher role';
  END IF;

  UPDATE public.profiles
  SET
    tenant_id = NULL,
    role = 'member',
    status = 'removed'
  WHERE id = p_profile_id
    AND tenant_id = v_tenant_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'team.member.removed',
    'profiles',
    'success',
    jsonb_build_object('profileId', p_profile_id)
  );

  RETURN jsonb_build_object('id', p_profile_id, 'removed', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.manage_team_invitation(
  p_invitation_id uuid,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_actor_role text;
  v_action text := lower(trim(COALESCE(p_action, '')));
  v_invite public.team_invitations%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_invitation_id IS NULL THEN
    RAISE EXCEPTION 'invitationId is required';
  END IF;

  IF v_action NOT IN ('resend', 'cancel') THEN
    RAISE EXCEPTION 'Invalid invitation action';
  END IF;

  SELECT lower(COALESCE(role, 'member'))
  INTO v_actor_role
  FROM public.profiles
  WHERE id = auth.uid()
    AND tenant_id = v_tenant_id
    AND COALESCE(status, 'active') = 'active';

  IF v_actor_role NOT IN ('owner', 'admin', 'manager') THEN
    RAISE EXCEPTION 'Insufficient permissions to manage invitations';
  END IF;

  SELECT *
  INTO v_invite
  FROM public.team_invitations
  WHERE id = p_invitation_id
    AND tenant_id = v_tenant_id;

  IF v_invite.id IS NULL THEN
    RAISE EXCEPTION 'Invitation not found';
  END IF;

  IF v_action = 'cancel' THEN
    UPDATE public.team_invitations
    SET
      status = 'revoked',
      expires_at = now()
    WHERE id = p_invitation_id
      AND tenant_id = v_tenant_id;
  ELSE
    UPDATE public.team_invitations
    SET
      status = 'sent',
      invited_by = auth.uid(),
      sent_at = now(),
      expires_at = now() + interval '14 days'
    WHERE id = p_invitation_id
      AND tenant_id = v_tenant_id;
  END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'team.invitation.' || v_action,
    'team_invitations',
    'success',
    jsonb_build_object('invitationId', p_invitation_id, 'email', v_invite.email)
  );

  SELECT *
  INTO v_invite
  FROM public.team_invitations
  WHERE id = p_invitation_id;

  RETURN jsonb_build_object(
    'id', v_invite.id,
    'email', v_invite.email,
    'status', v_invite.status,
    'expiresAt', v_invite.expires_at,
    'sentAt', v_invite.sent_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.team_role_rank(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_can_manage_team() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_team_management_payload(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.invite_team_members(text[], text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_team_member_role(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_team_member_status(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_team_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.manage_team_invitation(uuid, text) TO authenticated;
