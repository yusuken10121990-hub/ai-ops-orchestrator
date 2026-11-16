# Chrome 拡張（apps/extension）設計メモ

対象: Windows デスクトップ版 Chrome 116 以降 / Google Meet（ブラウザ版）。Manifest V3・TypeScript・React 19・Vite 7（`@crxjs` は使わず、マルチエントリビルド＋静的 manifest コピー）。

## 1. 一次資料の確認（確認日 2026-11-16）

| 資料 | 確認できたこと | 採用した設計 |
|---|---|---|
| [chrome.tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture) | `getMediaStreamId({ targetTabId, consumerTabId })` は stream ID を返す。ID は**1回限り・数秒で失効**。`consumerTabId` 省略時、**Chrome 116 以降は同じ拡張の render process 内の同一オリジン frame（offscreen document を含む）で使える**。拡張の起動（アクションのクリック等）後のみ取得可（activeTab と同様）。`targetTabId` 指定には `activeTab` が必要。**取得するとタブの音はローカルで鳴らなくなる** → AudioContext の `createMediaStreamSource` を `destination` に繋いで再生し直す。 | アクションのクリックで対象タブ ID を最初に記録 → service worker で `getMediaStreamId({targetTabId})` → 直ちに offscreen へ渡して `getUserMedia` で消費。`minimum_chrome_version: 116`。 |
| [chrome.offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen) | `createDocument({url, reasons, justification})`。Reason に `USER_MEDIA` / `AUDIO_PLAYBACK` 等。**拡張ごとに同時に1つ**。**`AUDIO_PLAYBACK` は 30 秒音が出ないと閉じられる**（他の理由は寿命制限なし）。offscreen 内で使える拡張 API は **`runtime` のみ**。存在確認は `runtime.getContexts()`（116+）。`closeDocument()`。 | reason は **`USER_MEDIA` のみ**（会議の沈黙 30 秒で閉じられるのを避けるため `AUDIO_PLAYBACK` は付けない。再生は USER_MEDIA の文書内の AudioContext で行う＝公式サンプルと同じ構成）。設定値・トークンは offscreen が `chrome.storage` を読めないため start メッセージで渡す。 |
| [Screen capture how-to](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture) | 「Record audio and video in the background」: `action.onClicked` → offscreen（USER_MEDIA）作成 → `getMediaStreamId({targetTabId: tab.id})` → offscreen で `getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId } } })` → `new AudioContext()` + `createMediaStreamSource(media).connect(destination)` で再生継続。 | 同じ手順を採用。**マイク許可（offscreen では許可ダイアログを出せない件）はこのページには記載がなかった**。offscreen はダイアログを表示できないため、**見える拡張ページ（設定画面 / copilot ウィンドウ）で先に `getUserMedia` して許可を得る**運用にした（同じ拡張オリジンなので offscreen でも許可が効く）。これは公式記載ではなく実装上の判断。Playwright の new headless + 偽デバイスで「設定画面で許可 → offscreen で取得」が動くことを確認（§6）。実 Chrome の許可ダイアログでの確認は手動チェック対象。 |

## 2. どの文脈が何を持つか

```
[会議タブ(Meet)] ──(アクションのクリック = 本人の操作)──▶ [service worker]
                                                          │ 1) targetTabId を storage.session に記録（以後フォーカス移動で変えない）
                                                          │ 2) tabCapture.getMediaStreamId({targetTabId})
                                                          │ 3) offscreen(USER_MEDIA) を作り streamId を渡す（数秒で失効するので即）
                                                          │ 4) copilot ウィンドウ（popup 440×720）を開く
                                                          ▼
[offscreen document] ← MediaStream / AudioContext / AudioWorklet / WebSocket は全部ここだけ
   REMOTE: getUserMedia(tab streamId) ─┬─▶ destination（相手の声を本人が聞けるよう1回だけ再生）
                                        └─▶ AudioWorkletNode(出力0) ─▶ 16kHz PCM16 ─▶ フレーム化 ─▶ WS
   SELF  : getUserMedia(選択マイク, echoCancellation/noiseSuppression) ─▶ AudioWorkletNode(出力0) ─▶ … ─▶ WS
           （destination へは繋がない＝スピーカーにも会議にも戻さない）
[copilot ウィンドウ(React)] ⇄ runtime メッセージ ⇄ offscreen（カード・状態・音量・操作）
[設定画面(React)] サーバーURL・ペアリング・マイク許可/テスト・承認済み条件の編集（HTTP は fetch で直接）
```

