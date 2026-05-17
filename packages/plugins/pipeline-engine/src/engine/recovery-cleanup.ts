import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { StateMachine } from "./state-machine.js";

const PIPELINE_ORIGIN_PREFIX = "plugin:paperclipai.pipeline-engine";

/**
 * Handles the case where the server's liveness system creates a recovery issue
 * as a child of a pipeline stage sub-issue that is already "done".
 *
 * The liveness monitor fires when it detects an agent hasn't produced a "next step"
 * for an issue — but the pipeline plugin has already completed the stage and moved on.
 * The recovery issue is spurious: it blocks the parent stage issue (and thus the whole
 * pipeline parent) creating disposition thrashing.
 *
 * Fix: When a new issue is created whose parent is a pipeline-managed stage issue
 * in "done" status, immediately cancel the recovery issue and remove any blocking
 * relationships it created.
 */
export async function handleRecoveryIssueCreated(
  ctx: PluginContext,
  event: PluginEvent,
  stateMachine: StateMachine,
): Promise<void> {
  const issueId = event.entityId;
  if (!issueId) return;

  const issue = await ctx.issues.get(issueId, event.companyId);
  if (!issue || !issue.parentId) return;

  // Only interested in system-created recovery issues (liveness monitor)
  // Detection: either the event was emitted by "system" actor, or the issue has
  // originKind "stranded_issue_recovery" (the liveness monitor's fingerprint).
  const isRecoveryIssue =
    event.actorType === "system" ||
    issue.originKind === "stranded_issue_recovery";
  if (!isRecoveryIssue) return;

  // Check if the parent is a pipeline-managed stage issue
  const parent = await ctx.issues.get(issue.parentId, event.companyId);
  if (!parent) return;

  const isPipelineStage = parent.originKind?.startsWith(PIPELINE_ORIGIN_PREFIX);
  if (!isPipelineStage) return;

  // Only act if the parent stage issue is already done (the pipeline completed it)
  if (parent.status !== "done") return;

  ctx.logger.info("Cancelling spurious recovery issue on completed pipeline stage", {
    recoveryIssueId: issueId,
    recoveryTitle: issue.title,
    parentStageIssueId: parent.id,
    parentStageIdentifier: parent.identifier,
    parentStatus: parent.status,
  });

  // 1. Cancel the recovery issue so it doesn't appear as active/blocked
  await ctx.issues.update(issueId, { status: "done" }, event.companyId);

  // 2. Remove any blocking relationship the recovery issue has on the parent stage
  const parentRelations = await ctx.issues.relations.get(parent.id, event.companyId);
  const isBlockingParent = parentRelations.blockedBy.some((b) => b.id === issueId);
  if (isBlockingParent) {
    await ctx.issues.relations.removeBlockers(parent.id, [issueId], event.companyId);
    ctx.logger.info("Removed blocking relationship from recovery issue to parent stage", {
      recoveryIssueId: issueId,
      parentStageIssueId: parent.id,
    });
  }

  // 3. Also check if recovery issue blocks the pipeline root issue (grandparent)
  if (parent.parentId) {
    const grandparentRelations = await ctx.issues.relations.get(parent.parentId, event.companyId);
    const isBlockingGrandparent = grandparentRelations.blockedBy.some((b) => b.id === issueId);
    if (isBlockingGrandparent) {
      await ctx.issues.relations.removeBlockers(parent.parentId, [issueId], event.companyId);
      ctx.logger.info("Removed blocking relationship from recovery issue to pipeline root", {
        recoveryIssueId: issueId,
        pipelineRootIssueId: parent.parentId,
      });
    }
  }
}

/**
 * Handles the case where a pipeline stage sub-issue transitions back to "blocked"
 * after the plugin already marked it as "done". This happens when the liveness
 * system creates a recovery issue and adds it as a blocker AFTER stage completion.
 *
 * Fix: When a pipeline stage issue in the DB (completed stage row) transitions
 * to "blocked", inspect its blockers — if all are non-pipeline recovery issues,
 * cancel them and restore the stage to "done".
 */
