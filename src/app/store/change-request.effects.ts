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

  /**
   * 跨标签页同步：另一标签页保存后写入 localStorage，本标签页通过 storage 事件
   * 拿到新状态。页面记住的 baseVersion 不会被更新，因此旧页面提交只能留待复核草稿。
   */
  externalSync$ = createEffect(() =>
    fromEvent<StorageEvent>(window, 'storage').pipe(
      filter((event) => event.key === this.service.storageKey),
      map((event) => this.service.parseSnapshot(event.newValue)),
      filter((changes): changes is NonNullable<typeof changes> => changes !== null),
      map((changes) => ChangeRequestActions.loadChangesSuccess({ changes })),
    ),
  );

  persistChanges$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(
          ChangeRequestActions.createChange,
          ChangeRequestActions.updateChange,
          ChangeRequestActions.adoptReviewDraft,
          ChangeRequestActions.discardReviewDraft,
          ChangeRequestActions.acknowledgeImpact,
          ChangeRequestActions.deleteDraft,
          ChangeRequestActions.submitForReview,
          ChangeRequestActions.approveStage,
          ChangeRequestActions.rejectStage,
          ChangeRequestActions.startExecution,
          ChangeRequestActions.toggleStep,
          ChangeRequestActions.recordDeviation,
          ChangeRequestActions.completeExecution,
        ),
        withLatestFrom(this.store.select(selectAllChanges)),
        tap(([, changes]) => this.service.save(changes)),
      ),
    { dispatch: false },
  );
}
