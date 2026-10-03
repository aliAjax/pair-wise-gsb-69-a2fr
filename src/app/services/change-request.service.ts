import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, map, Observable, of, tap } from 'rxjs';
import { ChangeRequest, normalizeChange } from '../models/change-request.model';

export const STORAGE_KEY = 'pair-wise-gsb-69-changes';

@Injectable({ providedIn: 'root' })
export class ChangeRequestService {
  private readonly http = inject(HttpClient);

  get storageKey(): string {
    return STORAGE_KEY;
  }

  load(): Observable<ChangeRequest[]> {
    const localValue = localStorage.getItem(STORAGE_KEY);
    if (localValue) {
      try {
        const parsed = JSON.parse(localValue) as ChangeRequest[];
        return of(parsed.map(normalizeChange));
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }

    return this.http.get<ChangeRequest[]>('/mock/change-requests.json').pipe(
      map((changes) => changes.map(normalizeChange)),
      tap((changes) => this.save(changes)),
      catchError((error: unknown) => {
        console.error('Failed to load change requests', error);
        return of([]);
      }),
    );
  }

  /** 供跨标签页 storage 事件使用，读取失败时返回 null。 */
  readStorage(): Observable<ChangeRequest[] | null> {
    const localValue = localStorage.getItem(STORAGE_KEY);
    if (!localValue) {
      return of(null);
    }
    try {
      return of((JSON.parse(localValue) as ChangeRequest[]).map(normalizeChange));
    } catch {
      return of(null);
    }
  }

  save(changes: ChangeRequest[]): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(changes));
  }

  exportRetrospective(change: ChangeRequest): string {
    const snapshot = change.executionSnapshot;
    const lines = [
      `# ${change.id} ${change.title} 复盘记录`,
      '',
      `状态：${change.status}`,
      `当前方案版本：v${change.version}`,
      `执行依据版本：${snapshot ? `v${snapshot.version}（${snapshot.createdAt} 冻结）` : '未冻结'}`,
      `负责人：${change.owner}`,
      `窗口：${change.window.start} - ${change.window.end}`,
      `风险等级：${change.risk}`,
      '',
      '## 执行偏离',
      ...(change.deviations.length
        ? change.deviations.map(
            (item) =>
              `- ${item.recordedAt} ${item.owner} [${item.decision}] ${item.description}`,
          )
        : ['- 无']),
      '',
      '## 上游关系变化影响提示',
      ...(change.impactNotices.length
        ? change.impactNotices.map(
            (item) =>
              `- ${item.observedAt} 来源 ${item.sourceChangeId}${
                item.acknowledged ? '（已确认）' : ''
              }：${item.detail}`,
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
