// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CardPanel } from './CardPanel';
import { TranscriptPanel } from './TranscriptPanel';
import { LiveView, type LiveActions } from './LiveView';
import { StatusBar, collectNotices, overallHealth } from './StatusBar';
import { EndView } from './EndView';
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
  });
});

describe('状態は 1 行にまとめる', () => {
  const status = {
    type: 'status' as const,
    sessionId: 's1',
    lifecycle: 'capturing' as const,
    mode: 'LIVE' as const,
    externalSending: true,
    storage: 'memory_only' as const,
    pipelines: {
      capture: {
        SELF: { state: 'active' as const, reason: null, since: 0 },
        REMOTE: { state: 'active' as const, reason: null, since: 0 },
      },
      stt: { state: 'active' as const, reason: null, since: 0 },
      advice: { state: 'active' as const, reason: null, since: 0 },
    },
    at: 0,
  };
  it('問題なし → 「LIVE・正常」', () => {
    expect(overallHealth({ snapshot, status, usage: null })).toEqual({ text: 'LIVE・正常', tone: 'ok' });
  });
  it('会議側が無音 → 「LIVE・会議側が無音」', () => {
    const s = { ...status, pipelines: { ...status.pipelines, capture: { ...status.pipelines.capture, REMOTE: { state: 'waiting' as const, reason: 'silence' as const, since: 0 } } } };
    expect(overallHealth({ snapshot, status: s, usage: null }).text).toBe('LIVE・会議側が無音');
  });
  it('一番重い問題を出し、件数を添える（通信断はエラー）', () => {
    const s = { ...status, pipelines: { ...status.pipelines, capture: { ...status.pipelines.capture, REMOTE: { state: 'waiting' as const, reason: 'silence' as const, since: 0 } } } };
    const h = overallHealth({ snapshot: { ...snapshot, ws: 'closed' }, status: s, usage: null });
    expect(h.tone).toBe('error');
    expect(h.text).toContain('通信断');
  });
  it('お知らせは同じ内容を 1 回だけ・エラーを先に', () => {
    const w = (id: string) => ({ type: 'warning' as const, warningId: id, code: 'degraded_capture' as const, message: '自分の音声取得はOFFです（会議のミュートとは別です）', evidenceUtteranceIds: [], at: 0 });
    const n = collectNotices({ snapshot: { ...snapshot, sources: { SELF: 'no_permission', REMOTE: 'capturing' } }, lastError: null, warnings: [w('w1'), w('w2')] });
    expect(n).toHaveLength(2);
    expect(n[0]!.tone).toBe('error');
    expect(n[0]!.text).toContain('設定画面でマイクを許可');
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

  it('商談目的（1 タップ接続では会議名）を商談中に変更できる', () => {
    const a = { ...actions(), updatePurpose: vi.fn() };
    render(<LiveView {...base} view={viewOf()} snapshot={snapshot} actions={a} purpose="Google Meet の商談（abc-defg-hij）" />);
    expect(screen.getByText(/商談目的: Google Meet の商談/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '変更' }));
    const input = screen.getByLabelText('商談目的') as HTMLInputElement;
    // 入力中のキーはショートカットにならない
    fireEvent.keyDown(input, { key: 'e' });
    expect(screen.queryByText('商談を終了しますか？')).toBeNull();
    fireEvent.change(input, { target: { value: '  A社 業務診断の結果共有 ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(a.updatePurpose).toHaveBeenCalledWith('A社 業務診断の結果共有');
  });

  it('全ボタンがキーボードで到達できる button 要素で、ショートカットを持つ', () => {
    render(<LiveView {...base} view={viewOf()} snapshot={snapshot} actions={actions()} />);
    const toolbar = screen.getByRole('toolbar');
    const buttons = toolbar.querySelectorAll('button');
    expect(buttons.length).toBe(9);
    for (const b of buttons) expect(b.getAttribute('aria-keyshortcuts')).toBeTruthy();
  });

  it('【次に言う一言】が画面の先頭（状態・お知らせ・操作より前）にある', () => {
    const { container } = render(
      <LiveView {...base} lastError="サーバー: 失敗" view={viewOf()} snapshot={snapshot} actions={actions()} />,
    );
    const say = container.querySelector('.say')!;
    expect(say.textContent).toBe(makeCard().say);
    const first = container.querySelector('main .card')!;
    expect(first.contains(say)).toBe(true);
    for (const sel of ['.statusline', '.notices', '[role="toolbar"]', '.extras']) {
      const el = container.querySelector(sel)!;
      expect(say.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // 【今の一手】は小さなラベルとしてその直前、【今は言わない】と根拠は後ろ
    const labels = [...container.querySelectorAll('.card .slot-label')].map((e) => e.textContent);
    expect(labels).toEqual(['【今の一手】', '【次に言う一言】', '【今は言わない】']);
  });

  it('同じ注意は 1 回だけ表示（warningId が違っても）', () => {
    const w = (id: string) => ({ type: 'warning' as const, warningId: id, code: 'degraded_capture' as const, message: '自分の音声取得はOFFです（会議のミュートとは別です）', evidenceUtteranceIds: [], at: 0 });
    render(<LiveView {...base} warnings={[w('w1'), w('w2')]} view={viewOf()} snapshot={snapshot} actions={actions()} />);
    expect(screen.getAllByText(/自分の音声取得はOFFです/)).toHaveLength(1);
  });

  it('お知らせは積み上げず 1 行。「ほかN件」で残りを開く', () => {
    const w = { type: 'warning' as const, warningId: 'w1', code: 'degraded_capture' as const, message: '注意その1', evidenceUtteranceIds: [], at: 0 };
    const { container } = render(
      <LiveView {...base} warnings={[w]} snapshot={{ ...snapshot, sources: { SELF: 'no_permission', REMOTE: 'capturing' } }} view={viewOf()} actions={actions()} />,
    );
    expect(container.querySelectorAll('.notice-line')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toContain('設定画面でマイクを許可');
    fireEvent.click(screen.getByRole('button', { name: 'ほか1件' }));
    expect(container.querySelectorAll('.notice-line')).toHaveLength(2);
  });

  it('状態は 1 行。送信中・保存なしは常に見え、詳細は開いて確認できる', () => {
    const status = {
      type: 'status' as const,
      sessionId: 's1',
      lifecycle: 'capturing' as const,
      mode: 'LIVE' as const,
      externalSending: true,
      storage: 'memory_only' as const,
      pipelines: {
        capture: { SELF: { state: 'active' as const, reason: null, since: 0 }, REMOTE: { state: 'active' as const, reason: null, since: 0 } },
        stt: { state: 'active' as const, reason: null, since: 0 },
        advice: { state: 'active' as const, reason: null, since: 0 },
      },
      at: 0,
    };
    const { container } = render(<LiveView {...base} status={status} view={viewOf()} snapshot={snapshot} actions={actions()} />);
    const line = container.querySelector('.statusline')!;
    expect(line.textContent).toContain('LIVE・正常');
    expect(line.textContent).toContain('送信中');
    expect(line.textContent).toContain('保存なし');
    expect(container.querySelector('.statusbar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /LIVE・正常/ }));
    expect(container.querySelector('.statusbar')!.textContent).toContain('文字起こし');
  });

  it('参考カードは見た目で区別（status-reference）し、言う一言の横に「参考」と出す', () => {
    let s = copilotReducer(initialCopilotState, { type: 'server', message: { type: 'advice.card', card: makeCard() } });
    s = copilotReducer(s, { type: 'pin', adviceId: 'a1' });
    s = copilotReducer(s, { type: 'server', message: { type: 'advice.card', card: makeCard({ adviceId: 'a2', createdAt: 1500 }) } });
    const { container } = render(<CardPanel view={selectCardView(s, 2000)} />);
    expect(container.querySelector('.card.status-reference')).toBeTruthy();
    expect(container.querySelector('.say-label')!.textContent).toContain('参考扱い');
  });

  it('主要3ボタン（切り返し・次に聞く・次の約束）は大きく、終了は他と離す', () => {
    const { container } = render(<LiveView {...base} view={viewOf()} snapshot={snapshot} actions={actions()} />);
    const big = [...container.querySelectorAll('.controls-primary button')].map((b) => b.textContent);
    expect(big).toEqual(['切り返しR', '次に聞くQ', '次の約束N']);
    const sec = container.querySelector('.controls-secondary')!;
    expect(sec.lastElementChild!.textContent).toBe('終了E');
    expect(sec.querySelector('.end-sep')!.nextElementSibling!.textContent).toBe('終了E');
  });

  it('文字起こし履歴は既定で閉じている', () => {
    const { container } = render(<LiveView {...base} view={viewOf()} snapshot={snapshot} actions={actions()} />);
    expect((container.querySelector('details.transcript') as HTMLDetailsElement).open).toBe(false);
  });
});

describe('終了画面（session.ended）', () => {
  it('session.ended で出力なし → 「何も保存していません」と保持期限', () => {
    render(<EndView reason="user_end" exportRequested={false} result={{ source: 'session.ended', exportPath: null, reviewAvailableUntil: Date.now() + 600_000 }} onClose={() => {}} />);
    expect(screen.getByTestId('no-export').textContent).toContain('何も保存していません');
    expect(screen.getByTestId('server-ended').textContent).toContain('サーバー側の終了を確認しました');
  });

  it('出力ありはパスを表示（テキストのみ）', () => {
    render(<EndView reason="user_end" exportRequested result={{ source: 'session.ended', exportPath: '<b>C:/exports/a.json</b>', reviewAvailableUntil: 1 }} onClose={() => {}} />);
    expect(screen.getByTestId('export-path').textContent).toBe('<b>C:/exports/a.json</b>');
    expect(document.querySelector('b')).toBeNull();
  });

  it('出力を頼んだが結果を確認できない場合は、保存されたと言わない', () => {
    render(<EndView reason="user_end" exportRequested result={{ source: 'unknown' }} onClose={() => {}} />);
    expect(document.body.textContent).toContain('保存されたか確認できません');
    expect(document.body.textContent).not.toContain('出力しました');
  });
});
