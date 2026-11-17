# セキュリティ設計（ローカルサーバー: apps/server）

SPEC §14 の実装内容と、それを確認する自動テスト。

## 待受

- `HOST`（既定 `127.0.0.1`）にだけ bind する。`0.0.0.0` などループバック以外は `ALLOW_NON_LOOPBACK=1` を明示しない限り
  起動を拒否する（`assertBindAllowed`）。
- 起動時に外部 API へ接続しない。STT はセッション開始後に最初の音声が届いた時、LLM は契機・ボタンがあった時だけ使う。

## ペアリングとトークン

- 起動時に 6 桁の一度限りのペアリングコードを発行し、**端末（TTY）にだけ**表示する（ログには出さない。TTY でない場合は表示せず警告のみ）。
  `pnpm start` / `pnpm dev` は端末をそのまま渡すので表示される。
- 自動テスト専用の固定コード `PAIRING_CODE_FOR_TEST` は **`NODE_ENV=test` のときだけ**受け付ける。それ以外の環境で設定されていると
  サーバーは起動を拒否する（`config.ts` の `pairingCodeForTest`、`units.test.ts` で確認）。コード自体はログに出さない。
- `POST /pair`（`{ pairingCode, extensionId, clientName }`）: `Origin: chrome-extension://<extensionId>` と body の ID が一致すること。
  `ALLOWED_EXTENSION_ID` を設定した場合はその ID に限定。コードは単回使用・10 分有効（`PAIRING_CODE_TTL_MS`）・
  試行 5 回（`PAIRING_MAX_ATTEMPTS`）で失効（以後はサーバー再起動で新コード）。
- 成功時にランダム 32byte（base64url）のセッショントークンを返す。有効期限 12 時間（`SESSION_TOKEN_TTL_MS`）、
  スコープ `session` / `settings`、拡張機能 ID に束縛。サーバーは SHA-256 ハッシュのみ保持（再起動で全失効）。
- HTTP: `Authorization: Bearer <token>`。WebSocket: 接続後最初の `hello` メッセージの `token`（5 秒以内。来なければ 4408 で切断、
  不正なら 4401）。**URL クエリに token / access_token / key 等が付いたリクエストは 400 で拒否**（受け付けない）。

## Origin / Host 検査（CORS だけに頼らない）

- 全 HTTP リクエストと WebSocket アップグレードで `Host` が `127.0.0.1:<PORT>` / `localhost:<PORT>` / `[::1]:<PORT>` 以外なら 421
  （DNS リバインディング対策）。
- `/health` 以外は、`Origin` があれば「ペアリング済み（または環境変数で許可）の `chrome-extension://<id>`」であること。違えば 403。
  トークンも同じ拡張機能 ID のものでなければ 401。
- **`Origin` ヘッダーが無い HTTP 要求**: Chrome は host_permissions を持つ拡張ページからの GET に `Origin` を付けない
  （実ブラウザの結合テスト `scripts/e2e-integration.mjs` で確認。モックでは見つからなかった不具合）。この場合は Bearer トークンの検査
  （期限・スコープ・発行先の拡張がペアリング済み）だけで判定する。Web ページが `Authorization` ヘッダーを付けると必ず CORS
  （`Origin` 付き）になるため、ブラウザ上の第三者ページはこの経路を使えない。
- **WebSocket アップグレードは `Origin` 必須**（ブラウザは常に付ける）。無い・違う場合は 403。
- `/health` は認証なし・最小（`{ ok, version }`）。

## ログ

- pino。会話本文・顧客名・商談目的・カンペ文・トークン・API キー・ペアリングコードをログに渡さない（ID・件数・理由コードのみ）。
- 多層防御として `text` / `token` / `apiKey` / `customerName` / `purpose` / `say` / `headline` 等のキーを redact。
- リクエストログ（URL・ヘッダー）は出さない。エラーはスタック・メッセージを出さず name / code / kind のみ。
- テスト: OFFLINE セッションを WS 経由で最後まで流し、全ログ行に「再生スクリプトの発話本文（8 文字断片）・顧客名・目的・
  カンペ文・トークン・ペアリングコード・偽 API キー」が含まれないことを確認（`offline-e2e.test.ts`、SPEC §16-1 #15）。