- **開始前（armed）**: アクションのクリック直後に会議タブの音声を取得するのは、stream ID が数秒で失効するため。開始ボタンまでは**PC内で音量確認と再生維持だけ**を行い、WebSocket は開かず外部へは何も送らない（UI にも明示）。
- **開始（明示確認後）**: `ws://<server>/ws` へ接続 → 最初のメッセージ `hello`（トークン。URL クエリには載せない）→ `hello.ack` → `session.start`（`consentConfirmed: true`）→ `status.sessionId` を受けてから音声フレーム送信を開始。
- **終了**: 「終了」→ `session.end` → 取得を即停止 → サーバーの `status(lifecycle=ended)` か切断を最大 5 秒待って WS を閉じる → service worker が offscreen を閉じる。
- **ウィンドウを閉じる**: `windows.onRemoved` → offscreen へ stop（`session.end` 送信・全トラック停止・AudioContext close・WS close・タイマー解除）→ offscreen を閉じる。
- **UI が消えた保険**: copilot が 2 秒ごとにハートビート。offscreen は 10 秒途切れたら全停止（Playwright で実測 約10.3秒で `session.end`＋切断）。
- **会議タブを閉じた／トラック終了（共有停止・権限取消）**: `tabs.onRemoved` とトラック `ended` を検知 → `source.state REMOTE lost` → 全停止（別タブへ勝手に切り替えない、スピーカー音をマイクで拾う方式へ黙って切り替えない）。
- **マイクが外れた**: `devicechange` で選択デバイスの消失を検知 → SELF だけ停止（`device_changed`）し、UI に直し方を表示。会議側は継続（本人が選ぶ縮退）。

## 3. 権限（manifest）

| 権限 | 理由 |
|---|---|
| `tabCapture` | 会議タブの音声取得 |
| `offscreen` | 長時間の MediaStream / AudioWorklet / WebSocket を持つ文書 |
| `storage` | 設定・トークン（local）、service worker の一時状態（session） |
| `activeTab` | クリックしたタブを `targetTabId` で指定するため（公式: targetTabId には activeTab が必要） |
| host: `http://127.0.0.1/*`, `http://localhost/*` | ローカルサーバーのみ。`<all_urls>` なし。CSP の `connect-src` もローカルのみに制限 |

`tabs`・`scripting`・content script は使わない（カンペを会議タブへ注入しない）。

## 4. 音声処理（SPEC §6-3）

- AudioContext は実デバイスの既定レート（通常 48000Hz）。worklet 内で **ダウンミックス → 窓付き sinc（Blackman, 片側16ゼロ交差, 遮断 = 出力ナイキストの 90%）で 16kHz へリサンプリング → PCM16** に変換（`src/audio/dsp/*`）。ラベルの付け替えではない（テストで 1kHz→1kHz 保存、12kHz 成分の除去、44.1kHz 非整数比を確認）。
- フレーム長 既定 200ms（設定で 100〜250ms）。ヘッダーは `@sales-copilot/contracts` の `encodeAudioFrame`（sessionId / source / streamGeneration / sequence / audioStartMs / durationMs / 16000 / pcm16le / 1ch）。
- `streamGeneration`: SELF の取り直し・解析再開ごとに +1、`sequence` は generation 内で 0 から。`audioStartMs` はセッション開始からの経過時間（generation 開始時刻 + 生成サンプル数）。
- バックプレッシャー: `ws.bufferedAmount + frame > 128KB`（約2秒分）なら破棄し欠落区間を記録（UI へ `gap`、サーバーへ `source.state` reason `backpressure_drop`）。破棄分の sequence は進める（欠落が分かる）。復旧後に再送しない。
- SELF の簡易エネルギー VAD（-45dBFS, attack 120ms, release 700ms）→ `speaking.state`。
- 解析一時停止: `analysis.pause` 送信・worklet 無効化・マイク解放。会議音声の再生は継続。再開時は generation +1。

## 5. 画面

