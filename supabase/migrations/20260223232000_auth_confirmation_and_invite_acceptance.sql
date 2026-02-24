-- Email confirmation handlers and invitation acceptance backend.

CREATE OR REPLACE FUNCTION public.get_team_invitation_by_token(
  p_token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token text := trim(COALESCE(p_token, ''));
  v_invite public.team_invitations%ROWTYPE;
  v_tenant_name text;
BEGIN
  IF v_token = '' THEN
    RETURN jsonb_build_object(
      'valid', false,
      'reason', 'missing_token'
    );
  END IF;

  SELECT ti.*
  INTO v_invite
  FROM public.team_invitations ti
  WHERE ti.token = v_token
  LIMIT 1;

  IF v_invite.id IS NULL THEN
    RETURN jsonb_build_object(
      'valid', false,
      'reason', 'not_found'
    );
  END IF;

  IF v_invite.expires_at IS NOT NULL AND v_invite.expires_at < now() THEN
    IF v_invite.status IN ('pending', 'sent') THEN
      UPDATE public.team_invitations
      SET status = 'expired', updated_at = now()
      WHERE id = v_invite.id;
    END IF;

    RETURN jsonb_build_object(
      'valid', false,
      'reason', 'expired'
    );
  END IF;

  IF v_invite.status NOT IN ('pending', 'sent') THEN
    RETURN jsonb_build_object(
      'valid', false,
      'reason', 'already_used',
      'status', v_invite.status
    );
  END IF;

  SELECT t.name
  INTO v_tenant_name
  FROM public.tenants t
  WHERE t.id = v_invite.tenant_id
  LIMIT 1;

  RETURN jsonb_build_object(
    'valid', true,
    'invitation', jsonb_build_object(
      'id', v_invite.id,
      'tenantId', v_invite.tenant_id,
      'tenantName', COALESCE(v_tenant_name, 'Workspace'),
      'email', v_invite.email,
      'role', lower(v_invite.role),
      'status', v_invite.status,
      'expiresAt', v_invite.expires_at,
      'sentAt', v_invite.sent_at
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_team_invitation_token(
  p_token text,
  p_full_name text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_token text := trim(COALESCE(p_token, ''));
  v_user_email text;
  v_invite public.team_invitations%ROWTYPE;
  v_existing_profile public.profiles%ROWTYPE;
  v_tenant_name text;
  v_effective_name text := NULLIF(trim(COALESCE(p_full_name, '')), '');
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_token = '' THEN
    RAISE EXCEPTION 'Invitation token is required';
  END IF;

  SELECT u.email
  INTO v_user_email
  FROM auth.users u
  WHERE u.id = v_user_id
  LIMIT 1;

  IF v_user_email IS NULL THEN
    RAISE EXCEPTION 'User email not found';
  END IF;

  SELECT ti.*
  INTO v_invite
  FROM public.team_invitations ti
  WHERE ti.token = v_token
  LIMIT 1;

  IF v_invite.id IS NULL THEN
    RAISE EXCEPTION 'Invitation not found';
  END IF;

  IF v_invite.expires_at IS NOT NULL AND v_invite.expires_at < now() THEN
    UPDATE public.team_invitations
    SET status = 'expired', updated_at = now()
    WHERE id = v_invite.id;

    RAISE EXCEPTION 'Invitation link expired';
  END IF;

  IF v_invite.status NOT IN ('pending', 'sent') THEN
    RAISE EXCEPTION 'Invitation is no longer active';
  END IF;

  IF lower(v_invite.email) <> lower(v_user_email) THEN
    RAISE EXCEPTION 'Invitation email does not match authenticated account';
  END IF;

  SELECT p.*
  INTO v_existing_profile
  FROM public.profiles p
  WHERE p.id = v_user_id
  FOR UPDATE;

  IF v_existing_profile.id IS NULL THEN
    INSERT INTO public.profiles (
      id,
      tenant_id,
      role,
      full_name,
      status,
      terms_accepted_at,
      last_active_at
    )
    VALUES (
      v_user_id,
      v_invite.tenant_id,
      lower(v_invite.role),
      v_effective_name,
      'active',
      now(),
      now()
    )
    ON CONFLICT (id)
    DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      role = EXCLUDED.role,
      full_name = COALESCE(EXCLUDED.full_name, public.profiles.full_name),
      status = 'active',
      terms_accepted_at = COALESCE(public.profiles.terms_accepted_at, now()),
      last_active_at = now(),
      updated_at = now();
  ELSE
    IF v_existing_profile.tenant_id IS NOT NULL
      AND v_existing_profile.tenant_id <> v_invite.tenant_id THEN
      RAISE EXCEPTION 'This account already belongs to another workspace';
    END IF;

    UPDATE public.profiles p
    SET
      tenant_id = COALESCE(p.tenant_id, v_invite.tenant_id),
      role = CASE
        WHEN public.team_role_rank(COALESCE(p.role, 'member')) >= public.team_role_rank(v_invite.role)
          THEN lower(COALESCE(p.role, 'member'))
        ELSE lower(v_invite.role)
      END,
      full_name = COALESCE(v_effective_name, p.full_name),
      status = 'active',
      terms_accepted_at = COALESCE(p.terms_accepted_at, now()),
      last_active_at = now(),
      updated_at = now()
    WHERE p.id = v_user_id;
  END IF;

  UPDATE public.team_invitations ti
  SET
    status = 'accepted',
    accepted_at = COALESCE(ti.accepted_at, now()),
    updated_at = now()
  WHERE ti.id = v_invite.id;

  SELECT t.name
  INTO v_tenant_name
  FROM public.tenants t
  WHERE t.id = v_invite.tenant_id
  LIMIT 1;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_invite.tenant_id,
    v_user_id,
    'team.invitation.accepted',
    'team_invitations',
    'success',
    jsonb_build_object(
      'invitationId', v_invite.id,
      'email', lower(v_invite.email),
      'role', lower(v_invite.role)
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'tenantId', v_invite.tenant_id,
    'tenantName', COALESCE(v_tenant_name, 'Workspace'),
    'role', lower(v_invite.role),
    'email', lower(v_invite.email)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_team_invitation_by_token(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_team_invitation_token(text, text) TO authenticated;