## データ

- `data/sales-copilot.sqlite`（node:sqlite、権限 0600、`data/` は Git 管理外）: 承認済み条件と履歴、セッションで使った条件の版、
  フィードバック（adviceId・評価・種類・promptVersion・rulesVersion・時刻）。学習用に、設定で ON（既定）のときだけ
  評価したカードの欄（今の一手・次に言う一言・今は言わない）・場面タグ・商談目的を保存（顧客名は伏せ字、会話の文字起こしは保存しない）。
  承認済みの営業補正ルールと履歴・版。改善案はモデル出力＝データとして形・長さ・内容（金額・期間・無料・保証・上書き指示・記号）を
  検査してから表示し、承認されるまで助言に使わない。ルールは承認済み条件・出力ルールより優先しない（プロンプトに明記し、検証層も従来どおり）。
- 会話・助言は既定でメモリのみ。終了後は振り返り用に `SESSION_RETENTION_MS`（既定 10 分）だけ保持して破棄。
- 本人が終了時にエクスポートを選んだ場合のみ `exports/`（Git 管理外、0600）へ JSON と Markdown を書き出す。
  Markdown には機密注意を明記し、会話は文字列としてエスケープする（HTML として扱わない）。
- 削除方法: `data/` と `exports/` を削除すればローカルの保存物はすべて消える。外部 API 事業者側の保持は別途確認が必要。

## 停止

- 一時停止・終了・WS 切断（ウィンドウを閉じた）で、STT 接続（CloseStream→close）・生成要求（AbortSignal）・待機キュー・
  タイマー・再生を停止。以後に届いた音声・ボタンは外部へ送らない（テストで確認: SPEC §16-1 #5）。
- 予算上限到達で新規の STT 送信・LLM 呼び出しを止める（80% で警告）。
- LLM の認証失敗は以後の呼び出しを止め、429 は 10 秒のバックオフ。

## Meet ページ内の取得（ワンタップ接続・2026-11-17 追加）

- 拡張がページに入れるスクリプトは `https://meet.google.com/*` だけ。ほかのサイトには入らない（`check-dist.mjs` で検査）。
- 「接続」を押すまで、ページ内では相手の音声トラックを**記録するだけ**で、音声の処理・送信・マイク取得はしない（「拒否」・× なら何もしない）。
- 音声はページ → content script（MessageChannel）→ offscreen（runtime Port）→ ローカルサーバー（127.0.0.1）の順にだけ流れる。
  ページ（Meet）からローカルサーバーへ直接は接続しない。トークンはページにも content script にも渡さない（offscreen だけが持つ）。
- offscreen は service worker が指定したタブの content script からの Port だけを受け付け、形の違うメッセージ・大きすぎる音声は捨てる。
- ページ内の部品（MAIN world のスクリプト）は Meet の JavaScript と同じ空間で動くため、Meet 自身からは見える。扱うのは Meet が元々持っている
  音声だけで、文字起こし・カンペ・トークン・設定は通らない。
- 一時停止・終了・ウィンドウを閉じる・タブを閉じる／再読み込みで、ページ内のマイクのトラックを止め、AudioContext を閉じる（相手側のトラックは Meet のものなので止めない）。
- 新しい通信メッセージ `session.update { purpose }`（商談目的の変更）は、内容をログに出さない（`purpose` は既に redact 対象）。

## 未検証（実機）

- 実際の Windows 版 Chrome（Chromium の自動化ではなく）でのペアリング手順の画面確認。
  （Chromium 153 + 実拡張 + 実サーバーでの Origin 付き WebSocket・ペアリング・HTTP は `pnpm test:e2e` で確認済み）
- Windows での `data/` のファイル権限（chmod は Windows では効かない）。
