-- Executive Intelligence: Org Graph + Cross-Domain Risk Correlation
--
-- Implements two missing executive-level intelligence RPCs:
--   1. get_entity_relationship_graph   → SVG org-graph nodes + edges
--   2. get_cross_domain_risk_correlations → compound risk when 2+ domains alert simultaneously

-- ─── 1. Entity Relationship Graph ────────────────────────────────────────────
-- Returns connection_entities as graph nodes and connection_relationships as
-- directed edges. Used by the KnowledgeBase "Graph" view.

CREATE OR REPLACE FUNCTION public.get_entity_relationship_graph(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nodes jsonb;
  v_edges jsonb;
BEGIN
  SELECT jsonb_agg(
    jsonb_build_object(
      'id',          e.id::text,
      'name',        e.name,
      'group',       e.entity_group,
      'sourceKind',  e.source_kind,
      'rowCount',    COALESCE(e.row_count, 0),
      'sensitivity', e.sensitivity,
      'connectionId', e.connection_id::text
    ) ORDER BY e.entity_group, e.name
  )
  INTO v_nodes
  FROM public.connection_entities e
  WHERE e.tenant_id = p_tenant_id
  LIMIT 80;

  SELECT jsonb_agg(
    jsonb_build_object(
      'source', r.source_entity_id::text,
      'target', r.target_entity_id::text,
      'type',   r.relation_type,
      'label',  r.label
    )
  )
  INTO v_edges
  FROM public.connection_relationships r
  WHERE r.tenant_id = p_tenant_id
  LIMIT 200;

  RETURN jsonb_build_object(
    'nodes', COALESCE(v_nodes, '[]'::jsonb),
    'edges', COALESCE(v_edges, '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_entity_relationship_graph(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_entity_relationship_graph(uuid) TO service_role;


-- ─── 2. Cross-Domain Risk Correlation ────────────────────────────────────────
-- Scans active anomaly_insights (last 24 h) and detects when 2+ data domains
-- (connections) are simultaneously degraded — a compound risk signal that is
-- stronger than any single-domain alert.
--
-- Returns:
--   correlationScore  0-100  weighted compound score
--   affectedDomains   int    number of domains with active risk
--   riskLevel         text   low / medium / high / critical
--   isCompound        bool   true when 2+ domains affected
--   domains           jsonb  per-domain breakdown
--   topRisks          jsonb  up to 5 most recent individual risk titles

CREATE OR REPLACE FUNCTION public.get_cross_domain_risk_correlations(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  WITH active_risks AS (
    SELECT
      i.connection_id,
      c.name               AS connection_name,
      i.severity,
      i.title,
      i.insight_category,
      i.detected_at
    FROM  public.anomaly_insights i
    LEFT  JOIN public.api_connections c ON c.id = i.connection_id
    WHERE i.tenant_id   = p_tenant_id
      AND i.status      IN ('new', 'acknowledged')
      AND i.detected_at > now() - interval '24 hours'
      AND i.severity    IN ('critical', 'high', 'medium')
  ),
  domain_agg AS (
    SELECT
      connection_id,
      MAX(connection_name)                                      AS domain_name,
      COUNT(*)                                                   AS risk_count,
      MAX(CASE severity WHEN 'critical' THEN 3
                        WHEN 'high'     THEN 2
                        ELSE 1 END)                             AS max_severity_score
    FROM  active_risks
    GROUP BY connection_id
  ),
  totals AS (
    SELECT
      SUM(max_severity_score * risk_count)::int   AS raw_score,
      COUNT(connection_id)::int                   AS affected_domains
    FROM domain_agg
  )
  SELECT jsonb_build_object(
    'correlationScore', LEAST(100, COALESCE(t.raw_score, 0)),
    'affectedDomains',  COALESCE(t.affected_domains, 0),
    'riskLevel',        CASE
                          WHEN COALESCE(t.raw_score, 0) >= 10 THEN 'critical'
                          WHEN COALESCE(t.raw_score, 0) >= 5  THEN 'high'
                          WHEN COALESCE(t.raw_score, 0) >= 2  THEN 'medium'
                          ELSE 'low'
                        END,
    'isCompound',       COALESCE(t.affected_domains, 0) >= 2,
    'domains',          COALESCE((
                          SELECT jsonb_agg(
                            jsonb_build_object(
                              'name',        COALESCE(d.domain_name, 'Unknown'),
                              'riskCount',   d.risk_count,
                              'maxSeverity', CASE d.max_severity_score
                                               WHEN 3 THEN 'critical'
                                               WHEN 2 THEN 'high'
                                               ELSE 'medium'
                                             END
                            ) ORDER BY d.max_severity_score DESC, d.risk_count DESC
                          )
                          FROM domain_agg d
                        ), '[]'::jsonb),
    'topRisks',         COALESCE((
                          SELECT jsonb_agg(
                            jsonb_build_object(
                              'title',      ar.title,
                              'severity',   ar.severity,
                              'domain',     COALESCE(ar.connection_name, 'Unknown'),
                              'detectedAt', ar.detected_at
                            ) ORDER BY ar.detected_at DESC
                          )
                          FROM active_risks ar
                          LIMIT 5
                        ), '[]'::jsonb)
  )
  INTO v_result
  FROM totals t;

  RETURN COALESCE(v_result, jsonb_build_object(
    'correlationScore', 0,
    'affectedDomains',  0,
    'riskLevel',        'low',
    'isCompound',       false,
    'domains',          '[]'::jsonb,
    'topRisks',         '[]'::jsonb
  ));
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_cross_domain_risk_correlations(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_cross_domain_risk_correlations(uuid) TO service_role;
