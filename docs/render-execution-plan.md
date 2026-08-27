# LingoPane 渲染管線執行方案（接手用）

> 建立日期：2026-08-27
> 設計理由與取捨：見 [`render-architecture-decision.md`](./render-architecture-decision.md)
> **本文件是操作入口。** 接手時先讀第 1、2 節，再從第 4 節的 PR-1 開始按序執行。

---

## 0. 這份文件怎麼用

- 第 4 節的任務**必須按編號順序執行**，PR 之間有硬依賴（第 3 節有依賴圖）。
- 每個任務都有「檢核條件」，是**可執行的指令或可觀察的結果**，不是「看起來對」。
- 第 5 節是**已實測驗證的技術事實**，直接採用，不要重新推測。
- 第 6 節是**明確不在範圍內**的事，不要順手做。

---

## 1. 環境與驗收指令（已在開發機實測可用）

```bash
# Rust 指令一律需要這個 PATH 前綴
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
```

| 指令 | 用途 |
|---|---|
| `npm run build` | TypeScript 檢查 + Vite production build |
| `npm run test:fixtures` | Node fixture 測試 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Rust 單元測試 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Rust 格式檢查 |
| `tools/docling-runtime/.venv/bin/python -m unittest discover -s tools/tests -v` | Python 測試（**用 venv 的 python，不要用系統 python3**） |
| `npm run tauri dev` | 實機驗證 |

實測環境：cargo 1.97.0 / node v24.16.0 / venv Python 3.13 / PyMuPDF 1.28.0 (MuPDF 1.29.0)。
系統 `python3` 是 3.14.4 且**沒有 docling 與 PyMuPDF**，測試一律走 `tools/docling-runtime/.venv/bin/python`。

**每個 PR 合併前必須全套跑過。**

---

## 2. 全域注意事項（每個任務都適用）

### 2.1 快取失效是隱形地雷

任何改動 layout 結構或 prompt 內容的任務，**必須同時 bump 快取 key**，否則會讀到舊格式資料而行為詭異：

- 改 `PdfPageLayout` / `PdfTextBlock` 結構 → `App.tsx:136` 的 `layout-v5` 往上加
- 改翻譯 system prompt 或分批策略 → `App.tsx:142` 的 `translationCacheKey` 的 `version: 1` 往上加

改完後在「設定 → 資料與快取 → 清除資料庫快取」實測一次，確認舊資料不會命中。

### 2.2 三條取消序號互相獨立，不要合併

`analysisRunRef`（Docling 分析）、`translationJobsRef`（逐頁翻譯）、`batchJobRef`（整份批次）是三條獨立的 job 序號，語意不同：

- `analysisRunRef` 遞增 = 放棄目前分析結果
- `translationJobsRef[page]` 換號 = 放棄該頁翻譯
- `batchJobRef` 遞增 = 中止整份批次迴圈

看起來重複，但合併會破壞「取消整份批次但保留已完成頁面」的行為。**Phase 2.5 改動翻譯層時不要動這三條的結構。**

### 2.3 座標系

PDF.js `getViewport({scale:1})` 與 PyMuPDF `page.rect` **都是左上原點、y 向下**，所以直接傳遞 `left/top` 目前是對的。但頁面帶 `/Rotate` 或 CropBox 原點非 (0,0) 時會分歧。Python 端一律加斷言：

```python
if abs(page.rect.width - plan_page["width"]) > 1 or abs(page.rect.height - plan_page["height"]) > 1:
    raise ValueError(f"第 {n} 頁座標系不一致：plan {w}x{h} vs page {page.rect}")
```

**明確報錯，不要靜默錯位。**

### 2.4 不要動 `pdfLayout.ts` 的啟發式規則

那 526 行沒有回歸測試，magic number 彼此連動。**在 3C-1（golden fixture）就位之前，只允許重新命名與提取常數，不允許改動判斷邏輯。**

### 2.5 macOS 專屬

`keyring`（apple-native）、`/bin/kill`、`libc::kill`、`titleBarStyle: Overlay`、`start_window_drag` 都是 macOS 專屬。新增程式碼不要假設跨平台，也不要順手「修正」成跨平台寫法。

---

## 3. 執行順序與依賴

