// @vitest-environment jsdom
// 2026-11-17 実商談のフィードバック対応の画面テスト（商談目的は任意・モード表示・再接続中・終了理由）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PreSession, type PreSessionProps } from './PreSession';
import { ModeBanner, MODE_BANNER_MS } from './ModeBanner';
import { EndView } from './EndView';
import { overallHealth } from './StatusBar';
import type { OffscreenSnapshot } from '../../shared/runtime-messages';
import { DEFAULT_SETTINGS } from '../../shared/settings';

// jsdom にはマイク一覧が無い（PreSession のマイク確認だけ空にする）
Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  configurable: true,
  value: { enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {}, getUserMedia: async () => ({ getTracks: () => [] }) },
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const now = 1_800_000_000_000;
const preProps = (over: Partial<PreSessionProps> = {}): PreSessionProps => ({
  target: { tabId: 1, title: 'Meet - A社 定例', isMeet: true, armed: true, armError: null, via: 'tab', autoStart: null },
  settings: { ...DEFAULT_SETTINGS, session: { token: 't'.repeat(43), tokenType: 'Bearer', issuedAt: now, expiresAt: now + 86400_000, scopes: ['session'] } },
  server: {
    health: 'ok',
    healthError: null,
    config: {
      version: 't',
      protocolVersion: 1,
      stt: { configured: true, provider: 'deepgram', model: 'nova-3', language: 'ja' },
      llm: { configured: true, provider: 'anthropic', model: 'm' },
      modes: { LIVE: true, OFFLINE: true },
      offlineAnthropicAvailable: false,
      priceTable: { configured: false, currency: null, checkedDate: null },
      retentionMs: 600000,
      budget: { maxSttSeconds: null, maxLlmCalls: null, maxLlmInputTokens: null, maxLlmOutputTokens: null, maxCost: null },
    } as never,
    configError: null,
    facts: [],
    factsError: null,
    scripts: null,
  },
  snapshot: {
    phase: 'armed',
    sources: { SELF: 'off', REMOTE: 'armed' },
    ws: 'none',
    paused: false,
    selfEnabled: false,
    sessionId: null,
    inputSampleRate: 48000,
    stopReason: null,
    reconnecting: false,
  },
  remoteLevel: -30,
  starting: false,
  startError: null,
  now,
  onStart: vi.fn(),
  onOpenOptions: vi.fn(),
  onRefresh: vi.fn(),
  onSelectMic: vi.fn(),
  ...over,
});

describe('商談目的は任意（「こんなの入れなくていいんだけど」）', () => {
  it('空欄のままでも開始でき、会議名が商談目的になる', () => {
    const onStart = vi.fn();
    render(<PreSession {...preProps({ onStart })} />);
    expect(screen.getByLabelText('商談目的（任意）')).toBeTruthy();
    for (const cb of screen.getAllByRole('checkbox')) if (!(cb as HTMLInputElement).checked && /①|②/.test(cb.parentElement?.textContent ?? '')) fireEvent.click(cb);
    expect(screen.queryByText(/開始に必要:.*商談目的/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '開始の確認へ' }));
    fireEvent.click(screen.getByRole('button', { name: '開始する' }));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart.mock.calls[0]![0].purpose).toBe('A社 定例');
  });

  it('会議名も無ければ「商談」', () => {
    const onStart = vi.fn();
    render(<PreSession {...preProps({ onStart, target: { tabId: 1, title: null, isMeet: true, armed: true, armError: null, via: 'tab', autoStart: null } })} />);
    for (const cb of screen.getAllByRole('checkbox')) if (!(cb as HTMLInputElement).checked && /①|②/.test(cb.parentElement?.textContent ?? '')) fireEvent.click(cb);
    fireEvent.click(screen.getByRole('button', { name: '開始の確認へ' }));
    fireEvent.click(screen.getByRole('button', { name: '開始する' }));
    expect(onStart.mock.calls[0]![0].purpose).toBe('商談');
  });
});

describe('モードを開始直後に大きく表示（OFFLINE の取り違え防止）', () => {
  it('LIVE は最初の数秒だけ大きく出して消える', () => {
    vi.useFakeTimers();
    render(<ModeBanner mode="LIVE" />);
    expect(screen.getByTestId('mode-banner').textContent).toMatch(/LIVE/);
    act(() => void vi.advanceTimersByTime(MODE_BANNER_MS + 10));
    expect(screen.queryByTestId('mode-banner')).toBeNull();
  });
  it('OFFLINE は「架空の会話」「本物の会話ではありません」と出し、数秒後も小さく残す', () => {
    vi.useFakeTimers();
    render(<ModeBanner mode="OFFLINE" />);
    expect(screen.getByRole('alert').textContent).toMatch(/架空の会話.*本物の会話ではありません/);
    act(() => void vi.advanceTimersByTime(MODE_BANNER_MS + 10));
    expect(screen.getByTestId('mode-banner').className).toMatch(/small/);
  });
});

describe('切れても終わらせない: 「再接続中」と終了理由', () => {
  const live: OffscreenSnapshot = {
    phase: 'live',
    sources: { SELF: 'capturing', REMOTE: 'reconnecting' },
    ws: 'open',
    paused: false,
    selfEnabled: true,
    sessionId: 's1',
    inputSampleRate: 48000,
    stopReason: null,
    reconnecting: true,
  };
  it('再接続中は「再接続中（商談は続いています）」を最優先で出す', () => {
    const l = overallHealth({ snapshot: live, status: null, usage: null });
    expect(l.text).toMatch(/再接続中（商談は続いています）/);
    expect(overallHealth({ snapshot: { ...live, ws: 'reconnecting', sources: { SELF: 'capturing', REMOTE: 'capturing' } }, status: null, usage: null }).text).toMatch(
      /再接続中/,
    );
  });
  it('終了画面に、拡張側の理由とサーバーが記録した終了理由を出す', () => {
    render(
      <EndView
        reason="call_left"
        exportRequested={false}
        result={{ source: 'session.ended', exportPath: null, reviewAvailableUntil: null, endReason: 'call_left' }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('status').textContent).toMatch(/通話から退出したため終了しました/);
    expect(screen.getByTestId('end-reason').textContent).toMatch(/通話から退出した/);
  });
});
