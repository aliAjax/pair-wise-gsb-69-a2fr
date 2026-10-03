import { DatePipe, NgClass } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { Store } from '@ngrx/store';
import { AuditTrailComponent } from '../../components/audit-trail/audit-trail.component';
import { DependencyGraphComponent } from '../../components/dependency-graph/dependency-graph.component';
import { ValidationPanelComponent } from '../../components/validation-panel/validation-panel.component';
import { WindowGanttComponent } from '../../components/window-gantt/window-gantt.component';
import {
  ApprovalStage,
  ChangeRequest,
  ChangeStep,
  DeviationRecord,
  ExecutionSnapshot,
  ImpactNotice,
  PHASE_LABELS,
  RESOURCE_LABELS,
  RISK_LABELS,
  RollbackAssessment,
  STAGE_LABELS,
  STATUS_LABELS,
  boundContentEquals,
  validateChange,
} from '../../models/change-request.model';
import { ChangeRequestService } from '../../services/change-request.service';
import { ChangeRequestActions } from '../../store/change-request.actions';
import { selectAllChanges } from '../../store/change-request.selectors';

type DetailTab = 'overview' | 'dependency' | 'window' | 'execution' | 'approval' | 'audit';

@Component({
  selector: 'app-change-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    NgClass,
    FormsModule,
    RouterLink,
    ClarityModule,
    AuditTrailComponent,
    DependencyGraphComponent,
    ValidationPanelComponent,
    WindowGanttComponent,
  ],
  template: `
    @if (change(); as item) {
      @if (stale()) {
        <clr-alert clrAlertType="warning" [clrAlertClosable]="false">
          <clr-alert-item>
            <span class="alert-text">
              本页基于方案 v{{ pageVersion() }}，最新版本已是 v{{ item.version }}（可能由另一标签页先保存）。
              当前页面提交不会覆盖新版本，只会把方案留为待复核草稿并使会签失效。
            </span>
            <div class="alert-actions">
              <button class="btn btn-sm btn-warning" type="button" (click)="rebaseToLatest()">
                刷新到最新版本
              </button>
            </div>
          </clr-alert-item>
        </clr-alert>
      }
      @if (item.status === 'pending_review') {
        <clr-alert clrAlertType="alert" [clrAlertClosable]="false">
          <clr-alert-item>
            <span class="alert-text">
              方案处于待复核草稿：会签已在会签后因版本变化失效，资源关系与回滚步骤核对无误后请重新提交四级会签。
            </span>
          </clr-alert-item>
        </clr-alert>
      }
      @if (unacknowledgedNotices().length) {
        @for (notice of unacknowledgedNotices(); track notice.id) {
          <clr-alert clrAlertType="danger" [clrAlertClosable]="false">
            <clr-alert-item>
              <span class="alert-text">
                上游资源关系在执行期间发生变化（{{ notice.observedAt | date: 'MM-dd HH:mm' }}）：
                {{ notice.detail }}
                正在执行的步骤维持批准时快照，不做改动。
              </span>
              <div class="alert-actions">
                <button class="btn btn-sm" type="button" (click)="acknowledgeNotice(notice.id)">
                  已知悉，挂为影响提示
                </button>
              </div>
            </clr-alert-item>
          </clr-alert>
        }
      }

      <section class="detail-heading">
        <div class="heading-main">
          <a routerLink="/" class="back-link">返回变更队列</a>
          <div class="title-row">
            <div>
              <span class="change-id">{{ item.id }}</span>
              <h1>{{ item.title }}</h1>
            </div>
            <span class="status" [class]="item.status">{{ statusLabel(item.status) }}</span>
          </div>
          <p>{{ item.summary || '尚未填写变更摘要。' }}</p>
        </div>
        <div class="heading-meta">
          <div>
            <span>负责人</span>
            <strong>{{ item.owner }}</strong>
          </div>
          <div>
            <span>方案版本</span>
            <strong>
              v{{ item.version }}
              @if (snapshot(); as snap) {
                                · 执行依据 v{{ snap.version }}
              }
            </strong>
          </div>
          <div>
            <span>更新</span>
            <strong>{{ item.updatedAt | date: 'MM-dd HH:mm' }}</strong>
          </div>
        </div>
      </section>

      <nav class="tab-nav" aria-label="变更详情">
        @for (tab of tabs; track tab.id) {
          <button
            type="button"
            [class.active]="selectedTab() === tab.id"
            (click)="selectedTab.set(tab.id)"
          >
            {{ tab.label }}
            @if (tab.id === 'approval' && pendingStage(); as stage) {
              <span class="nav-badge">{{ stageLabel(stage) }}</span>
            }
          </button>
        }
      </nav>

      @switch (selectedTab()) {
        @case ('overview') {
          <div class="content-grid">
            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>方案概览</h2>
                  <span>影响范围、值班和执行边界 · 资源依赖/窗口/回滚步骤与版本绑定</span>
                </div>
                <button
                  class="btn btn-sm"
                  type="button"
                  (click)="editing() ? cancelEdit() : beginEdit()"
                  [disabled]="item.status === 'executing' || item.status === 'completed' || item.status === 'rolled_back'"
                >
                  {{ editing() ? '取消编辑' : '编辑方案' }}
                </button>
              </div>

              @if (editing()) {
                @if (['submitted', 'approved', 'rejected', 'pending_review'].includes(item.status)) {
                  <div class="inline-warning">
                    会签后修改资源依赖、执行窗口或回滚步骤会生成新版本并使原会签失效，方案回到待复核草稿。
                  </div>
                }
                @if (stale()) {
                  <div class="inline-warning danger">
                    本页记住的是 v{{ pageVersion() }}，最新为 v{{ item.version }}，保存不会覆盖新版本内容。
                  </div>
                }
                <div class="edit-form">
                  <clr-input-container>
                    <label>标题</label>
                    <input
                      clrInput
                      [ngModel]="draft()?.title"
                      (ngModelChange)="updateDraft('title', $event)"
                    />
                  </clr-input-container>
                  <clr-textarea-container>
                    <label>摘要</label>
                    <textarea
                      clrTextarea
                      rows="3"
                      [ngModel]="draft()?.summary"
                      (ngModelChange)="updateDraft('summary', $event)"
                    ></textarea>
                  </clr-textarea-container>
                  <div class="edit-grid">
                    <clr-input-container>
                      <label>窗口开始</label>
                      <input
                        clrInput
                        type="datetime-local"
                        [ngModel]="draft()?.window?.start"
                        (ngModelChange)="updateDraftWindow('start', $event)"
                      />
                    </clr-input-container>
                    <clr-input-container>
                      <label>窗口结束</label>
                      <input
                        clrInput
                        type="datetime-local"
                        [ngModel]="draft()?.window?.end"
                        (ngModelChange)="updateDraftWindow('end', $event)"
                      />
                    </clr-input-container>
                    <clr-input-container>
                      <label>观察窗口（分钟）</label>
                      <input
                        clrNumberInput
                        type="number"
                        [ngModel]="draft()?.window?.observationWindowMinutes"
                        (ngModelChange)="updateObservation($event)"
                      />
                    </clr-input-container>
                  </div>
                  <div class="edit-actions">
                    @if (editingBoundContent()) {
                      <span class="version-hint">将保存为新版本，绑定内容已变更</span>
                    }
                    <button class="btn btn-primary" type="button" (click)="saveEdit()">保存方案</button>
                  </div>
                </div>
              } @else {
                <dl class="facts">
                  <div>
                    <dt>执行窗口</dt>
                    <dd>
                      {{ item.window.start | date: 'yyyy-MM-dd HH:mm' }} 至
                      {{ item.window.end | date: 'yyyy-MM-dd HH:mm' }}
                    </dd>
                  </div>
                  <div>
                    <dt>观察窗口</dt>
                    <dd>{{ item.window.observationWindowMinutes }} 分钟</dd>
                  </div>
                  <div>
                    <dt>值守人员</dt>
                    <dd>{{ item.onCall.join('、') }}</dd>
                  </div>
                  <div>
                    <dt>风险等级</dt>
                    <dd>{{ riskLabel(item.risk) }}</dd>
                  </div>
                  <div class="span-2">
                    <dt>当前门禁</dt>
                    <dd>{{ pendingStage() ? stageLabel(pendingStage()!) + '待会签' : approvalGate() }}</dd>
                  </div>
                </dl>
              }
            </section>

            <app-validation-panel [change]="item" [allChanges]="changes()" />

            @if (rollbackAssessment(); as assessment) {
              <section class="surface assessment">
                <div class="surface-heading">
                  <div>
                    <h2>回滚能力（按资源关系重算）</h2>
                    <span>
                      评估基于 v{{ assessment.basedOnVersion }}
                      @if (assessment.basedOnVersion !== item.version) {
                        · 已落后当前 v{{ item.version }}，需重新评估
                      }
                    </span>
                  </div>
                  <span
                    class="assessment-badge"
                    [class.bad]="!assessment.executable || assessment.basedOnVersion !== item.version"
                  >
                    {{ assessment.executable ? '可执行' : '不可执行' }}
                  </span>
                </div>
                <dl class="facts compact">
                  <div>
                    <dt>覆盖资源</dt>
                    <dd>{{ assessment.coveredResourceIds.length }} 个</dd>
                  </div>
                  <div>
                    <dt>未覆盖资源</dt>
                    <dd>
                      {{
                        assessment.uncoveredResourceIds.length
                          ? assessment.uncoveredResourceIds.map((id) => resourceName(id)).join('、')
                          : '无'
                      }}
                    </dd>
                  </div>
                  <div>
                    <dt>缺责任人回滚步骤</dt>
                    <dd>{{ assessment.stepsMissingOwner.length }}</dd>
                  </div>
                  <div>
                    <dt>缺命令回滚步骤</dt>
                    <dd>{{ assessment.stepsMissingCommand.length }}</dd>
                  </div>
                </dl>
                <p class="assessment-foot">
                  前置机柜或共享资源关系一变，未执行方案的回滚能力会按新关系自动重算并阻断重新会签。
                </p>
              </section>
            }

            <section class="surface span-2">
              <div class="surface-heading">
                <div>
                  <h2>资源清单</h2>
                  <span>{{ item.resources.length }} 个对象，明确关键资源依赖</span>
                </div>
              </div>
              <div class="resource-table">
                @for (resource of item.resources; track resource.id) {
                  <article>
                    <span class="type">{{ resourceLabel(resource.type) }}</span>
                    <div>
                      <strong>{{ resource.name }}</strong>
                      <small>{{ resource.id }}</small>
                    </div>
                    <span>{{ resource.critical ? '关键资源' : '一般资源' }}</span>
                    <span>依赖 {{ resource.dependencies.length }} 项</span>
                  </article>
                } @empty {
                  <p class="empty">未配置资源。</p>
                }
              </div>
            </section>
          </div>
        }

        @case ('dependency') {
          <section class="surface">
            <div class="surface-heading">
              <div>
                <h2>依赖关系图</h2>
                <span>虚线表示依赖资源未纳入本次影响范围</span>
              </div>
            </div>
            <app-dependency-graph [change]="item" />
          </section>
        }

        @case ('window') {
          <section class="surface">
            <div class="surface-heading">
              <div>
                <h2>窗口与资源冲突</h2>
                <span>按 09-29 至 10-02 展示所有有效窗口</span>
              </div>
            </div>
            <app-window-gantt [changes]="changes()" [selectedId]="item.id" />
            <div class="conflict-notes">
              @for (issue of issues(); track issue.id) {
                @if (issue.code === 'WINDOW_CONFLICT') {
                  <article>
                    <strong>{{ issue.title }}</strong>
                    <p>{{ issue.detail }}</p>
                    <span>{{ issue.suggestedAction }}</span>
                  </article>
                }
              } @empty {
                <p class="empty">当前没有窗口冲突。</p>
              }
            </div>
          </section>
        }

        @case ('execution') {
          <div class="content-grid execution-grid">
            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>执行步骤</h2>
                  <span>
                    执行中可逐项勾选，所有操作保留时间戳
                    @if (snapshot(); as snap) {
                      · 步骤以批准快照 v{{ snap.version }} 为准，后续资源变化不改执行步骤
                    }
                  </span>
                </div>
                @if (item.status === 'approved') {
                  <button class="btn btn-primary" type="button" (click)="startExecution()">
                    开始执行
                  </button>
                }
              </div>
              <div class="step-list">
                @for (step of displaySteps(); track step.id) {
                  <label class="step-row" [class.completed]="step.completed">
                    <input
                      type="checkbox"
                      [checked]="step.completed"
                      [disabled]="item.status !== 'executing'"
                      (change)="toggleStep(step.id)"
                    />
                    <span class="phase">{{ phaseLabel(step.phase) }}</span>
                    <div>
                      <strong>{{ step.title }}</strong>
                      <code>{{ step.command || '未填写命令' }}</code>
                    </div>
                    <span>{{ step.owner || '未指定' }}</span>
                  </label>
                } @empty {
                  <p class="empty">没有执行步骤。</p>
                }
              </div>
            </section>

            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>实时执行记录</h2>
                  <span>记录偏离并明确继续、暂停或回滚</span>
                </div>
                <a class="btn btn-sm" href="https://logs.example.internal/change/{{ item.id }}" target="_blank" rel="noopener">
                  打开实时日志
                </a>
              </div>
              @if (item.status === 'executing') {
                <div class="deviation-form">
                  <clr-textarea-container>
                    <label>偏离说明</label>
                    <textarea
                      clrTextarea
                      rows="3"
                      [ngModel]="deviationText()"
                      (ngModelChange)="deviationText.set($event)"
                      placeholder="描述实际执行与方案差异"
                    ></textarea>
                  </clr-textarea-container>
                  <div class="deviation-actions">
                    <clr-select-container>
                      <label>处置决定</label>
                      <select
                        clrSelect
                        [ngModel]="deviationDecision()"
                        (ngModelChange)="deviationDecision.set($event)"
                      >
                        <option value="continue">继续观察</option>
                        <option value="pause">暂停执行</option>
                        <option value="rollback">立即回滚</option>
                      </select>
                    </clr-select-container>
                    <button class="btn" type="button" (click)="recordDeviation()">记录偏离</button>
                  </div>
                </div>
                <div class="completion-actions">
                  <button class="btn" type="button" (click)="complete('rolled_back')">判定回滚</button>
                  <button class="btn btn-primary" type="button" (click)="complete('completed')">
                    执行完成
                  </button>
                </div>
              }
              <div class="deviation-list">
                @for (deviation of item.deviations; track deviation.id) {
                  <article>
                    <div>
                      <strong>{{ deviation.owner }}</strong>
                      <time>{{ deviation.recordedAt | date: 'MM-dd HH:mm' }}</time>
                    </div>
                    <p>{{ deviation.description }}</p>
                    <span>{{ decisionLabel(deviation.decision) }}</span>
                  </article>
                } @empty {
                  <p class="empty">尚无执行偏离。</p>
                }
              </div>
            </section>
          </div>

          @if (item.impactNotices.length) {
            <section class="surface span-2">
              <div class="surface-heading">
                <div>
                  <h2>上游关系变化影响提示</h2>
                  <span>
                    执行中方案保留批准快照，前置机柜/共享资源的后续变化只挂提示，不改正执行中的步骤
                  </span>
                </div>
              </div>
              <div class="notice-list">
                @for (notice of item.impactNotices; track notice.id) {
                  <article [class.acknowledged]="notice.acknowledged">
                    <div>
                      <strong>{{ notice.sourceChangeId }}</strong>
                      <time>{{ notice.observedAt | date: 'MM-dd HH:mm' }}</time>
                    </div>
                    <p>{{ notice.detail }}</p>
                    <span>
                      影响资源：{{ notice.changedResourceIds.map((id) => resourceName(id)).join('、') }}
                      · {{ notice.acknowledged ? '已确认' : '待确认' }}
                    </span>
                    @if (!notice.acknowledged) {
                      <button class="btn btn-sm" type="button" (click)="acknowledgeNotice(notice.id)">
                        已知悉
                      </button>
                    }
                  </article>
                }
              </div>
            </section>
          }
        }

        @case ('approval') {
          <div class="content-grid approval-grid">
            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>顺序会签</h2>
                  <span>
                    必须按网络、系统、安全、业务顺序完成 · 签署基于方案
                    v{{ pageVersion() ?? item.version }}
                  </span>
                </div>
                @if (['draft', 'rejected', 'pending_review'].includes(item.status)) {
                  <button
                    class="btn btn-primary"
                    type="button"
                    (click)="submitForReview()"
                    [disabled]="hasBlockers()"
                  >
                    {{ item.status === 'pending_review' ? '重新提交审批' : '提交审批' }}
                  </button>
                }
              </div>
              <ol class="approval-flow">
                @for (approval of item.approvals; track approval.stage) {
                  <li [ngClass]="approval.state">
                    <span class="flow-index">{{ $index + 1 }}</span>
                    <div>
                      <strong>{{ stageLabel(approval.stage) }}</strong>
                      <p>
                        {{ approval.comment || approvalStateText(approval.state) }}
                      </p>
                      @if (approval.approver) {
                        <small>
                          {{ approval.approver }}
                          @if (approval.signedVersion) {
                            · v{{ approval.signedVersion }}
                          }
                          · {{ approval.decidedAt | date: 'MM-dd HH:mm' }}
                        </small>
                      }
                    </div>
                  </li>
                }
              </ol>
            </section>

            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>会签操作</h2>
                  <span>只有当前顺位负责人可以签署</span>
                </div>
              </div>
              @if (pendingStage(); as stage) {
                @if (item.status === 'submitted') {
                  <div class="approval-form">
                    @if (stale()) {
                      <div class="inline-warning danger">
                        本页打开后方案已被更新到 v{{ item.version }}，此刻批准/退回不会生效，
                        仅会把方案留为待复核草稿。请先刷新到最新版本再签署。
                      </div>
                    }
                    <clr-input-container>
                      <label>审批人</label>
                      <input
                        clrInput
                        [ngModel]="approver()"
                        (ngModelChange)="approver.set($event)"
                      />
                    </clr-input-container>
                    <clr-textarea-container>
                      <label>意见</label>
                      <textarea
                        clrTextarea
                        rows="3"
                        [ngModel]="approvalComment()"
                        (ngModelChange)="approvalComment.set($event)"
                      ></textarea>
                    </clr-textarea-container>
                    <div class="approval-actions">
                      <button class="btn" type="button" (click)="reject(stage)">退回</button>
                      <button class="btn btn-primary" type="button" (click)="approve(stage)">
                        批准 {{ stageLabel(stage) }}
                      </button>
                    </div>
                  </div>
                } @else {
                  <p class="empty">当前状态不允许审批操作。</p>
                }
              } @else {
                <p class="approved-message">
                  会签已完成。开始执行后审批记录自动冻结，不允许修改。
                </p>
              }
            </section>

            <section class="surface span-2">
              <div class="surface-heading">
                <div>
                  <h2>审批冻结快照</h2>
                  <span>
                    @if (snapshot(); as snap) {
                      四级会签于 {{ snap.createdAt | date: 'MM-dd HH:mm' }} 完成，执行与复盘以
                      v{{ snap.version }} 冻结版本为准
                    } @else {
                      批准时生成快照；会签失效或尚未批准时暂无冻结版本
                    }
                  </span>
                </div>
              </div>
              <div class="freeze-strip">
                @for (approval of item.approvals; track approval.stage) {
                  <div>
                    <span>{{ stageLabel(approval.stage) }}</span>
                    <strong>{{ approvalStateText(approval.state) }}</strong>
                    @if (approval.signedVersion) {
                      <small>签署于 v{{ approval.signedVersion }}</small>
                    }
                  </div>
                }
              </div>
            </section>
          </div>
        }

        @case ('audit') {
          <div class="content-grid audit-grid">
            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>审计轨迹</h2>
                  <span>创建、编辑、会签、执行和回滚均记录</span>
                </div>
                <button class="btn btn-sm" type="button" (click)="exportRetrospective()">
                  导出复盘记录
                </button>
              </div>
              <app-audit-trail [records]="item.audit" />
            </section>
            <section class="surface">
              <div class="surface-heading">
                <div>
                  <h2>复盘摘要</h2>
                  <span>进入正式变更档案的事实记录</span>
                </div>
              </div>
              <dl class="facts compact">
                <div>
                  <dt>最终状态</dt>
                  <dd>{{ statusLabel(item.status) }}</dd>
                </div>
                <div>
                  <dt>执行偏离</dt>
                  <dd>{{ item.deviations.length }} 条</dd>
                </div>
                <div>
                  <dt>审计事件</dt>
                  <dd>{{ item.audit.length }} 条</dd>
                </div>
                <div>
                  <dt>完成步骤</dt>
                  <dd>{{ completedSteps(item) }} / {{ item.steps.length }}</dd>
                </div>
              </dl>
              <div class="retrospective-note">
                <strong>导出内容</strong>
                <p>包含变更窗口、资源范围、执行偏离、最终状态和完整审计轨迹。</p>
              </div>
            </section>
          </div>
        }
      }
    } @else {
      <section class="not-found">
        <h1>变更不存在</h1>
        <p>该记录可能已被删除，或链接中的编号无效。</p>
        <a class="btn btn-primary" routerLink="/">返回变更队列</a>
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .detail-heading {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 24px;
        padding: 20px 0 24px;
        border-bottom: 1px solid #d7d7d7;
      }

      .back-link {
        display: inline-block;
        margin-bottom: 14px;
        font-size: 12px;
      }

      .title-row {
        display: flex;
        align-items: center;
        gap: 14px;
      }

      .change-id {
        color: #266c91;
        font-size: 12px;
        font-weight: 600;
      }

      h1 {
        margin: 2px 0 0;
        font-size: 28px;
      }

      .heading-main > p {
        max-width: 760px;
        margin: 12px 0 0;
        color: #5e5e5e;
      }

      .heading-meta {
        display: grid;
        grid-template-columns: repeat(3, minmax(90px, 1fr));
        align-self: end;
        border: 1px solid #d7d7d7;
        background: #fff;
      }

      .heading-meta div {
        padding: 12px 16px;
        border-left: 1px solid #e1e1e1;
      }

      .heading-meta div:first-child {
        border-left: 0;
      }

      .heading-meta span,
      .heading-meta strong {
        display: block;
      }

      .heading-meta span {
        color: #6d6d6d;
        font-size: 11px;
      }

      .heading-meta strong {
        margin-top: 4px;
        font-size: 13px;
      }

      .status {
        padding: 3px 9px;
        border: 1px solid #9a9a9a;
        background: #f3f3f3;
        color: #474747;
        font-size: 12px;
      }

      .status.submitted,
      .status.approved {
        border-color: #5688a5;
        background: #eaf4f9;
        color: #1d5877;
      }

      .status.pending_review {
        border-color: #d0a251;
        background: #fff7e6;
        color: #7c5000;
      }

      .alert-actions {
        margin-top: 8px;
      }

      .inline-warning {
        margin-bottom: 12px;
        padding: 10px 12px;
        border-left: 3px solid #d99000;
        background: #fff7e6;
        color: #7c5000;
        font-size: 12px;
      }

      .inline-warning.danger {
        border-left-color: #c21d00;
        background: #fbece8;
        color: #8e260f;
      }

      .version-hint {
        align-self: center;
        margin-right: auto;
        color: #7c5000;
        font-size: 12px;
      }

      .assessment-badge {
        padding: 3px 10px;
        border: 1px solid #8fb99f;
        background: #edf7f0;
        color: #286140;
        font-size: 12px;
      }

      .assessment-badge.bad {
        border-color: #d58d7e;
        background: #fbece8;
        color: #8e260f;
      }

      .assessment-foot {
        margin: 12px 0 0;
        color: #6b6b6b;
        font-size: 12px;
      }

      .notice-list article {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 6px 14px;
        padding: 14px 4px;
        border-bottom: 1px solid #e6e6e6;
        border-left: 3px solid #c21d00;
        padding-left: 12px;
      }

      .notice-list article.acknowledged {
        border-left-color: #8fb99f;
        opacity: 0.75;
      }

      .notice-list article > div {
        display: flex;
        justify-content: space-between;
      }

      .notice-list p {
        grid-column: 1 / -1;
        margin: 4px 0;
      }

      .notice-list span {
        color: #8e260f;
        font-size: 11px;
      }

      .notice-list .btn {
        grid-row: 1;
        grid-column: 2;
      }

      .status.executing,
      .status.completed {
        border-color: #75a489;
        background: #edf7f0;
        color: #245f3d;
      }

      .status.rejected,
      .status.rolled_back {
        border-color: #d58d7e;
        background: #fbece8;
        color: #8e260f;
      }

      .tab-nav {
        display: flex;
        gap: 0;
        margin-bottom: 20px;
        border-bottom: 1px solid #d7d7d7;
        overflow-x: auto;
      }

      .tab-nav button {
        position: relative;
        padding: 13px 18px;
        border: 0;
        border-bottom: 3px solid transparent;
        background: transparent;
        color: #575757;
        cursor: pointer;
        white-space: nowrap;
      }

      .tab-nav button.active {
        border-bottom-color: #266c91;
        color: #174d6a;
        font-weight: 600;
      }

      .nav-badge {
        margin-left: 6px;
        padding: 1px 5px;
        background: #eaf4f9;
        color: #215a78;
        font-size: 10px;
      }

      .content-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }

      .surface {
        padding: 18px;
        border: 1px solid #d7d7d7;
        background: #fff;
      }

      .span-2 {
        grid-column: 1 / -1;
      }

      .surface-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding-bottom: 14px;
        border-bottom: 1px solid #e3e3e3;
      }

      .surface-heading h2 {
        margin: 0;
        font-size: 17px;
      }

      .surface-heading span {
        color: #666;
        font-size: 12px;
      }

      .facts {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 1px;
        margin: 18px 0 0;
        background: #e1e1e1;
      }

      .facts div {
        padding: 14px;
        background: #fafafa;
      }

      .facts dt {
        color: #666;
        font-size: 12px;
      }

      .facts dd {
        margin: 5px 0 0;
        font-weight: 600;
      }

      .facts.compact {
        margin-top: 16px;
      }

      .facts .span-2 {
        grid-column: 1 / -1;
      }

      .edit-form {
        padding-top: 18px;
      }

      .edit-grid,
      .deviation-actions {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 14px;
      }

      .edit-actions,
      .completion-actions,
      .approval-actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 16px;
      }

      .resource-table article {
        display: grid;
        grid-template-columns: 80px minmax(180px, 1fr) 100px 120px;
        align-items: center;
        gap: 14px;
        padding: 12px 4px;
        border-bottom: 1px solid #e6e6e6;
      }

      .resource-table article:last-child {
        border-bottom: 0;
      }

      .resource-table article div {
        display: flex;
        flex-direction: column;
      }

      .resource-table small,
      .resource-table article > span:last-child {
        color: #6b6b6b;
        font-size: 11px;
      }

      .type,
      .phase {
        display: inline-block;
        width: fit-content;
        padding: 2px 7px;
        background: #edf3f6;
        color: #205d7e;
        font-size: 11px;
      }

      .conflict-notes {
        margin-top: 16px;
      }

      .conflict-notes article {
        padding: 14px;
        border-left: 3px solid #c21d00;
        background: #fbece8;
      }

      .conflict-notes p {
        margin: 6px 0;
      }

      .conflict-notes span {
        color: #8e260f;
        font-size: 12px;
      }

      .step-row {
        display: grid;
        grid-template-columns: 20px 50px 1fr 90px;
        align-items: center;
        gap: 12px;
        padding: 14px 2px;
        border-bottom: 1px solid #e6e6e6;
      }

      .step-row.completed {
        background: #f5faf6;
      }

      .step-row div {
        display: flex;
        flex-direction: column;
      }

      .step-row code {
        margin-top: 4px;
        color: #666;
        font-size: 11px;
      }

      .deviation-form {
        padding: 16px 0;
        border-bottom: 1px solid #e3e3e3;
      }

      .deviation-actions {
        grid-template-columns: 1fr auto;
        align-items: end;
      }

      .deviation-list article {
        padding: 12px 0;
        border-bottom: 1px solid #e6e6e6;
      }

      .deviation-list article > div {
        display: flex;
        justify-content: space-between;
      }

      .deviation-list p {
        margin: 7px 0;
      }

      .deviation-list span {
        color: #8e260f;
        font-size: 11px;
      }

      .approval-flow {
        margin: 18px 0 0;
        padding: 0;
        list-style: none;
      }

      .approval-flow li {
        display: grid;
        grid-template-columns: 32px 1fr;
        gap: 12px;
        padding: 12px 0;
        border-bottom: 1px solid #e6e6e6;
      }

      .flow-index {
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        border: 1px solid #9d9d9d;
        color: #555;
      }

      .approval-flow li.approved .flow-index {
        border-color: #4b8d65;
        background: #e8f5ed;
        color: #245f3d;
      }

      .approval-flow li.rejected .flow-index {
        border-color: #c21d00;
        background: #fbece8;
        color: #8e260f;
      }

      .approval-flow li.invalidated {
        opacity: 0.8;
      }

      .approval-flow li.invalidated .flow-index {
        border-color: #d0a251;
        background: #fff7e6;
        color: #7c5000;
      }

      .approval-flow p {
        margin: 5px 0;
        color: #5f5f5f;
      }

      .approval-flow small {
        color: #737373;
      }

      .approval-form {
        padding-top: 16px;
      }

      .approved-message {
        margin: 18px 0 0;
        padding: 16px;
        border-left: 3px solid #4b8d65;
        background: #edf7f0;
        color: #245f3d;
      }

      .freeze-strip {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 1px;
        margin-top: 18px;
        background: #d7d7d7;
      }

      .freeze-strip div {
        display: flex;
        flex-direction: column;
        padding: 14px;
        background: #fafafa;
      }

      .freeze-strip span {
        color: #666;
        font-size: 11px;
      }

      .freeze-strip strong {
        margin-top: 4px;
      }

      .freeze-strip small {
        margin-top: 3px;
        color: #737373;
        font-size: 11px;
      }

      .retrospective-note {
        margin-top: 18px;
        padding: 16px;
        background: #f4f6f7;
      }

      .retrospective-note p {
        margin: 6px 0 0;
        color: #5f5f5f;
      }

      .empty {
        color: #737373;
      }

      .not-found {
        margin-top: 50px;
        padding: 48px;
        text-align: center;
        border: 1px solid #d7d7d7;
        background: #fff;
      }

      @media (max-width: 1100px) {
        .detail-heading,
        .content-grid {
          grid-template-columns: 1fr;
        }

        .span-2 {
          grid-column: auto;
        }
      }

      @media (max-width: 700px) {
        .heading-meta,
        .facts,
        .edit-grid,
        .freeze-strip {
          grid-template-columns: 1fr;
        }

        .heading-meta div {
          border-left: 0;
          border-top: 1px solid #e1e1e1;
        }

        .resource-table article,
        .step-row {
          grid-template-columns: 1fr;
        }

        .tab-nav {
          padding-bottom: 4px;
        }
      }
    `,
  ],
})
export class ChangeDetailComponent {
  private readonly store = inject(Store);
  private readonly route = inject(ActivatedRoute);
  private readonly service = inject(ChangeRequestService);
  private readonly changeId = this.route.snapshot.paramMap.get('id') ?? '';

