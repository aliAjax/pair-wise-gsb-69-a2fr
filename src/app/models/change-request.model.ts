export type ChangeStatus =
  'draft' | 'submitted' | 'approved' | 'executing' | 'completed' | 'rolled_back' | 'rejected';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ResourceType = 'datacenter' | 'rack' | 'network' | 'storage' | 'service';
export type ApprovalStage = 'network' | 'system' | 'security' | 'business';
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'frozen';
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
  /** 签署时绑定的方案版本，会签与版本一一对应 */
  boundVersion?: number;
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

/** 旧页面基于过期版本提交时留存的待复核草稿 */
export interface ReviewDraft {
  savedAt: string;
  /** 草稿所依据的旧方案版本 */
  baseVersion: number;
  /** 最新方案版本，便于提示差异 */
  latestVersion: number;
  origin: 'stale-save' | 'stale-approval';
  /** stale-save 时留存的旧版本完整方案 */
  staleChange?: ChangeRequest;
  /** stale-approval 时留存的会签意向 */
  approvalIntent?: {
    stage: ApprovalStage;
    decision: 'approved' | 'rejected';
    approver: string;
    comment: string;
  };
  note: string;
}

/** 开始执行时冻结的批准快照，执行期间步骤定义以此为准 */
export interface ExecutionSnapshot {
  schemeVersion: number;
  capturedAt: string;
  bundleSignature: string;
  resources: ChangeResource[];
  steps: ChangeStep[];
  window: ChangeWindow;
  approvals: ApprovalRecord[];
}

/** 前置机柜或共享资源变化后挂到相关方案上的影响提示 */
export interface ImpactNotice {
  id: string;
  recordedAt: string;
  sourceChangeId: string;
  sourceVersion: number;
  /** 直接发生关系变化的资源 ID */
  sourceResourceIds: string[];
  /** 本方案中被波及的资源（含传递依赖） */
  affectedResourceIds: string[];
  /** 未执行方案：会签失效；执行中方案：仅提示 */
  kind: 'upstream-invalidated' | 'execution-advisory';
  title: string;
  detail: string;
  acknowledged: boolean;
}

export interface ChangeRequest {
  id: string;
  title: string;
  summary: string;
  owner: string;
  onCall: string[];
  status: ChangeStatus;
  risk: RiskLevel;
  resources: ChangeResource[];
  steps: ChangeStep[];
  window: ChangeWindow;
  approvals: ApprovalRecord[];
  deviations: DeviationRecord[];
  audit: AuditRecord[];
  createdAt: string;
  updatedAt: string;
  /** 方案版本：资源依赖、执行窗口、回滚步骤每保存一次递增 */
  schemeVersion: number;
  /** 最近一次提交会签时绑定的方案包签名；与当前签名不一致即会签失效 */
  boundSignature?: string;
  /** 过期页面提交后留存的待复核草稿 */
  reviewDraft?: ReviewDraft | null;
  /** 批准并开始执行时的不可变快照 */
  executionSnapshot?: ExecutionSnapshot | null;
  /** 前置资源变化带来的影响提示 */
  impactNotices?: ImpactNotice[];
}

export interface ValidationIssue {
  id: string;
  changeId: string;
  severity: IssueSeverity;
  code:
    | 'DEPENDENCY_MISSING'
    | 'WINDOW_CONFLICT'
    | 'ROLLBACK_UNEXECUTABLE'
    | 'ROLLBACK_COVERAGE_RECOMPUTED'
    | 'OBSERVATION_TOO_SHORT'
    | 'OWNER_MISSING'
    | 'UPSTREAM_INVALIDATED'
    | 'STALE_REVIEW_DRAFT';
  title: string;
  detail: string;
  suggestedAction: string;
  relatedId?: string;
}

export const APPROVAL_ORDER: ApprovalStage[] = ['network', 'system', 'security', 'business'];

export const STATUS_LABELS: Record<ChangeStatus, string> = {
  draft: '草稿',
  submitted: '待会签',
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
    resources: [],
    steps: [],
    window: {
      start: toLocalInputValue(start),
      end: toLocalInputValue(end),
      observationWindowMinutes: 30,
      blackoutProtected: false,
    },
    approvals: createEmptyApprovals(),
    deviations: [],
    audit: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    schemeVersion: 1,
    boundSignature: undefined,
    reviewDraft: null,
    executionSnapshot: null,
    impactNotices: [],
  };
}

/**
 * 规范化历史数据（localStorage 旧记录、初始 mock），补齐版本化字段。
 * 执行中的旧记录按当前内容补拍一份批准快照。
 */
