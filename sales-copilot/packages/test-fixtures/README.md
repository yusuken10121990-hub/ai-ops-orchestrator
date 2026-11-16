# packages/test-fixtures

匿名の架空会話データと回帰テスト用フィクスチャ。`data/style-examples.ja.md`（SPEC §11 の返答例 A〜R・改変しない）や、STT イベント列（interim/final/再配送/訂正）、架空商談の再生用スクリプトを置き、OFFLINE テストと各パッケージのテストから参照する。実在の顧客名・会話・音声は置かない。

## 中身

- `data/conversations/*.json` … 架空会話（SPEC §16-1 の 7〜14, 18 と、同じ顧客発言で文脈だけ違う組 `contextGroup`）。期待は正確な文ではなく判断の制約（`expect.safety` = 禁止する約束、`expect.quality` = 必須の判断）と、良い/悪い候補出力
- `data/replay/*.json` … OFFLINE 再生用の時刻付き STT 行 `{ atMs, source, text, isFinal }`（interim→final、「できます」→「できますか？」の訂正を含む）
- API: `listConversationFixtures()` / `loadConversationFixture(id)` / `loadAllConversationFixtures()` / `fixtureMemoSnapshot(f)` / `checkJudgement(output, expect, 'safety'|'full')` / `listReplayScripts()` / `loadReplayScript(name)` / `loadStyleExamplesText()`