```
PR-1  Phase 0     修好匯出（9 項）           ← 使用者可見的 bug，最優先
  │
PR-2  Phase 3A    工程基礎（CI / lint / 常數）← 之後每個 PR 都受惠
  │
PR-3  Phase 1     單一契約（刪 unifiedIR / babeldoc）
  │
PR-4  Phase 2.5   翻譯穩健性                 ← PR-5 的硬依賴
  │
PR-5  Phase 2 前半 planner + bilingual        ← planner 正確性驗證點
  │
PR-6  Phase 2 後半 adaptive + obstacle 繞行
```

**可隨時穿插、彼此無依賴**：3B（效能）、3C（版面品質，3C-1 必須先於 3C-2~5）、3D（清理）。

---

## 4. 逐項任務

### PR-1 ── Phase 0：修好匯出

> **現況：使用者點「匯出」的預設路徑 100% 失敗。** 這個 PR 不動架構，只讓匯出能用。

| # | 任務 | 檔案 | 注意細節 | 檢核條件 |
|---|---|---|---|---|
| 0-1 | 移除 `BABELDOC_SOURCE`，三種模式一律導向 `pdf_renderer.py`；後者接受 `--mode` 但暫時只實作 `faithful`，其餘回傳明確中文錯誤 | `renderer.rs:10,154-157`、`pdf_renderer.py:146` | **根因**：`renderer.rs:161` 無條件傳 `--mode`，但 `babeldoc_worker.py` 的 argparse 沒定義它 → exit 2 | 三種模式都不再 crash；未實作者顯示中文錯誤而非 argparse 訊息 |
| 0-2 | `ExportDialog` 只開放 `faithful`，其餘 `disabled` 並標「開發中」 | `ExportDialog.tsx:50-76` | 同時把 `App.tsx:230` 的 `selectedRenderMode` 預設改為 `"faithful"` | 選不到會失敗的模式 |
| 0-3 | 修 `enhancedLayouts` 空洞：`onLayoutResolved` 除了寫 SQLite 也要 `setEnhancedLayouts` | `App.tsx:1195-1206` | **根因**：`cacheResolvedLayout()` 只 `invoke("save_cached_layout")`，從不更新 state → fast 模式首開時 `enhancedLayouts === {}` → `exportPdf` 跳過全部頁面。第二次開啟因快取已建立而正常，所以呈現為「時好時壞」 | 全新文件 + fast 模式 + 翻譯一頁 → 匯出成功（不再報 `noTranslationsToExport`） |
| 0-4 | `apply_redactions()` 移出迴圈改每頁一次，並帶 `images` 與 `graphics` 參數 | `pdf_renderer.py:99-100` | **見第 5.1 節**：預設 `graphics=1` 會清掉被矩形碰到的向量線 → **表格框線會消失**。這與專案「保留表格線」的核心需求直接衝突 | 含表格的頁面匯出後框線完整；10 頁文件匯出時間明顯下降 |
| 0-5 | redaction 改用 `layout.textRects`（逐 text-item 緊密框）而非合併後的 block bbox | `App.tsx:1116-1131`、`pdf_renderer.py` | 螢幕上的 `source-text-mask`（`TranslationPage.tsx:195`）已經正確用 `textRects`，匯出卻沒有 —— 直接沿用同一份資料 | 匯出頁的欄間留白與表格線不再被白塊覆蓋 |
| 0-6 | 修 `_find_cjk_font()` 與 `min_font_scale` 死碼 | `pdf_renderer.py:29-41,105-106` | **見第 5.2 節**：`PingFang.ttc` 在本機**不存在**，`fontfile` 路徑全部落空。改為**直接使用內建 `china-t`，完全不用 `fontfile`**。另 `max(s*0.9, s*0.85)` 恆等於 `s*0.9`，下限永遠不生效 | 匯出 PDF 的嵌入字型為 `Fangti`；繁體字可正確取回 |
| 0-7 | 匯出改為 Rust 寫檔 + `tauri-plugin-opener` 開啟 | `App.tsx:1150-1156`、`renderer.rs` | 現行 `link.download` 在 WKWebView 不可靠，且 `URL.revokeObjectURL()` 同步緊接在 `click()` 後可能中斷寫入。已有 `tauri-plugin-opener` 依賴，寫到 `~/Downloads/` 後開啟即可 | 匯出後檔案確實落地並自動開啟 |
| 0-8 | `settings.renderMode` 與 `selectedRenderMode` 合一 | `App.tsx:230,1570,1590` | 目前設定視窗的下拉選單**只寫不讀**，匯出實際走獨立 state | 設定視窗選的模式即匯出預設值 |
| 0-9 | `renderModeHelp` 拆成三個獨立 i18n key | `i18n.ts:323`、`ExportDialog.tsx:46,60,74` | 現行用 `.split(".")[n]` 拆句子，標點一改就錯位 | 說明文字不再依賴字串切割 |

