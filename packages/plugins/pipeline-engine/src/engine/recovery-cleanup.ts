import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { StateMachine } from "./state-machine.js";
import type { PipelineRun } from "../types.js";

const PIPELINE_ORIGIN_PREFIX = "plugin:paperclipai.pipeline-engine";
const RECOVERY_ORIGIN_KIND = "stranded_issue_recovery";

function formatError(err: unknown): object | string {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return String(err);
}

export async function handleRecoveryIssueCreated(
  ctx: PluginContext,
  event: PluginEvent,
  stateMachine: StateMachine,
): Promise<void> {
  const issueId = event.entityId;
  if (!issueId) return;

  try {
    const issue = await ctx.issues.get(issueId, event.companyId);
    if (!issue) {
      ctx.logger.warn("Recovery cleanup: issue not found for just-created event", { issueId, companyId: event.companyId });
      return;
    }
    if (!issue.parentId) return;

    const isRecoveryIssue =
      event.actorType === "system" ||
      issue.originKind === RECOVERY_ORIGIN_KIND;
    if (!isRecoveryIssue) return;

    const parent = await ctx.issues.get(issue.parentId, event.companyId);
    if (!parent) return;

    const isPipelineStage = parent.originKind?.startsWith(PIPELINE_ORIGIN_PREFIX);
    if (!isPipelineStage) return;

    if (parent.status !== "done") return;

    ctx.logger.info("Cancelling spurious recovery issue on completed pipeline stage", {
      recoveryIssueId: issueId,
      recoveryTitle: issue.title,
      parentStageIssueId: parent.id,
      parentStageIdentifier: parent.identifier,
      parentStatus: parent.status,
    });

    await ctx.issues.update(issueId, { status: "done" }, event.companyId);

    const parentRelations = await ctx.issues.relations.get(parent.id, event.companyId);
    const isBlockingParent = parentRelations.blockedBy.some((b) => b.id === issueId);
    if (isBlockingParent) {
      await ctx.issues.relations.removeBlockers(parent.id, [issueId], event.companyId);
      ctx.logger.info("Removed blocking relationship from recovery issue to parent stage", {
        recoveryIssueId: issueId,
        parentStageIssueId: parent.id,
      });
    }

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
  } catch (err) {
    ctx.logger.error("Recovery cleanup failed in handleRecoveryIssueCreated", {
      issueId,
      companyId: event.companyId,
      error: formatError(err),
    });
  }
}

export async function handleStageReBlocked(
  ctx: PluginContext,
  event: PluginEvent,
  stateMachine: StateMachine,
): Promise<void> {
  const issueId = event.entityId;
  if (!issueId) return;

  try {
    const issue = await ctx.issues.get(issueId, event.companyId);
    if (!issue || issue.status !== "blocked") return;

    const isPipelineStage = issue.originKind?.startsWith(PIPELINE_ORIGIN_PREFIX);
    if (!isPipelineStage) return;

    const stageRow = await stateMachine.getStageBySubIssueId(issueId);
    if (!stageRow || stageRow.status !== "completed") return;

    ctx.logger.info("Pipeline stage re-blocked after completion — checking for recovery issues", {
      issueId,
      identifier: issue.identifier,
    });

    const relations = await ctx.issues.relations.get(issueId, event.companyId);
    if (relations.blockedBy.length === 0) return;

    const blockerIds = relations.blockedBy.map((b) => b.id);
    const recoveryBlockerIds: string[] = [];

    for (const blockerId of blockerIds) {
      const blocker = await ctx.issues.get(blockerId, event.companyId);
      if (!blocker) {
        recoveryBlockerIds.push(blockerId);
        continue;
      }

      if (blocker.originKind?.startsWith(PIPELINE_ORIGIN_PREFIX)) {
        return;
      }

      if (blocker.originKind === RECOVERY_ORIGIN_KIND) {
        recoveryBlockerIds.push(blockerId);
      }
    }

    if (recoveryBlockerIds.length === 0) return;

    const successfullyClosed: string[] = [];
    for (const blockerId of recoveryBlockerIds) {
      try {
        await ctx.issues.update(blockerId, { status: "done" }, event.companyId);
        successfullyClosed.push(blockerId);
        ctx.logger.info("Cancelled recovery blocker on completed pipeline stage", {
          recoveryIssueId: blockerId,
          stageIssueId: issueId,
        });
      } catch (err) {
        ctx.logger.error("Failed to cancel recovery blocker", {
          recoveryIssueId: blockerId,
          stageIssueId: issueId,
          error: formatError(err),
        });
      }
    }

    if (successfullyClosed.length === 0) return;

    try {
      await ctx.issues.relations.removeBlockers(issueId, successfullyClosed, event.companyId);
    } catch (err) {
      ctx.logger.error("Failed to remove blocker relations after cancelling recovery issues", {
        stageIssueId: issueId,
        blockerIds: successfullyClosed,
        error: formatError(err),
      });
      return;
    }

    if (successfullyClosed.length === recoveryBlockerIds.length) {
      await ctx.issues.update(issueId, { status: "done" }, event.companyId);
      ctx.logger.info("Restored completed pipeline stage to done status", {
        issueId,
        identifier: issue.identifier,
        removedBlockers: successfullyClosed.length,
      });
    }
  } catch (err) {
    ctx.logger.error("Recovery cleanup failed in handleStageReBlocked", {
      issueId,
      companyId: event.companyId,
      error: formatError(err),
    });
  }
}

