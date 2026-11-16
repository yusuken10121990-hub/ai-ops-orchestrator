# packages/coaching

助言生成の中身を担う。`prompts/system-prompt.ja.md`（SPEC §10 の原文・改変しない）を読み込み、会話ウィンドウ・構造化メモ・承認済み条件・野中専用の補正ルールから LLM 入力を組み立てる。LLM 出力を `@sales-copilot/contracts` の AdviceLlmOutput で検証し、未確認の数値・保証の新規約束、承認済み条件との矛盾、顧客の拒否や未解決の疑問の無視を表示前に検査して、不合格時は有限の再試行か「確認してお伝えする」へ安全に切り替える。promptVersion を管理する。

## 公開 API（`@sales-copilot/coaching`）

| 名前 | 役割 |
|---|---|
| `createAdviceEngine({ llm, maxRetries=1, timeoutMs=8000 })` | `generate(ctx, signal)` → `AdviceResult`（`outcome: ok/repaired/fallback`）。外部 signal の中止だけが例外（AbortError）。API障害・不正JSON・検証不合格は有限回の再試行後に安全カードへ切替 |
| `AdviceLlm` / `AdviceLlmError(kind)` | プロバイダーが実装する口。kind = not_configured / auth_failed / rate_limited / timeout / aborted / invalid_json / network / unknown |
| `validateAdvice(output, ctx)` | 表示前検証（SPEC §12）。ID実在・数値の出所・保証語・使わない表現・無料・削減量・可否の言い切り・単位のすり替え・二者択一・質問1つ/3文以内、見送り/未解決/弱い前向き反応/解約条件の矛盾への置き換え |
| `buildAdvicePrompt(ctx)` / `promptVersion()` | システム＝原文＋アプリ側ルール、ユーザー＝依頼種別・目的・承認済み条件・メモ・直近発言（`<transcript_data>` 内の JSON、`<` `>` はエスケープ）＋返答例2〜3件 |
| `adviceOutputJsonSchema()` | contracts の `AdviceLlmOutputBase` から導出（structured outputs 非対応の長さ制約は除去し、アプリ側で再検証） |
| `shouldTriggerAuto(...)` / `extractMemoCandidates(...)` | 自動助言の契機判定（SPEC §8-1）と、規則ベースのメモ候補抽出（会話由来の条件は unverified の確認候補止まり） |
| `RuleBasedOfflineLlm` | APIキー無しの OFFLINE デモ用。AI ではない（model=`offline-rule-based`、briefReason 先頭に `[OFFLINE規則]`） |
| `FakeAdviceLlm`（`/testing` にも） | 台本どおりに応答し要求を記録するテスト用 LLM。`contextFromFixture()` も `/testing` から |

## 評価

- `pnpm test` … 検証器・エンジン（不正JSON/429/認証/timeout/中止/注入/発明ID/発明価格）・フィクスチャ評価（SPEC §16-1 7〜14, 18）。実APIは呼ばない
- `LIVE_EVAL=1 ANTHROPIC_API_KEY=... pnpm --filter @sales-copilot/coaching eval:live` … 実APIでフィクスチャを評価（最大20呼び出し、モデルは `ADVICE_MODEL`、既定 `claude-opus-5-5`）。両方の環境変数が無ければ何もしない
