import { inject, Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { catchError, filter, fromEvent, map, of, switchMap, tap, withLatestFrom } from 'rxjs';
import { ChangeRequestService } from '../services/change-request.service';
import { ChangeRequestActions } from './change-request.actions';
import { selectAllChanges } from './change-request.selectors';

@Injectable()
export class ChangeRequestEffects {
  private readonly actions$ = inject(Actions);
  private readonly service = inject(ChangeRequestService);
  private readonly store = inject(Store);

  loadChanges$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ChangeRequestActions.loadChanges),
      switchMap(() =>
        this.service.load().pipe(
          map((changes) => ChangeRequestActions.loadChangesSuccess({ changes })),
          catchError((error: unknown) =>
            of(
              ChangeRequestActions.loadChangesFailure({
                error: error instanceof Error ? error.message : '变更数据加载失败',
              }),
            ),
          ),
        ),
      ),
    ),
  );

  persistChanges$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(
          ChangeRequestActions.createChange,
          ChangeRequestActions.updateChange,
          ChangeRequestActions.deleteDraft,
          ChangeRequestActions.submitForReview,
          ChangeRequestActions.approveStage,
          ChangeRequestActions.rejectStage,
          ChangeRequestActions.startExecution,
          ChangeRequestActions.toggleStep,
          ChangeRequestActions.recordDeviation,
          ChangeRequestActions.completeExecution,
          ChangeRequestActions.acknowledgeImpactNotice,
        ),
        withLatestFrom(this.store.select(selectAllChanges)),
        tap(([, changes]) => this.service.save(changes)),
      ),
    { dispatch: false },
  );

  /**
   * 跨标签页同步：另一个标签页先保存后，本标签页通过 storage 事件拿到最新数据，
   * 保证审批页记住的版本能立即与最新版本比对出来。
   */
  syncFromStorage$ = createEffect(() =>
    fromEvent<StorageEvent>(window, 'storage').pipe(
      filter((event) => !event.key || event.key === this.service.storageKey),
      switchMap(() =>
        this.service.readStorage().pipe(
          map((changes) =>
            changes ? ChangeRequestActions.syncFromStorage({ changes }) : null,
          ),
          catchError(() => of(null)),
        ),
      ),
      filter((action): action is ReturnType<typeof ChangeRequestActions.syncFromStorage> =>
        action !== null,
      ),
    ),
  );
}