  readonly changes = this.store.selectSignal(selectAllChanges);
  readonly change = computed(() => this.changes().find((item) => item.id === this.changeId));
  readonly selectedTab = signal<DetailTab>('overview');
  readonly editing = signal(false);
  readonly draft = signal<ChangeRequest | null>(null);
  readonly approver = signal('');
  readonly approvalComment = signal('');
  readonly deviationText = signal('');
  readonly deviationDecision = signal<DeviationRecord['decision']>('continue');
  /**
   * 审批页打开时记住的方案版本。审批操作与保存都带上该值做乐观并发校验：
   * 另一标签页先保存后，这里仍停留在旧版本，提交只会留下待复核草稿。
   */
  readonly pageVersion = signal<number | null>(null);

  readonly tabs: Array<{ id: DetailTab; label: string }> = [
    { id: 'overview', label: '方案概览' },
    { id: 'dependency', label: '依赖关系' },
    { id: 'window', label: '窗口甘特' },
    { id: 'execution', label: '执行记录' },
    { id: 'approval', label: '审批会签' },
    { id: 'audit', label: '审计复盘' },
  ];

  readonly issues = computed(() => {
    const item = this.change();
    return item ? validateChange(item, this.changes()) : [];
  });

  readonly hasBlockers = computed(() =>
    this.issues().some((issue) => issue.severity === 'blocker'),
  );

