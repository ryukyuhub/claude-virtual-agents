# サンプルのカスタムサブエージェント定義

このディレクトリの `*.md` は、Claude Virtual Agents で可視化するときに**名前と役割が揃って見えるようにした**カスタムサブエージェントのサンプルです。そのままでは使われません。使いたいものだけコピーしてください。

```powershell
# Windows (PowerShell) — このプロジェクトだけで使う
copy examples\agents\sayla.md .claude\agents\
```

```bash
# macOS / Linux — 全プロジェクトで使う
mkdir -p ~/.claude/agents && cp examples/agents/sayla.md ~/.claude/agents/
```

コピーしたら Claude Code を再起動してください。

## 収録しているエージェント

| 定義名 | 表示名 | 担当 |
| --- | --- | --- |
| `sayla` | セイラ | Web 検索。結論・根拠・出典の 3 点だけを返す |

## 表示名の仕組み

Claude Code のエージェント定義名(`name`)は**英小文字とハイフンのみ**と決まっているため、定義名は `sayla` のような ASCII にしています。

ビューアーの名札に出す日本語名は、frontmatter の `displayName:` に書きます。収録しているサンプルにはすでに入っているので、自分で定義を作るときも同じように足してください。

```yaml
---
name: sayla
displayName: セイラ
model: haiku
---
```

`displayName:` の書き換えは**サーバーを再起動しなくても次のイベントで反映されます**(サーバーが定義ファイルの更新日時を見て読み直します)。名札を試しながら決められます。

定義ファイルを書き換えずに上書きしたい場合は `.env` の `CVA_AGENT_NAMES` を使います。こちらが優先されます。

```ini
# .env
CVA_AGENT_NAMES=sayla:セイラ,amuro:アムロ,reviewer:査閲官
```

優先順位は **`CVA_AGENT_NAMES` > `displayName:` > サーバー組み込みの対応表(既定でガンダムシリーズの名前)> 定義名そのまま**です。どこにも指定が無ければ、その名前(`sayla` など)がそのまま名札に出ます。`.env` が `displayName:` に勝ったときは、サーバーのログに 1 行出ます。

```
表示名は .env の CVA_AGENT_NAMES を優先しました: sayla → 通信士(定義ファイルの displayName: セイラ は使われません)
```

サーバー組み込みの対応表には、以前の定義名 / よくある定義名(`renderer-dev` → アムロ など)と Claude Code の**組み込みエージェント**が入っています。組み込みは定義ファイルが存在しないため、カスタムと重複しない名前を割り当ててあります。

| 定義名 | 表示名 | 種別 |
| --- | --- | --- |
| `Explore` | ミハル | 組み込み(探索・検索) |
| `Plan` | レビル | 組み込み(設計・計画) |
| `general-purpose` | フラウ | 組み込み(汎用) |

詳しくは [README.md](../../README.md) を参照してください。
