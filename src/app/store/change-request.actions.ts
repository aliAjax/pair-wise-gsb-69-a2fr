import { createActionGroup, emptyProps, props } from '@ngrx/store';
import { ApprovalStage, ChangeRequest, DeviationRecord } from '../models/change-request.model';

export const ChangeRequestActions = createActionGroup({
  source: 'Change Request',
  events: {
    'Load Changes': emptyProps(),
    'Load Changes Success': props<{ changes: ChangeRequest[] }>(),
    'Load Changes Failure': props<{ error: string }>(),
    'Create Change': props<{ change: ChangeRequest }>(),
    /** 保存方案；携带审批页打开时记住的版本，过期提交只留待复核草稿 */
    'Update Change': props<{ change: ChangeRequest; baseVersion: number }>(),
    /** 复核待复核草稿：采纳并并入最新版本 */
    'Adopt Review Draft': props<{ id: string }>(),
    /** 复核待复核草稿：丢弃 */
    'Discard Review Draft': props<{ id: string }>(),
    /** 确认前置资源变化的影响提示，清除阻断门禁 */
    'Acknowledge Impact': props<{ id: string; noticeId: string }>(),
    'Delete Draft': props<{ id: string }>(),
    'Submit For Review': props<{ id: string; baseVersion: number }>(),
    'Approve Stage': props<{
      id: string;
      stage: ApprovalStage;
      approver: string;
      comment: string;
      baseVersion: number;
    }>(),
    'Reject Stage': props<{
      id: string;
      stage: ApprovalStage;
      approver: string;
      comment: string;
      baseVersion: number;
    }>(),
    'Start Execution': props<{ id: string }>(),
    'Toggle Step': props<{ id: string; stepId: string }>(),
    'Record Deviation': props<{ id: string; deviation: DeviationRecord }>(),
    'Complete Execution': props<{
      id: string;
      result: 'completed' | 'rolled_back';
      note: string;
    }>(),
  },
});
