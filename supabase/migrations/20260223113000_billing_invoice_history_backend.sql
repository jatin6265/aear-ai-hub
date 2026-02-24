-- Billing invoice history backend for /dashboard/billing.

CREATE OR REPLACE FUNCTION public.get_billing_invoice_history(
  p_year integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_now timestamptz := now();
  v_year integer := COALESCE(p_year, EXTRACT(YEAR FROM v_now)::integer);
  v_invoices jsonb := '[]'::jsonb;
  v_latest_failed jsonb := NULL;
  v_total_spent_cents bigint := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant context found';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', i.id,
        'invoiceNumber', COALESCE(NULLIF(i.provider_invoice_id, ''), 'INV-' || upper(substr(replace(i.id::text, '-', ''), 1, 8))),
        'period', CASE
          WHEN i.period_start IS NOT NULL THEN to_char(i.period_start, 'Mon YYYY')
          WHEN i.created_at IS NOT NULL THEN to_char(i.created_at, 'Mon YYYY')
          ELSE 'N/A'
        END,
        'amountCents', COALESCE(i.total_cents, 0),
        'currency', COALESCE(i.currency, 'usd'),
        'status', CASE
          WHEN lower(COALESCE(i.invoice_status, '')) IN ('paid') THEN 'paid'
          WHEN lower(COALESCE(i.invoice_status, '')) IN ('void', 'voided') THEN 'void'
          WHEN lower(COALESCE(i.invoice_status, '')) IN ('uncollectible', 'failed', 'payment_failed', 'past_due', 'unpaid') THEN 'failed'
          ELSE 'pending'
        END,
        'invoiceDate', COALESCE(i.created_at, i.period_start, i.period_end, i.due_at),
        'dueDate', i.due_at,
        'paymentDate', i.paid_at,
        'pdfUrl', COALESCE(NULLIF(i.hosted_invoice_url, ''), NULLIF(i.invoice_url, ''))
      )
      ORDER BY COALESCE(i.created_at, i.period_end, i.period_start, i.due_at) DESC, i.id DESC
    ),
    '[]'::jsonb
  )
  INTO v_invoices
  FROM public.invoice_snapshots i
  WHERE i.tenant_id = v_tenant_id
    AND EXTRACT(YEAR FROM COALESCE(i.period_start, i.created_at, v_now))::integer = v_year;

  SELECT COALESCE(SUM(i.total_cents), 0)::bigint
  INTO v_total_spent_cents
  FROM public.invoice_snapshots i
  WHERE i.tenant_id = v_tenant_id
    AND EXTRACT(YEAR FROM COALESCE(i.period_start, i.created_at, v_now))::integer = v_year
    AND lower(COALESCE(i.invoice_status, '')) IN ('paid');

  SELECT jsonb_build_object(
    'id', f.id,
    'invoiceNumber', COALESCE(NULLIF(f.provider_invoice_id, ''), 'INV-' || upper(substr(replace(f.id::text, '-', ''), 1, 8))),
    'period', CASE
      WHEN f.period_start IS NOT NULL THEN to_char(f.period_start, 'Mon YYYY')
      WHEN f.created_at IS NOT NULL THEN to_char(f.created_at, 'Mon YYYY')
      ELSE 'N/A'
    END,
    'amountCents', COALESCE(f.total_cents, 0),
    'currency', COALESCE(f.currency, 'usd')
  )
  INTO v_latest_failed
  FROM public.invoice_snapshots f
  WHERE f.tenant_id = v_tenant_id
    AND lower(COALESCE(f.invoice_status, '')) IN ('uncollectible', 'failed', 'payment_failed', 'past_due', 'unpaid')
  ORDER BY COALESCE(f.created_at, f.period_end, f.period_start, f.due_at) DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'year', v_year,
    'invoices', v_invoices,
    'latestFailed', v_latest_failed,
    'yearlyTotalSpentCents', v_total_spent_cents,
    'downloadZipName', 'aear-invoices-' || v_year::text || '.zip'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_billing_invoice_detail(
  p_invoice_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_invoice record;
  v_company_name text;
  v_address_line_1 text;
  v_address_line_2 text;
  v_city text;
  v_state_region text;
  v_postal_code text;
  v_country_code text;
  v_plan_fee_cents integer := 0;
  v_token_overages_cents integer := 0;
  v_storage_cents integer := 0;
  v_line_items jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant context found';
  END IF;

  SELECT *
  INTO v_invoice
  FROM public.invoice_snapshots i
  WHERE i.id = p_invoice_id
    AND i.tenant_id = v_tenant_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  SELECT
    COALESCE(bp.company_name, t.name, 'AEAR Workspace'),
    COALESCE(bp.address_line_1, ''),
    COALESCE(bp.address_line_2, ''),
    COALESCE(bp.city, ''),
    COALESCE(bp.state_region, ''),
    COALESCE(bp.postal_code, ''),
    COALESCE(bp.country_code, 'US')
  INTO
    v_company_name,
    v_address_line_1,
    v_address_line_2,
    v_city,
    v_state_region,
    v_postal_code,
    v_country_code
  FROM public.tenants t
  LEFT JOIN public.tenant_billing_profiles bp
    ON bp.tenant_id = t.id
  WHERE t.id = v_tenant_id
  LIMIT 1;

  v_token_overages_cents := GREATEST(
    COALESCE((v_invoice.metadata ->> 'token_overage_cents')::integer, 0),
    COALESCE((v_invoice.metadata ->> 'tokens_overage_cents')::integer, 0)
  );

  v_storage_cents := GREATEST(
    COALESCE((v_invoice.metadata ->> 'storage_cents')::integer, 0),
    COALESCE((v_invoice.metadata ->> 'storage_overage_cents')::integer, 0)
  );

  v_plan_fee_cents := COALESCE((v_invoice.metadata ->> 'plan_fee_cents')::integer, 0);
  IF v_plan_fee_cents = 0 THEN
    v_plan_fee_cents := GREATEST(COALESCE(v_invoice.subtotal_cents, 0) - v_token_overages_cents - v_storage_cents, 0);
  END IF;

  v_line_items := jsonb_build_array(
    jsonb_build_object('label', 'Plan fee', 'amountCents', v_plan_fee_cents),
    jsonb_build_object('label', 'Token overages', 'amountCents', v_token_overages_cents),
    jsonb_build_object('label', 'Storage', 'amountCents', v_storage_cents),
    jsonb_build_object('label', 'Total', 'amountCents', COALESCE(v_invoice.total_cents, 0))
  );

  RETURN jsonb_build_object(
    'id', v_invoice.id,
    'invoiceNumber', COALESCE(NULLIF(v_invoice.provider_invoice_id, ''), 'INV-' || upper(substr(replace(v_invoice.id::text, '-', ''), 1, 8))),
    'invoiceDate', COALESCE(v_invoice.created_at, v_invoice.period_start, v_invoice.period_end),
    'dueDate', v_invoice.due_at,
    'periodStart', v_invoice.period_start,
    'periodEnd', v_invoice.period_end,
    'currency', COALESCE(v_invoice.currency, 'usd'),
    'status', CASE
      WHEN lower(COALESCE(v_invoice.invoice_status, '')) IN ('paid') THEN 'paid'
      WHEN lower(COALESCE(v_invoice.invoice_status, '')) IN ('void', 'voided') THEN 'void'
      WHEN lower(COALESCE(v_invoice.invoice_status, '')) IN ('uncollectible', 'failed', 'payment_failed', 'past_due', 'unpaid') THEN 'failed'
      ELSE 'pending'
    END,
    'paymentDate', v_invoice.paid_at,
    'pdfUrl', COALESCE(NULLIF(v_invoice.hosted_invoice_url, ''), NULLIF(v_invoice.invoice_url, '')),
    'billTo', jsonb_build_object(
      'companyName', v_company_name,
      'addressLine1', v_address_line_1,
      'addressLine2', v_address_line_2,
      'city', v_city,
      'stateRegion', v_state_region,
      'postalCode', v_postal_code,
      'countryCode', v_country_code
    ),
    'lineItems', v_line_items
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.request_invoice_payment_retry(
  p_invoice_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid := public.get_user_tenant_id();
  v_invoice record;
  v_now timestamptz := now();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenant context found';
  END IF;

  SELECT *
  INTO v_invoice
  FROM public.invoice_snapshots i
  WHERE i.id = p_invoice_id
    AND i.tenant_id = v_tenant_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  UPDATE public.invoice_snapshots i
  SET
    invoice_status = CASE
      WHEN lower(COALESCE(i.invoice_status, '')) IN ('uncollectible', 'failed', 'payment_failed', 'past_due', 'unpaid') THEN 'open'
      ELSE i.invoice_status
    END,
    metadata = COALESCE(i.metadata, '{}'::jsonb) || jsonb_build_object(
      'retry_requested_at', v_now,
      'retry_requested_by', auth.uid()::text
    ),
    updated_at = v_now
  WHERE i.id = p_invoice_id
    AND i.tenant_id = v_tenant_id;

  INSERT INTO public.billing_events (
    tenant_id,
    provider,
    provider_event_id,
    event_type,
    payload,
    status,
    processed_at
  )
  VALUES (
    v_tenant_id,
    'internal',
    'invoice_retry_' || p_invoice_id::text || '_' || extract(epoch FROM v_now)::bigint::text,
    'invoice.retry_requested',
    jsonb_build_object(
      'invoiceId', p_invoice_id,
      'providerInvoiceId', v_invoice.provider_invoice_id,
      'requestedBy', auth.uid()::text
    ),
    'processed',
    v_now
  );

  INSERT INTO public.audit_logs (tenant_id, user_id, action, resource, status, details)
  VALUES (
    v_tenant_id,
    auth.uid(),
    'billing.invoice.retry',
    p_invoice_id::text,
    'success',
    jsonb_build_object(
      'providerInvoiceId', v_invoice.provider_invoice_id,
      'requestedAt', v_now
    )
  );

  RETURN jsonb_build_object(
    'accepted', true,
    'invoiceId', p_invoice_id,
    'message', 'Retry payment request submitted'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_billing_invoice_history(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_billing_invoice_detail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_invoice_payment_retry(uuid) TO authenticated;