export async function handleStageReBlocked(
  ctx: PluginContext,
  event: PluginEvent,
  stateMachine: StateMachine,
): Promise<void> {
  const issueId = event.entityId;
  if (!issueId) return;

  const issue = await ctx.issues.get(issueId, event.companyId);
  if (!issue || issue.status !== "blocked") return;

  // Check if this is a pipeline-managed stage issue
  const isPipelineStage = issue.originKind?.startsWith(PIPELINE_ORIGIN_PREFIX);
  if (!isPipelineStage) return;

  // Check if the pipeline stage is actually completed in our DB
  const stageRow = await stateMachine.getStageBySubIssueId(issueId);
  if (!stageRow || stageRow.status !== "completed") return;

  ctx.logger.info("Pipeline stage re-blocked after completion — checking for recovery issues", {
    issueId,
    identifier: issue.identifier,
  });

  // Get the blockers
  const relations = await ctx.issues.relations.get(issueId, event.companyId);
  if (relations.blockedBy.length === 0) return;

  // Check if ALL blockers are non-pipeline (recovery) issues
  const blockerIds = relations.blockedBy.map((b) => b.id);
  const nonPipelineBlockers: string[] = [];

  for (const blockerId of blockerIds) {
    const blocker = await ctx.issues.get(blockerId, event.companyId);
    if (!blocker) continue;

    const isBlockerPipeline = blocker.originKind?.startsWith(PIPELINE_ORIGIN_PREFIX);
    if (isBlockerPipeline) {
      // A pipeline-managed issue is blocking — this is legitimate, don't touch it
      return;
    }
    nonPipelineBlockers.push(blockerId);
  }

  // All blockers are non-pipeline recovery issues — clean them up
  for (const blockerId of nonPipelineBlockers) {
    await ctx.issues.update(blockerId, { status: "done" }, event.companyId);
    ctx.logger.info("Cancelled recovery blocker on completed pipeline stage", {
      recoveryIssueId: blockerId,
      stageIssueId: issueId,
    });
  }

  // Remove all blocking relationships
  await ctx.issues.relations.removeBlockers(issueId, nonPipelineBlockers, event.companyId);

  // Restore stage issue to "done"
  await ctx.issues.update(issueId, { status: "done" }, event.companyId);
  ctx.logger.info("Restored completed pipeline stage to done status", {
    issueId,
    identifier: issue.identifier,
    removedBlockers: nonPipelineBlockers.length,
  });
}

/**
 * Handles the case where the pipeline root issue transitions to "blocked"
 * because a recovery issue was added as a blocker on a completed child stage.
 *
 * The server's blocker propagation may mark the root "blocked" even though
 * the actual blockers are spurious recovery issues on already-completed stages.
 *
 * Fix: When the root pipeline issue becomes blocked, walk its blockedBy list.
 * For each blocker that is a recovery issue (originKind "stranded_issue_recovery")
 * whose parent stage is already completed, cancel the recovery and remove the relation.
 */
export async function handlePipelineRootBlocked(
  ctx: PluginContext,
  event: PluginEvent,
  stateMachine: StateMachine,
): Promise<void> {
  const issueId = event.entityId;
  if (!issueId) return;

  const issue = await ctx.issues.get(issueId, event.companyId);
  if (!issue || issue.status !== "blocked") return;

  // Only interested in pipeline root issues (have a run in any state)
  const run = await stateMachine.getAnyRunForIssue(issueId, event.companyId);
  if (!run) return;

  const relations = await ctx.issues.relations.get(issueId, event.companyId);

  // Strategy 1: Direct blockers on the root issue
  if (relations.blockedBy.length > 0) {
    const removableBlockerIds: string[] = [];

    for (const blocker of relations.blockedBy) {
      const blockerIssue = await ctx.issues.get(blocker.id, event.companyId);
      if (!blockerIssue) continue;

      // Check if this blocker is a recovery issue on a completed pipeline stage
      if (blockerIssue.originKind !== "stranded_issue_recovery") continue;
      if (!blockerIssue.parentId) continue;

      // Verify the parent stage is completed in pipeline state
      const stageRow = await stateMachine.getStageBySubIssueId(blockerIssue.parentId);
      if (!stageRow || stageRow.status !== "completed") continue;

      removableBlockerIds.push(blocker.id);
    }

    if (removableBlockerIds.length > 0) {
      ctx.logger.info("Pipeline root blocked by spurious recovery issues — cleaning up", {
        issueId,
        identifier: issue.identifier,
        removableBlockers: removableBlockerIds.length,
        totalBlockers: relations.blockedBy.length,
      });

      // Cancel recovery issues and remove blocking relations
      for (const blockerId of removableBlockerIds) {
        await ctx.issues.update(blockerId, { status: "done" }, event.companyId);
      }
      await ctx.issues.relations.removeBlockers(issueId, removableBlockerIds, event.companyId);

      // If we removed ALL blockers, the issue should no longer be blocked
      if (removableBlockerIds.length === relations.blockedBy.length) {
        await ctx.issues.update(issueId, { status: "in_progress" }, event.companyId);
        ctx.logger.info("Restored pipeline root issue from blocked to in_progress", {
          issueId,
          identifier: issue.identifier,
        });
      }
      return;
    }
  }

  // Strategy 2: Sub-issue status propagation — the root is "blocked" because a
  // child recovery issue is in "blocked" state with no actual blockers.
  // Paperclip propagates blocked status up the parent chain via sub-issue inheritance,
  // even without a direct blockedBy relationship on the root.
  // Walk the pipeline's sub-issues to find and cancel orphaned recovery issues.
  await cleanOrphanedRecoveryIssues(ctx, issueId, event.companyId, stateMachine);
}

