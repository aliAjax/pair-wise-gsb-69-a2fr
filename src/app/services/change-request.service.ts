import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, Observable, of, tap } from 'rxjs';
import { ChangeRequest, normalizeChange } from '../models/change-request.model';

const STORAGE_KEY = 'pair-wise-gsb-69-changes';

@Injectable({ providedIn: 'root' })
export class ChangeRequestService {
  private readonly http = inject(HttpClient);

  readonly storageKey = STORAGE_KEY;

  /** 供 storage 事件回调解析其他标签页写入的快照 */
  parseSnapshot(raw: string | null): ChangeRequest[] | null {
    if (!raw) {
      return null;
    }
    try {
      return (JSON.parse(raw) as Partial<ChangeRequest>[]).map(normalizeChange);
    } catch {
      return null;
    }
  }

  load(): Observable<ChangeRequest[]> {
    const localValue = localStorage.getItem(STORAGE_KEY);
    if (localValue) {
      const snapshot = this.parseSnapshot(localValue);
      if (snapshot) {
        return of(snapshot);
      }
      localStorage.removeItem(STORAGE_KEY);
    }

    return this.http.get<ChangeRequest[]>('/mock/change-requests.json').pipe(
      tap((changes) => this.save(changes)),
      catchError((error: unknown) => {
        console.error('Failed to load change requests', error);
        return of([]);
      }),
    );
  }

  save(changes: ChangeRequest[]): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(changes));
  }

  exportRetrospective(change: ChangeRequest): string {
    const lines = [
      `# ${change.id} ${change.title} 复盘记录`,
      '',
      `状态：${change.status}`,
      `负责人：${change.owner}`,
      `窗口：${change.window.start} - ${change.window.end}`,
      `风险等级：${change.risk}`,
      `最终方案版本：v${change.schemeVersion}`,
      change.executionSnapshot
        ? `执行依据快照：v${change.executionSnapshot.schemeVersion}（${change.executionSnapshot.bundleSignature}，冻结于 ${change.executionSnapshot.capturedAt}）`
        : '执行依据快照：无',
      '',
      '## 前置资源影响提示',
      ...((change.impactNotices ?? []).length
        ? (change.impactNotices ?? []).map(
            (item) =>
              `- ${item.recordedAt} [${item.kind === 'upstream-invalidated' ? '会签失效' : '执行提示'}] ${item.title}：${item.detail}`,
          )
        : ['- 无']),
      '',
      '## 执行偏离',
      ...(change.deviations.length
        ? change.deviations.map(
            (item) => `- ${item.recordedAt} ${item.owner} [${item.decision}] ${item.description}`,
          )
        : ['- 无']),
      '',
      '## 审计轨迹',
      ...change.audit.map(
        (item) => `- ${item.timestamp} ${item.actor} ${item.action}：${item.detail}`,
      ),
    ];
    return lines.join('\n');
  }
}
