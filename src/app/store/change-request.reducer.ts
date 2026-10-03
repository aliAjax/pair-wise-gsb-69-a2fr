import { createReducer, on } from '@ngrx/store';
import {
  ApprovalRecord,
  ApprovalStage,
  ChangeRequest,
  APPROVAL_ORDER,
  changedRelationResourceIds,
  createAudit,
  hasAnyApprovalDecision,
  invalidateApprovalsForReview,
  normalizeChange,
  planSignature,
  recomputeRollback,
  referencesImpacted,
  buildExecutionSnapshot,
} from '../models/change-request.model';
import { ChangeRequestActions } from './change-request.actions';

export interface ChangeRequestState {
  changes: ChangeRequest[];
  loading: boolean;
  error: string | null;
}

export const initialChangeRequestState: ChangeRequestState = {
  changes: [],
  loading: false,
  error: null,
};

const LOCKED_STATUSES: ChangeRequest['status'][] = [
  'executing',
  'completed',
  'rolled_back',
];

const REVIEW_STATUSES: ChangeRequest['status'][] = ['submitted', 'approved'];

function touch(change: ChangeRequest): ChangeRequest {
  return { ...change, updatedAt: new Date().toISOString() };
}

function nextPendingStage(change: ChangeRequest): ApprovalStage | null {
  return APPROVAL_ORDER.find((stage) =>
    change.approvals.some(
      (approval) => approval.stage === stage && approval.state === 'pending',
    ),
  ) ?? null;
}

/**
 * 旧页面提交（版本不一致）的统一处置：
 * 不覆盖新标签页已保存的内容，只把方案留成待复核草稿并使会签失效。
 */
function downgradeToPendingReview(
  change: ChangeRequest,
  expectedVersion: number,
  action: string,
): ChangeRequest {
  const now = new Date().toISOString();
  const detail = `页面基于 v${expectedVersion} 提交${action}，最新版本为 v${change.version}，提交未覆盖新内容，已留为待复核草稿。`;

  if (LOCKED_STATUSES.includes(change.status)) {
    return {
      ...change,
      audit: [createAudit('拒绝过期提交', `${detail}方案已进入执行，步骤不可修改。`, '系统'), ...change.audit],
      updatedAt: now,
    };
  }

  if (change.status === 'pending_review') {
    return {
      ...change,
      audit: [createAudit('过期提交已忽略', detail, '系统'), ...change.audit],
      updatedAt: now,
    };
  }

  const needsInvalidate =
    REVIEW_STATUSES.includes(change.status) || hasAnyApprovalDecision(change);
  const base = needsInvalidate
    ? invalidateApprovalsForReview(change, detail)
    : { ...change, status: 'pending_review' as const };
  return {
    ...base,
    audit: [createAudit('降级待复核', detail, '系统'), ...base.audit],
    updatedAt: now,
  };
}