  /** 页面记住的版本与 store 中最新版本是否不一致（旧标签页场景）。 */
  readonly stale = computed(() => {
    const item = this.change();
    const pageVersion = this.pageVersion();
    return !!item && pageVersion !== null && item.version !== pageVersion;
  });

  /** 编辑中的草稿相对页面打开时是否改动了绑定内容（资源依赖/窗口/回滚步骤）。 */
  readonly editingBoundContent = computed(() => {
    const item = this.change();
    const draft = this.draft();
    return !!item && !!draft && !boundContentEquals(item, draft);
  });

  readonly pendingStage = computed<ApprovalStage | null>(() => {
    const item = this.change();
    if (!item || !['submitted'].includes(item.status)) {
      return null;
    }
    const rejected = item.approvals.find((approval) => approval.state === 'rejected');
    if (rejected) {
      return rejected.stage;
    }
    return item.approvals.find((approval) => approval.state === 'pending')?.stage ?? null;
  });

  /** 进入执行后以批准快照为准的步骤清单（实时勾选状态从当前步骤合并）。 */
  readonly snapshotSteps = computed<ChangeStep[] | null>(() => {
    const item = this.change();
    if (!item || !item.executionSnapshot) {
      return null;
    }
    if (item.status === 'approved') {
      return item.executionSnapshot.steps;
    }
    const liveState = new Map(item.steps.map((step) => [step.id, step]));
    return item.executionSnapshot.steps.map((step) => {
      const live = liveState.get(step.id);
      return live
        ? { ...step, completed: live.completed, completedAt: live.completedAt }
        : step;
    });
  });

