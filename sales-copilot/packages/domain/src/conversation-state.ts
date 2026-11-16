import type { AudioSource } from '@sales-copilot/contracts';
import { createSequentialIdGenerator, systemClock, type Clock, type IdGenerator } from './clock';
import { isBackchannel, looksLikeCorrectionOrNegation, looksLikeQuestion } from './text';
import type { SegmentFlag, Utterance } from './transcript-store';

/** 構造化メモの項目（SPEC §7-2）。 */
export type MemoField =
  | 'stage' // 商談段階（固定フローを強制しない）
  | 'issues' // 課題と優先事項
  | 'currentOperations' // 現在の業務・仕組み・変えたくない部分
  | 'openQuestions' // 未回答の質問
  | 'checkItems' // 実現性/費用/運用/承認/時期の確認事項
  | 'stakeholders' // 使用者・関係者・意思決定経路
  | 'evaluationCriteria' // 顧客の言葉による評価基準
  | 'proposalsAndAgreements' // 提案・同意・実施済み
  | 'declineSignals' // 見送りや連絡不要の意思
  | 'nextActions'; // 次の行動・担当・期日

export const MEMO_FIELDS: readonly MemoField[] = [
  'stage',
  'issues',
  'currentOperations',
  'openQuestions',
  'checkItems',
  'stakeholders',
  'evaluationCriteria',
  'proposalsAndAgreements',
  'declineSignals',
  'nextActions',
];

/** 前提が変わる（実行中の生成を破棄すべき）項目。 */
const SIGNIFICANT_FIELDS: ReadonlySet<MemoField> = new Set([
  'openQuestions',
  'checkItems',
  'proposalsAndAgreements',
  'declineSignals',
  'nextActions',
]);

/** fact = 発話で確認済み / hypothesis = 推定 / unverified = 未確認・帰属不明 */
export type MemoStatus = 'fact' | 'hypothesis' | 'unverified';

export type CheckCategory = 'feasibility' | 'cost' | 'operation' | 'approval' | 'timing';

export interface MemoItemMeta {
  checkCategory?: CheckCategory;
  owner?: string;
  /** 期日の文言。dueAgreed=false の間は確定扱いにしない。 */
  due?: string;
  dueAgreed?: boolean;
}

export interface MemoItem {
  itemId: string;
  field: MemoField;
  text: string;
  status: MemoStatus;
  evidenceUtteranceIds: string[];
  resolved: boolean;
  resolvedByUtteranceIds: string[];
  /** 根拠発話が訂正された → 再確認が必要 */
  needsRecheck: boolean;
  createdAt: number;
  updatedAt: number;
  meta: MemoItemMeta;
}

export interface MemoItemInput {
  /** 指定時は更新、未指定は新規。 */
  itemId?: string;
  field: MemoField;
  text: string;
  status: MemoStatus;
  evidenceUtteranceIds: string[];
  meta?: MemoItemMeta;
}

export type MemoWarningCode =
  | 'missing_evidence'
  | 'unknown_evidence_id'
  | 'unknown_source_evidence'
  | 'echo_evidence'
  | 'degraded_capture'
  | 'due_not_agreed';

export interface MemoUpsertResult {
  ok: boolean;
  item: MemoItem | null;
  /** 根拠の都合で status を下げた場合など。 */
  warnings: MemoWarningCode[];
  contextRevisionBumped: boolean;
}

export interface ConversationUtterance {
  utteranceId: string;
  source: AudioSource;
  text: string;
  startMs: number;
  endMs: number;
  flags: SegmentFlag[];
  revision: number;
}

export interface ConversationStateOptions {
  /** 直近ウィンドウ（ms）。SPEC §7-2: 60〜120秒。 */
  windowMs?: number;
  clock?: Clock;
  idGenerator?: IdGenerator;
}

export type RevisionReason =
  | 'question'
  | 'correction'
  | 'utterance_revised'
  | 'memo_changed'
  | 'question_resolved'
  | 'source_availability'
  | 'manual';

export interface UpsertUtteranceResult {
  /** 前提が変わる発話か（実行中の生成を破棄すべきか）。 */
  significant: boolean;
  backchannel: boolean;
  contextRevision: number;
  /** 訂正で再確認対象になったメモ項目。 */
  recheckItemIds: string[];
}

export interface SourceAvailability {
  SELF: boolean;
  REMOTE: boolean;
}

/**
 * 会話状態（SPEC §7-2）: 直近の確定発言ウィンドウ＋更新型の構造化メモ。
 * メモは必ず根拠 utteranceId を持ち、窓から消えても未解決の疑問は残る。
 * 要約から新しい事実を生まない: 根拠が無い・帰属不明・回り込み疑いは fact にしない。
 */
export class ConversationState {
  readonly windowMs: number;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly utterances = new Map<string, ConversationUtterance>();
  private readonly memo = new Map<string, MemoItem>();
  private revision = 0;
  private readonly revisionLog: { revision: number; reason: RevisionReason; at: number }[] = [];
  private availability: SourceAvailability = { SELF: true, REMOTE: true };