**PR-1 整體驗收**：開啟全新 PDF → fast 模式 → 翻譯 2 頁 → 匯出 faithful → 產出 PDF 中譯文正確、表格線完整、圖片未被挖除、繁體字正常。

---

### PR-2 ── Phase 3A：工程基礎

> 先做這個，之後每個 PR 都有自動驗證。

| # | 任務 | 檢核條件 |
|---|---|---|
| 3A-1 | 加 CI（GitHub Actions）：第 1 節全套指令 | push / PR 觸發，全綠 |
| 3A-2 | 加 ESLint + Prettier（目前完全沒有） | `npm run lint` 可執行且通過 |
| 3A-3 | `2022_Ito_Sentence_Embedding_Emotion_Recognition.pdf`（1.8 MB）移至 `tools/tests/fixtures/` | repo 根目錄無測試資料 |
| 3A-4 | 統一 `MAX_PDF_BYTES`：`files.rs:5`（512 MB）/ `docling.rs:14`（200 MB）/ `llm.rs:428`（字元上限），集中成單一常數模組 | 三處引用同一常數 |
| 3A-5 | `tauri.conf.json` 的 `security.csp: null` 改為 `default-src 'self'; connect-src 'self' http://localhost:* http://127.0.0.1:*` | App 功能正常且 CSP 生效 |

> 3A-5 注意：翻譯請求是由 **Rust 後端**送出，不是前端 fetch，所以 `connect-src` 收緊不會擋到翻譯。若實測有問題，先確認是否有前端直連。

---

### PR-3 ── Phase 1：單一渲染契約

| # | 任務 | 檔案 | 注意細節 | 檢核條件 |
|---|---|---|---|---|
| 1-1 | **刪除 `src/lib/unifiedIR.ts`** | — | 全檔 382 行從未被 import。其中 `mergeDoclingIRIntoPdfLayout()` 是**第三套** Docling 合併實作（另兩套是 `mergeDoclingPage`、`alignBlockToPdfText`），留著是陷阱 | `npm run build` 通過；`grep -r unifiedIR src` 無結果 |
| 1-2 | 新增 `src/lib/renderPlan.ts`，`exportPdf()` 改為呼叫 `buildRenderPlan()` | `App.tsx:1103-1162` | schema 見決策文件第三節。**譯文內嵌進 block，不再另傳 `translations` map**。`kind` 沿用既有 6 種，不要再做第二套 type 對照表 | `exportPdf` 內無匿名物件字面值 |
| 1-3 | `renderer.rs` 的 `RenderRequest` 對齊新 schema（單一 `plan` 欄位） | `renderer.rs:13-51` | `cargo test` 通過 | 序列化欄位與 TS 型別一致 |
| 1-4 | **刪除 `tools/babeldoc_worker.py`** | — | 其 `_compute_column_regions()` 算完從未被使用，實際行為與 faithful 相同 | `renderer.rs` 只剩一個 `include_str!` |
| 1-5 | 抽 `src-tauri/src/python_runtime.rs`：`python_candidates()` + 探測結果 `OnceLock` 快取 | 新檔 + `docling.rs:138`、`renderer.rs:53` | 兩處各約 55 行幾乎逐字重複 | 重複碼消失；連續兩次匯出，第二次無 Python 探測開銷 |
| 1-6 | 移除死指令 `cancel_pdf_render`、`test_connection`（或前端接上） | `lib.rs:28,32` | 兩者已註冊但前端從不呼叫 | 無未使用的 `#[tauri::command]` |
| 1-7 | Python 端加座標系斷言 | `pdf_renderer.py` | 見第 2.3 節 | 帶 `/Rotate` 的 PDF 明確報錯而非錯位 |

---

### PR-4 ── Phase 2.5：翻譯穩健性

