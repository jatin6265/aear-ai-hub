-- Reusable simulation preview backend contract used by chat action cards and approval review modal.

CREATE OR REPLACE FUNCTION public.simulate_action_preview(
  p_action text DEFAULT NULL,
  p_resource text DEFAULT NULL,
  p_risk_level text DEFAULT 'medium',
  p_existing_preview jsonb DEFAULT '{}'::jsonb,
  p_params jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action text := trim(COALESCE(p_action, ''));
  v_resource text := trim(COALESCE(p_resource, ''));
  v_risk text := lower(trim(COALESCE(p_risk_level, 'medium')));
  v_existing jsonb := COALESCE(p_existing_preview, '{}'::jsonb);
  v_params jsonb := COALESCE(p_params, '{}'::jsonb);

  v_records integer := 1;
  v_reversible boolean := true;
  v_reversible_reason text := 'Compensation update is available for modified rows.';
  v_estimated text := '< 100ms';
  v_data_scope text := 'Within governed tenant data only';

  v_preview_rows jsonb := '[]'::jsonb;
  v_downstream jsonb := '[]'::jsonb;
  v_risk_factors jsonb := '[]'::jsonb;
  v_rollback text := '';
  v_bulk_enabled boolean := false;
  v_bulk_remaining integer := 0;
  v_has_where boolean := false;
  v_has_backup boolean := true;
  v_affects_financial boolean := false;
  v_business_hours boolean := false;
  v_hour integer;
BEGIN
  IF v_risk NOT IN ('low', 'medium', 'high', 'critical') THEN
    v_risk := 'medium';
  END IF;

  v_records := GREATEST(
    COALESCE(NULLIF((v_existing ->> 'recordCount')::integer, 0), NULLIF((v_existing ->> 'affectedRows')::integer, 0), NULLIF((v_existing ->> 'rowsAffected')::integer, 0), NULLIF((v_params ->> 'affected_rows')::integer, 0), 1),
    1
  );

  v_reversible := COALESCE((v_existing ->> 'reversible')::boolean, true);
  IF NOT v_reversible THEN
    v_reversible_reason := 'This action cannot be safely reversed automatically.';
  END IF;

  IF v_records > 250 THEN
    v_estimated := '< 800ms';
  ELSIF v_records > 50 THEN
    v_estimated := '< 300ms';
  ELSE
    v_estimated := '< 100ms';
  END IF;

  IF lower(v_resource) ~ '(finance|invoice|payment|billing|revenue|ledger)' THEN
    v_data_scope := 'Within Finance data only';
  ELSIF lower(v_resource) ~ '(inventory|stock|warehouse|sku)' THEN
    v_data_scope := 'Within Inventory data only';
  ELSIF lower(v_resource) ~ '(hr|employee|payroll)' THEN
    v_data_scope := 'Within HR data only';
  END IF;

  -- Build normalized preview rows from any known shape.
  WITH raw_rows AS (
    SELECT x.value
    FROM jsonb_array_elements(
      COALESCE(
        v_existing -> 'beforeAfterRows',
        v_existing -> 'previewRows',
        v_existing -> 'changes',
        '[]'::jsonb
      )
    ) AS x(value)
  ), normalized AS (
    SELECT
      COALESCE(NULLIF(value ->> 'field', ''), NULLIF(value ->> 'column', ''), NULLIF(value ->> 'key', ''), 'value') AS field,
      COALESCE(value ->> 'currentValue', value ->> 'before', '-') AS current_value,
      COALESCE(value ->> 'newValue', value ->> 'after', '-') AS new_value
    FROM raw_rows
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'field', n.field,
        'currentValue', CASE
          WHEN lower(n.field) ~ '(email|phone|mobile|ssn|aadhaar|pan|address|dob|birth|name)'
            THEN '[masked]'
          ELSE n.current_value
        END,
        'newValue', CASE
          WHEN lower(n.field) ~ '(email|phone|mobile|ssn|aadhaar|pan|address|dob|birth|name)'
            THEN '[masked]'
          ELSE n.new_value
        END,
        'changed', COALESCE(n.current_value, '') IS DISTINCT FROM COALESCE(n.new_value, ''),
        'masked', lower(n.field) ~ '(email|phone|mobile|ssn|aadhaar|pan|address|dob|birth|name)',
        'pii', lower(n.field) ~ '(email|phone|mobile|ssn|aadhaar|pan|address|dob|birth|name)'
      )
      ORDER BY n.field
    ),
    '[]'::jsonb
  ) INTO v_preview_rows
  FROM normalized n;

  IF jsonb_array_length(v_preview_rows) = 0 THEN
    v_preview_rows := jsonb_build_array(
      jsonb_build_object(
        'field', 'status',
        'currentValue', 'current',
        'newValue', 'updated',
        'changed', true,
        'masked', false,
        'pii', false
      )
    );
  END IF;

  v_bulk_enabled := v_records > 3;
  v_bulk_remaining := GREATEST(v_records - 3, 0);

  v_has_where := lower(v_action) ~ '\bwhere\b' OR lower(COALESCE(v_params ->> 'sql', '')) ~ '\bwhere\b';
  v_has_backup := COALESCE((v_params ->> 'has_backup')::boolean, true);
  v_affects_financial := lower(v_resource) ~ '(finance|invoice|payment|billing|revenue|ledger)'
    OR lower(v_action) ~ '(finance|invoice|payment|billing|revenue|ledger)';

  v_hour := EXTRACT(HOUR FROM now())::integer;
  v_business_hours := v_hour BETWEEN 9 AND 18;

  v_risk_factors := jsonb_build_array(
    jsonb_build_object('label', 'Has WHERE clause (not mass update)', 'passed', v_has_where),
    jsonb_build_object('label', 'Target table has backup', 'passed', v_has_backup),
    jsonb_build_object('label', 'Affects financial calculations', 'passed', v_affects_financial),
    jsonb_build_object('label', 'Within business hours', 'passed', v_business_hours)
  );

  IF jsonb_typeof(v_existing -> 'downstreamEffects') = 'array' THEN
    v_downstream := v_existing -> 'downstreamEffects';
  ELSE
    v_downstream := jsonb_build_array(
      'Inventory reports will be recalculated',
      '3 related records may be updated'
    );

    IF v_affects_financial THEN
      v_downstream := jsonb_build_array(
        'Financial dashboards will be recalculated',
        'Ledger-derived analytics may refresh',
        'Downstream billing reports may change'
      );
    ELSIF lower(v_resource) ~ '(inventory|stock|warehouse|sku)' THEN
      v_downstream := jsonb_build_array(
        'Inventory reports will be recalculated',
        'Related stock snapshots will refresh',
        'Low-stock alerts may be re-evaluated'
      );
    END IF;
  END IF;

  IF v_reversible THEN
    v_rollback := COALESCE(
      NULLIF(v_existing ->> 'rollbackInfo', ''),
      format(
        'Compensation action: SET %s = %L WHERE id = ''...''',
        COALESCE(v_preview_rows -> 0 ->> 'field', 'value'),
        COALESCE(v_preview_rows -> 0 ->> 'currentValue', 'previous')
      )
    );
  ELSE
    v_rollback := 'No automatic rollback available for this action.';
  END IF;

  RETURN jsonb_build_object(
    'recordsAffected', v_records,
    'reversible', v_reversible,
    'reversibleExplanation', v_reversible_reason,
    'estimatedExecutionTime', COALESCE(NULLIF(v_existing ->> 'estimatedExecutionTime', ''), v_estimated),
    'dataScope', COALESCE(NULLIF(v_existing ->> 'dataScope', ''), v_data_scope),
    'beforeAfterRows', v_preview_rows,
    'bulkPreview', jsonb_build_object(
      'enabled', v_bulk_enabled,
      'shownCount', LEAST(v_records, 3),
      'remainingCount', v_bulk_remaining,
      'message', CASE
        WHEN v_bulk_enabled THEN format('Preview of first 3 records + %s more', v_bulk_remaining)
        ELSE 'Preview of affected records'
      END
    ),
    'downstreamEffects', v_downstream,
    'riskFactors', v_risk_factors,
    'rollbackInfo', v_rollback,
    'undoWindowSeconds', COALESCE(NULLIF((v_existing ->> 'undoWindowSeconds')::integer, 0), 30),
    'highRiskWarning', CASE
      WHEN v_risk IN ('high', 'critical') THEN 'This is a high-risk action. Review carefully.'
      ELSE NULL
    END,
    'dryRun', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.simulate_action_preview(text, text, text, jsonb, jsonb) TO authenticated;