  readonly snapshot = computed<ExecutionSnapshot | null>(() => this.change()?.executionSnapshot ?? null);

  readonly unacknowledgedNotices = computed<ImpactNotice[]>(() =>
    (this.change()?.impactNotices ?? []).filter((notice) => !notice.acknowledged),
  );

  readonly rollbackAssessment = computed<RollbackAssessment | null>(
    () => this.change()?.rollbackAssessment ?? null,
  );

  /**
   * 审批页打开时记住版本：数据首次到达即锚定。
   * 之后只有用户显式点击“刷新到最新版本”才更新锚点，模拟两个标签页各自持有版本。
   */
  private readonly anchorVersion = effect(() => {
    const item = this.change();
    if (item && this.pageVersion() === null) {
      this.pageVersion.set(item.version);
    }
  });

  rebaseToLatest(): void {
    const item = this.change();
    if (!item) {
      return;
    }
    this.pageVersion.set(item.version);
    this.editing.set(false);
    this.draft.set(null);
  }

  beginEdit(): void {
    const item = this.change();
    if (!item) {
      return;
    }
    this.draft.set(structuredClone(item));
    this.editing.set(true);
  }

  cancelEdit(): void {
    this.editing.set(false);
    this.draft.set(null);
  }

  updateDraft<K extends keyof ChangeRequest>(key: K, value: ChangeRequest[K]): void {
    this.draft.update((draft) => (draft ? { ...draft, [key]: value } : draft));
  }

