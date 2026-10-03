import { createReducer, on } from '@ngrx/store';
import {
  ApprovalRecord,
  ApprovalStage,
  APPROVAL_ORDER,
  ChangeRequest,
  ImpactNotice,
  buildResourceIndex,
  computeBundleSignature,
  createAudit,
  isPreExecutionStatus,
  normalizeChange,
  resourceFootprint,
  validateChange,
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

function nowIso(): string {
  return new Date().toISOString();
}

function touch(change: ChangeRequest): ChangeRequest {
  return { ...change, updatedAt: nowIso() };
}

function freshApprovals(): ApprovalRecord[] {
  return APPROVAL_ORDER.map((stage) => ({ stage, state: 'pending' as const }));
}

function nextPendingStage(change: ChangeRequest): ApprovalStage | null {
  return (
    APPROVAL_ORDER.find((stage) =>
      change.approvals.some((approval) => approval.stage === stage && approval.state === 'pending'),
    ) ?? null
  );
}

/** 保存前后资源关系发生变化的资源 ID（新增、移除或依赖边调整） */
function diffResourceRelations(before: ChangeRequest, after: ChangeRequest): Set<string> {
  const changed = new Set<string>();
  const beforeMap = new Map(before.resources.map((resource) => [resource.id, resource]));
  const afterMap = new Map(after.resources.map((resource) => [resource.id, resource]));

  afterMap.forEach((resource, id) => {
    const previous = beforeMap.get(id);
    if (
      !previous ||
      previous.type !== resource.type ||
      previous.critical !== resource.critical ||
      previous.name !== resource.name ||
      JSON.stringify([...previous.dependencies].sort()) !==
        JSON.stringify([...resource.dependencies].sort())
    ) {
      changed.add(id);
    }
  });
  beforeMap.forEach((_resource, id) => {
    if (!afterMap.has(id)) {
      changed.add(id);
    }
  });
  return changed;
}

/**
 * 前置机柜或共享资源一变：沿合并后的全局资源图（含旧图，避免边删除漏判）
 * 找到传递依赖它的其他方案。未执行方案连同会签一起失效；执行中方案只挂提示。
 */
function propagateUpstreamChanges(
  changes: ChangeRequest[],
  sourceChangeId: string,
  sourceVersion: number,
  changedResourceIds: Set<string>,
): ChangeRequest[] {
  if (changedResourceIds.size === 0) {
    return changes;
  }

  const source = changes.find((change) => change.id === sourceChangeId);
  const newIndex = buildResourceIndex(changes);

  return changes.map((change) => {
    if (change.id === sourceChangeId) {
      return change;
    }

    const newFootprint = resourceFootprint(change, newIndex);
    const hitIds = [...changedResourceIds].filter((id) => newFootprint.has(id));
    if (hitIds.length === 0) {
      return change;
    }

    const resourceNames = hitIds.map((id) => newIndex.get(id)?.name ?? id).join('、');
    const timestamp = nowIso();

    if (isPreExecutionStatus(change.status)) {
      const alreadyNoted = (change.impactNotices ?? []).some(
        (notice) =>
          notice.kind === 'upstream-invalidated' &&
          notice.sourceChangeId === sourceChangeId &&
          notice.affectedResourceIds.length === hitIds.length &&
          hitIds.every((id) => notice.affectedResourceIds.includes(id)),
      );
      if (alreadyNoted) {
        return change;
      }

      const notice: ImpactNotice = {
        id: `notice-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
        recordedAt: timestamp,
        sourceChangeId,
        sourceVersion,
        sourceResourceIds: [...changedResourceIds],
        affectedResourceIds: hitIds,
        kind: 'upstream-invalidated',
        title: `${source?.title ?? sourceChangeId}（v${sourceVersion}）改动前置资源 ${resourceNames}`,
        detail:
          '前置机柜或共享资源关系发生变化，本方案按新资源关系重算依赖与回滚能力，原四级会签失效。',
        acknowledged: false,
      };
      return {
        ...change,
        status: 'draft',
        boundSignature: undefined,
        approvals: freshApprovals(),
        impactNotices: [...(change.impactNotices ?? []), notice],
        updatedAt: timestamp,
        audit: [
          createAudit(
            '前置变化失效',
            `${sourceChangeId} v${sourceVersion} 改动 ${resourceNames}，本方案未执行，会签一并失效，回滚能力按新关系重算`,
          ),
          ...change.audit,
        ],
      };
    }

    // 执行中及已结束方案：保留批准时快照，只挂影响提示
    const alreadyNoted = (change.impactNotices ?? []).some(
      (notice) =>
        notice.kind === 'execution-advisory' &&
        notice.sourceChangeId === sourceChangeId &&
        hitIds.every((id) => notice.affectedResourceIds.includes(id)),
    );
    if (alreadyNoted) {
      return change;
    }
    const notice: ImpactNotice = {
      id: `notice-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      recordedAt: timestamp,
      sourceChangeId,
      sourceVersion,
      sourceResourceIds: [...changedResourceIds],
      affectedResourceIds: hitIds,
      kind: 'execution-advisory',
      title: `${source?.title ?? sourceChangeId}（v${sourceVersion}）改动共享资源 ${resourceNames}`,
      detail: `本方案已进入执行阶段，执行步骤继续以批准时 v${
        change.executionSnapshot?.schemeVersion ?? change.schemeVersion
      } 快照为准；该变化仅作为影响提示，不改变正在执行的步骤。`,
      acknowledged: false,
    };
    return {
      ...change,
      impactNotices: [...(change.impactNotices ?? []), notice],
      updatedAt: timestamp,
      audit: [
        createAudit(
          '执行期影响提示',
          `${sourceChangeId} v${sourceVersion} 改动 ${resourceNames}，快照不变，仅挂影响提示`,
        ),
        ...change.audit,
      ],
    };
  });
}

/**
 * 把一份编辑后的方案并入当前方案：
 * - 资源依赖/执行窗口/回滚步骤组成的方案包一旦变化，版本递增且会签失效；
 * - 保存后向前置资源的下游方案传播失效或影响提示。
 */
function applyIncomingChange(
  existing: ChangeRequest[],
  targetId: string,
  incoming: ChangeRequest,
): ChangeRequest[] {
  const current = existing.find((change) => change.id === targetId);
  if (!current) {
    return existing;
  }

  // 进入执行后的方案不可再保存，任何修改都不能触及正在执行的步骤
  if (!isPreExecutionStatus(current.status)) {
    return existing;
  }

  const beforeSignature = computeBundleSignature(current);
  const changedResourceIds = diffResourceRelations(current, incoming);
  const nextVersion = current.schemeVersion + 1;
  const bundleChanged =
    computeBundleSignature({ ...incoming, schemeVersion: nextVersion }) !== beforeSignature;

  const merged: ChangeRequest = {
    ...structuredClone(incoming),
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: nowIso(),
    schemeVersion: nextVersion,
    status: bundleChanged ? 'draft' : current.status,
    approvals: bundleChanged ? freshApprovals() : current.approvals,
    boundSignature: bundleChanged ? undefined : current.boundSignature,
    deviations: current.deviations,
    executionSnapshot: current.executionSnapshot ?? null,
    reviewDraft: current.reviewDraft ?? null,
    impactNotices: current.impactNotices ?? [],
    audit: [
      createAudit(
        bundleChanged ? '方案改版' : '保存变更方案',
        bundleChanged
          ? `保存为 v${nextVersion}：资源依赖、执行窗口或回滚步骤变化，原四级会签失效`
          : `保存 v${nextVersion}：未改动绑定内容，会签保持有效`,
      ),
      ...current.audit,
    ],
  };

  const nextChanges = existing.map((change) => (change.id === targetId ? merged : change));
  return propagateUpstreamChanges(nextChanges, targetId, nextVersion, changedResourceIds);
}

/** 旧页面基于过期版本提交时，只留下待复核草稿 */
function stashReviewDraft(
  changes: ChangeRequest[],
  targetId: string,
  draft: NonNullable<ChangeRequest['reviewDraft']>,
): ChangeRequest[] {
  return changes.map((change) =>
    change.id === targetId
      ? {
          ...change,
          reviewDraft: draft,
          updatedAt: nowIso(),
          audit: [
            createAudit(
              '过期提交留存',
              `旧页面基于 v${draft.baseVersion} 的${
                draft.origin === 'stale-approval' ? '会签意见' : '方案修改'
              }未覆盖当前 v${draft.latestVersion}，已留存为待复核草稿`,
            ),
            ...change.audit,
          ],
        }
      : change,
  );
}

export const changeRequestReducer = createReducer(
  initialChangeRequestState,
  on(ChangeRequestActions.loadChanges, (state) => ({ ...state, loading: true, error: null })),
  on(ChangeRequestActions.loadChangesSuccess, (state, { changes }) => ({
    ...state,
    changes: changes.map((change) => normalizeChange(change)),
    loading: false,
  })),
  on(ChangeRequestActions.loadChangesFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  })),
  on(ChangeRequestActions.createChange, (state, { change }) => {
    const created: ChangeRequest = {
      ...normalizeChange(change),
      audit: [createAudit('创建草稿', `创建变更 ${change.id}（方案版本 v1）`), ...change.audit],
    };
    const nextChanges = [created, ...state.changes];
    const changedResourceIds = new Set(created.resources.map((resource) => resource.id));
    return {
      ...state,
      changes: propagateUpstreamChanges(nextChanges, created.id, 1, changedResourceIds),
    };
  }),
  on(ChangeRequestActions.updateChange, (state, { change, baseVersion }) => {
    const current = state.changes.find((item) => item.id === change.id);
    if (!current) {
      return state;
    }
    if (!isPreExecutionStatus(current.status)) {
      // 执行中的方案只接受批准时快照，外部保存一律不落库
      return state;
    }
    if (baseVersion !== current.schemeVersion) {
      return {
        ...state,
        changes: stashReviewDraft(state.changes, change.id, {
          savedAt: nowIso(),
          baseVersion,
          latestVersion: current.schemeVersion,
          origin: 'stale-save',
          staleChange: normalizeChange(change),
          note: `旧页面保存的“${change.title || change.id}”基于过期版本，未覆盖最新方案`,
        }),
      };
    }
    return {
      ...state,
      changes: applyIncomingChange(state.changes, change.id, normalizeChange(change)),
    };
  }),
  on(ChangeRequestActions.adoptReviewDraft, (state, { id }) => {
    const current = state.changes.find((change) => change.id === id);
    if (!current?.reviewDraft) {
      return state;
    }
    const draft = current.reviewDraft;
    let nextChanges = state.changes;

    if (draft.staleChange) {
      nextChanges = applyIncomingChange(nextChanges, id, draft.staleChange);
    } else if (draft.approvalIntent) {
      const intent = draft.approvalIntent;
      nextChanges = nextChanges.map((change) => {
        if (change.id !== id || !isPreExecutionStatus(change.status)) {
          return change;
        }
        if (intent.decision === 'rejected') {
          return touch({
            ...change,
            status: 'rejected',
            approvals: change.approvals.map((approval) =>
              approval.stage === intent.stage
                ? {
                    ...approval,
                    state: 'rejected',
                    approver: intent.approver,
                    comment: intent.comment,
                    decidedAt: nowIso(),
                    boundVersion: change.schemeVersion,
                  }
                : approval,
            ),
            audit: [
              createAudit(
                '复核草稿退回',
                `${intent.stage} 由 ${intent.approver} 按待复核草稿退回：${intent.comment}`,
              ),
              ...change.audit,
            ],
          });
        }
        if (nextPendingStage(change) !== intent.stage) {
          return change;
        }
        const approvals = change.approvals.map((approval) =>
          approval.stage === intent.stage
            ? {
                ...approval,
                state: 'approved' as const,
                approver: intent.approver,
                comment: intent.comment,
                decidedAt: nowIso(),
                boundVersion: change.schemeVersion,
              }
            : approval,
        );
        const allApproved = approvals.every((approval) => approval.state === 'approved');
        return touch({
          ...change,
          status: allApproved ? 'approved' : 'submitted',
          approvals,
          audit: [
            createAudit(
              '复核草稿批准',
              `${intent.stage} 由 ${intent.approver} 按待复核草稿在 v${change.schemeVersion} 上批准：${intent.comment}`,
            ),
            ...change.audit,
          ],
        });
      });
    }

    const adopted = nextChanges.find((change) => change.id === id);
    return {
      ...state,
      changes: nextChanges.map((change) =>
        change.id === id
          ? {
              ...change,
              reviewDraft: null,
              audit: [
                createAudit(
                  '采纳待复核草稿',
                  `基于 v${draft.baseVersion} 的草稿已在最新版本上复核采纳`,
                ),
                ...(adopted?.audit ?? change.audit),
              ],
            }
          : change,
      ),
    };
  }),
  on(ChangeRequestActions.discardReviewDraft, (state, { id }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id && change.reviewDraft
        ? {
            ...change,
            reviewDraft: null,
            updatedAt: nowIso(),
            audit: [createAudit('丢弃待复核草稿', '旧版本提交内容经复核后丢弃'), ...change.audit],
          }
        : change,
    ),
  })),
  on(ChangeRequestActions.acknowledgeImpact, (state, { id, noticeId }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id
        ? {
            ...change,
            impactNotices: (change.impactNotices ?? []).map((notice) =>
              notice.id === noticeId ? { ...notice, acknowledged: true } : notice,
            ),
            audit: [
              createAudit('确认前置影响', `已确认影响提示 ${noticeId}，可按新关系重新提交会签`),
              ...change.audit,
            ],
          }
        : change,
    ),
  })),
  on(ChangeRequestActions.deleteDraft, (state, { id }) => ({
    ...state,
    changes: state.changes.filter((change) => change.id !== id || change.status !== 'draft'),
  })),
  on(ChangeRequestActions.submitForReview, (state, { id, baseVersion }) => {
    const current = state.changes.find((change) => change.id === id);
    if (!current || !['draft', 'rejected'].includes(current.status)) {
      return state;
    }
    if (baseVersion !== current.schemeVersion) {
      return {
        ...state,
        changes: stashReviewDraft(state.changes, id, {
          savedAt: nowIso(),
          baseVersion,
          latestVersion: current.schemeVersion,
          origin: 'stale-approval',
          approvalIntent: undefined,
          note: '旧页面在过期版本上提交会签，需刷新后基于最新版本重新提交',
        }),
      };
    }
    const blockers = validateChange(current, state.changes).some(
      (issue) => issue.severity === 'blocker',
    );
    if (blockers) {
      return state;
    }
    const signature = computeBundleSignature(current);
    return {
      ...state,
      changes: state.changes.map((change) =>
        change.id === id
          ? touch({
              ...change,
              status: 'submitted',
              approvals: freshApprovals(),
              boundSignature: signature,
              reviewDraft: null,
              audit: [
                createAudit(
                  '提交审批',
                  `v${change.schemeVersion}（${signature}）冻结后进入网络、系统、安全、业务顺序会签`,
                ),
                ...change.audit,
              ],
            })
          : change,
      ),
    };
  }),
  on(ChangeRequestActions.approveStage, (state, { id, stage, approver, comment, baseVersion }) => {
    const current = state.changes.find((change) => change.id === id);
    if (!current || !isPreExecutionStatus(current.status)) {
      return state;
    }
    const signatureMismatch =
      current.status === 'submitted' &&
      current.boundSignature !== undefined &&
      current.boundSignature !== computeBundleSignature(current);
    if (
      baseVersion !== current.schemeVersion ||
      nextPendingStage(current) !== stage ||
      current.status !== 'submitted' ||
      signatureMismatch
    ) {
      return {
        ...state,
        changes: stashReviewDraft(state.changes, id, {
          savedAt: nowIso(),
          baseVersion,
          latestVersion: current.schemeVersion,
          origin: 'stale-approval',
          approvalIntent: { stage, decision: 'approved', approver, comment },
          note: `${stage} 的批准意见来自旧页面（v${baseVersion}），未写入当前 v${current.schemeVersion}`,
        }),
      };
    }

    return {
      ...state,
      changes: state.changes.map((change) => {
        if (change.id !== id) {
          return change;
        }
        const approvals = change.approvals.map((approval) =>
          approval.stage === stage
            ? {
                ...approval,
                state: 'approved' as const,
                approver,
                comment,
                decidedAt: nowIso(),
                boundVersion: change.schemeVersion,
              }
            : approval,
        );
        const allApproved = approvals.every((approval) => approval.state === 'approved');
        return touch({
          ...change,
          status: allApproved ? 'approved' : 'submitted',
          approvals,
          audit: [
            createAudit(
              '阶段会签',
              `${stage} 已由 ${approver} 按 v${change.schemeVersion} 批准：${comment}`,
            ),
            ...change.audit,
          ],
        });
      }),
    };
  }),
  on(ChangeRequestActions.rejectStage, (state, { id, stage, approver, comment, baseVersion }) => {
    const current = state.changes.find((change) => change.id === id);
    if (!current || !isPreExecutionStatus(current.status)) {
      return state;
    }
    if (baseVersion !== current.schemeVersion || current.status !== 'submitted') {
      return {
        ...state,
        changes: stashReviewDraft(state.changes, id, {
          savedAt: nowIso(),
          baseVersion,
          latestVersion: current.schemeVersion,
          origin: 'stale-approval',
          approvalIntent: { stage, decision: 'rejected', approver, comment },
          note: `${stage} 的退回意见来自旧页面（v${baseVersion}），未写入当前 v${current.schemeVersion}`,
        }),
      };
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
                      decidedAt: nowIso(),
                      boundVersion: change.schemeVersion,
                    }
                  : approval,
              ),
              audit: [
                createAudit(
                  '审批退回',
                  `${stage} 由 ${approver} 按 v${change.schemeVersion} 退回：${comment}`,
                ),
                ...change.audit,
              ],
            })
          : change,
      ),
    };
  }),
  on(ChangeRequestActions.startExecution, (state, { id }) => ({
    ...state,
    changes: state.changes.map((change) => {
      if (change.id !== id || change.status !== 'approved') {
        return change;
      }
      const blockers = validateChange(change, state.changes).some(
        (issue) => issue.severity === 'blocker',
      );
      if (blockers) {
        return change;
      }
      // 批准时快照：资源依赖、窗口、回滚步骤、四级会签一并冻结
      const snapshot: ChangeRequest['executionSnapshot'] = {
        schemeVersion: change.schemeVersion,
        capturedAt: nowIso(),
        bundleSignature: computeBundleSignature(change),
        resources: structuredClone(change.resources),
        steps: structuredClone(change.steps),
        window: structuredClone(change.window),
        approvals: structuredClone(change.approvals),
      };
      return touch({
        ...change,
        status: 'executing',
        approvals: change.approvals.map((approval) => ({ ...approval, state: 'frozen' })),
        executionSnapshot: snapshot,
        audit: [
          createAudit(
            '开始执行',
            `按批准时 v${change.schemeVersion} 快照执行，审批记录冻结，后续资源变化只挂影响提示`,
          ),
          ...change.audit,
        ],
      });
    }),
  })),
  on(ChangeRequestActions.toggleStep, (state, { id, stepId }) => ({
    ...state,
    changes: state.changes.map((change) => {
      if (change.id !== id || change.status !== 'executing' || !change.executionSnapshot) {
        return change;
      }
      // 勾选只作用于批准时快照中的步骤定义
      const snapshotSteps = change.executionSnapshot.steps.map((step) =>
        step.id === stepId
          ? {
              ...step,
              completed: !step.completed,
              completedAt: step.completed ? undefined : nowIso(),
            }
          : step,
      );
      return touch({
        ...change,
        executionSnapshot: { ...change.executionSnapshot, steps: snapshotSteps },
        steps: change.steps.map((step) => {
          const snapshotStep = snapshotSteps.find((item) => item.id === stepId);
          return step.id === stepId && snapshotStep
            ? { ...step, completed: snapshotStep.completed, completedAt: snapshotStep.completedAt }
            : step;
        }),
      });
    }),
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
);