> **這是 PR-5 的硬依賴，不能跳過。**
> 原因：`buildRenderPlan()` 會略過沒有譯文的 block。`faithful` 模式下無害（原文留著）；但在 **`adaptive` / `bilingual` 的重排流程中，缺譯文的段落會直接消失、後續段落往上遞補 —— 內容靜默遺失且無從察覺**。

現況（`llm.rs:436-492`）：整頁所有 block 打包成一個 JSON，要求模型「每個 id 剛好回傳一次、順序完全相同」，數量或 id 不符即整頁 `Err`。本地 12B 以下模型難以穩定達成。

| # | 任務 | 檔案 | 檢核條件 |
|---|---|---|---|
| 2.5-1 | 分批：以字元預算切塊（~2000 字元或 20 blocks 先到者為準），沿用 `translate_with_translate_gemma` 既有的 `buffer_unordered(3)` 併發模式 | `llm.rs:412-498` | 400 block 的頁面不再直接報「區塊過多」 |
| 2.5-2 | 驗證改為**以 id 比對**，不再比對數量與順序；未知 id 丟棄 | `llm.rs:477-492` | 模型改變順序時不再整頁失敗 |
| 2.5-3 | 缺 id 補譯：該批缺漏的 id 重試該子集（上限 2 次），仍缺者退為單 block 請求 | `llm.rs` | 人工模擬漏回 3 個 id，最終仍取得完整譯文 |
| 2.5-4 | 部分失敗不再是整頁失敗：仍缺者回空字串 + `missingIds: Vec<String>` | `llm.rs`、`TranslationResult` | 回傳結構含 `missingIds` |
| 2.5-5 | 前端 `TranslationStatus` 新增 `"partial"`，標示未譯區塊 | `TranslationPage.tsx:7`、`App.tsx` | 部分失敗頁可正常閱讀已譯內容 |
| 2.5-6 | planner 新增 `on_missing_translation` 策略：`keep_source`（預設，保留原文不 redact）/ `placeholder` / `skip` | `renderPlan.ts`、`pdf_renderer.py` | 缺譯文的段落在匯出 PDF 中**不會靜默消失** |
| 2.5-7 | prompt 版本納入 `translationCacheKey` | `App.tsx:142-151` | 改 prompt 後舊快取不再命中 |

> **取消行為不受影響**：`Abortable` 包在最外層（`llm.rs:529`），分批後仍整體可取消。改動時保持這個包裹位置。

---

### PR-5 ── Phase 2 前半：Flow Planner + bilingual

> **刻意先做 `bilingual`**：它是 planner 的最小可用子集（要量測、排版、溢位換頁，但**不需要 obstacle 繞行、不需要 redaction**），可在不受 redaction 品質干擾的情況下驗證整條管線。

| # | 任務 | 注意細節 | 檢核條件 |
|---|---|---|---|
| 2-1 | `wrap()` 斷行器：`pymupdf.Font.text_length()` 逐字元累加 | **見第 5.3 節**：CJK:Latin 實測寬度比 ≈ 1.85:1。現行 `chars_per_line = width / (fontSize * 0.55)` 對中文**低估 1.82 倍行數** —— 這就是譯文溢位的直接數學原因。CJK 可任意斷行，但不得在行首禁則字元前斷：`。，、；：？！）」』》〉】…—～%` | pytest：純英 / 純中 / 中英混排 / 含禁則標點，行數與寬度符合預期 |
| 2-2 | `detect_columns()` 間隙分群（取代 `pageWidth / 2`） | 演算法見決策文件 4.3。偵測結果 N > 4 或任一欄寬 < `page_width * 0.15` → 判定不可靠，退回單欄 | pytest：`fixtures/docling-two-column-table.pdf` → 2 欄；單欄 PDF → 1 欄 |
| 2-3 | Policy 表 + `ModeConfig`（自 `unifiedIR.ts` 移植） | 見決策文件 4.2。注意 `caption` 是 `pin=True`（圖說必須跟著圖，不流動） | 單元測試涵蓋 6 種 kind × 3 種 mode |
| 2-4 | **`bilingual` 模式**：原頁原封不動複製 + 其後插入譯文頁 | 譯文頁 = 同尺寸空白、`use_obstacles=False`、整頁可用、僅 flowables | 頁數 = 2 × 原頁數（+續頁）；譯文頁無溢位、無截斷 |
| 2-5 | 續頁邏輯 + `MAX_CONTINUATION_PAGES = 3` | 超過 3 頁代表版面偵測失敗 → **放棄該頁 reflow、退回 faithful**，stderr 記錄頁碼。不要無限增頁 | 人工塞入超長譯文，確認產生續頁且有上限 |