  updateDraftWindow(key: 'start' | 'end', value: string): void {
    this.draft.update((draft) =>
      draft ? { ...draft, window: { ...draft.window, [key]: value } } : draft,
    );
  }

  updateObservation(value: string | number): void {
    this.draft.update((draft) =>
      draft
        ? {
            ...draft,
            window: { ...draft.window, observationWindowMinutes: Number(value) || 0 },
          }
        : draft,
    );
  }

  saveEdit(): void {
    const draft = this.draft();
    const pageVersion = this.pageVersion();
    if (!draft || pageVersion === null) {
      return;
    }
    this.store.dispatch(
      ChangeRequestActions.updateChange({ change: draft, expectedVersion: pageVersion }),
    );
    this.editing.set(false);
    this.draft.set(null);
  }

  submitForReview(): void {
    const pageVersion = this.pageVersion();
    if (pageVersion === null) {
      return;
    }
    if (!this.hasBlockers()) {
      this.store.dispatch(
        ChangeRequestActions.submitForReview({ id: this.changeId, expectedVersion: pageVersion }),
      );
    }
  }

  approve(stage: ApprovalStage): void {
    const pageVersion = this.pageVersion();
    if (pageVersion === null) {
      return;
    }
    const approver = this.approver().trim() || '当前用户';
    const comment = this.approvalComment().trim() || '同意按方案执行。';
    this.store.dispatch(
      ChangeRequestActions.approveStage({
        id: this.changeId,
        stage,
        approver,
        comment,
        expectedVersion: pageVersion,
      }),
    );
    this.clearApprovalForm();
  }