  constructor(opts: ConversationStateOptions = {}) {
    const w = opts.windowMs ?? 90_000;
    if (w < 60_000 || w > 120_000) throw new RangeError('windowMs must be within 60000..120000 (SPEC §7-2)');
    this.windowMs = w;
    this.clock = opts.clock ?? systemClock;
    this.ids = opts.idGenerator ?? createSequentialIdGenerator();
  }

  get contextRevision(): number {
    return this.revision;
  }

  get revisions(): readonly { revision: number; reason: RevisionReason; at: number }[] {
    return this.revisionLog;
  }

  bumpRevision(reason: RevisionReason): number {
    this.revision++;
    this.revisionLog.push({ revision: this.revision, reason, at: this.clock.now() });
    if (this.revisionLog.length > 500) this.revisionLog.shift();
    return this.revision;
  }

  /** TranscriptStore の確定発話を反映（新規・訂正どちらも）。 */
  upsertUtterance(u: Utterance | ConversationUtterance): UpsertUtteranceResult {
    if (u.text.length === 0) {
      return { significant: false, backchannel: true, contextRevision: this.revision, recheckItemIds: [] };
    }
    const prev = this.utterances.get(u.utteranceId);
    const entry: ConversationUtterance = {
      utteranceId: u.utteranceId,
      source: u.source,
      text: u.text,
      startMs: u.startMs,
      endMs: u.endMs,
      flags: [...u.flags],
      revision: u.revision,
    };
    this.utterances.set(u.utteranceId, entry);
    this.pruneUtterances();

    const backchannel = isBackchannel(u.text);
    const recheck: string[] = [];
    if (prev && prev.text !== u.text) {
      // 訂正: 依存するメモを再確認対象に（新しい事実は作らない）
      for (const item of this.memo.values()) {
        if (item.evidenceUtteranceIds.includes(u.utteranceId) || item.resolvedByUtteranceIds.includes(u.utteranceId)) {
          item.needsRecheck = true;
          if (item.status === 'fact') item.status = 'unverified';
          item.updatedAt = this.clock.now();
          recheck.push(item.itemId);
        }
      }
      this.bumpRevision('utterance_revised');
      return { significant: true, backchannel, contextRevision: this.revision, recheckItemIds: recheck };
    }
    if (prev) {
      // 本文同一でフラグのみ変化（回り込み疑い等）: 根拠にしているメモの確度を下げる
      if (entry.flags.some((f) => !prev.flags.includes(f))) {
        for (const item of this.memo.values()) {
          if (item.status === 'fact' && item.evidenceUtteranceIds.includes(u.utteranceId)) {
            item.status = 'unverified';
            item.updatedAt = this.clock.now();
            recheck.push(item.itemId);
          }
        }
      }
      return { significant: false, backchannel, contextRevision: this.revision, recheckItemIds: recheck };
    }
    let significant = false;
    if (!backchannel && u.source !== 'SELF') {
      if (looksLikeQuestion(u.text)) {
        this.bumpRevision('question');
        significant = true;
      } else if (looksLikeCorrectionOrNegation(u.text)) {
        this.bumpRevision('correction');
        significant = true;
      }
    }
    return { significant, backchannel, contextRevision: this.revision, recheckItemIds: [] };
  }

  getUtterance(id: string): ConversationUtterance | undefined {
    return this.utterances.get(id);
  }

  /** 直近ウィンドウ（最新の発話終端から windowMs 以内）の確定発話。 */
  window(): ConversationUtterance[] {
    const all = [...this.utterances.values()].sort((a, b) => a.startMs - b.startMs);
    const latest = all.reduce((m, u) => Math.max(m, u.endMs), 0);
    return all.filter((u) => u.endMs >= latest - this.windowMs);
  }

  setSourceAvailability(next: Partial<SourceAvailability>): boolean {
    const merged = { ...this.availability, ...next };
    const changed = merged.SELF !== this.availability.SELF || merged.REMOTE !== this.availability.REMOTE;
    this.availability = merged;
    if (changed) this.bumpRevision('source_availability');
    return changed;
  }

  get sourceAvailability(): SourceAvailability {
    return { ...this.availability };
  }

  /** 片側欠落（縮退）中か。 */
  isDegraded(): boolean {
    return !this.availability.SELF || !this.availability.REMOTE;
  }