- **開始前**: 対象タブ（Meet かどうか）と会議側メーター、サーバー接続・ペアリング・API設定状態（`/config/status`: 文字起こし/助言の設定有無、LIVE 可否、OFFLINE の助言方式、価格表）、マイク選択・許可・テスト、商談目的（必須）・顧客名（任意）、承認済み条件の選択（版・承認日）、LIVE/OFFLINE、取得元・送信先・保存方針、画面共有の注意、①ブラウザのマイク許可 と ②相手への説明・同意/社内承認 を別チェック、「Meetのミュートではこのアプリの自分の音声取得は止まらない」の明示。開始は2段階（「開始の確認へ」→ 送信先を示した最終確認「開始する」）。
- **商談中**: 【今の一手】【次に言う一言】（最大・最も目立つ）【今は言わない】、根拠・確認事項と文字起こし履歴は折りたたみ。状態ラベルは文字（現行/参考/無効）。状態バーは 会議側/自分側/外部送信/文字起こし/助言/サーバー接続/LIVE・OFFLINE/保存/使用量 を個別ラベル（無音・権限なし・API未設定・通信断・遅延・エラー・一時停止を区別）。ボタン9個（キー R/Q/N/P/G/B/M/S/E、文字サイズ +/-、明暗 D）。文字サイズと明暗は `chrome.storage.local`。
- **カードの原子的表示**: 完全に検証済みの `advice.card` だけで差し替え（UI 側でも Zod 再検証）。`createdAt`/`contextRevision` が古いカードは上書きしない。`advice.invalidated` はカードより先に届いても保持。表示固定中は固定カードを残し、新しいカードがあれば「参考」＋お知らせ＋解除ボタン。期限切れ・サーバーの `card.pin.state` も反映。
- **終了**: 終了確認で任意の出力（機密情報を含む可能性の注意）。出力先パスは `GET /sessions/:id/review` の `exportPath` で表示、無ければ「何も保存していません」。
- 会話・助言は全て React のテキストノードで描画（`dangerouslySetInnerHTML` 不使用。ビルド後検査 `scripts/check-dist.mjs` でも確認）。

## 6. テスト

| 種類 | 内容 | 結果（2026-11-16） |
|---|---|---|
| Vitest（node） | DSP（48k→16k 周波数保存・サンプル数・折り返し除去・44.1k・ブロック分割非依存・DC）、PCM 変換、チャンカー、VAD、フレーマー（contracts で復号）、バックプレッシャー、CaptureController の後始末（停止でトラック停止・WS close・タイマー0・AudioContext close・停止後送信なし）、ハートビート、タブ終了、SELF OFF/ON の generation、権限なし、デバイス変更、一時停止、不正メッセージ破棄、API クライアント（トークンはヘッダーのみ）、設定の検証 | 全件成功 |
| Vitest（jsdom） | XSS（カード全フィールド・文字起こし）、状態ラベル、無効カード、固定中の新カード、状態バーの区別、ショートカット、終了確認 | 全件成功 |
| Playwright（`pnpm --filter @sales-copilot/extension test:e2e`、ビルド後） | Chromium new headless に拡張を読み込み、モックサーバーに対し: 設定画面でマイク許可 → copilot で OFFLINE 開始 → hello/トークン・Origin・session.start 同意 → **偽マイク→offscreen→AudioWorklet→16kHz/200ms フレーム**受信 → カード描画と XSS 非実行 → 表示固定 → 自分OFFでフレーム停止 → 画面を閉じてハートビート切れで session.end＋切断 | 21/21 成功 |

**自動化できていないもの**（実機チェック docs/manual-checklist.md）: アクションのクリックによる tabCapture（Playwright から拡張アイコンを押せない）、Meet 実音声の二系統、再生維持・ハウリング、実 Chrome の許可ダイアログ、`windows.onRemoved` による終了（スモークはタブで開くためハートビート経路で確認）、実 API 経由の助言、60 分連続稼働。

## 7. ビルド・読込

```
pnpm install
pnpm --filter @sales-copilot/extension build      # apps/extension/dist（ルートの pnpm build にも含まれる）
```
chrome://extensions → デベロッパーモード ON → 「パッケージ化されていない拡張機能を読み込む」→ `apps/extension/dist`。
初回: 拡張の「オプション」→ サーバーURL → サーバーに表示された6桁コードでペアリング → 「マイクを許可してテスト」。

## 8. contracts への変更要望（拡張側では未変更・隔離して吸収）

1. **終了結果のサーバーメッセージ**: 出力先パスを WS で受け取る型が無い。現在は `GET /sessions/:id/review` の `exportPath` を読む（`src/shared/noncontract.ts`）。`session.ended { sessionId, exportPath: string|null }` 等の追加を希望（WS で `session.exported` が来れば拡張は既に受ける）。
2. **音声欠落の通知**: 破棄区間を送る型が無い。現在は `source.state`（SELF=`on` / REMOTE=`ok`）＋ reason `backpressure_drop` で代用。`audio.gap { source, streamGeneration, fromMs, toMs, droppedFrames }` を希望。
3. **OFFLINE 台本の選択**: `SessionStartMessage` に台本 ID が無く、一覧 API も無い。現在は「サーバー既定」表示。`replayScriptId?: string` と一覧の型を希望。
4. **HTTP 応答の型**: `/config/status`・`/facts`（`{facts}` ラッパー）・`PATCH /facts/:id`（`{fact, approvalRevoked}`）・`/sessions/:id/review` が contracts に無い。拡張は緩い Zod で受けている（形が違えば「確認できません」表示）。contracts 化を希望。
5. `SourceStateMessage` の SELF に `paused`（解析一時停止でマイク解放中）を表す状態が無い。現在は送らずローカル表示のみ。