/**
 * Finds and cancels recovery issues that are children of completed pipeline stages
 * but are stuck in "blocked" status with no actual blockers. This happens when:
 *
 * 1. Stage agent posts pipeline output
 * 2. Liveness monitor fires (creates recovery issue) BEFORE plugin marks stage done
 * 3. Plugin marks stage done and advances pipeline
 * 4. Recovery issue remains "blocked" (no blockers) — orphaned
 * 5. Server propagates "blocked" status up through sub-issue inheritance
 *
 * The recovery issue (originKind "stranded_issue_recovery") is parented to the
 * stage issue, and its blocked status propagates up to the pipeline root via:
 * stage issue → root issue (sub-issue status inheritance).
 */
async function cleanOrphanedRecoveryIssues(
  ctx: PluginContext,
  rootIssueId: string,
  companyId: string,
  stateMachine: StateMachine,
): Promise<void> {
  // Get all stages for this pipeline run to find sub-issue IDs
  const run = await stateMachine.getAnyRunForIssue(rootIssueId, companyId);
  if (!run) return;

  const stages = await stateMachine.getRunStages(run.id);
  const completedStageSubIssueIds = stages
    .filter((s) => s.status === "completed" && s.subIssueId)
    .map((s) => s.subIssueId!);

  if (completedStageSubIssueIds.length === 0) return;

  // For each completed stage, check for child recovery issues stuck in blocked state
  let cleaned = false;
  for (const stageSubIssueId of completedStageSubIssueIds) {
    const recoveryIssues = await ctx.issues.list({
      companyId,
      originId: stageSubIssueId,
      originKind: "stranded_issue_recovery",
    });
    if (!recoveryIssues || recoveryIssues.length === 0) continue;

    for (const child of recoveryIssues) {
      if (child.status === "done" || child.status === "cancelled") continue;

      // This is a recovery issue on a completed stage — cancel it
      ctx.logger.info("Cancelling orphaned recovery issue on completed pipeline stage (sub-issue propagation)", {
        recoveryIssueId: child.id,
        recoveryIdentifier: child.identifier,
        parentStageIssueId: stageSubIssueId,
        recoveryStatus: child.status,
      });

      await ctx.issues.update(child.id, { status: "done" }, companyId);

      // Also remove any blocking relationship it has on the parent stage
      const stageRelations = await ctx.issues.relations.get(stageSubIssueId, companyId);
      const isBlockingStage = stageRelations.blockedBy.some((b) => b.id === child.id);
      if (isBlockingStage) {
        await ctx.issues.relations.removeBlockers(stageSubIssueId, [child.id], companyId);
      }

      cleaned = true;
    }
  }

  // If we cleaned any orphaned recovery issues, restore the root to in_progress
  if (cleaned) {
    // Re-check root status — only restore if still blocked
    const rootIssue = await ctx.issues.get(rootIssueId, companyId);
    if (rootIssue && rootIssue.status === "blocked") {
      await ctx.issues.update(rootIssueId, { status: "in_progress" }, companyId);
      ctx.logger.info("Restored pipeline root from blocked after orphaned recovery cleanup", {
        issueId: rootIssueId,
        identifier: rootIssue.identifier,
      });
    }
  }
}