  upsertMemoItem(input: MemoItemInput): MemoUpsertResult {
    const warnings: MemoWarningCode[] = [];
    const evidence = [...new Set(input.evidenceUtteranceIds)];
    if (evidence.length === 0) {
      return { ok: false, item: null, warnings: ['missing_evidence'], contextRevisionBumped: false };
    }
    const known = evidence.filter((id) => this.utterances.has(id));
    if (known.length !== evidence.length) {
      // 存在しない根拠IDは受け付けない（要約から新しい事実を生まない）
      return { ok: false, item: null, warnings: ['unknown_evidence_id'], contextRevisionBumped: false };
    }
    let status = input.status;
    const evUtts = known.map((id) => this.utterances.get(id)!);
    if (status === 'fact') {
      if (evUtts.some((u) => u.source === 'UNKNOWN' || u.flags.includes('unknown_source'))) {
        status = 'unverified';
        warnings.push('unknown_source_evidence');
      } else if (evUtts.some((u) => u.flags.includes('possible_echo'))) {
        status = 'unverified';
        warnings.push('echo_evidence');
      } else if (this.isDegraded() && input.field !== 'stage') {
        // 片側しか聞こえていない状態で相手の合意等を確定しない
        status = 'hypothesis';
        warnings.push('degraded_capture');
      }
    }
    const meta: MemoItemMeta = { ...(input.meta ?? {}) };
    if (input.field === 'nextActions' && meta.due && meta.dueAgreed !== true) {
      meta.dueAgreed = false;
      warnings.push('due_not_agreed');
    }

    const now = this.clock.now();
    let item: MemoItem;
    const existing = input.itemId ? this.memo.get(input.itemId) : undefined;
    if (existing) {
      existing.text = input.text;
      existing.status = status;
      existing.evidenceUtteranceIds = [...new Set([...existing.evidenceUtteranceIds, ...evidence])];
      existing.meta = meta;
      existing.needsRecheck = false;
      existing.updatedAt = now;
      item = existing;
    } else {
      if (input.field === 'stage') {
        // 段階は最新1件（旧項目は履歴として resolved 扱い）
        for (const it of this.memo.values()) if (it.field === 'stage' && !it.resolved) it.resolved = true;
      }
      item = {
        itemId: input.itemId ?? this.ids('memo'),
        field: input.field,
        text: input.text,
        status,
        evidenceUtteranceIds: evidence,
        resolved: false,
        resolvedByUtteranceIds: [],
        needsRecheck: false,
        createdAt: now,
        updatedAt: now,
        meta,
      };
      this.memo.set(item.itemId, item);
    }
    const bump = SIGNIFICANT_FIELDS.has(input.field);
    if (bump) this.bumpRevision('memo_changed');
    return { ok: true, item: { ...item }, warnings, contextRevisionBumped: bump };
  }

  /** 未回答の質問や確認事項を解決済みにする（根拠必須）。 */
  resolveMemoItem(itemId: string, evidenceUtteranceIds: string[]): boolean {
    const item = this.memo.get(itemId);
    if (!item || item.resolved) return false;
    const ev = evidenceUtteranceIds.filter((id) => this.utterances.has(id));
    if (ev.length === 0) return false;
    item.resolved = true;
    item.resolvedByUtteranceIds = ev;
    item.updatedAt = this.clock.now();
    this.bumpRevision('question_resolved');
    return true;
  }

  memoItems(field?: MemoField): MemoItem[] {
    return [...this.memo.values()].filter((i) => !field || i.field === field).map((i) => ({ ...i }));
  }

  /** 未解決の質問・確認事項（ウィンドウ外の根拠でも残る）。 */
  unresolvedQuestions(): MemoItem[] {
    return this.memoItems().filter((i) => (i.field === 'openQuestions' || i.field === 'checkItems') && !i.resolved);
  }

  /** LLM 入力用スナップショット。 */
  snapshot(): {
    contextRevision: number;
    window: ConversationUtterance[];
    memo: Record<MemoField, MemoItem[]>;
    sourceAvailability: SourceAvailability;
  } {
    const memo = Object.fromEntries(MEMO_FIELDS.map((f) => [f, [] as MemoItem[]])) as Record<MemoField, MemoItem[]>;
    for (const i of this.memo.values()) {
      if (i.field === 'stage' && i.resolved) continue;
      memo[i.field].push({ ...i });
    }
    return { contextRevision: this.revision, window: this.window(), memo, sourceAvailability: this.sourceAvailability };
  }

  clear(): void {
    this.utterances.clear();
    this.memo.clear();
  }

  /**
   * 発話の保持: ウィンドウ外でも、メモの根拠になっている発話は残す（根拠IDの検証に必要）。
   * それ以外はウィンドウの2倍を超えたら捨てる。
   */
  private pruneUtterances(): void {
    const latest = [...this.utterances.values()].reduce((m, u) => Math.max(m, u.endMs), 0);
    const cutoff = latest - this.windowMs * 2;
    const referenced = new Set<string>();
    for (const i of this.memo.values()) {
      for (const id of i.evidenceUtteranceIds) referenced.add(id);
      for (const id of i.resolvedByUtteranceIds) referenced.add(id);
    }
    for (const [id, u] of this.utterances) {
      if (u.endMs < cutoff && !referenced.has(id)) this.utterances.delete(id);
    }
  }
}