/** 上游资源关系变化后，把影响传播给依赖它的其他方案。 */
function cascadeRelationChange(
  changes: ChangeRequest[],
  source: ChangeRequest,
  changedIds: string[],
): ChangeRequest[] {
  if (changedIds.length === 0) {
    return changes;
  }

  const nameMap = new Map<string, string>();
  changes.forEach((change) =>
    change.resources.forEach((resource) => nameMap.set(resource.id, resource.name)),
  );
  const changedNames = changedIds
    .map((id) => nameMap.get(id) ?? id)
    .join('、');
  const impactedSet = new Set(changedIds);
  const now = new Date().toISOString();

  return changes.map((change) => {
    if (change.id === source.id || !referencesImpacted(change, impactedSet)) {
      return change;
    }

    if (LOCKED_STATUSES.includes(change.status)) {
      const dedupeKey = changedIds.slice().sort().join('|');
      const alreadyNoticed = change.impactNotices.some(
        (notice) =>
          notice.sourceChangeId === source.id &&
          !notice.acknowledged &&
          notice.changedResourceIds.slice().sort().join('|') === dedupeKey,
      );
      if (alreadyNoticed) {
        return change;
      }
      return {
        ...change,
        impactNotices: [
          {
            id: `notice-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            observedAt: now,
            sourceChangeId: source.id,
            changedResourceIds: [...changedIds],
            detail: `上游方案 ${source.id}（${source.title}）调整了资源关系：${changedNames}。执行步骤维持批准时快照，不在执行中改动。`,
            acknowledged: false,
          },
          ...change.impactNotices,
        ],
        audit: [
          createAudit(
            '挂接影响提示',
            `上游资源关系变化（${changedNames}），执行快照 v${change.executionSnapshot?.version ?? change.version} 保持不变。`,
            '系统',
          ),
          ...change.audit,
        ],
        updatedAt: now,
      };
    }

    const assessment = recomputeRollback(change, now);
    if (REVIEW_STATUSES.includes(change.status)) {
      const reason = `依赖的前置机柜或共享资源（${changedNames}）在 ${source.id} 中发生变化，未执行方案的会签整体失效，回滚能力按新关系重算。`;
      return {
        ...invalidateApprovalsForReview(change, reason, now),
        rollbackAssessment: assessment,
      };
    }

    return {
      ...change,
      rollbackAssessment: assessment,
      audit: [
        createAudit('回滚能力重算', `上游资源关系变化（${changedNames}），已按新关系重新评估回滚步骤。`, '系统'),
        ...change.audit,
      ],
      updatedAt: now,
    };
  });
}

export const changeRequestReducer = createReducer(
  initialChangeRequestState,
  on(ChangeRequestActions.loadChanges, (state) => ({ ...state, loading: true, error: null })),
  on(ChangeRequestActions.loadChangesSuccess, (state, { changes }) => ({
    ...state,
    changes: changes.map(normalizeChange),
    loading: false,
  })),
  on(ChangeRequestActions.loadChangesFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  })),
  on(ChangeRequestActions.syncFromStorage, (state, { changes }) => ({
    ...state,
    changes: changes.map(normalizeChange),
  })),
  on(ChangeRequestActions.createChange, (state, { change }) => ({
    ...state,
    changes: [
      normalizeChange({
        ...change,
        version: 1,
        audit: [createAudit('创建草稿', `创建变更 ${change.id}（方案 v1）`), ...change.audit],
      }),
      ...state.changes,
    ],
  })),
  on(ChangeRequestActions.updateChange, (state, { change: incoming, expectedVersion }) => {
    const current = state.changes.find((item) => item.id === incoming.id);
    if (!current) {
      return state;
    }

    // 审批页打开时记住的版本已落后：旧标签页提交不能覆盖先保存的新内容。
    if (current.version !== expectedVersion) {
      return {
        ...state,
        changes: state.changes.map((item) =>
          item.id === current.id
            ? downgradeToPendingReview(current, expectedVersion, '方案保存')
            : item,
        ),
      };
    }

    const boundChanged =
      planSignature(current) !== planSignature(incoming);
    const now = new Date().toISOString();

    let saved: ChangeRequest = {
      ...incoming,
      version: boundChanged ? current.version + 1 : current.version,
      status: current.status,
      approvals: current.approvals,
      executionSnapshot: current.executionSnapshot,
      impactNotices: current.impactNotices,
      deviations: current.deviations,
      audit: current.audit,
      // 自身版本变化后旧评估作废，由级联逻辑或重新提交后的校验补齐。
      rollbackAssessment: boundChanged ? null : current.rollbackAssessment,
      updatedAt: now,
    };

    if (boundChanged) {
      saved = {
        ...saved,
        audit: [
          createAudit(
            '保存方案新版本',
            `资源依赖、执行窗口或回滚步骤发生变化，版本 v${current.version} → v${saved.version}。`,
          ),
          ...saved.audit,
        ],
      };

      // 会签后又动了绑定内容：本方案会签随之失效，回滚留待按新关系重算。
      if (REVIEW_STATUSES.includes(saved.status) || hasAnyApprovalDecision(saved)) {
        saved = invalidateApprovalsForReview(
          saved,
          `方案在会签后修改了绑定内容并保存为 v${saved.version}，原会签失效。`,
          now,
        );
      }
    } else {
      saved = touch({
        ...saved,
        audit: [createAudit('保存变更方案', '更新标题、摘要等非绑定信息'), ...saved.audit],
      });
    }

    // 资源关系一变，依赖它（含方案内传递依赖）的其他未执行方案会签失效；
    // 执行中的方案只挂影响提示。
    const changedIds = boundChanged
      ? changedRelationResourceIds(current.resources, incoming.resources)
      : [];
    if (changedIds.length > 0 && !LOCKED_STATUSES.includes(saved.status)) {
      saved = { ...saved, rollbackAssessment: recomputeRollback(saved, now) };
    }
    const replaced = state.changes.map((item) => (item.id === current.id ? saved : item));
    return {
      ...state,
      changes: cascadeRelationChange(replaced, saved, changedIds),
    };
  }),
  on(ChangeRequestActions.deleteDraft, (state, { id }) => ({
    ...state,
    changes: state.changes.filter(
      (change) => change.id !== id || !['draft', 'pending_review', 'rejected'].includes(change.status),
    ),
  })),
  on(ChangeRequestActions.submitForReview, (state, { id, expectedVersion }) => {
    const current = state.changes.find((change) => change.id === id);
    if (!current) {
      return state;
    }
    if (current.version !== expectedVersion) {
      return {
        ...state,
        changes: state.changes.map((item) =>
          item.id === id ? downgradeToPendingReview(current, expectedVersion, '提交审批') : item,
        ),
      };
    }
    if (!['draft', 'rejected', 'pending_review'].includes(current.status)) {
      return state;
    }
    return {
      ...state,
      changes: state.changes.map((change) =>
        change.id === id
          ? touch({
              ...change,
              status: 'submitted',
              approvals: change.approvals.map(
                (approval): ApprovalRecord => ({ ...approval, state: 'pending' }),
              ),
              audit: [
                createAudit(
                  '提交审批',
                  `方案 v${change.version} 冻结后进入网络、系统、安全、业务顺序会签`,
                ),
                ...change.audit,
              ],
            })
          : change,
      ),
    };
  }),
  on(ChangeRequestActions.approveStage, (state, { id, stage, approver, comment, expectedVersion }) => {
    const current = state.changes.find((change) => change.id === id);
    if (!current) {
      return state;
    }
    if (current.version !== expectedVersion) {
      return {
        ...state,
        changes: state.changes.map((item) =>
          item.id === id ? downgradeToPendingReview(current, expectedVersion, '会签批准') : item,
        ),
      };
    }
    if (nextPendingStage(current) !== stage) {
      return state;
    }

    const now = new Date().toISOString();
    const approvals = current.approvals.map((approval) =>
      approval.stage === stage
        ? {
            ...approval,
            state: 'approved' as const,
            approver,
            comment,
            decidedAt: now,
            signedVersion: current.version,
          }
        : approval,
    );
    const allApproved = approvals.every(
      (approval) => approval.state === 'approved' || approval.state === 'frozen',
    );

    let updated: ChangeRequest = {
      ...current,
      status: allApproved ? 'approved' : 'submitted',
      approvals,
      audit: [
        createAudit(
          '阶段会签',
          `${stage} 已由 ${approver} 基于 v${current.version} 批准：${comment}`,
        ),
        ...current.audit,
      ],
      updatedAt: now,
    };
    if (allApproved) {
      updated = {
        ...updated,
        executionSnapshot: buildExecutionSnapshot(updated, now),
        audit: [
          createAudit(
            '批准快照冻结',
            `四级会签完成，资源依赖、窗口与回滚步骤按 v${updated.version} 冻结为执行快照。`,
          ),
          ...updated.audit,
        ],
      };
    }
    return {
      ...state,
      changes: state.changes.map((item) => (item.id === id ? updated : item)),
    };
  }),
  on(ChangeRequestActions.rejectStage, (state, { id, stage, approver, comment, expectedVersion }) => {
    const current = state.changes.find((change) => change.id === id);
    if (!current) {
      return state;
    }
    if (current.version !== expectedVersion) {
      return {
        ...state,
        changes: state.changes.map((item) =>
          item.id === id ? downgradeToPendingReview(current, expectedVersion, '会签退回') : item,
        ),
      };
    }
    if (nextPendingStage(current) !== stage) {
      return state;
    }
    return {
      ...state,
      changes: state.changes.map((change) =>
        change.id === id
          ? touch({
              ...change,
              status: 'rejected',
              approvals: change.approvals.map((approval) =>
                approval.stage === stage
                  ? {
                      ...approval,
                      state: 'rejected',
                      approver,
                      comment,
                      decidedAt: new Date().toISOString(),
                      signedVersion: change.version,
                    }
                  : approval,
              ),
              audit: [
                createAudit('审批退回', `${stage} 由 ${approver} 基于 v${change.version} 退回：${comment}`),
                ...change.audit,
              ],
            })
          : change,
      ),
    };
  }),
  on(ChangeRequestActions.startExecution, (state, { id, expectedVersion }) => {
    const current = state.changes.find((change) => change.id === id);
    if (!current || current.version !== expectedVersion) {
      return state;
    }
    return {
      ...state,
      changes: state.changes.map((change) =>
        change.id === id && change.status === 'approved' && change.executionSnapshot
          ? touch({
              ...change,
              status: 'executing',
              approvals: change.approvals.map((approval) => ({ ...approval, state: 'frozen' })),
              audit: [
                createAudit(
                  '开始执行',
                  `按批准快照 v${change.executionSnapshot.version} 执行，审批记录已冻结。`,
                ),
                ...change.audit,
              ],
            })
          : change,
      ),
    };
  }),
  on(ChangeRequestActions.toggleStep, (state, { id, stepId }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id
        ? touch({
            ...change,
            steps: change.steps.map((step) =>
              step.id === stepId
                ? {
                    ...step,
                    completed: !step.completed,
                    completedAt: step.completed ? undefined : new Date().toISOString(),
                  }
                : step,
            ),
          })
        : change,
    ),
  })),
  on(ChangeRequestActions.recordDeviation, (state, { id, deviation }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id
        ? touch({
            ...change,
            deviations: [deviation, ...change.deviations],
            audit: [
              createAudit('记录执行偏离', `${deviation.owner}：${deviation.description}`),
              ...change.audit,
            ],
          })
        : change,
    ),
  })),
  on(ChangeRequestActions.completeExecution, (state, { id, result, note }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id && change.status === 'executing'
        ? touch({
            ...change,
            status: result,
            audit: [
              createAudit(result === 'completed' ? '执行完成' : '执行回滚', note),
              ...change.audit,
            ],
          })
        : change,
    ),
  })),
  on(ChangeRequestActions.acknowledgeImpactNotice, (state, { id, noticeId }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id
        ? {
            ...change,
            impactNotices: change.impactNotices.map((notice) =>
              notice.id === noticeId ? { ...notice, acknowledged: true } : notice,
            ),
          }
        : change,
    ),
  })),
);