  reject(stage: ApprovalStage): void {
    const pageVersion = this.pageVersion();
    if (pageVersion === null) {
      return;
    }
    const approver = this.approver().trim() || '当前用户';
    const comment = this.approvalComment().trim();
    if (!comment) {
      return;
    }
    this.store.dispatch(
      ChangeRequestActions.rejectStage({
        id: this.changeId,
        stage,
        approver,
        comment,
        expectedVersion: pageVersion,
      }),
    );
    this.clearApprovalForm();
  }

  startExecution(): void {
    const pageVersion = this.pageVersion();
    if (pageVersion === null) {
      return;
    }
    this.store.dispatch(
      ChangeRequestActions.startExecution({ id: this.changeId, expectedVersion: pageVersion }),
    );
  }

  toggleStep(stepId: string): void {
    this.store.dispatch(ChangeRequestActions.toggleStep({ id: this.changeId, stepId }));
  }

  acknowledgeNotice(noticeId: string): void {
    this.store.dispatch(
      ChangeRequestActions.acknowledgeImpactNotice({ id: this.changeId, noticeId }),
    );
  }

  resourceName(resourceId: string): string {
    return this.changes()
      .flatMap((change) => change.resources)
      .find((resource) => resource.id === resourceId)?.name ?? resourceId;
  }

