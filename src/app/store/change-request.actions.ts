import { createActionGroup, emptyProps, props } from '@ngrx/store';
import {
  ApprovalStage,
  ChangeRequest,
  DeviationRecord,
} from '../models/change-request.model';

export const ChangeRequestActions = createActionGroup({
  source: 'Change Request',
  events: {
    'Load Changes': emptyProps(),
    'Load Changes Success': props<{ changes: ChangeRequest[] }>(),
    'Load Changes Failure': props<{ error: string }>(),
    'Create Change': props<{ change: ChangeRequest }>(),
    /**
     * 保存方案。expectedVersion 为页面打开时记住的版本；
     * 与 store 中当前版本不一致时不覆盖新内容，旧页面仅留下待复核草稿。
     */
    'Update Change': props<{
      change: ChangeRequest;
      expectedVersion: number;
    }>(),
    'Delete Draft': props<{ id: string }>(),
    'Submit For Review': props<{ id: string; expectedVersion: number }>(),
    'Approve Stage': props<{
      id: string;
      stage: ApprovalStage;
      approver: string;
      comment: string;
      expectedVersion: number;
    }>(),
    'Reject Stage': props<{
      id: string;
      stage: ApprovalStage;
      approver: string;
      comment: string;
      expectedVersion: number;
    }>(),
    'Start Execution': props<{ id: string; expectedVersion: number }>(),
    'Toggle Step': props<{ id: string; stepId: string }>(),
    'Record Deviation': props<{ id: string; deviation: DeviationRecord }>(),
    'Complete Execution': props<{ id: string; result: 'completed' | 'rolled_back'; note: string }>(),
    /** 另一标签页写入 localStorage 后同步本标签页状态。 */
    'Sync From Storage': props<{ changes: ChangeRequest[] }>(),
    /** 确认执行中方案收到的上游关系变化影响提示。 */
    'Acknowledge Impact Notice': props<{ id: string; noticeId: string }>(),
  },
});
