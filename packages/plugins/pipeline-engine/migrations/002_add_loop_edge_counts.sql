ALTER TABLE plugin_pipeline_engine_d43f8e84dd.pipeline_runs
  ADD COLUMN IF NOT EXISTS loop_edge_counts JSONB DEFAULT '{}';