---

### PR-6 ── Phase 2 後半：adaptive

| # | 任務 | 注意細節 | 檢核條件 |
|---|---|---|---|
| 2-6 | `skip_obstacles()`：`[cursor, cursor+h)` 與 pinned 區間 y 相交且 x 重疊 > 40% → `cursor = obstacle.bottom + gap` 後重試 | 加迴圈次數上限防死迴圈 | 雙欄論文匯出：圖 / 表 / 公式位置不變，段落不跨欄、不壓到圖上 |
| 2-7 | `adaptive` 模式接上 | 見決策文件 4.5 排版主迴圈 | — |
| 2-8 | `faithful` 改由同一 planner 驅動（`allow_reflow=False`） | 這是回歸點：輸出應與 PR-1 的 faithful 視覺一致 | 與 PR-1 產物比對無明顯差異 |
| 2-9 | `ExportDialog` 開放全部三種模式，並標示「匯出採重排排版，與畫面預覽不同」 | 見決策文件第六節：螢幕與匯出的落差是**刻意保留**的 | 三種模式皆可成功匯出 |

---

## 5. 已實測驗證的技術事實

> 以下為在開發機（PyMuPDF 1.28.0 / MuPDF 1.29.0）實際執行驗證的結果，**直接採用，不要重新推測**。

### 5.1 `apply_redactions` 預設會清掉表格線 ⚠️

```python
Page.apply_redactions(images: int = 2, graphics: int = 1, text: int = 0)
# PDF_REDACT_IMAGE_NONE     = 0
# PDF_REDACT_LINE_ART_NONE  = 0
# PDF_REDACT_TEXT_REMOVE    = 0
```

**預設 `graphics=1` 會移除被 redact 矩形碰到的向量線 —— 表格框線會消失。**
這與專案「保留頁面圖片、表格線與背景」的核心需求直接衝突。正確呼叫：

```python
page.apply_redactions(
    images=pymupdf.PDF_REDACT_IMAGE_NONE,
    graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
)
```

> 決策文件 B-4 原本只提到 `images`，**`graphics` 才是表格線消失的主因**。

### 5.2 字型：不要用 `fontfile`，直接用內建 `china-t`

- **`/System/Library/Fonts/PingFang.ttc` 在本機不存在** → `_find_cjk_font()` 的候選路徑全部落空，`fontfile` 分支形同虛設。
- 內建 `china-t` 實測可用：嵌入字型為 `Fangti`，`'繁體中文測試：關鍵詞彙與臺灣用語'` 可完整取回。
- **修正決策文件 B-5 的一項錯誤**：`china-t` / `china-s` / `japan` / `korea` 在 PyMuPDF 1.28 都解析到同一個 fallback 字型（Droid Sans Fallback），**選 `china-s` 並不會讓繁體字變成簡體字形**。原本的說法未經驗證，不成立。仍建議依目標語言選對應代碼（影響輸出 PDF 的字型名稱與 CID 編碼），但這不是 bug。
- 真正的 bug 是 `_find_cjk_font()` 指向不存在的路徑。**移除 `fontfile` 路徑，統一走內建 CJK 代碼。**

### 5.3 CJK 文字寬度：現行公式低估 1.82 倍

`pymupdf.Font("china-t").text_length(s, 10)` 實測：

| 字串 | 寬度 | 每字 |
|---|---|---|
| `中文字寬` | 40.00 | **10.0（1.0 em）** |
| `abcd` | 21.68 | **5.42（0.542 em）** |
| `中a中a` | 30.62 | 混排 |

現行 `_compute_text_height()` 的 `chars_per_line = width / (fontSize * 0.55)` 假設每字 0.55 em：
- 對 Latin（0.542 em）**碰巧準確**
- 對 CJK（1.0 em）**低估 1.82 倍行數**（0.55 / 1.0 的倒數）

→ 這是「翻譯溢位」的直接數學原因，也是 2-1 必須自建量測的理由。

