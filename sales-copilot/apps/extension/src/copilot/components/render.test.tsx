// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CardPanel } from './CardPanel';
import { TranscriptPanel } from './TranscriptPanel';
import { LiveView, type LiveActions } from './LiveView';
import { StatusBar } from './StatusBar';
import { makeCard } from '../test-cards';
import { copilotReducer, initialCopilotState, selectCardView } from '../state';
import type { OffscreenSnapshot } from '../../shared/runtime-messages';

afterEach(cleanup);

const XSS = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';

const snapshot: OffscreenSnapshot = {
  phase: 'live',
  sources: { SELF: 'capturing', REMOTE: 'capturing' },
  ws: 'open',
  paused: false,
  selfEnabled: true,
  sessionId: 's1',
  inputSampleRate: 48000,
  stopReason: null,
};

function viewOf(card = makeCard()) {
  const s = copilotReducer(initialCopilotState, { type: 'server', message: { type: 'advice.card', card } });
  return selectCardView(s, 2000);
}

describe('XSS: 会話・助言は HTML として描画しない', () => {
  it('カードの全フィールドをテキストとして表示し、要素を生成しない', () => {
    const card = makeCard({
      headline: '<b>x</b>',
      say: XSS,
      avoid: '<a href="javascript:1">x</a>',
      briefReason: '<iframe src=x>',
      missingItems: ['<svg onload=alert(1)>'],
    });
    const { container } = render(<CardPanel view={viewOf(card)} />);
    expect(container.querySelector('img, script, iframe, svg, b, a[href]')).toBeNull();
    expect(container.textContent).toContain(XSS);
    expect(container.textContent).toContain('<b>x</b>');
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it('文字起こし履歴もテキストのみ', () => {
    const { container } = render(
      <TranscriptPanel
        segments={[
          {
            type: 'transcript.segment',
            segmentId: 'g',
            utteranceId: 'u',
            source: 'REMOTE',
            streamGeneration: 0,
            text: XSS,
            isFinal: true,
            speechFinal: true,
            startMs: 0,
            endMs: 1,
            revision: 0,
          },
        ]}
      />,
    );
    expect(container.querySelector('img, script')).toBeNull();
    expect(container.textContent).toContain(XSS);
  });
});

describe('CardPanel 表示', () => {
  it('【今の一手】【次に言う一言】【今は言わない】と状態ラベル（色だけに頼らない）', () => {
    render(<CardPanel view={viewOf()} />);
    expect(screen.getByText('【今の一手】')).toBeTruthy();
    expect(screen.getByText('【次に言う一言】')).toBeTruthy();
    expect(screen.getByText('【今は言わない】')).toBeTruthy();
    expect(screen.getByText('状態: 現行')).toBeTruthy();
  });

  it('無効カードは「無効」ラベルと理由を出し、言う一言を表示しない', () => {
    let s = copilotReducer(initialCopilotState, { type: 'server', message: { type: 'advice.card', card: makeCard() } });
    s = copilotReducer(s, { type: 'server', message: { type: 'advice.invalidated', adviceId: 'a1', reason: 'transcript_revised' } });
    const { container } = render(<CardPanel view={selectCardView(s, 2000)} />);
    expect(screen.getByText('状態: 無効')).toBeTruthy();
    expect(container.textContent).not.toContain(makeCard().say!);
    expect(container.textContent).toContain('文字起こしが訂正');
  });

  it('固定中に新しいカード → 参考 + お知らせ + 解除ボタン', () => {
    let s = copilotReducer(initialCopilotState, { type: 'server', message: { type: 'advice.card', card: makeCard() } });
    s = copilotReducer(s, { type: 'pin', adviceId: 'a1' });
    s = copilotReducer(s, { type: 'server', message: { type: 'advice.card', card: makeCard({ adviceId: 'a2', createdAt: 1500 }) } });
    const onUnpin = vi.fn();
    render(<CardPanel view={selectCardView(s, 2000)} onUnpin={onUnpin} />);
    expect(screen.getByText('状態: 参考')).toBeTruthy();
    expect(screen.getByText('表示固定中')).toBeTruthy();
    fireEvent.click(screen.getByText('固定を解除して新しいカードを見る'));
    expect(onUnpin).toHaveBeenCalled();
  });
});

describe('StatusBar: 待機を一括りにしない', () => {
  it('API未設定・無音・権限なし・通信断を別ラベルで表示', () => {
    const status = {
      type: 'status' as const,
      sessionId: 's1',
      lifecycle: 'capturing' as const,
      mode: 'LIVE' as const,
      externalSending: true,
      storage: 'memory_only' as const,
      pipelines: {
        capture: {
          SELF: { state: 'waiting' as const, reason: 'silence' as const, since: 0 },
          REMOTE: { state: 'active' as const, reason: null, since: 0 },
        },
        stt: { state: 'not_configured' as const, reason: 'not_configured' as const, since: 0 },
        advice: { state: 'offline' as const, reason: 'disconnected' as const, since: 0 },
      },
      at: 0,
    };
    const { container, rerender } = render(<StatusBar snapshot={snapshot} status={status} usage={null} />);
    const t = container.textContent!;
    expect(t).toContain('無音');
    expect(t).toContain('API未設定');
    expect(t).toContain('通信断');
    expect(t).toContain('LIVE');
    rerender(<StatusBar snapshot={{ ...snapshot, sources: { SELF: 'no_permission', REMOTE: 'capturing' } }} status={status} usage={null} />);
    expect(container.textContent).toContain('権限なし');
    expect(container.textContent).toContain('設定画面でマイクを許可');
  });
});

describe('LiveView 操作', () => {
  function actions(): LiveActions & Record<string, ReturnType<typeof vi.fn>> {
    return {
      sendClient: vi.fn(),
      pin: vi.fn(),
      unpin: vi.fn(),
      setSelf: vi.fn(),
      setPaused: vi.fn(),
      end: vi.fn(),
      changeFont: vi.fn(),
      toggleTheme: vi.fn(),
      openOptions: vi.fn(),
    };
  }
  const base = {
    transcript: [],
    warnings: [],
    levels: { SELF: -30, REMOTE: -20 },
    status: null,
    usage: null,
    lastError: null,
    newId: () => 'req-1',
  };

  it('キーボードショートカット（R=切り返し, P=固定, M=自分OFF, S=一時停止, +/-=文字）', () => {
    const a = actions();
    render(<LiveView {...base} view={viewOf()} snapshot={snapshot} actions={a} />);
    fireEvent.keyDown(window, { key: 'r' });
    expect(a.sendClient).toHaveBeenCalledWith({ type: 'advice.request', kind: 'rebuttal', requestId: 'req-1' });
    fireEvent.keyDown(window, { key: 'p' });
    expect(a.pin).toHaveBeenCalledWith('a1');
    fireEvent.keyDown(window, { key: 'm' });
    expect(a.setSelf).toHaveBeenCalledWith(false);
    fireEvent.keyDown(window, { key: 's' });
    expect(a.setPaused).toHaveBeenCalledWith(true);
    fireEvent.keyDown(window, { key: '+' });
    expect(a.changeFont).toHaveBeenCalledWith(0.1);
  });

  it('終了は確認を挟み、出力は機密情報の注意つきで任意', () => {
    const a = actions();
    render(<LiveView {...base} view={viewOf()} snapshot={snapshot} actions={a} />);
    fireEvent.click(screen.getByRole('button', { name: /^終了/ }));
    expect(a.end).not.toHaveBeenCalled();
    expect(screen.getByText(/機密情報が含まれる可能性/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('終了する'));
    expect(a.end).toHaveBeenCalledWith(true);
  });

  it('全ボタンがキーボードで到達できる button 要素で、ショートカットを持つ', () => {
    render(<LiveView {...base} view={viewOf()} snapshot={snapshot} actions={actions()} />);
    const toolbar = screen.getByRole('toolbar');
    const buttons = toolbar.querySelectorAll('button');
    expect(buttons.length).toBe(9);
    for (const b of buttons) expect(b.getAttribute('aria-keyshortcuts')).toBeTruthy();
  });
});
