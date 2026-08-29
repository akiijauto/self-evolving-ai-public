# app — PWA (Sprint 1〜6)

RealTime AI MVP Generator のクライアント。
現在のスコープは **Sprint 6: MVP生成 + 配信・URL表示** まで。
マイク入力・音声ストリーミング・リアルタイム文字起こし・生成Markdownの表示・
トリガーの確認UI・生成物のURLとQRコード提示を含む。
実装範囲と完了条件は [../ROADMAP.md](../ROADMAP.md) を参照。

## セットアップ

```bash
npm install              # リポジトリのルートで1回(npm workspaces)
npm run dev --workspace server   # 先に Gateway Server を起動(:8787)
npm run dev              # このディレクトリで。http://localhost:5173
```

`/api` と `/ws` は vite の proxy が Gateway Server へ転送する。
PWAとサーバーが同一オリジンに見えるため、CORS を考えなくてよい。
別ホストに置く場合は `VITE_API_BASE_URL` を設定する。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | 開発サーバー(LAN公開あり) |
| `npm run build` | 型チェック + 本番ビルド → `dist/` |
| `npm run preview` | ビルド成果物の確認 |
| `npm run typecheck` | 型チェックのみ |
| `npm test` | 単体テスト(vitest) |

## 実機(スマートフォン)での確認

`getUserMedia` は **セキュアコンテキストでのみ動作する**。
`localhost` は例外として許可されるが、LAN内のIPアドレス(`http://192.168.x.x:5173`)では
マイクが取得できない。実機で試すには次のいずれかが必要。

1. HTTPSトンネルを通す(`cloudflared tunnel --url http://localhost:5173` など)
2. 自己署名証明書でHTTPS配信する
3. Chrome の `chrome://flags/#unsafely-treat-insecure-origin-as-secure` に
   開発機のオリジンを登録する(開発時のみ)

Service Worker も同様にセキュアコンテキストを要求するため、
PWAのインストール確認には 1 か 2 が必要。

## 構成

```
src/
├── main.tsx                      エントリ。Service Worker 登録(本番のみ)
├── App.tsx                       画面全体
├── format.ts                     時間・バイト数の表示整形
├── components/
│   ├── RecordingIndicator.tsx    録音中の常時表示(プライバシー要件)
│   ├── ConnectionStatus.tsx      接続状態と受信統計
│   ├── Transcript.tsx            リアルタイム文字起こし
│   ├── Documents.tsx             生成されたMarkdown(タブ切り替え)
│   ├── TriggerConfirm.tsx        明示承認の確認UI
│   ├── Artifact.tsx              生成の進捗・URL・QRコード
│   ├── ErrorNotice.tsx           権限拒否・失敗の通知
│   └── ClipPlayer.tsx            録音結果のローカル再生
├── recorder/
│   ├── types.ts                  状態・イベント・ブラウザAPIの抽象
│   ├── machine.ts                状態遷移(純粋関数)
│   ├── browserAudioSource.ts     getUserMedia / MediaRecorder への唯一の依存点
│   └── useRecorder.ts            React hook。上記を束ねる
├── transcript/
│   └── merge.ts                  確定 / 未確定 / backlog の統合(純粋関数)
├── documents/
│   ├── markdown.ts               最小限のMarkdown解釈と表示名(純粋関数)
│   └── useDocuments.ts           document.updated を受けて本文を取り直す
├── qr/
│   └── encode.ts                 QRコードの符号化(純粋関数)
└── gateway/
    ├── backoff.ts                再接続の待ち時間(純粋関数)
    ├── offlineBuffer.ts          切断中の音声バッファ(最大60秒)
    ├── GatewayClient.ts          WebSocket接続・再接続・バッファ送出
    ├── sessionApi.ts             HTTP API クライアント
    └── useGateway.ts             React hook。セッション作成〜接続を束ねる
```

`components/ConnectionStatus.tsx` に `data-session-id` を出している。
動作確認とサポート問い合わせのため。トークンではないので画面に出しても安全。

### 設計方針

- **状態遷移をブラウザAPIから分離する。** `machine.ts` は純粋関数で、
  `MediaRecorder` を知らない。テストはブラウザなしで走る。
- **ブラウザAPIに触れるのは `browserAudioSource.ts` だけ。**
  Sprint 2 で音声をWebSocketへ流す際も、ここより上の層は変えなかった。
- **不正なイベントは無視する。** 呼び出し側が状態を確認せずに
  `pause()` を呼んでも壊れない。
- **録音と通信を分離する。** `useRecorder` はチャンクを `onChunk` で渡すだけで、
  送信先を知らない。Sprint 3 で文字起こしを足すとき、録音側は変更しない。
- **通信プロトコルの型は `@rt-mvp/protocol` で共有する。**
  クライアントとサーバーで別々に定義しない。正本は ARCHITECTURE.md。
- **Markdownの描画は自前で最小限に留める。** 汎用ライブラリを入れない。
  顧客の目の前に出る画面に、想定外の描画をさせないため。
  扱うのは DATAFLOW.md のスキーマに出てくる要素だけ(見出し・箇条書き・チェックリスト・段落)。
- **外部API(STT / LLM)の停止は、セッションのエラーと区別する。**
  録音と送信は続いているため、赤いエラー表示にはしない。
  該当のパネルに「停止しています」と出すに留める。
- **QRコードは自前で作る。** 外部のQR生成サービスへURLを送れば、
  商談内容から作られたURLを外へ出すことになる。
  `qr/encode.ts` は純粋関数で、書いたものを読み返す試験で符号化を検証している。
- **確認UIに自動承認を置かない。** タップされるまで生成は始まらない。
  カウントダウンで勝手に進むと、雑談で商談画面が切り替わる。

## 音声フォーマット

`audio/webm;codecs=opus` を優先する(REQUIREMENTS.md の通信要件:
圧縮音声でモバイル回線に収める)。Safari は WebM 非対応のため
`audio/mp4` へフォールバックする。選択順は `browserAudioSource.ts` の
`PREFERRED_MIME_TYPES` を参照。

## 音声の扱い

録音した音声は **この端末のメモリ上にのみ存在する**。
サーバーへは送信せず、ディスクにも保存しない。
「破棄する」または再読み込みで Object URL ごと解放される。