  recordDeviation(): void {
    const description = this.deviationText().trim();
    if (!description) {
      return;
    }
    const deviation: DeviationRecord = {
      id: `dev-${Date.now()}`,
      recordedAt: new Date().toISOString(),
      owner: this.change()?.onCall[0] ?? '当前用户',
      description,
      decision: this.deviationDecision(),
    };
    this.store.dispatch(ChangeRequestActions.recordDeviation({ id: this.changeId, deviation }));
    this.deviationText.set('');
  }

  complete(result: 'completed' | 'rolled_back'): void {
    const note =
      result === 'completed'
        ? '观察窗口内指标稳定，变更完成。'
        : '发现不可接受影响，按方案完成回滚。';
    this.store.dispatch(ChangeRequestActions.completeExecution({ id: this.changeId, result, note }));
  }

  exportRetrospective(): void {
    const item = this.change();
    if (!item) {
      return;
    }
    const blob = new Blob([this.service.exportRetrospective(item)], {
      type: 'text/markdown;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${item.id}-retrospective.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  stepsBy(change: ChangeRequest): ChangeStep[] {
    return this.sortSteps(change.steps);
  }

  displaySteps(): ChangeStep[] {
    // 已批准及执行中：执行步骤以批准时快照为准，实时勾选状态单独合并。
    return this.snapshotSteps() ?? this.sortSteps(this.change()?.steps ?? []);
  }

  private sortSteps(steps: ChangeStep[]): ChangeStep[] {
    const order: ChangeStep['phase'][] = ['prepare', 'execute', 'verify', 'rollback'];
    return [...steps].sort((left, right) => {
      const phase = order.indexOf(left.phase) - order.indexOf(right.phase);
      return phase || left.id.localeCompare(right.id);
    });
  }

  completedSteps(change: ChangeRequest): number {
    return change.steps.filter((step) => step.completed).length;
  }

  statusLabel(status: ChangeRequest['status']): string {
    return STATUS_LABELS[status];
  }

  riskLabel(risk: ChangeRequest['risk']): string {
    return RISK_LABELS[risk];
  }

  resourceLabel(type: ChangeRequest['resources'][number]['type']): string {
    return RESOURCE_LABELS[type];
  }

  stageLabel(stage: ApprovalStage): string {
    return STAGE_LABELS[stage];
  }

  phaseLabel(phase: ChangeStep['phase']): string {
    return PHASE_LABELS[phase];
  }

  approvalStateText(state: ChangeRequest['approvals'][number]['state']): string {
    return {
      pending: '等待签署',
      approved: '已批准',
      rejected: '已退回',
      frozen: '已冻结',
      invalidated: '会签失效',
    }[state];
  }

  approvalGate(): string {
    const item = this.change();
    if (!item) {
      return '-';
    }
    if (item.status === 'pending_review') {
      return '会签已失效，待复核重签';
    }
    if (item.status === 'approved') {
      return '已批准，等待执行';
    }
    if (['executing', 'completed', 'rolled_back'].includes(item.status)) {
      return '审批已冻结';
    }
    return '方案草稿';
  }

  decisionLabel(decision: DeviationRecord['decision']): string {
    return {
      continue: '继续观察',
      pause: '暂停执行',
      rollback: '立即回滚',
    }[decision];
  }

  private clearApprovalForm(): void {
    this.approver.set('');
    this.approvalComment.set('');
  }
}
