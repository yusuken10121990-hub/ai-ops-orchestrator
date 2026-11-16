import type { AudioSource } from '@sales-copilot/contracts';
import { createSequentialIdGenerator, type IdGenerator } from './clock';
import { normalizeText } from './text';

/** STT プロバイダーから来る1件の結果（時刻はセッション音声時刻に整列済み）。 */
export interface SttResultInput {
  source: AudioSource;
  streamGeneration: number;
  text: string;
  isFinal: boolean;
  /** プロバイダーの発話終了推定（Deepgram speech_final 相当）。区間 final とは別。 */
  speechFinal: boolean;
  startMs: number;
  endMs: number;
}

export type SegmentFlag = 'unknown_source' | 'possible_echo';

export interface TranscriptSegment {
  segmentId: string;
  utteranceId: string;
  source: AudioSource;
  streamGeneration: number;
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  startMs: number;
  endMs: number;
  revision: number;
  flags: SegmentFlag[];
}

export interface Utterance {
  utteranceId: string;
  source: AudioSource;
  streamGeneration: number;
  segmentIds: string[];
  /** 確定 (final) 区間のみを連結した本文。interim は含めない。 */
  text: string;
  startMs: number;
  endMs: number;
  /** speechFinal を受けて閉じたか。 */
  closed: boolean;
  /** 本文が変化するたびに増える。 */
  revision: number;
  flags: SegmentFlag[];
}

export type IngestChange =
  | 'interim_created'
  | 'interim_updated'
  | 'final_created'
  | 'final_revised'
  | 'duplicate'
  | 'stale_interim_ignored'
  | 'empty_ignored';

export interface IngestResult {
  change: IngestChange;
  segment: TranscriptSegment | null;
  utterance: Utterance | null;
  /** 確定本文が変化した発話（会話状態の再確認対象）。 */
  utteranceTextChanged: boolean;
  /** 本文変化により無効化すべき助言ID。 */
  invalidatedAdviceIds: string[];
  /** この取り込みでフラグ（回り込み疑い等）が変わった他の発話。会話状態へ再反映すること。 */
  otherUtterancesFlagged: Utterance[];
}

export interface TranscriptStoreOptions {
  idGenerator?: IdGenerator;
  /** 同一区間とみなす開始時刻の許容差（ms）。 */
  startToleranceMs?: number;
  /** 再接続後の再配送を重複とみなす時間重なり率。 */
  duplicateOverlapRatio?: number;
  /** 保持する区間数の上限（古いものから捨てる）。 */
  maxSegments?: number;
}

function overlapRatio(a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }): number {
  const inter = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
  if (inter <= 0) return 0;
  const shorter = Math.max(1, Math.min(a.endMs - a.startMs, b.endMs - b.startMs));
  return inter / shorter;
}

/**
 * 文字起こしの統合（SPEC §7-1）。
 * - 同じ発言の interim は同じ segment を更新（重複発言にしない）
 * - final の再配送は (source, streamGeneration, 開始時刻) と、再接続後は時間重なり＋同一本文で重複排除
 * - 確定本文が変わったら、その発話に依存する助言IDを無効化対象として返す
 */
export class TranscriptStore {
  private readonly ids: IdGenerator;
  private readonly startTol: number;
  private readonly dupOverlap: number;
  private readonly maxSegments: number;
  private readonly segments = new Map<string, TranscriptSegment>();
  private readonly segmentOrder: string[] = [];
  private readonly utterances = new Map<string, Utterance>();
  private readonly utteranceOrder: string[] = [];
  /** `${source}|${gen}` → 開いている発話ID */
  private readonly openUtterance = new Map<string, string>();
  /** utteranceId → 依存する adviceId 集合 */
  private readonly adviceDeps = new Map<string, Set<string>>();

  constructor(opts: TranscriptStoreOptions = {}) {
    this.ids = opts.idGenerator ?? createSequentialIdGenerator();
    this.startTol = opts.startToleranceMs ?? 30;
    this.dupOverlap = opts.duplicateOverlapRatio ?? 0.6;
    this.maxSegments = opts.maxSegments ?? 5000;
  }

