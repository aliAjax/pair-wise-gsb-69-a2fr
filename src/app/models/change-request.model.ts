export type ChangeStatus =
  | 'draft'
  | 'submitted'
  | 'pending_review'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'rolled_back'
  | 'rejected';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ResourceType = 'datacenter' | 'rack' | 'network' | 'storage' | 'service';
export type ApprovalStage = 'network' | 'system' | 'security' | 'business';
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'frozen' | 'invalidated';
export type StepPhase = 'prepare' | 'execute' | 'verify' | 'rollback';
export type IssueSeverity = 'blocker' | 'warning' | 'info';

export interface ChangeResource {
  id: string;
  name: string;
  type: ResourceType;
  critical: boolean;
  dependencies: string[];
}

export interface ChangeStep {
  id: string;
  phase: StepPhase;
  title: string;
  owner: string;
  durationMinutes: number;
  command: string;
  completed: boolean;
  completedAt?: string;
}

export interface ChangeWindow {
  start: string;
  end: string;
  observationWindowMinutes: number;
  blackoutProtected: boolean;
}

export interface ApprovalRecord {
  stage: ApprovalStage;
  state: ApprovalState;
  approver?: string;
  decidedAt?: string;
  comment?: string;
  /** 该次签署所基于的方案版本，会签失效时用于定位旧版本。 */
  signedVersion?: number;
}

/** 按当前资源关系重算的回滚能力评估结果。 */
export interface RollbackAssessment {
  /** 评估所基于的方案版本；与当前版本不一致表示关系已变化，需要重新评估。 */
  basedOnVersion: number;
  executable: boolean;
  coveredResourceIds: string[];
  uncoveredResourceIds: string[];
  stepsMissingOwner: string[];
  stepsMissingCommand: string[];
  computedAt: string;
}

/** 四级会签完成（批准）时冻结的方案快照，执行与复盘均以该版本为准。 */
export interface ExecutionSnapshot {
  version: number;
  createdAt: string;
  resources: ChangeResource[];
  steps: ChangeStep[];
  window: ChangeWindow;
  approvals: ApprovalRecord[];
}

/** 执行中/已结束方案在上游关系变化后收到的影响提示，不改变执行步骤。 */
export interface ImpactNotice {
  id: string;
  observedAt: string;
  sourceChangeId: string;
  changedResourceIds: string[];
  detail: string;
  acknowledged: boolean;
}

export interface DeviationRecord {
  id: string;
  recordedAt: string;
  owner: string;
  description: string;
  decision: 'continue' | 'pause' | 'rollback';
}

export interface AuditRecord {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  detail: string;
}

export interface ChangeRequest {
  id: string;
  title: string;
  summary: string;
  owner: string;
  onCall: string[];
  status: ChangeStatus;
  risk: RiskLevel;
  /**
   * 方案版本：资源依赖、执行窗口、执行/回滚步骤任一一处落盘即 +1。
   * 审批页打开时记住该值，提交时做乐观并发校验。
   */
  version: number;
  resources: ChangeResource[];
  steps: ChangeStep[];
  window: ChangeWindow;
  approvals: ApprovalRecord[];
  /** 批准（四级会签完成）时的快照；进入执行后步骤与回滚以快照为准。 */
  executionSnapshot: ExecutionSnapshot | null;
  /** 按当前资源关系重算的回滚能力；自身版本变化时清空，由级联逻辑重算。 */
  rollbackAssessment: RollbackAssessment | null;
  /** 执行中及已结束方案在依赖关系后续变化时只挂影响提示。 */
  impactNotices: ImpactNotice[];
  deviations: DeviationRecord[];
  audit: AuditRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssue {
  id: string;
  changeId: string;
  severity: IssueSeverity;
  code:
    | 'DEPENDENCY_MISSING'
    | 'WINDOW_CONFLICT'
    | 'ROLLBACK_UNEXECUTABLE'
    | 'ROLLBACK_RELATION_STALE'
    | 'OBSERVATION_TOO_SHORT'
    | 'OWNER_MISSING'
    | 'PENDING_REVIEW';
  title: string;
  detail: string;
  suggestedAction: string;
  relatedId?: string;
}

export const APPROVAL_ORDER: ApprovalStage[] = ['network', 'system', 'security', 'business'];

export const STATUS_LABELS: Record<ChangeStatus, string> = {
  draft: '草稿',
  submitted: '待会签',
  pending_review: '待复核草稿',
  approved: '已批准',
  executing: '执行中',
  completed: '已完成',
  rolled_back: '已回滚',
  rejected: '已退回',
};

export const RISK_LABELS: Record<RiskLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  critical: '严重',
};