export async function handlePipelineRootBlocked(
  ctx: PluginContext,
  event: PluginEvent,
  stateMachine: StateMachine,
): Promise<void> {
  const issueId = event.entityId;
  if (!issueId) return;

  try {
    const issue = await ctx.issues.get(issueId, event.companyId);
    if (!issue || issue.status !== "blocked") return;

    const run = await stateMachine.getAnyRunForIssue(issueId, event.companyId);
    if (!run) return;

    const relations = await ctx.issues.relations.get(issueId, event.companyId);

    // Strategy 1: Direct blockers on the root issue
    if (relations.blockedBy.length > 0) {
      const removableBlockerIds: string[] = [];

      for (const blocker of relations.blockedBy) {
        const blockerIssue = await ctx.issues.get(blocker.id, event.companyId);
        if (!blockerIssue) continue;

        if (blockerIssue.originKind !== RECOVERY_ORIGIN_KIND) continue;
        if (!blockerIssue.parentId) continue;

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

        const successfullyClosed: string[] = [];
        for (const blockerId of removableBlockerIds) {
          try {
            await ctx.issues.update(blockerId, { status: "done" }, event.companyId);
            successfullyClosed.push(blockerId);
          } catch (err) {
            ctx.logger.error("Failed to cancel recovery blocker on root", {
              recoveryIssueId: blockerId,
              rootIssueId: issueId,
              error: formatError(err),
            });
          }
        }

        if (successfullyClosed.length > 0) {
          try {
            await ctx.issues.relations.removeBlockers(issueId, successfullyClosed, event.companyId);
          } catch (err) {
            ctx.logger.error("Failed to remove blocker relations from pipeline root", {
              rootIssueId: issueId,
              blockerIds: successfullyClosed,
              error: formatError(err),
            });
            return;
          }

          if (successfullyClosed.length === relations.blockedBy.length) {
            await ctx.issues.update(issueId, { status: "in_progress" }, event.companyId);
            ctx.logger.info("Restored pipeline root issue from blocked to in_progress", {
              issueId,
              identifier: issue.identifier,
            });
          }
        }
        return;
      }
    }

    // Strategy 2: Sub-issue status propagation
    await cleanOrphanedRecoveryIssues(ctx, issueId, event.companyId, stateMachine, run);
  } catch (err) {
    ctx.logger.error("Recovery cleanup failed in handlePipelineRootBlocked", {
      issueId,
      companyId: event.companyId,
      error: formatError(err),
    });
  }
}

async function cleanOrphanedRecoveryIssues(
  ctx: PluginContext,
  rootIssueId: string,
  companyId: string,
  stateMachine: StateMachine,
  run: PipelineRun,
): Promise<void> {
  const stages = await stateMachine.getRunStages(run.id);
  const completedStageSubIssueIds = stages
    .filter((s) => s.status === "completed" && s.subIssueId)
    .map((s) => s.subIssueId!);

  if (completedStageSubIssueIds.length === 0) return;

  let cleaned = false;
  for (const stageSubIssueId of completedStageSubIssueIds) {
    const recoveryIssues = await ctx.issues.list({
      companyId,
      originId: stageSubIssueId,
      originKind: RECOVERY_ORIGIN_KIND,
    });
    if (!recoveryIssues || recoveryIssues.length === 0) continue;

    for (const child of recoveryIssues) {
      if (child.status === "done" || child.status === "cancelled") continue;

      ctx.logger.info("Cancelling orphaned recovery issue on completed pipeline stage (sub-issue propagation)", {
        recoveryIssueId: child.id,
        recoveryIdentifier: child.identifier,
        parentStageIssueId: stageSubIssueId,
        recoveryStatus: child.status,
      });

      try {
        await ctx.issues.update(child.id, { status: "done" }, companyId);

        const stageRelations = await ctx.issues.relations.get(stageSubIssueId, companyId);
        const isBlockingStage = stageRelations.blockedBy.some((b) => b.id === child.id);
        if (isBlockingStage) {
          await ctx.issues.relations.removeBlockers(stageSubIssueId, [child.id], companyId);
        }

        cleaned = true;
      } catch (err) {
        ctx.logger.error("Failed to clean orphaned recovery issue", {
          recoveryIssueId: child.id,
          stageSubIssueId,
          error: formatError(err),
        });
      }
    }
  }

  if (cleaned) {
    const rootIssue = await ctx.issues.get(rootIssueId, companyId);
    const rootRelations = await ctx.issues.relations.get(rootIssueId, companyId);
    if (rootIssue && rootIssue.status === "blocked" && rootRelations.blockedBy.length === 0) {
      await ctx.issues.update(rootIssueId, { status: "in_progress" }, companyId);
      ctx.logger.info("Restored pipeline root from blocked after orphaned recovery cleanup", {
        issueId: rootIssueId,
        identifier: rootIssue.identifier,
      });
    }
  }
}
