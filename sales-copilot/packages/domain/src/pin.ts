import type { AdviceCard, AdviceCardStatus, AdviceWarning } from '@sales-copilot/contracts';

export interface PinView {
  mode: 'pinned' | 'live' | 'empty';
  card: AdviceCard | null;
  /** 表示上の状態。固定中でも期限切れ・話題変化なら reference、無効なら invalidated。 */
  displayStatus: AdviceCardStatus | null;
  warnings: AdviceWarning[];
  /** 固定中に新しいカードが届いているか。 */
  hasNewerCard: boolean;
}

export type PinError = 'not_found' | 'invalidated' | 'not_pinned' | 'other_card_pinned';

/**
 * 表示固定（SPEC §4-2）。解析停止とは別物。
 * 固定中でも古い・矛盾したカードは現行推奨として扱わず「参考」＋警告で見せる。
 */
export class PinController {
  private pinned: AdviceCard | null = null;
  private latestLiveCreatedAt = 0;

  get pinnedAdviceId(): string | null {
    return this.pinned?.adviceId ?? null;
  }

  pin(card: AdviceCard | undefined | null): { ok: true } | { ok: false; error: PinError } {
    if (!card) return { ok: false, error: 'not_found' };
    if (card.status === 'invalidated') return { ok: false, error: 'invalidated' };
    this.pinned = card;
    return { ok: true };
  }

  unpin(adviceId: string): { ok: true } | { ok: false; error: PinError } {
    if (!this.pinned) return { ok: false, error: 'not_pinned' };
    if (this.pinned.adviceId !== adviceId) return { ok: false, error: 'other_card_pinned' };
    this.pinned = null;
    return { ok: true };
  }

  /** 固定中カードの最新状態（無効化・参考化）を反映する。 */
  sync(card: AdviceCard): void {
    if (this.pinned && this.pinned.adviceId === card.adviceId) this.pinned = card;
  }

  clear(): void {
    this.pinned = null;
  }

  view(liveCard: AdviceCard | null, now: number): PinView {
    if (liveCard && (!this.pinned || liveCard.adviceId !== this.pinned.adviceId)) {
      this.latestLiveCreatedAt = Math.max(this.latestLiveCreatedAt, liveCard.createdAt);
    }
    const target = this.pinned ?? liveCard;
    if (!target) return { mode: 'empty', card: null, displayStatus: null, warnings: [], hasNewerCard: false };
    const warnings: AdviceWarning[] = [...target.warnings];
    let status: AdviceCardStatus = target.status;
    if (status === 'current' && now >= target.expiresAt) {
      status = 'reference';
      if (!warnings.some((w) => w.code === 'stale')) warnings.push({ code: 'stale', message: '時間が経過したため参考扱い' });
    }
    if (this.pinned && status !== 'current' && !warnings.some((w) => w.code === 'pinned_stale')) {
      warnings.push({
        code: 'pinned_stale',
        message: status === 'invalidated' ? '固定中のカードは前提が崩れています' : '固定中のカードは現行推奨ではありません',
      });
    }
    const hasNewerCard =
      !!this.pinned && !!liveCard && liveCard.adviceId !== this.pinned.adviceId && liveCard.createdAt > this.pinned.createdAt;
    return { mode: this.pinned ? 'pinned' : 'live', card: target, displayStatus: status, warnings, hasNewerCard };
  }
}
