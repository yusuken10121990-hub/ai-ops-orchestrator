import type { CaptureSource } from '@sales-copilot/contracts';

/** STT の失敗分類（contracts の StatusReason へ写像して UI に出す）。 */
export type RecognizerErrorKind = 'not_configured' | 'auth_failed' | 'rate_limited' | 'network' | 'protocol';

export type RecognizerState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'failed';

/** 正規化済みの STT 結果。時刻はセッション音声時刻（ms）に整列済み。 */
export interface NormalizedSttResult {
  source: CaptureSource;
  /** 接続（再接続）ごとに増える世代。 */
  streamGeneration: number;
  isFinal: boolean;
  /** プロバイダーの発話終了推定（Deepgram speech_final）。区間 final とは別。 */
  speechFinal: boolean;
  text: string;
  startMs: number;
  endMs: number;
  /** 同一区間の識別キー（source|generation|startMs）。interim→final の更新単位。 */
  segmentKey: string;
  /** サーバー時計で受信した時刻（epoch ms）。遅延計測用。 */
  receivedAt: number;
  /** Finalize 要求による final か（Deepgram from_finalize）。 */
  fromFinalize: boolean;
}

export interface UtteranceEndEvent {
  type: 'utterance_end';
  source: CaptureSource;
  streamGeneration: number;
  /** セッション音声時刻での最終語の終了（ms）。 */
  lastWordEndMs: number;
  receivedAt: number;
}

export interface AudioChunkMeta {
  /** クライアント側フレームの世代と連番（使用量の重複計上防止キー）。 */
  frameGeneration: number;
  sequence: number;
  /** セッション音声時刻（ms）。 */
  audioStartMs: number;
  durationMs: number;
}

export type RecognizerEvent =
  | { type: 'result'; result: NormalizedSttResult }
  | UtteranceEndEvent
  | { type: 'state'; state: RecognizerState; streamGeneration: number; reason: RecognizerErrorKind | null }
  | { type: 'error'; kind: RecognizerErrorKind; message: string; fatal: boolean }
  /** 実際にプロバイダーへ送った音声（使用量計上はこれを根拠にする）。 */
  | { type: 'audio_sent'; source: CaptureSource; meta: AudioChunkMeta; streamGeneration: number }
  /** 上限超過・切断中で破棄した音声区間（欠落区間の記録）。 */
  | { type: 'audio_dropped'; source: CaptureSource; fromMs: number; toMs: number; droppedMs: number; reason: 'backpressure' | 'disconnected' | 'stopped' };

/**
 * 1つの取得系統（SELF / REMOTE）につき1インスタンス・1接続。
 * - 音声を最初に受け取った時に接続する（遅延接続）。起動時に勝手に接続しない
 * - 再接続のたびに streamGeneration を増やす
 * - stop() 後は二度と外部へ送信しない
 */
export interface SpeechRecognizer {
  readonly source: CaptureSource;
  readonly state: RecognizerState;
  readonly streamGeneration: number;
  /** 音声を送る（必要なら接続を開始）。受理しなかった場合 false。 */
  sendAudio(pcm: Uint8Array, meta: AudioChunkMeta): boolean;
  /** 送信を止め接続を閉じる。以後の sendAudio は false。 */
  stop(): Promise<void>;
  on(listener: (ev: RecognizerEvent) => void): () => void;
}

export type SpeechRecognizerFactory = (source: CaptureSource) => SpeechRecognizer;

/** 小さなイベントエミッター（依存なし）。 */
export class Emitter<T> {
  private readonly ls = new Set<(ev: T) => void>();
  on(l: (ev: T) => void): () => void {
    this.ls.add(l);
    return () => this.ls.delete(l);
  }
  emit(ev: T): void {
    for (const l of [...this.ls]) {
      try {
        l(ev);
      } catch {
        // リスナーの例外で受信ループを壊さない
      }
    }
  }
  clear(): void {
    this.ls.clear();
  }
}