  ingest(input: SttResultInput): IngestResult {
    const text = input.text.trim();
    const existing = this.findSegment(input);

    if (!existing && text.length === 0) {
      return this.result('empty_ignored', null, null, false);
    }

    if (existing) {
      if (existing.isFinal && !input.isFinal) {
        // 確定後に届いた古い interim は無視
        return this.result('stale_interim_ignored', existing, this.utterances.get(existing.utteranceId) ?? null, false);
      }
      if (existing.isFinal && input.isFinal) {
        if (normalizeText(existing.text) === normalizeText(text) && existing.speechFinal === input.speechFinal) {
          return this.result('duplicate', existing, this.utterances.get(existing.utteranceId) ?? null, false);
        }
        // final の訂正（例: 「できます」→「できません」）
        existing.text = text;
        existing.endMs = Math.max(existing.endMs, input.endMs);
        existing.speechFinal = existing.speechFinal || input.speechFinal;
        existing.revision++;
        return this.afterFinal(existing, 'final_revised');
      }
      // interim → interim / interim → final
      existing.text = text;
      existing.endMs = input.endMs;
      existing.revision++;
      if (input.isFinal) {
        existing.isFinal = true;
        existing.speechFinal = input.speechFinal;
        return this.afterFinal(existing, 'final_created');
      }
      return this.result('interim_updated', existing, this.utterances.get(existing.utteranceId) ?? null, false);
    }

    if (input.isFinal) {
      const dup = this.findCrossGenerationDuplicate(input.source, text, input);
      if (dup) return this.result('duplicate', dup, this.utterances.get(dup.utteranceId) ?? null, false);
    }

    const utt = this.getOrOpenUtterance(input);
    const seg: TranscriptSegment = {
      segmentId: this.ids('seg'),
      utteranceId: utt.utteranceId,
      source: input.source,
      streamGeneration: input.streamGeneration,
      text,
      isFinal: input.isFinal,
      speechFinal: input.isFinal && input.speechFinal,
      startMs: input.startMs,
      endMs: input.endMs,
      revision: 0,
      flags: input.source === 'UNKNOWN' ? ['unknown_source'] : [],
    };
    this.segments.set(seg.segmentId, seg);
    this.segmentOrder.push(seg.segmentId);
    utt.segmentIds.push(seg.segmentId);
    this.trim();
    if (seg.isFinal) return this.afterFinal(seg, 'final_created');
    return this.result('interim_created', seg, utt, false);
  }

  /** 助言がどの発話に依存しているかを登録する（訂正時の無効化に使う）。 */
  registerAdviceDependency(adviceId: string, utteranceIds: readonly string[]): void {
    for (const u of utteranceIds) {
      let set = this.adviceDeps.get(u);
      if (!set) this.adviceDeps.set(u, (set = new Set()));
      set.add(adviceId);
    }
  }

  releaseAdvice(adviceId: string): void {
    for (const set of this.adviceDeps.values()) set.delete(adviceId);
  }

  getSegment(segmentId: string): TranscriptSegment | undefined {
    return this.segments.get(segmentId);
  }

  getUtterance(utteranceId: string): Utterance | undefined {
    return this.utterances.get(utteranceId);
  }

  hasUtterance(utteranceId: string): boolean {
    return this.utterances.has(utteranceId);
  }

  /** 確定本文を持つ発話（時刻順）。 */
  finalUtterances(): Utterance[] {
    return this.utteranceOrder
      .map((id) => this.utterances.get(id)!)
      .filter((u) => u && u.text.length > 0)
      .sort((a, b) => a.startMs - b.startMs);
  }

  allSegments(): TranscriptSegment[] {
    return this.segmentOrder.map((id) => this.segments.get(id)!).filter(Boolean);
  }

  /** 終了時などに全消去（会話は既定メモリのみ・保持上限あり）。 */
  clear(): void {
    this.segments.clear();
    this.segmentOrder.length = 0;
    this.utterances.clear();
    this.utteranceOrder.length = 0;
    this.openUtterance.clear();
    this.adviceDeps.clear();
  }

  // -------------------------------------------------------------------------

  private findSegment(input: SttResultInput): TranscriptSegment | undefined {
    // 新しい方から探す（最近の区間に当たる確率が高い）
    for (let i = this.segmentOrder.length - 1; i >= 0 && i >= this.segmentOrder.length - 200; i--) {
      const s = this.segments.get(this.segmentOrder[i]!);
      if (!s) continue;
      if (
        s.source === input.source &&
        s.streamGeneration === input.streamGeneration &&
        Math.abs(s.startMs - input.startMs) <= this.startTol
      ) {
        return s;
      }
    }
    // 進行中の interim は1つだけ: 開いている発話の末尾が未確定なら、開始時刻が多少ずれても同じ区間として更新する
    const openId = this.openUtterance.get(`${input.source}|${input.streamGeneration}`);
    const open = openId ? this.utterances.get(openId) : undefined;
    if (open && !open.closed) {
      const last = this.segments.get(open.segmentIds[open.segmentIds.length - 1] ?? '');
      if (last && !last.isFinal && input.startMs >= last.startMs - this.startTol) return last;
    }
    return undefined;
  }

  /** 再接続で streamGeneration が変わった後の同一 final の再配送を検出。 */
  private findCrossGenerationDuplicate(
    source: AudioSource,
    text: string,
    range: { startMs: number; endMs: number },
  ): TranscriptSegment | undefined {
    const n = normalizeText(text);
    for (let i = this.segmentOrder.length - 1; i >= 0 && i >= this.segmentOrder.length - 200; i--) {
      const s = this.segments.get(this.segmentOrder[i]!);
      if (!s || !s.isFinal || s.source !== source) continue;
      if (normalizeText(s.text) === n && overlapRatio(s, range) >= this.dupOverlap) return s;
    }
    return undefined;
  }

