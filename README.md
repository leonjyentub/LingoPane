# LingoPane

[繁體中文](README.md) | [English](README.en.md)

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
- 依頁串行處理的跨頁翻譯佇列、進度顯示與停止後續頁面
- 翻譯文字區塊的基礎溢位偵測與自動縮字
- 可在設定中切換 PDF.js 快速分析或 Docling standard pipeline 增強分析
- Docling runtime 探測、版本化分析契約、左上原點座標正規化與 PDF.js 自動 fallback
- Docling 標題、段落、圖說與表格區塊已可接入既有翻譯與 overlay 流程
- Docling 以目前頁優先的 5 頁批次分析；每批完成即可使用，並可真正終止目前 worker
- SQLite 持久化逐頁 PDF.js／Docling 版面與翻譯結果，重新開啟同一文件可直接還原
- 文件快取預設保留最近 30 份，可在「文件分析設定」調整為 1–500 份；不保存原始 PDF

尚待完成的主要項目是真正中止已送出的後端 HTTP 請求、縮到最小字級後仍溢位的顯式告警，以及更完整的雙欄／表格版面自動化測試。

## Docling 版面分析整合 Roadmap

### 目標與技術決策

LingoPane 正在將 [Docling](https://github.com/docling-project/docling) 整合為「可選的增強分析層」，用來改善雙欄論文、表格、圖說、頁首／頁尾、掃描頁與複雜閱讀順序的辨識。現有 PDF.js 流程仍負責即時預覽、原生文字與精確座標，oMLX、Ollama 或其他 OpenAI 相容端點則只負責本地文字翻譯。

預定原則：

- 不以 Docling 取代 PDF.js 渲染，而是合併兩者的優點。
- 只使用 Docling 官方 Python runtime 的 standard pipeline，包含 PDF parser、layout、table structure 與 OCR。
- 不嘗試把 Heron、TableFormer 或其他 Docling 模型轉成 oMLX 格式，也不讓 oMLX 承擔文件分析。
- 只對掃描頁、文字層損壞或低信心版面使用 Docling 的選擇性 OCR。
- Docling 與模型必須可在本機執行；不默認將 PDF 送往雲端服務。
- 不整合 MarkItDown。它的 Markdown 輸出難以穩定對應回 PDF 座標，與目前「保留原版面翻譯」的核心需求不符。
- 在驗證品質改善前，不將 Python、PyTorch 與所有 Docling 模型直接打包進主 App DMG。

### 預計架構

```text
本機 PDF
├─ PDF.js：即時渲染、原生文字、字形遮罩與精確座標
└─ Docling worker：閱讀順序、區塊類型、階層、表格、OCR 與信心度
       │
       └─ Rust layout adapter：座標正規化與 PDF.js / Docling 對齊
              │
              └─ Translation Units：標題、段落、圖說、表格儲存格與上下文
                     │
                     ├─ oMLX / Ollama：本地翻譯
                     ├─ SQLite：分析與翻譯快取
                     └─ React overlay：依原始座標呈現翻譯
```

LingoPane 會建立自有的版本化 `DocumentAnalysis` 格式，不讓 React 直接依賴 Docling JSON schema。每個分析區塊至少包含文件 hash、頁碼、區塊類型、文字、閱讀順序、左上原點 bounding box、階層關係、信心度與是否可翻譯。穩定 ID 將由 PDF hash、analyzer/model 版本、頁碼、區塊參照與正規化文字組成。

### TODO 與驗收條件

#### 1. 建立版面基準測試集

- [ ] 收集可重複測試的單欄、雙欄、跨欄標題、表格、圖說、公式與掃描 PDF。
- [ ] 為閱讀順序、區塊類型、表格儲存格與不可翻譯區域建立人工確認的 golden data。
- [ ] 建立 PDF.js 現有規則與 Docling standard pipeline 的比較報告。

驗收：每次版面算法變更都能自動顯示閱讀順序、區塊分類、表格完整度與文字遺漏的差異。

#### 2. Docling prototype 與本機服務邊界

- [x] 以最小 Python worker 建立獨立 prototype，避免 React 直接依賴 Docling API。
- [x] 加入 runtime probe、Python／Docling／worker／schema 版本回報。
- [x] 使用 standard pipeline，啟用 layout 與 table structure，並讓 OCR 可由設定開關控制。
- [x] 加入 analysis ID、目前頁優先的 page-range 批次、逐批進度事件與真正終止 worker。
- [ ] 將首次模型下載／載入與文件分析拆成更細的進度狀態。
- [ ] 記錄分析時間、峰值記憶體、模型下載量與失敗原因。

驗收：在 Apple Silicon Mac 上可全程離線分析測試 PDF，並回傳含頁碼、類型、文字、閱讀順序與 bounding box 的版本化 JSON。

#### 3. Rust adapter 與座標融合

- [x] 定義版本化 `DocumentAnalysis`、`AnalyzedPage` 與 `AnalyzedItem` schema。
- [x] 將 Docling 的 `TOPLEFT` / `BOTTOMLEFT` 座標統一為 PDF.js 使用的左上原點座標。
- [ ] 以頁碼、文字正規化與幾何重疊對齊 PDF.js text items 與 Docling items。
- [x] 將 Docling 區塊縮放到 PDF.js page viewport，並在 Docling 不可用時自動改用 PDF.js fallback。
- [ ] 加入低信心配對、跨來源文字對齊與衝突解決。

驗收：切換「快速」與「Docling 增強」模式時不影響 PDF 渲染與雙向同步捲動，且翻譯區塊可穩定對齊原始頁面。

#### 4. 以文件結構重建翻譯單元

- [ ] 依閱讀順序組合同段落的跨行文字，並支援跨頁段落。
- [ ] 將 section heading、前後段落、圖說與表格欄名當作翻譯上下文，但只回傳指定區塊 ID。
- [x] 表格改為逐儲存格翻譯，保留 row/column span、header、原始表格線與每格文字位置。
- [ ] 補齊數字、單位、公式不可變規則，以及從 PDF 向量線取得更精確的 cell 邊界。
- [ ] 排除頁首、頁尾、公式、裝飾文字與純數字區塊。

驗收：雙欄內容不會跨欄誤合併，表格不會被展平成無結構段落，且模型不能新增、刪除或更改區塊 ID。

#### 5. 快取、工作佇列與真正取消

- [x] 以 SQLite 分開儲存 PDF.js／Docling 逐頁分析版面與翻譯結果，並以最近使用順序限制文件數量。
- [x] 快取 key 納入 PDF SHA-256、版面 schema、分析模式、OCR 開關、翻譯服務、模型、語言對與 prompt 版本。
- [ ] 將 Docling runtime 與官方 layout／table model 的實際版本加入自動失效條件。
- [ ] 統一分析與翻譯 job queue，支援頁級進度、重試、優先順序與失敗恢復。
- [x] 取消 Docling 分析時送出 `SIGTERM`，真正終止目前 Python worker。
- [ ] 取消翻譯時真正終止 reqwest HTTP request，不只是忽略回傳結果。

驗收：重新開啟同一份 PDF 不需重複分析或翻譯；更換模型、語言或分析 schema 時只失效相關快取；取消後本機後端不再繼續佔用運算資源。

#### 6. 選擇性 OCR

- [ ] 以頁面原生文字量、版面信心度與分析異常自動判斷是否需要 OCR。
- [ ] 使用 Docling standard pipeline 支援的本地 OCR，並只處理需要的頁面。
- [ ] 保留 OCR 結果、信心度與原始頁圖的可追溯關係。

驗收：原生文字 PDF 不會無故啟動 OCR；掃描 PDF 能產生可翻譯且可映射回頁面的文字區塊；所有流程可在本機離線執行。

#### 7. macOS 發佈與模型生命週期

- [ ] 在 prototype 驗證後決定提供「使用者自管 Docling service」或「LingoPane 管理的可下載 sidecar」。
- [ ] 如提供 sidecar，將 Python runtime、Docling 套件與模型儲存在版本化的 Application Support / Cache 目錄，不直接膨脹主 App bundle。
- [ ] 加入下載大小、磁碟空間、模型版本、更新、移除、license attribution 與離線狀態介面。
- [ ] 將 sidecar 與資源納入 codesign、notarization 與完整卸載測試。

驗收：未啟用 Docling 的使用者不需下載大型依賴；啟用後可由 App 清楚管理引擎與模型狀態，且不破壞 macOS 簽章、公證與離線使用。

### 預期成果

完成上述 roadmap 後，LingoPane 預期能達成：

- 簡單 PDF 保持現有快速開啟體驗，複雜 PDF 可選擇更高品質的 Docling 增強分析。
- 顯著降低雙欄跨欄誤合併、頁首／頁尾誤翻譯、圖說錯位與表格展平等問題。
- 翻譯模型可取得章節、段落、表格欄名與圖說上下文，提升術語一致性與跨頁連貫性。
- 掃描文件可在本機透過 Docling OCR 轉成可翻譯且可對齊的內容。
- 分析與翻譯結果可重複使用、可版本化失效、可真正取消，並能透過基準測試防止版面回歸。
- PDF 內容、分析、OCR 與翻譯維持 local-first，使用者可明確選擇所使用的本地引擎與模型。

### 使用目前的 Docling prototype

Docling 是選用依賴，不會隨一般的 `npm ci` 安裝。建議先安裝 [uv](https://docs.astral.sh/uv/)，再依鎖定檔建立獨立 Python runtime：

```bash
brew install uv
uv sync --project tools/docling-runtime --frozen

# 驗證 Python、Docling、worker 與 schema 版本
tools/docling-runtime/.venv/bin/python tools/docling_worker.py --probe
```

在 LingoPane 的「文件分析設定」頁選擇「Docling 增強（獨立 Python worker）」。Python 路徑建議留白，App 會依序尋找 `LINGOPANE_DOCLING_PYTHON`、Application Support 內的受管理 runtime、App Resources 內的 runtime、專案的 `tools/docling-runtime/.venv/bin/python`，最後才嘗試系統 Python。若需要覆寫，也可填入專案 runtime 的絕對路徑：

```text
/path/to/LingoPane/tools/docling-runtime/.venv/bin/python
```

第一次分析會由 Docling 下載官方 layout／table 模型，時間與磁碟用量會高於後續分析；模型備妥後可在本機離線使用。若 runtime 缺失或分析失敗，App 會保留 PDF 渲染並自動回退到 PDF.js 快速分析。

可用下列指令驗證 bridge 契約與真實 standard pipeline：

```bash
python3 -m unittest discover -s tools/tests -v

# 重新產生固定的雙欄／表格 fixture
python3 tools/tests/make_docling_fixture.py

# 首次執行可能下載官方模型；不加 --ocr 可避免對原生文字 PDF 啟動 OCR
tools/docling-runtime/.venv/bin/python tools/docling_worker.py \
  --input tools/tests/fixtures/docling-two-column-table.pdf
```

目前 prototype 會透過 Tauri IPC 將 PDF bytes 傳給 Rust，再建立暫存檔交給文件級 Python worker，單檔上限為 200 MB。worker 在同一份文件內只建立一次 Docling converter，預設以 5 頁為一批，優先分析目前頁所在批次，再處理相鄰批次；每批結果會立即送回 React 並寫入 SQLite。正式發佈前仍需完成模型下載進度、Docling 實際模型版本失效、逐頁 OCR 判斷，以及以原生檔案路徑降低大型 PDF 的記憶體成本。

## 開發環境

需求：

- Node.js 與 npm
- Xcode Command Line Tools
- Rust stable 與 Cargo

先檢查現有環境：

```bash
node --version
npm --version
rustc --version
cargo --version
xcode-select -p
```

若尚未安裝，可使用 Homebrew 與 `rustup`：

```bash
xcode-select --install
brew install node rustup

export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
rustup-init -y
rustup default stable
```

安裝完成後請重新開啟 Terminal，再確認上述版本指令皆可正常執行。

## 從 GitHub 全新安裝

```bash
git clone <repository-url>
cd LingoPane

# 嚴格依照 package-lock.json 安裝 React、Vite 與 Tauri CLI 等套件
npm ci

# 選用：預先下載 Cargo.lock 指定的 Rust 套件
cargo fetch --locked --manifest-path src-tauri/Cargo.toml
```

`cargo fetch` 可以省略，第一次開發或打包時 Cargo 也會自動下載所需套件。已有 `package-lock.json` 時建議使用 `npm ci`；只有在新增或更新依賴時才使用 `npm install`。

### 產生 App 圖示

專案已將 Tauri 打包必需的圖示納入 Git。如果更新了圖示主檔，可從無外圍留白的滿版主圖重新產生 `.icns`、`.ico` 與 PNG：

```bash
npm run icons
```

圖示來源是 `assets/app-icon-master.png`，產生結果位於 `src-tauri/icons/`。`npm run bundle:mac` 與 `npm run bundle:mac:app` 都會在打包前自動重新產生圖示。

## 開發模式

```bash
npm run tauri dev
```

若 Rust 是由 Homebrew 的 `rustup` 安裝，但 Terminal 尚未找到 `cargo`，可使用：

```bash
PATH="/opt/homebrew/opt/rustup/bin:$PATH" npm run tauri dev
```

## 建置前驗證

```bash
# TypeScript 檢查與 Vite production build
npm run build

# Rust 格式檢查
PATH="/opt/homebrew/opt/rustup/bin:$PATH" \
  cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

`tauri build` 會透過 `beforeBuildCommand` 再執行一次 `npm run build`，因此直接打包時不一定需要先單獨執行這個前端建置指令。

## 打包 macOS App 與 DMG

### 同時建立 release App 與 DMG

沒有 Apple Developer 憑證、只需安裝在本機時，可使用 ad-hoc 簽章：

```bash
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"

APPLE_SIGNING_IDENTITY="-" \
  npm run bundle:mac
```

專案的 `src-tauri/tauri.conf.json` 已設定 `bundle.targets` 為 `all`，所以也可以簡寫為：

```bash
APPLE_SIGNING_IDENTITY="-" npm run tauri build
```

release 產物位於：

```text
src-tauri/target/release/bundle/macos/LingoPane.app
src-tauri/target/release/bundle/dmg/LingoPane_0.1.0_aarch64.dmg
```

### 只建立 App

```bash
APPLE_SIGNING_IDENTITY="-" \
  npm run bundle:mac:app
```

### 只建立 DMG

```bash
APPLE_SIGNING_IDENTITY="-" \
  npm run tauri build -- --bundles dmg
```

### 建立 debug 版本

```bash
APPLE_SIGNING_IDENTITY="-" \
  npm run tauri build -- --debug
```

debug 產物會輸出到 `src-tauri/target/debug/bundle/`。debug 版本適合排錯；日常安裝與測試建議使用 release 版本。

## 驗證與安裝 App

先驗證建置後的 App bundle：

```bash
APP="src-tauri/target/release/bundle/macos/LingoPane.app"

codesign --verify --deep --strict --verbose=2 "$APP"
```

如果本機版本顯示 bundle 簽章不完整，可重新套用 ad-hoc 簽章後再驗證：

```bash
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
```

直接安裝到 `/Applications`：

```bash
sudo ditto "$APP" "/Applications/LingoPane.app"
open "/Applications/LingoPane.app"
```

也可以開啟 DMG，再將 App 拖進 Applications：

```bash
open src-tauri/target/release/bundle/dmg/*.dmg
```

## 簽章與對外發布

`APPLE_SIGNING_IDENTITY="-"` 產生的是本機 ad-hoc 簽章，適合在自己的 Mac 上開發、測試與安裝，不等同於 Apple 正式簽章。若要將 App 或 DMG 發送給其他使用者，需要：

- Apple Developer Program 帳號
- Developer ID Application 憑證
- 以 Developer ID 進行 codesign
- 送交 Apple notarization 並 staple 公證結果

缺少正式簽章與公證時，其他 Mac 上的 Gatekeeper 可能會阻擋 App。