### 5.4 其他

| 項目 | 結果 |
|---|---|
| `pymupdf.TextWriter` | ✅ 可用 |
| `import fitz` | ✅ 1.28 下無 deprecation warning，現有程式碼不需改 |
| `Font.text_length()` 對缺字 | ⚠️ 缺 glyph 時仍回傳預設寬度（`helv` 量測中文也給 40.0），**不能用它判斷字型是否支援該字**，要用 `has_glyph()` |
| 系統 `python3`(3.14) | ❌ 無 docling / PyMuPDF，測試一律用 venv |

---

## 6. 明確不在範圍內

| 項目 | 理由 |
|---|---|
| **`App.tsx` 拆分** | 1,603 行 / ~40 個 `useRef` / 6 條狀態機確實該拆，但本計畫對 `App.tsx` 的改動集中在 `exportPdf()` 與少數 state 宣告，與那 6 條狀態機無交集。純結構重構 blast radius 極大，與渲染改造並行會無法歸因。**留到 PR-6 完成後單獨進行**，屆時 `exportPdf` 已縮成幾行呼叫 `buildRenderPlan()`，拆分更容易 |
| **改 `pdfLayout.ts` 的判斷邏輯** | 見 2.4，等 3C-1 golden fixture |
| **讓螢幕 overlay 也做 reflow** | 見決策文件第六節，落差是刻意保留的設計 |
| **跨平台化** | 見 2.5 |
| **整合真正的 BabelDOC 套件** | 本計畫自建 planner；是否改用上游套件應在 PR-6 完成、有實測品質數據後再評估 |

---

## 7. 平行工作線（無依賴，可隨時穿插）

### 3B 效能

| # | 任務 | 檢核條件 |
|---|---|---|
| 3B-1 | **IPC 停止 `Array.from(pdfBytes)`**：改吃原生檔案路徑（拖放與最近開啟已有路徑），僅檔案選擇器情境需傳 bytes | `App.tsx:331,386,817,1142` 不再出現 `Array.from`；50 MB PDF 開啟記憶體峰值明顯下降 |
| 3B-2 | SQLite 改 `tauri::State<Mutex<Connection>>`，停止每次 `open_connection` 都跑 `PRAGMA` + `CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` | `cache.rs` 只在啟動時 `initialize` 一次 |
| 3B-3 | `FittedTextBlock` 的逐塊 RAF 縮字改為一次量測 + `transform: scale` | 100+ 區塊頁面捲動不掉幀 |

### 3C 版面品質（3C-1 為其餘前置）

| # | 任務 | 檢核條件 |
|---|---|---|
| 3C-1 | **建 golden fixture 測試集**：單欄 / 雙欄 / 跨欄標題 / 表格 / 圖說 / 公式 / 掃描頁，各附人工確認的閱讀順序與區塊分類 | 涵蓋 7 類；差異報告可自動產生 |
| 3C-2 | `pdfLayout.ts` magic number 提為具名常數（`> 30`、`* 0.65`、`< 1200`、`* 1.45`、`top < 220`…） | 判斷式中無裸數字 |
| 3C-3 | 移除領域硬編碼：`isNonLinguisticText` 的 `char-BERT\|CNN\|LSTM…` 詞表、`isArtifactText` 的 IEEE 版權句 → 改用字母比例 + 符號密度 + 長度的統計特徵 | 非英文 / 非 IEEE 文件不再誤判 |
| 3C-4 | 欄位偵測改用間隙分群（與 2-2 同演算法） | 三欄與不對稱欄寬 PDF 不再誤合併 |
| 3C-5 | 字級來源統一：刪 `docling_worker.py#estimate_font_size` 與 `TranslationPage` 的 `bodyFontSize` 中位數補救，一律取自 PDF.js text item | Docling 模式下同頁字級不再跳動 |

### 3D 清理

| # | 任務 |
|---|---|
| 3D-1 | 語言選項（en / ja / zh-TW）寫死在 JSX 三處，提成常數陣列（`App.tsx:1555-1557`） |
| 3D-2 | README 標示本 App 目前僅支援 macOS |
| 3D-3 | 驗證 `Abortable`（`llm.rs:529`）是否已真正取消 reqwest 連線；若成立，劃掉 README roadmap TODO #5 該項 |