export const RESOURCE_LABELS: Record<ResourceType, string> = {
  datacenter: '机房',
  rack: '机柜',
  network: '网络',
  storage: '存储',
  service: '服务',
};

export const STAGE_LABELS: Record<ApprovalStage, string> = {
  network: '网络负责人',
  system: '系统负责人',
  security: '安全负责人',
  business: '业务负责人',
};

export const PHASE_LABELS: Record<StepPhase, string> = {
  prepare: '准备',
  execute: '执行',
  verify: '验证',
  rollback: '回滚',
};

export function createEmptyApprovals(): ApprovalRecord[] {
  return APPROVAL_ORDER.map((stage) => ({ stage, state: 'pending' }));
}

export function createEmptyChange(): ChangeRequest {
  const now = new Date();
  const start = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

  return {
    id: `CHG-${Math.floor(1000 + Math.random() * 9000)}`,
    title: '',
    summary: '',
    owner: '',
    onCall: [],
    status: 'draft',
    risk: 'medium',
    version: 1,
    resources: [],
    steps: [],
    window: {
      start: toLocalInputValue(start),
      end: toLocalInputValue(end),
      observationWindowMinutes: 30,
      blackoutProtected: false,
    },
    approvals: createEmptyApprovals(),
    executionSnapshot: null,
    rollbackAssessment: null,
    impactNotices: [],
    deviations: [],
    audit: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function toLocalInputValue(date: Date): string {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

export function isWindowOverlapping(left: ChangeWindow, right: ChangeWindow): boolean {
  const leftStart = new Date(left.start).getTime();
  const leftEnd = new Date(left.end).getTime();
  const rightStart = new Date(right.start).getTime();
  const rightEnd = new Date(right.end).getTime();
  return leftStart < rightEnd && rightStart < leftEnd;
}

/** 参与方案版本绑定的内容：资源依赖、执行窗口和全部步骤（含回滚步骤）。 */
export interface PlanBoundContent {
  resources: ChangeResource[];
  steps: ChangeStep[];
  window: ChangeWindow;
}

/**
 * 方案绑定内容的稳定签名。资源 ID/依赖边、窗口、步骤命令/责任人任一变化都会得到不同签名。
 */
export function planSignature(content: PlanBoundContent): string {
  const resources = content.resources
    .map((resource) => ({
      id: resource.id,
      type: resource.type,
      critical: resource.critical,
      dependencies: [...resource.dependencies].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const steps = content.steps
    .map((step) => ({
      id: step.id,
      phase: step.phase,
      title: step.title,
      owner: step.owner,
      durationMinutes: step.durationMinutes,
      command: step.command,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const window = {
    start: content.window.start,
    end: content.window.end,
    observationWindowMinutes: content.window.observationWindowMinutes,
    blackoutProtected: content.window.blackoutProtected,
  };
  return JSON.stringify({ resources, steps, window });
}

export function boundContentEquals(left: PlanBoundContent, right: PlanBoundContent): boolean {
  return planSignature(left) === planSignature(right);
}

/** 对比保存前后的资源关系，返回依赖边/增删发生变化的资源 ID（含其上下游变化）。 */
export function changedRelationResourceIds(
  previous: ChangeResource[],
  next: ChangeResource[],
): string[] {
  const changed = new Set<string>();
  const previousMap = new Map(previous.map((resource) => [resource.id, resource]));
  const nextMap = new Map(next.map((resource) => [resource.id, resource]));

  next.forEach((resource) => {
    const before = previousMap.get(resource.id);
    if (!before) {
      changed.add(resource.id);
      resource.dependencies.forEach((id) => changed.add(id));
      return;
    }
    const beforeDeps = new Set(before.dependencies);
    const afterDeps = new Set(resource.dependencies);
    if (
      before.critical !== resource.critical ||
      before.type !== resource.type ||
      before.dependencies.length !== resource.dependencies.length ||
      [...afterDeps].some((id) => !beforeDeps.has(id))
    ) {
      changed.add(resource.id);
      beforeDeps.forEach((id) => changed.add(id));
      afterDeps.forEach((id) => changed.add(id));
    }
  });

  previous.forEach((resource) => {
    if (!nextMap.has(resource.id)) {
      changed.add(resource.id);
      resource.dependencies.forEach((id) => changed.add(id));
    }
  });

  return [...changed];
}

/** 在一份资源清单内，从种子资源出发沿依赖边向下游传播（谁依赖我谁受影响）。 */
export function transitiveImpact(seedIds: string[], resources: ChangeResource[]): Set<string> {
  const impacted = new Set(seedIds);
  let grew = true;
  while (grew) {
    grew = false;
    resources.forEach((resource) => {
      if (impacted.has(resource.id)) {
        return;
      }
      if (resource.dependencies.some((dependencyId) => impacted.has(dependencyId))) {
        impacted.add(resource.id);
        grew = true;
      }
    });
  }
  return impacted;
}

/** 判断方案是否（直接或经其方案内依赖链）引用了任一受影响资源。 */
export function referencesImpacted(change: ChangeRequest, impactedResourceIds: Set<string>): boolean {
  const reachable = transitiveImpact(
    change.resources
      .filter((resource) => impactedResourceIds.has(resource.id))
      .map((resource) => resource.id),
    change.resources,
  );
  return reachable.size > 0;
}

export function hasAnyApprovalDecision(change: ChangeRequest): boolean {
  return change.approvals.some(
    (approval) => approval.state === 'approved' || approval.state === 'rejected',
  );
}

/**
 * 按当前资源关系重算回滚能力：
 * 回滚步骤必须有责任人与可执行命令，且资源（经依赖闭包）均被回滚步骤覆盖。
 */
export function recomputeRollback(
  change: ChangeRequest,
  nowIso = new Date().toISOString(),
): RollbackAssessment {
  const rollbackSteps = change.steps.filter((step) => step.phase === 'rollback');
  const stepsMissingOwner = rollbackSteps
    .filter((step) => !step.owner.trim())
    .map((step) => step.id);
  const stepsMissingCommand = rollbackSteps
    .filter((step) => !step.command.trim())
    .map((step) => step.id);

  const mentionedIds = new Set<string>();
  const pattern = /[A-Za-z][A-Za-z0-9]*-(?:[A-Za-z0-9]+-?)*[A-Za-z0-9]/g;
  rollbackSteps.forEach((step) => {
    const haystack = `${step.title} ${step.command}`;
    const matches = haystack.match(pattern);
    matches?.forEach((token) => mentionedIds.add(token));
  });

  const coveredResourceIds: string[] = [];
  const uncoveredResourceIds: string[] = [];
  change.resources.forEach((resource) => {
    const reachable = transitiveImpact([resource.id], change.resources);
    const covered = [...reachable].some((id) => mentionedIds.has(id));
    (covered ? coveredResourceIds : uncoveredResourceIds).push(resource.id);
  });

  return {
    basedOnVersion: change.version,
    executable:
      rollbackSteps.length > 0 &&
      stepsMissingOwner.length === 0 &&
      stepsMissingCommand.length === 0 &&
      uncoveredResourceIds.length === 0,
    coveredResourceIds,
    uncoveredResourceIds,
    stepsMissingOwner,
    stepsMissingCommand,
    computedAt: nowIso,
  };
}

/** 会签失效：已有签署回到待复核，未签署标记为失效，方案转为待复核草稿，等待重新走会签。 */
export function invalidateApprovalsForReview(
  change: ChangeRequest,
  reasonDetail: string,
  nowIso = new Date().toISOString(),
): ChangeRequest {
  const sawDecision = hasAnyApprovalDecision(change);
  return {
    ...change,
    status: 'pending_review',
    // 批准随会签一并作废，执行前必须重新批准并生成新快照。
    executionSnapshot: null,
    approvals: change.approvals.map((approval) =>
      approval.state === 'frozen'
        ? approval
        : {
            ...approval,
            state: 'invalidated',
            comment: sawDecision
              ? `原签署因方案版本变化失效（${approval.approver ?? '未署名'}）`
              : approval.comment,
          },
    ),
    audit: [createAudit('会签失效', reasonDetail, '系统'), ...change.audit],
    updatedAt: nowIso,
  };
}

/** 四级会签全部完成时冻结批准快照，此后执行步骤与回滚以快照为准。 */
export function buildExecutionSnapshot(
  change: ChangeRequest,
  nowIso = new Date().toISOString(),
): ExecutionSnapshot {
  return {
    version: change.version,
    createdAt: nowIso,
    resources: structuredClone(change.resources),
    steps: structuredClone(change.steps),
    window: structuredClone(change.window),
    approvals: structuredClone(change.approvals),
  };
}

/** 兼容历史 localStorage / mock 数据，补齐版本化改造引入的字段。 */
export function normalizeChange(raw: ChangeRequest): ChangeRequest {
  const normalized: ChangeRequest = {
    ...raw,
    version: typeof raw.version === 'number' && raw.version > 0 ? raw.version : 1,
    approvals: raw.approvals.length ? raw.approvals : createEmptyApprovals(),
    executionSnapshot: raw.executionSnapshot ?? null,
    rollbackAssessment: raw.rollbackAssessment ?? null,
    impactNotices: raw.impactNotices ?? [],
    deviations: raw.deviations ?? [],
    audit: raw.audit ?? [],
  };
  // 已经走到批准之后的历史数据，按当前内容补一张快照，保证执行页有冻结版本可依。
  if (
    !normalized.executionSnapshot &&
    ['approved', 'executing', 'completed', 'rolled_back'].includes(normalized.status)
  ) {
    normalized.executionSnapshot = buildExecutionSnapshot(normalized, normalized.updatedAt);
  }
  return normalized;
}

export function validateChange(change: ChangeRequest, allChanges: ChangeRequest[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const resourceMap = new Map(change.resources.map((resource) => [resource.id, resource]));

  change.resources.forEach((resource) => {
    resource.dependencies
      .filter((dependencyId) => !resourceMap.has(dependencyId))
      .forEach((dependencyId) => {
        issues.push({
          id: `${change.id}-dependency-${resource.id}-${dependencyId}`,
          changeId: change.id,
          severity: 'blocker',
          code: 'DEPENDENCY_MISSING',
          title: `缺少依赖对象 ${dependencyId}`,
          detail: `${resource.name} 依赖 ${dependencyId}，但该对象未纳入本次变更范围。`,
          suggestedAction: '补充依赖对象，或提供不在范围内的书面依据。',
          relatedId: dependencyId,
        });
      });
  });

  allChanges
    .filter(
      (candidate) =>
        candidate.id !== change.id &&
        !['draft', 'pending_review', 'rejected', 'rolled_back'].includes(candidate.status) &&
        isWindowOverlapping(change.window, candidate.window),
    )
    .forEach((candidate) => {
      const shared = change.resources.filter((resource) =>
        candidate.resources.some((candidateResource) => candidateResource.id === resource.id),
      );
      if (shared.length > 0) {
        issues.push({
          id: `${change.id}-conflict-${candidate.id}`,
          changeId: change.id,
          severity: 'blocker',
          code: 'WINDOW_CONFLICT',
          title: `与 ${candidate.id} 存在窗口冲突`,
          detail: `共享资源：${shared.map((resource) => resource.name).join('、')}。两项变更的执行窗口发生重叠。`,
          suggestedAction: '调整窗口、串行等待，或将冲突资源移出本次范围。',
          relatedId: candidate.id,
        });
      }
    });

  change.steps
    .filter((step) => step.phase === 'rollback' && (!step.command.trim() || !step.owner.trim()))
    .forEach((step) => {
      issues.push({
        id: `${change.id}-rollback-${step.id}`,
        changeId: change.id,
        severity: 'blocker',
        code: 'ROLLBACK_UNEXECUTABLE',
        title: `回滚步骤“${step.title || '未命名'}”不可执行`,
        detail: '回滚步骤必须包含明确命令或操作说明，并指定责任人。',
        suggestedAction: '补齐回滚命令和责任人后重新校验。',
        relatedId: step.id,
      });
    });

  change.resources
    .filter((resource) => resource.type === 'service' && resource.critical)
    .forEach((resource) => {
      if (change.window.observationWindowMinutes < 30) {
        issues.push({
          id: `${change.id}-observation-${resource.id}`,
          changeId: change.id,
          severity: 'warning',
          code: 'OBSERVATION_TOO_SHORT',
          title: `${resource.name} 观察窗口不足`,
          detail: '关键服务建议至少保留 30 分钟观察窗口。',
          suggestedAction: '延长观察窗口，并由业务负责人签署风险接受记录。',
          relatedId: resource.id,
        });
      }
    });

  if (!change.owner.trim() || change.onCall.length === 0) {
    issues.push({
      id: `${change.id}-owner`,
      changeId: change.id,
      severity: 'blocker',
      code: 'OWNER_MISSING',
      title: '缺少变更责任人',
      detail: '变更负责人与值守人员均不能为空。',
      suggestedAction: '指定变更负责人和至少一名值守人员。',
    });
  }

  if (change.status === 'pending_review') {
    issues.push({
      id: `${change.id}-pending-review`,
      changeId: change.id,
      severity: 'blocker',
      code: 'PENDING_REVIEW',
      title: '方案已被降为待复核草稿',
      detail:
        '方案在会签后发生了版本变化（旧页面提交或资源关系变更），原有会签已失效，需重新提交四级会签。',
      suggestedAction: '核对最新资源关系与回滚步骤后，重新提交审批。',
    });
  }

  const assessment = change.rollbackAssessment;
  if (
    assessment &&
    !['completed', 'rolled_back'].includes(change.status) &&
    (!assessment.executable || assessment.basedOnVersion !== change.version)
  ) {
    const stale = assessment.basedOnVersion !== change.version;
    const uncoveredNames = change.resources
      .filter((resource) => assessment.uncoveredResourceIds.includes(resource.id))
      .map((resource) => resource.name);
    issues.push({
      id: `${change.id}-rollback-relation`,
      changeId: change.id,
      severity: 'blocker',
      code: 'ROLLBACK_RELATION_STALE',
      title: stale ? '回滚能力需按新资源关系重算' : '按新关系重算后回滚不可执行',
      detail: stale
        ? `回滚评估基于 v${assessment.basedOnVersion}，当前为 v${change.version}；前置机柜或共享资源关系已变化。`
        : `回滚步骤未覆盖：${uncoveredNames.join('、') || '存在缺失'}。`,
      suggestedAction: '依据最新依赖关系补齐回滚步骤、责任人和命令后重新提交会签。',
    });
  }

  return issues;
}

export function createAudit(
  action: string,
  detail: string,
  actor = '当前用户',
): AuditRecord {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: new Date().toISOString(),
    actor,
    action,
    detail,
  };
}
