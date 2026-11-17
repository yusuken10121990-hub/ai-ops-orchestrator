import { useEffect, useState } from 'react';
import type { SessionMode } from '@sales-copilot/contracts';

/** 開始直後にモードを大きく出す時間。 */
export const MODE_BANNER_MS = 8000;

/**
 * 開始直後の数秒、モード（LIVE＝本物の会話／OFFLINE テスト＝架空会話の再生）を大きく出す。
 * 2026-11-17 の実商談で、OFFLINE（架空会話の再生）で始まっていたのに気づきにくかった。
 * OFFLINE は本番の商談で使うものではないので、数秒たっても小さく出し続ける（見落とし防止）。
 */
export function ModeBanner({ mode, sinceMs = MODE_BANNER_MS }: { mode: SessionMode | null; sinceMs?: number }) {
  const [big, setBig] = useState(true);
  useEffect(() => {
    setBig(true);
    const t = setTimeout(() => setBig(false), sinceMs);
    return () => clearTimeout(t);
  }, [mode, sinceMs]);
  if (!mode) return null;
  if (mode === 'LIVE') {
    if (!big) return null;
    return (
      <p className="mode-banner mode-live" role="status" data-testid="mode-banner">
        LIVE（本物の会話を解析中）
      </p>
    );
  }
  return (
    <p className={big ? 'mode-banner mode-offline' : 'mode-banner mode-offline small'} role="alert" data-testid="mode-banner">
      OFFLINEテスト — 架空の会話を再生しています（本物の会話ではありません）
    </p>
  );
}