  private getOrOpenUtterance(input: SttResultInput): Utterance {
    const key = `${input.source}|${input.streamGeneration}`;
    const openId = this.openUtterance.get(key);
    const open = openId ? this.utterances.get(openId) : undefined;
    if (open && !open.closed) return open;
    const utt: Utterance = {
      utteranceId: this.ids('utt'),
      source: input.source,
      streamGeneration: input.streamGeneration,
      segmentIds: [],
      text: '',
      startMs: input.startMs,
      endMs: input.endMs,
      closed: false,
      revision: 0,
      flags: input.source === 'UNKNOWN' ? ['unknown_source'] : [],
    };
    this.utterances.set(utt.utteranceId, utt);
    this.utteranceOrder.push(utt.utteranceId);
    this.openUtterance.set(key, utt.utteranceId);
    return utt;
  }

  private afterFinal(seg: TranscriptSegment, change: 'final_created' | 'final_revised'): IngestResult {
    const utt = this.utterances.get(seg.utteranceId)!;
    const before = utt.text;
    utt.text = utt.segmentIds
      .map((id) => this.segments.get(id))
      .filter((s): s is TranscriptSegment => !!s && s.isFinal)
      .map((s) => s.text)
      .join('');
    utt.startMs = Math.min(utt.startMs, seg.startMs);
    utt.endMs = Math.max(utt.endMs, seg.endMs);
    if (seg.speechFinal) utt.closed = true;
    const flagged = this.markEcho(seg, utt);
    const changed = before !== utt.text;
    let invalidated: string[] = [];
    if (changed) {
      utt.revision++;
      const deps = this.adviceDeps.get(utt.utteranceId);
      if (deps && deps.size > 0) {
        invalidated = [...deps];
        deps.clear();
      }
    }
    return this.result(change, seg, utt, changed, invalidated, flagged);
  }

  /**
   * SELF と REMOTE で同時刻・同一本文 → スピーカー音の回り込み等の可能性。黙って確定扱いにしない。
   */
  private markEcho(seg: TranscriptSegment, utt: Utterance): Utterance[] {
    const others: Utterance[] = [];
    if (seg.source === 'UNKNOWN') return others;
    const n = normalizeText(seg.text);
    if (n.length < 4) return others;
    for (let i = this.segmentOrder.length - 1; i >= 0 && i >= this.segmentOrder.length - 50; i--) {
      const s = this.segments.get(this.segmentOrder[i]!);
      if (!s || !s.isFinal || s === seg || s.source === seg.source || s.source === 'UNKNOWN') continue;
      if (normalizeText(s.text) === n && overlapRatio(s, seg) > 0) {
        for (const target of [seg, s]) if (!target.flags.includes('possible_echo')) target.flags.push('possible_echo');
        if (!utt.flags.includes('possible_echo')) utt.flags.push('possible_echo');
        const other = this.utterances.get(s.utteranceId);
        if (other && other !== utt && !other.flags.includes('possible_echo')) {
          other.flags.push('possible_echo');
          others.push(other);
        }
      }
    }
    return others;
  }

  private trim(): void {
    while (this.segmentOrder.length > this.maxSegments) {
      const id = this.segmentOrder.shift()!;
      const s = this.segments.get(id);
      this.segments.delete(id);
      if (s) {
        const u = this.utterances.get(s.utteranceId);
        if (u && u.segmentIds[0] === id) {
          u.segmentIds.shift();
          if (u.segmentIds.length === 0) {
            this.utterances.delete(u.utteranceId);
            const idx = this.utteranceOrder.indexOf(u.utteranceId);
            if (idx >= 0) this.utteranceOrder.splice(idx, 1);
            this.adviceDeps.delete(u.utteranceId);
          }
        }
      }
    }
  }

  private result(
    change: IngestChange,
    segment: TranscriptSegment | null,
    utterance: Utterance | null,
    utteranceTextChanged: boolean,
    invalidatedAdviceIds: string[] = [],
    otherUtterancesFlagged: Utterance[] = [],
  ): IngestResult {
    return {
      change,
      segment: segment ? { ...segment, flags: [...segment.flags] } : null,
      utterance: utterance ? { ...utterance, segmentIds: [...utterance.segmentIds], flags: [...utterance.flags] } : null,
      utteranceTextChanged,
      invalidatedAdviceIds,
      otherUtterancesFlagged: otherUtterancesFlagged.map((u) => ({ ...u, segmentIds: [...u.segmentIds], flags: [...u.flags] })),
    };
  }
}
