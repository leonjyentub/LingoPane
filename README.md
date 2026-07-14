# LingoPane — Local PDF Translator

以原文與翻譯並排閱讀為核心的 macOS PDF 閱讀器。應用程式使用 Tauri 2、React、TypeScript 與 PDF.js，目標是連接 oMLX、Ollama 或任何 OpenAI 相容端點，在本機保留 PDF 原有版面並同步閱讀位置。

## 目前進度

- 開啟並解析本機 PDF
- PDF 頁面延遲渲染，避免一次繪製整份文件
- 左側原文、右側翻譯版面骨架
- 可拖曳中央分隔線
- 頁碼跳轉、上一頁、下一頁與 50–200% 縮放
- 以「頁碼＋頁內位置」進行雙向同步捲動
- oMLX、Ollama 與通用 OpenAI 相容端點設定介面
- 來源與目標語言設定
- 從 `/v1/models` 讀取模型與測試連線
- 透過 `/v1/chat/completions` 翻譯目前頁面
- API Key 儲存在 macOS Keychain，不寫入 localStorage
- PDF 文字依行距、欄位與字級分組為穩定區塊 ID
- 翻譯結果依原始座標覆蓋，保留頁面圖片、表格線與背景
- 翻譯回應格式與區塊 ID 驗證

下一階段會加入跨頁翻譯工作佇列、真正中止後端請求、SQLite 翻譯快取、文字溢位偵測與更完整的雙欄／表格版面測試。

## 開發

需求：Node.js、Xcode Command Line Tools、Rust stable。

```bash
npm install
npm run tauri dev
```

若 Rust 是由 Homebrew 的 `rustup` 安裝，可使用：

```bash
PATH=/opt/homebrew/opt/rustup/bin:$PATH npm run tauri dev
```

## 驗證與打包

```bash
npm run build
PATH=/opt/homebrew/opt/rustup/bin:$PATH cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
PATH=/opt/homebrew/opt/rustup/bin:$PATH npm run tauri build -- --debug
```

debug App 與 DMG 會輸出到 `src-tauri/target/debug/bundle/`。
