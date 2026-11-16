/**
 * 自分側（SELF）の簡易エネルギー VAD。発話中は大きなカード更新を抑えるためのヒント（SPEC §8-2）。
 * 話者判定ではない。閾値超えが attackMs 続いたら発話開始、閾値-ヒステリシス未満が releaseMs 続いたら終了。
 */
export interface VadOptions {
  thresholdDb?: number;
  hysteresisDb?: number;
  attackMs?: number;
  releaseMs?: number;
}

export interface VadTransition {
  speaking: boolean;
  atMs: number;
}

export class EnergyVad {
  private readonly thresholdDb: number;
  private readonly hysteresisDb: number;
  private readonly attackMs: number;
  private readonly releaseMs: number;
  private speaking = false;
  private aboveMs = 0;
  private belowMs = 0;
  private aboveStartMs = 0;
  private belowStartMs = 0;

  constructor(opts: VadOptions = {}) {
    this.thresholdDb = opts.thresholdDb ?? -45;
    this.hysteresisDb = opts.hysteresisDb ?? 4;
    this.attackMs = opts.attackMs ?? 120;
    this.releaseMs = opts.releaseMs ?? 700;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** 1ブロック分の dBFS を与える。状態が変わったときだけ遷移を返す。 */
  update(db: number, durationMs: number, startMs: number): VadTransition | null {
    if (!this.speaking) {
      if (db >= this.thresholdDb) {
        if (this.aboveMs === 0) this.aboveStartMs = startMs;
        this.aboveMs += durationMs;
        if (this.aboveMs >= this.attackMs) {
          this.speaking = true;
          this.belowMs = 0;
          return { speaking: true, atMs: this.aboveStartMs };
        }
      } else {
        this.aboveMs = 0;
      }
    } else {
      if (db < this.thresholdDb - this.hysteresisDb) {
        if (this.belowMs === 0) this.belowStartMs = startMs;
        this.belowMs += durationMs;
        if (this.belowMs >= this.releaseMs) {
          this.speaking = false;
          this.aboveMs = 0;
          return { speaking: false, atMs: this.belowStartMs };
        }
      } else {
        this.belowMs = 0;
      }
    }
    return null;
  }

  reset(): VadTransition | null {
    const was = this.speaking;
    this.speaking = false;
    this.aboveMs = 0;
    this.belowMs = 0;
    return was ? { speaking: false, atMs: 0 } : null;
  }
}
