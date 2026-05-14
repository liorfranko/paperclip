    PHASE 1: COMPOSABILITY (make pipelines programmable)
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    What's missing: sub-pipeline execution, dynamic stage generation, pipeline templates.

      a) Sub-pipeline execution
         - Already typed (SubPipelineStage) but throws "not supported"
         - Enables: bug-fix pipeline reuses the review→fix→validate loop
         - Key decision: inline expansion vs nested run tracking?

      b) Dynamic stage generation (the n8n-killer feature)
         - fan_out today requires pre-defined activationKeys
         - Need: a stage that PRODUCES its own downstream stages at runtime
         - Example: "plan-tasks" should create N implementation sub-pipelines
           based on what the planner decides, not what the JSON hardcodes
         - This is where n8n completely fails — it can't generate its own topology

      c) Pipeline templates / inheritance
         - Common patterns (TDD loop, review battery, CI fix loop) should be
           reusable fragments, not copy-pasted across pipeline JSONs
         - Think: stage groups that can be referenced by ID


    PHASE 2: OBSERVABILITY & LEARNING (make pipelines self-improving)
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      a) Stage-level metrics
         - Duration, token cost, success/failure rate per stage
         - Identify bottleneck stages (is de-slop always blocking?)
         - Loop iteration counts: are we always hitting max_iterations?

      b) Pipeline analytics
         - Completion rate by pipeline version
         - Common failure patterns → auto-suggest pipeline improvements
         - "This stage fails 60% of the time when preceded by X"

      c) Feedback loops
         - Scenario validation results feed back to improve planning
         - Review findings correlate with implementation quality
         - Build a dataset: issue → pipeline run → outcome quality score

      d) Adaptive routing
         - If a stage consistently produces "escalate", route around it
         - Confidence-based fan-out: skip reviews for trivial changes
         - Learn which review types actually catch issues vs noise


    PHASE 3: MULTI-REPO / MULTI-AGENT ORCHESTRATION (scale beyond single repo)
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      a) Cross-repo pipelines
         - A feature touches backend + frontend + infra repos
         - Pipeline should orchestrate across repos with their own CI
         - Current model: one pipeline per issue per company
         - Need: multi-workspace execution contexts

      b) Agent specialization marketplace
         - Today: pipe-backend, pipe-frontend, pipe-reviewer, pipe-validator
         - Need: agents declare capabilities, pipeline matches dynamically
         - Enables: "find me an agent that knows React + accessibility"

      c) Workspace isolation
         - Multiple pipeline runs on same repo shouldn't conflict
         - Branch-per-run, worktree management, merge conflict resolution
         - The "concurrent development" problem n8n doesn't even think about


    PHASE 4: ECOSYSTEM & STANDARDIZATION (make it a protocol, not just a tool)
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      a) Pipeline Definition Language (PDL)
         - Formalize the JSON schema as a spec others can implement
         - Like GitHub Actions YAML but for autonomous dev
         - Support: stage types, edge semantics, fan-out/in, loops, blocks

      b) Open agent protocol
         - Standardize how agents report structured output
         - Today: output sentinel parsing (custom format)
         - Could align with OpenClaw or define a new standard
         - Enable any agent framework (Claude Code, Codex, Cursor) to plug in

      c) Pipeline marketplace
         - Share pipeline definitions (like GitHub Actions marketplace)
         - "autonomous-dev" is one pipeline — there should be:
           "security-audit", "dependency-update", "migration", "refactor"
         - Community-contributed stage actions

      d) Governance as code
         - Approval gates encoded in pipeline definition
         - Budget constraints per-stage
         - Compliance requirements as block stages with automated checks


    MY RECOMMENDATIONS FOR IMMEDIATE PRIORITIES:
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    1. DYNAMIC STAGE GENERATION (Phase 1b) — this is the killer differentiator.
       n8n can't do it, GitHub Actions can't do it, no workflow engine can.
       A pipeline that rewrites itself based on what it discovers is fundamentally
       new. You already have the "plan-tasks" stage that SHOULD do this.

    2. SUB-PIPELINE EXECUTION (Phase 1a) — unblocks composability.
       Without it, you're forced to put everything in one giant JSON.

    3. STAGE METRICS (Phase 2a) — you need data to prove this works better.
       "Our pipeline completes features in X hours with Y% success rate"
       is the compelling story.