export function normalizeChange(raw: Partial<ChangeRequest>): ChangeRequest {
  const fallback = createEmptyChange();
  const approvals = raw.approvals && raw.approvals.length ? raw.approvals : createEmptyApprovals();
  const change: ChangeRequest = {
    ...fallback,
    ...raw,
    approvals,
    deviations: raw.deviations ?? [],
    audit: raw.audit ?? [],
    resources: raw.resources ?? [],
    steps: raw.steps ?? [],
    window: raw.window ?? fallback.window,
    schemeVersion: raw.schemeVersion ?? 1,
    boundSignature: raw.boundSignature,
    reviewDraft: raw.reviewDraft ?? null,
    executionSnapshot: raw.executionSnapshot ?? null,
    impactNotices: raw.impactNotices ?? [],
  } as ChangeRequest;

  if (change.status === 'executing' && !change.executionSnapshot) {
    change.executionSnapshot = {
      schemeVersion: change.schemeVersion,
      capturedAt: change.updatedAt,
      bundleSignature: computeBundleSignature(change),
      resources: structuredClone(change.resources),
      steps: structuredClone(change.steps),
      window: structuredClone(change.window),
      approvals: structuredClone(change.approvals),
    };
    if (!change.boundSignature) {
      change.boundSignature = change.executionSnapshot.bundleSignature;
    }
  }
  return change;
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

/**
 * 方案包签名：把“资源依赖、执行窗口、回滚步骤”绑到同一版本。
 * 任一部分变化都会导致签名改变，会签随之失效。
 */
export function computeBundleSignature(change: ChangeRequest): string {
  const payload = JSON.stringify({
    resources: change.resources
      .map((resource) => ({
        id: resource.id,
        type: resource.type,
        critical: resource.critical,
        dependencies: [...resource.dependencies].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    window: {
      start: change.window.start,
      end: change.window.end,
      observationWindowMinutes: change.window.observationWindowMinutes,
      blackoutProtected: change.window.blackoutProtected,
    },
    rollback: change.steps
      .filter((step) => step.phase === 'rollback')
      .map((step) => ({
        title: step.title,
        owner: step.owner,
        command: step.command,
        durationMinutes: step.durationMinutes,
      })),
  });
  return `sig-${hash32(payload)}`;
}

function hash32(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 全局资源关系索引：同一资源 ID 以最近保存（updatedAt 最新）的方案定义为准。
 * 机柜、共享资源在另一个方案里被改动后，其他方案通过该索引看到新关系。
 */
export interface ResourceRelation {
  id: string;
  name: string;
  type: ResourceType;
  critical: boolean;
  dependencies: string[];
  changeId: string;
  updatedAt: string;
  schemeVersion: number;
}

export function buildResourceIndex(changes: ChangeRequest[]): Map<string, ResourceRelation> {
  const index = new Map<string, ResourceRelation>();
  [...changes]
    .sort((left, right) => {
      const byTime = left.updatedAt.localeCompare(right.updatedAt);
      return byTime || left.schemeVersion - right.schemeVersion;
    })
    .forEach((change) => {
      change.resources.forEach((resource) => {
        index.set(resource.id, {
          id: resource.id,
          name: resource.name,
          type: resource.type,
          critical: resource.critical,
          dependencies: resource.dependencies,
          changeId: change.id,
          updatedAt: change.updatedAt,
          schemeVersion: change.schemeVersion,
        });
      });
    });
  return index;
}

/**
 * 计算方案在合并全局资源图后的传递资源闭包（含自身资源）。
 * 从方案资源的依赖边出发在全局图上展开，因此闭包包含跨方案的前置机柜/共享资源；
 * 用于判断前置机柜/共享资源一变时，本方案是否被波及。
 */
export function resourceFootprint(
  change: ChangeRequest,
  index: Map<string, ResourceRelation>,
): Set<string> {
  const visited = new Set<string>();
  const stack = change.resources.map((resource) => resource.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (visited.has(id)) {
      continue;
    }
    visited.add(id);
    const relation = index.get(id);
    // 方案内资源即使没有被其他方案登记，也保留其自身依赖边
    const localResource = change.resources.find((resource) => resource.id === id);
    const dependencies = relation?.dependencies ?? localResource?.dependencies ?? [];
    dependencies.forEach((dependencyId) => {
      if (!visited.has(dependencyId)) {
        stack.push(dependencyId);
      }
    });
  }
  return visited;
}

export interface RollbackReadiness {
  /** 新关系下闭包内的关键资源数 */
  criticalCount: number;
  /** 责任人与命令齐备、当前可执行的回滚步骤数 */
  executableRollbackCount: number;
  executable: boolean;
  reasons: string[];
  footprint: string[];
}

/** 回滚能力按最新资源关系重算 */
export function recomputeRollbackReadiness(
  change: ChangeRequest,
  allChanges: ChangeRequest[],
): RollbackReadiness {
  const index = buildResourceIndex(allChanges);
  const footprint = resourceFootprint(change, index);
  const criticalIds = [...footprint].filter((id) => index.get(id)?.critical);
  const rollbackSteps = change.steps.filter((step) => step.phase === 'rollback');
  const executableRollbackCount = rollbackSteps.filter(
    (step) => step.command.trim() && step.owner.trim(),
  ).length;

  const reasons: string[] = [];
  if (rollbackSteps.length === 0) {
    reasons.push('方案没有任何回滚步骤');
  }
  if (rollbackSteps.some((step) => !step.command.trim() || !step.owner.trim())) {
    reasons.push('存在责任人或命令缺失的回滚步骤');
  }
  if (criticalIds.length > executableRollbackCount) {
    reasons.push(
      `新关系下闭包内有 ${criticalIds.length} 个关键资源，可执行回滚步骤仅 ${executableRollbackCount} 项`,
    );
  }

  return {
    criticalCount: criticalIds.length,
    executableRollbackCount,
    executable: reasons.length === 0,
    reasons,
    footprint: [...footprint].sort(),
  };
}

/** 未进入执行阶段的状态：会签可被前置变化失效 */
export function isPreExecutionStatus(status: ChangeStatus): boolean {
  return ['draft', 'submitted', 'approved', 'rejected'].includes(status);
}

export function validateChange(
  change: ChangeRequest,
  allChanges: ChangeRequest[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const resourceMap = new Map(change.resources.map((resource) => [resource.id, resource]));
  // 机柜、共享资源可能登记在其他方案中：以全局资源索引判定依赖对象是否真实存在
  const globalResourceIndex = buildResourceIndex(allChanges);

  change.resources.forEach((resource) => {
    resource.dependencies
      .filter(
        (dependencyId) => !resourceMap.has(dependencyId) && !globalResourceIndex.has(dependencyId),
      )
      .forEach((dependencyId) => {
        issues.push({
          id: `${change.id}-dependency-${resource.id}-${dependencyId}`,
          changeId: change.id,
          severity: 'blocker',
          code: 'DEPENDENCY_MISSING',
          title: `缺少依赖对象 ${dependencyId}`,
          detail: `${resource.name} 依赖 ${dependencyId}，但该对象未纳入本次变更范围，也没有其他在途方案登记。`,
          suggestedAction: '补充依赖对象，或提供不在范围内的书面依据。',
          relatedId: dependencyId,
        });
      });
  });

  allChanges
    .filter(
      (candidate) =>
        candidate.id !== change.id &&
        !['draft', 'rejected', 'rolled_back'].includes(candidate.status) &&
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

  const pendingUpstream = (change.impactNotices ?? []).filter(
    (notice) => notice.kind === 'upstream-invalidated' && !notice.acknowledged,
  );
  pendingUpstream.forEach((notice, index) => {
    const readiness = recomputeRollbackReadiness(change, allChanges);
    issues.push({
      id: `${change.id}-upstream-${notice.id}`,
      changeId: change.id,
      severity: 'blocker',
      code: 'UPSTREAM_INVALIDATED',
      title: `前置资源变更，v${change.schemeVersion} 会签已失效`,
      detail: `${notice.title} 波及本方案的 ${notice.affectedResourceIds.join('、') || '共享资源'}。原四级会签已随旧关系作废，回滚能力已按新关系重算：${
        readiness.executable
          ? `现有 ${readiness.executableRollbackCount} 项可执行回滚步骤覆盖 ${readiness.criticalCount} 个关键资源。`
          : readiness.reasons.join('；') + '。'
      }`,
      suggestedAction: `核对依赖图与回滚覆盖（${index === 0 ? '确认后' : '逐条确认'}），按新关系重新提交四级会签。`,
      relatedId: notice.sourceChangeId,
    });
  });

  if (change.reviewDraft) {
    const draft = change.reviewDraft;
    issues.push({
      id: `${change.id}-review-draft`,
      changeId: change.id,
      severity: 'warning',
      code: 'STALE_REVIEW_DRAFT',
      title: `留存基于 v${draft.baseVersion} 的待复核草稿`,
      detail: `${draft.savedAt.toLocaleString()} 有一个基于旧版本的${
        draft.origin === 'stale-approval' ? '会签意见' : '方案修改'
      }未进入正式版本（当前 v${draft.latestVersion}）：${draft.note}`,
      suggestedAction: '打开审批页复核该草稿，采纳后基于最新版本重新保存，或丢弃。',
    });
  }

  return issues;
}

export function createAudit(action: string, detail: string, actor = '当前用户'): AuditRecord {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: new Date().toISOString(),
    actor,
    action,
    detail,
  };
}
