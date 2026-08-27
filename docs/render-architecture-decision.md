# LingoPane 渲染架構定案：Unified IR 去留 與 Adaptive 引擎設計

> 定案日期：2026-08-27
> 適用範圍：`src/lib/unifiedIR.ts`、`src/App.tsx#exportPdf`、`src-tauri/src/renderer.rs`、`tools/pdf_renderer.py`、`tools/babeldoc_worker.py`
>
> **本文件說明「為什麼」。實際執行請從 [`render-execution-plan.md`](./render-execution-plan.md) 開始** —— 那份包含執行順序、逐項檢核條件、全域注意事項與已實測驗證的技術事實。

---

## 一、兩個定案（TL;DR）

### 定案 A：`unifiedIR.ts` **刪除，不接上**

不是因為它寫得不好，而是因為它模擬的東西**分屬兩種生命週期，被錯誤地合成了一層**：

| 類別 | 內容 | 正確歸屬 |
|---|---|---|
| **持久事實** | 幾何、文字、區塊類型、閱讀順序 | 已存在於 `PdfPageLayout` / `PdfTextBlock`，且已進 SQLite 快取 |
| **衍生決策** | `columnId`、`FlowRegion`、`isObstacle`、`LayoutPolicy` | 是「持久事實 + 渲染模式」的**純函式**，且必須在**能量測文字的地方**計算 → 屬於 Python/PyMuPDF，不屬於 TS |

把衍生決策存進 IR 並快取，會憑空多出第二條失效軸（policy version），卻換不到任何東西。而 `mergeDoclingIRIntoPdfLayout()` 更是**第三套** Docling→layout 合併實作（另外兩套是 `mergeDoclingPage()` 與 `alignBlockToPdfText()`），留著是陷阱。

**要搶救的兩樣東西：**

1. `layoutPolicyDefaults` 那張「哪種區塊可 reflow / 可縮字 / 可換頁」的表 —— 這是全檔最有價值的設計，**移植到 Python planner**。
2. 「版本化契約」的觀念 —— 落實成 `src/lib/renderPlan.ts`，取代目前散在 `exportPdf()` 內的匿名物件字面值。

### 定案 B：三種匯出模式 **不是三個 renderer，而是同一個 flow planner 的三組參數**

| 模式 | reflow | obstacle | 溢位處理 | 頁數 | redaction |
|---|---|---|---|---|---|
| `faithful` | 關（釘死原 bbox） | 釘住 | 縮字 → 截斷 | 1:1 | 需要 |
| `adaptive` | 開（欄內流動） | 釘住並繞開 | 縮字 → 切段 → 續頁 | 1:N | 需要 |
| `bilingual` | 開（整欄可用） | 丟棄 | 縮字 → 切段 → 續頁 | 1:1+N | **不需要** |

因此：**刪除 `babeldoc_worker.py`，把 `pdf_renderer.py` 改寫成「一個 planner + 一個 renderer + 一組 mode config」**。這一步同時消掉 `_find_cjk_font` 重複、死掉的 `_compute_column_regions`、`renderer.rs` 的雙 `include_str!`、以及壞掉的模式路由。

**實作順序刻意反直覺：先做 `bilingual`。** 它是 planner 的最小可用子集（要量測、要排版、要溢位換頁，但不需要 obstacle 繞行、不需要 redaction），可以在不受 redaction 品質干擾的情況下驗證整個 planner 是否正確。

---

## 二、阻斷性缺陷（Phase 0，先修才談架構）

以下四項使得「匯出」功能目前**在預設路徑上是壞的**，且都與架構無關，可獨立修復。

### B-1 `adaptive` 匯出必定 crash（預設模式）

`renderer.rs:161` 無條件傳 `--mode`，但 `tools/babeldoc_worker.py` 的 argparse **沒有定義 `--mode`** → `unrecognized arguments` → exit 2。
而 `App.tsx:230` 的 `selectedRenderMode` 預設就是 `"adaptive"`。

→ **使用者點「匯出」的預設路徑 100% 失敗。**

### B-2 `bilingual` 匯出必定失敗

`renderer.rs:154` 只把 `adaptive` 導向 babeldoc，其餘（含 `bilingual`）導向 `pdf_renderer.py`，而後者 `main()` 對非 `faithful` 直接 `return 1`。

### B-3 快速模式下「第一次開啟的文件」無法匯出

`exportPdf()` 只讀 `enhancedLayouts[pageNum]`，`if (!layout) continue`。
但 `cacheResolvedLayout()`（`TranslationPage` 的 `onLayoutResolved` 回呼）**只寫 SQLite，從不 `setEnhancedLayouts`**。

→ fast 模式 + 該文件無快取時 `enhancedLayouts === {}` → `renderPages` 全空 → 報 `noTranslationsToExport`。
→ 同一份文件**第二次**開啟時因為快取已建立而正常，所以這個 bug 會呈現為「時好時壞」。

### B-4 redaction 三個問題

```python
# pdf_renderer.py:99-100  ← 在每個 block 的迴圈內
page.add_redact_annot(rect, fill=(1, 1, 1))
page.apply_redactions()
```

1. **`apply_redactions()` 在迴圈內**：PyMuPDF 每次都重寫整頁 content stream，一頁 N 個區塊 = N 次重寫。應該全部 `add_redact_annot` 之後**每頁呼叫一次**。
2. **預設會刪除影像，也會刪除向量線**。實測簽章（PyMuPDF 1.28）：

   ```python
   Page.apply_redactions(images: int = 2, graphics: int = 1, text: int = 0)
   ```

   `images=2` 會抹除相交影像的像素；**`graphics=1` 會移除被矩形碰到的向量線 —— 表格框線會消失**，這與專案「保留表格線」的核心需求直接衝突。正確呼叫需**兩個參數都給**：

   ```python
   page.apply_redactions(
       images=pymupdf.PDF_REDACT_IMAGE_NONE,      # 0
       graphics=pymupdf.PDF_REDACT_LINE_ART_NONE, # 0
   )
   ```

3. **遮罩範圍用的是合併後的 block bbox**，而非 `layout.textRects`（逐 text-item 的緊密框）。合併框會覆蓋到圖、表格線與欄間空白。螢幕上的 `source-text-mask` 已經正確使用 `textRects`，匯出卻沒有 —— **把 `textRects` 一起送進 render plan 即可。**

### B-5 其他（順手修）

| 問題 | 位置 |
|---|---|
| `min_font_scale` 是死碼：`max(s*0.9, s*0.85)` 恆等於 `s*0.9`，永遠不會縮到下限 | `pdf_renderer.py:105-106` |
| `_find_cjk_font()` 的候選路徑（`PingFang.ttc` 等）在本機**全部不存在**，`fontfile` 分支形同虛設 → 應移除，統一走內建 `china-t`（實測嵌入 `Fangti`，繁體字正確往返）。<br>~~繁中用 `china-s` 會出現簡體字形~~ —— **此說法經實測不成立**，四種 CJK 代碼在 PyMuPDF 1.28 都解析到同一 fallback 字型，詳見執行方案 5.2 | `pdf_renderer.py:29-41,125`、`babeldoc_worker.py:24-36,179` |
| `settings.renderMode` 只寫不讀（設定視窗改了沒作用，匯出走 `selectedRenderMode`） | `App.tsx:1570` vs `App.tsx:230` |
| `link.download` + 緊接著 `URL.revokeObjectURL()`：WKWebView 下下載行為不可靠，且同步 revoke 可能中斷寫入 | `App.tsx:1150-1156` |
| `fontScale: settings.translationFontScale * 0.5` 借用螢幕字級設定，應獨立為 `exportFontScale` | `App.tsx:1146` |
| `ExportDialog` 用 `t("renderModeHelp").split(".")[n]` 拆句子當說明，標點一改就錯位 | `ExportDialog.tsx:46,60,74` |

---

## 三、渲染契約：`src/lib/renderPlan.ts`

取代 `exportPdf()` 內的匿名結構。**譯文直接內嵌進 block，不再另傳 `translations` map**（目前 TS 拆成兩份、Python 再 join，是多餘的間接層）。

```ts
export const RENDER_PLAN_VERSION = 1;

export type RenderMode = "faithful" | "adaptive" | "bilingual";

export type RenderRect = { x: number; y: number; width: number; height: number };

export type RenderBlock = {
  id: string;
  kind: PdfTextBlock["kind"];      // 沿用既有 6 種，不再做第二套 type 對照
  bbox: RenderRect;                // PDF 使用者座標、scale=1、左上原點
  fontSize: number;
  textAlign?: "left" | "center" | "right";
  emphasis?: "bold";
  text: string;                    // 譯文；未翻譯的 block 不進 plan
};

export type RenderPagePlan = {
  pageNumber: number;
  width: number;                   // 供 Python 校驗座標系（見下方「座標系陷阱」）
  height: number;
  blocks: RenderBlock[];
  maskRects: RenderRect[];         // = layout.textRects，redaction 專用
};

export type RenderPlan = {
  version: number;
  mode: RenderMode;
  targetLanguage: string;          // 決定字型與斷行規則
  fontScale: number;
  minFontScale: number;
  pages: RenderPagePlan[];
};

export function buildRenderPlan(
  layouts: Record<number, PdfPageLayout>,
  translations: Record<number, TranslatedBlock[]>,
  options: { mode: RenderMode; targetLanguage: string; fontScale: number; minFontScale: number },
): RenderPlan;
```

### 座標系陷阱（必須寫進 Python 端校驗）

PDF.js `getViewport({scale:1})` 與 PyMuPDF `page.rect` **都是左上原點、y 向下**，所以目前直接把 `left/top` 丟進 `fitz.Rect` **碰巧是對的**。但兩者在以下情況會分歧：

- 頁面帶 `/Rotate 90|180|270`
- CropBox 原點非 (0,0)

`pdfLayout.ts` 已用 `Util.transform(viewport.transform, item.transform)` 正確處理，PyMuPDF 端則需要 `page.rect` 已套用旋轉。**契約傳 `width`/`height` 就是為了讓 Python 端斷言**：

```python
if abs(page.rect.width - plan_page["width"]) > 1 or abs(page.rect.height - plan_page["height"]) > 1:
    # 等比縮放或明確報錯，不要靜默錯位
```

---

## 四、Flow Planner 設計（`tools/pdf_renderer.py` 改寫）

### 4.1 模組邊界

| 層 | 職責 | 是否快取 |
|---|---|---|
| **TS `pdfLayout` / `docling`** | 幾何、文字、區塊類型、閱讀順序（＝陣列順序） | ✅ SQLite |
| **TS `renderPlan`** | 序列化成版本化 wire schema | ❌ |
| **Python `planner`** | 欄位分群、policy、量測、排版、溢位、分頁 | ❌ 純函式 |
| **Python `renderer`** | redaction、`TextWriter` 落字、續頁生成 | ❌ |

> **閱讀順序不需要新增欄位**：`makeBlocks()` 依 `readingOrder(lines)` 推入，`mergeDoclingPage()` 依 `item.readingOrder` 排序後 flatMap，兩條路徑的**陣列順序本身就是閱讀順序**，且 JSON 往返保序。不要為了「顯式化」而動快取 schema。

### 4.2 Policy 表（自 `unifiedIR.ts` 移植）

```python
@dataclass(frozen=True)
class Policy:
    reflow: bool        # 可否離開原 y 座標
    shrink: bool        # 可否縮字
    pin: bool           # 是否為 obstacle（其他文字須繞開）
    render: bool = True # 是否輸出譯文

POLICY = {
    "text":     Policy(reflow=True,  shrink=True,  pin=False),
    "heading":  Policy(reflow=True,  shrink=True,  pin=False),
    "caption":  Policy(reflow=False, shrink=True,  pin=True),   # 圖說必須跟著圖，不流動
    "table":    Policy(reflow=False, shrink=True,  pin=True),
    "formula":  Policy(reflow=False, shrink=False, pin=True),
    "artifact": Policy(reflow=False, shrink=False, pin=True, render=False),
}
```

模式覆寫：

```python
MODE = {
    "faithful":  ModeConfig(allow_reflow=False, allow_expansion=False, use_obstacles=True,  redact=True),
    "adaptive":  ModeConfig(allow_reflow=True,  allow_expansion=True,  use_obstacles=True,  redact=True),
    "bilingual": ModeConfig(allow_reflow=True,  allow_expansion=True,  use_obstacles=False, redact=False),
}
```

### 4.3 欄位偵測：用間隙分群，**不要用頁面中點**

現行 TS 端 `flowColumn()` 用 `pageWidth / 2` ± gutter，遇到三欄、不對稱欄寬、單欄含側欄就失效。Planner 端改用一維投影：

```
detect_columns(blocks, page_width):
    1. 取所有 policy.reflow 為 True 的 block 的 [left, right] 區間
    2. 對 x 軸做覆蓋投影，找出所有寬度 ≥ max(9, page_width * 0.018) 的空白帶
    3. 空白帶切出 N 個欄段；每段的 [xStart, xEnd] = 該段內 block 的極值
    4. 跨越 >1 欄段、或寬度 > 0.7 * page_width 的 block → 標為 spanning
    5. 若偵測結果 N > 4 或任一欄寬 < page_width * 0.15 → 判定不可靠，退回單欄
```

`spanning` block 的 y 區間把頁面**水平切成數個 band**；每個 band 內各欄獨立流動。這正確處理「跨欄大標題底下接雙欄正文」。

### 4.4 文字量測：自建斷行（**核心工作量所在**）

`insert_textbox()` 只回傳剩餘高度（不足時為負），**無法告訴你哪裡切斷**，因此跨頁切段做不到。必須自行斷行後用 `fitz.TextWriter` 落字。

```python
def wrap(text, font: fitz.Font, size: float, width: float, lang: str) -> list[str]:
    """逐字元累加 font.text_length(ch, size)，超過 width 就斷行。
    斷點規則：
      - ASCII 區段：只在空白處斷（回退到上一個空白）
      - CJK 區段：任意位置可斷，但不得在「行首禁則字元」前斷
                  禁則：。，、；：？！）」』》〉】…—～%
      - 中英混排：兩種規則同時生效，取較晚的合法斷點
    """

LINE_HEIGHT = {"zh-TW": 1.5, "zh": 1.5, "ja": 1.5, "ko": 1.5}  # 其餘 1.35
```

> 現行 `_compute_text_height()` 用 `chars_per_line = width / (fontSize * 0.55)` —— 對 CJK 全形字（寬度 ≈ 1.0em）低估約一倍，對混排完全不準。這是螢幕與匯出字級不一致的根源之一，**必須換掉**。

### 4.5 排版主迴圈

```
plan_band_column(blocks, column, band, mode, obstacles):
    cursor = band.top
    overflow = []
    for b in blocks:                          # 已是閱讀順序
        p = POLICY[b.kind]
        if not p.render:            continue
        if p.pin and mode.use_obstacles:
            emit(b, at=b.bbox)                # 原位輸出，不進 flow
            continue
        if not (p.reflow and mode.allow_reflow):
            emit_fixed(b)                     # faithful：釘在原 bbox，僅縮字
            continue

        size = b.fontSize * plan.fontScale
        lines = wrap(b.text, font, size, column.width, lang)
        h = len(lines) * size * line_height

        cursor = skip_obstacles(cursor, h, obstacles)     # 跳過重疊的 pinned 區間

        if cursor + h > band.bottom:
            size = max(size * plan.minFontScale, MIN_PT)  # ① 先縮字
            lines = wrap(...); h = ...
        if cursor + h > band.bottom:
            fit = max_lines_in(band.bottom - cursor, size)  # ② 再切段
            emit_lines(lines[:fit], column.x, cursor, size)
            overflow.append(Remainder(b.id, lines[fit:], size))
            break
        emit_lines(lines, column.x, cursor, size)
        cursor += h + gap(b.kind)
    return overflow
```

`skip_obstacles(cursor, h, obstacles)`：若 `[cursor, cursor+h)` 與任一 pinned 區間的 y 範圍相交且 x 範圍重疊 > 40%，則 `cursor = obstacle.bottom + gap` 後重試（最多 N 次防迴圈）。

### 4.6 續頁（`allow_expansion`）

```
if overflow and mode.allow_expansion:
    new_page = doc.new_page(pno=current+1, width=W, height=H)  # 空白，不複製底圖
    # 沿用同一組 column 幾何、無 obstacle
    # 頁首標註「(接第 N 頁)」
    # 遞迴排入 overflow，直到清空或達到 MAX_CONTINUATION_PAGES = 3
```

上限 3 頁：超過代表版面偵測失敗，此時應**放棄該頁 reflow、退回 faithful**，並在 stderr 記錄頁碼供除錯，而不是無限增頁。

### 4.7 `bilingual` = planner 最小子集

- 原頁**原封不動**複製（不 redact、不改動）
- 其後插入一張同尺寸空白頁
- 空白頁用同一 planner：`use_obstacles=False`、整頁可用、僅 flowables
- 溢位直接開下一張續頁

→ 不碰 redaction、不碰 obstacle 繞行，卻完整跑過「欄位分群 → 量測 → 排版 → 溢位 → 續頁」。**先做這個。**

---

## 五、落地計畫

### Phase 0：修好匯出（不動架構，約 0.5–1 天）

| # | 任務 | 檔案 | 驗收 |
|---|---|---|---|
| 0-1 | `renderer.rs` 移除 `BABELDOC_SOURCE`，一律導向 `pdf_renderer.py`；`pdf_renderer.py` 接受 `--mode` 但暫時只實作 `faithful` | `renderer.rs:10,154-157`、`pdf_renderer.py` | 三種模式都不再 crash；未實作者回傳明確中文錯誤 |
| 0-2 | `ExportDialog` 只開放 `faithful`，其餘 `disabled` 並標「開發中」 | `ExportDialog.tsx` | 使用者選不到會失敗的模式 |
| 0-3 | 修 `enhancedLayouts` 空洞：`onLayoutResolved` 同時 `setEnhancedLayouts` | `App.tsx:1195-1206`、`TranslationPage.tsx:133` | 全新文件、fast 模式、翻譯一頁後可成功匯出 |
| 0-4 | `apply_redactions()` 移出迴圈（每頁一次）＋ `images=fitz.PDF_REDACT_IMAGE_NONE` | `pdf_renderer.py:99-100` | 含圖表頁匯出後圖表完整；10 頁文件匯出時間明顯下降 |
| 0-5 | redaction 改用 `maskRects`（`layout.textRects`） | `App.tsx#exportPdf`、`pdf_renderer.py` | 匯出頁的表格線、欄間留白不再被白塊蓋掉 |
| 0-6 | 字型依 `targetLanguage` 選擇（`china-t`/`china-s`/`japan`/`korea`）；修 `min_font_scale` 死碼 | `pdf_renderer.py` | 繁中譯文不再出現簡體字形 |
| 0-7 | 匯出改為 Rust 寫檔 + `tauri-plugin-opener` 開啟，取代 `link.download` | `App.tsx:1150-1156`、新增 `renderer.rs` 指令 | 匯出後檔案確實落地並自動開啟 |
| 0-8 | `settings.renderMode` 與 `selectedRenderMode` 合一 | `App.tsx:230,1570` | 設定視窗選的模式即匯出預設模式 |
| 0-9 | `renderModeHelp` 拆成三個獨立 i18n key | `i18n.ts`、`ExportDialog.tsx` | 說明文字不再依賴 `.split(".")` |

### Phase 1：建立單一契約（約 1 天）

| # | 任務 | 檔案 | 驗收 |
|---|---|---|---|
| 1-1 | **刪除 `src/lib/unifiedIR.ts`** | — | `npm run build` 通過；全專案無 `unifiedIR` 參照 |
| 1-2 | 新增 `src/lib/renderPlan.ts`（第三節 schema），`exportPdf()` 改為呼叫 `buildRenderPlan()` | `App.tsx:1103-1162` | `exportPdf` 內不再有匿名結構字面值 |
| 1-3 | `renderer.rs` 的 `RenderRequest` 對齊新 schema（單一 `plan` 欄位，移除 `translations` map） | `renderer.rs:13-51` | `cargo test` 通過 |
| 1-4 | **刪除 `tools/babeldoc_worker.py`** | — | `renderer.rs` 只剩一個 `include_str!` |
| 1-5 | 抽 `src-tauri/src/python_runtime.rs`：`python_candidates()` + 探測結果快取（`OnceLock`），`docling.rs` 與 `renderer.rs` 共用 | 新檔 + 兩處 | 兩份 ~55 行重複碼消失；匯出不再每次重跑 `import fitz` |
| 1-6 | 移除死指令 `cancel_pdf_render`、`test_connection`（或前端接上） | `lib.rs:28,32` | 無未使用的 `#[tauri::command]` |
| 1-7 | Python 端加座標系斷言（第三節） | `pdf_renderer.py` | 帶 `/Rotate` 的 PDF 匯出時明確報錯而非靜默錯位 |

### Phase 2：Flow Planner（核心，約 3–5 天）

| # | 任務 | 驗收 |
|---|---|---|
| 2-1 | `wrap()` 斷行器 + `fitz.Font.text_length` 量測；純函式，可單獨測試 | pytest：純英/純中/中英混排/含禁則標點，行數與寬度符合預期 |
| 2-2 | `detect_columns()` 間隙分群 | pytest：對 `fixtures/docling-two-column-table.pdf` 得到 2 欄；單欄 PDF 得到 1 欄；不可靠時退回單欄 |
| 2-3 | Policy 表 + `ModeConfig` | 單元測試涵蓋 6 種 kind × 3 種 mode |
| 2-4 | **`bilingual` 模式**（planner 最小子集） | 匯出後頁數 = 2 × 原頁數（+續頁）；譯文頁無溢位、無截斷 |
| 2-5 | `skip_obstacles()` + `adaptive` 模式 | 雙欄論文匯出：圖/表/公式位置不變，段落不跨欄、不壓到圖上 |
| 2-6 | 續頁邏輯 + `MAX_CONTINUATION_PAGES` 退回 faithful | 人工塞入超長譯文，確認產生續頁且不無限增頁 |
| 2-7 | `faithful` 改由同一 planner 驅動（`allow_reflow=False`） | 與 Phase 0 的輸出視覺一致（回歸） |
| 2-8 | 匯出後自動開啟結果（沿用 0-7），作為輕量預覽 | — |

### Phase 2.5：翻譯穩健性（**Phase 2 的前置依賴，非平行工作**）

**為什麼是依賴而非平行**：`buildRenderPlan()` 會略過沒有譯文的 block。
`faithful` 模式下無害（該塊不 redact，原文留著）；但在 **`adaptive` / `bilingual` 的重排流程中，缺譯文的段落會直接消失、後續段落往上遞補 —— 內容靜默遺失且無從察覺**。
因此「整頁一次性 JSON 翻譯、漏一個 id 就整頁 `Err`」必須在 planner 之前解決。

現況（`llm.rs:436-492`）：整頁所有 block 打包成一個 JSON，要求模型「每個 id 剛好回傳一次、順序完全相同」，數量或 id 不符即整頁失敗。本地 12B 以下模型很難穩定達成。

| # | 任務 | 檔案 | 驗收 |
|---|---|---|---|
| 2.5-1 | 分批：以字元預算切塊（~2000 字元或 20 blocks 先到者為準），沿用 `translate_with_translate_gemma` 既有的 `buffer_unordered(3)` 併發模式 | `llm.rs:412-498` | 400 block 的頁面不再直接報「區塊過多」 |
| 2.5-2 | 驗證改為 **以 id 比對**而非數量與順序比對；多餘的未知 id 丟棄 | `llm.rs:477-492` | 模型改變順序時不再整頁失敗 |
| 2.5-3 | 缺 id 補譯：該批缺漏的 id 重試該子集（上限 2 次），仍缺者退為單 block 請求 | `llm.rs` | 人工模擬模型漏回 3 個 id，最終仍取得完整譯文 |
| 2.5-4 | 部分失敗不再是整頁失敗：仍缺的 block 回傳空字串並附 warning | `llm.rs`、`TranslationResult` | 回傳結構新增 `missingIds: Vec<String>` |
| 2.5-5 | 前端 `TranslationStatus` 新增 `"partial"` 狀態並標示哪些區塊未譯 | `TranslationPage.tsx:7`、`App.tsx` | 部分失敗頁可正常閱讀已譯內容 |
| 2.5-6 | planner 新增 `on_missing_translation` 策略：`keep_source`（預設，保留原文不 redact）/ `placeholder` / `skip` | `renderPlan.ts`、`pdf_renderer.py` | 缺譯文的段落在匯出 PDF 中**不會靜默消失** |
| 2.5-7 | prompt 版本納入 `translationCacheKey`（分批改動了 prompt，必須連帶失效舊快取） | `App.tsx:142-151` | 改 system prompt 後舊快取不再命中 |

> 取消行為不受影響：`Abortable` 包在最外層（`llm.rs:529`），分批後仍整體可取消。

### Phase 3：平行工作線（不阻塞前述 Phase，可穿插進行）

#### 3A 工程基礎（最先做，成本最低，回報最高）

| # | 任務 | 驗收 |
|---|---|---|
| 3A-1 | 加 CI：`tsc --noEmit`、`cargo fmt --check`、`cargo test`、`node --test tools/tests/`、`python -m unittest discover -s tools/tests` | PR / push 觸發，全綠 |
| 3A-2 | 加 ESLint + Prettier（目前完全沒有） | `npm run lint` 可執行 |
| 3A-3 | `2022_Ito_Sentence_Embedding_Emotion_Recognition.pdf`（1.8 MB）移出根目錄至 `tools/tests/fixtures/` | repo 根目錄無測試資料 |
| 3A-4 | `MAX_PDF_BYTES` 統一：`files.rs` 512 MB / `docling.rs` 200 MB / `llm.rs` 字元上限，集中成單一常數模組 | 三處引用同一常數 |
| 3A-5 | `tauri.conf.json` 的 `security.csp: null` 改為 `default-src 'self'; connect-src 'self' http://localhost:* http://127.0.0.1:*` | App 正常運作且 CSP 生效 |

#### 3B 效能

| # | 任務 | 驗收 |
|---|---|---|
| 3B-1 | **IPC 停止 `Array.from(pdfBytes)`**：`open_cached_document` / `analyze_pdf_with_docling` / `render_translated_pdf` 改吃原生檔案路徑（拖放與最近開啟已有路徑）；僅檔案選擇器情境需傳 bytes | `App.tsx:331,386,817,1142` 不再出現 `Array.from`；50 MB PDF 開啟記憶體峰值明顯下降 |
| 3B-2 | SQLite 連線改 `tauri::State<Mutex<Connection>>`，停止每次 `open_connection` 都跑 `PRAGMA` + `CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` | `cache.rs` 只在啟動時 `initialize` 一次 |
| 3B-3 | Python runtime 探測結果快取（已列於 1-5，此處為驗收）：匯出不再每次重跑 `import fitz` | 連續兩次匯出，第二次無 Python 探測開銷 |
| 3B-4 | `FittedTextBlock` 的逐塊 RAF 縮字迴圈改為一次量測 + `transform: scale`，避免整頁上百區塊的 layout thrash | 100+ 區塊頁面捲動不掉幀 |

#### 3C 版面品質（動 `pdfLayout.ts` 的前置）

| # | 任務 | 驗收 |
|---|---|---|
| 3C-1 | **建 golden fixture 測試集**（README roadmap TODO #1）：單欄 / 雙欄 / 跨欄標題 / 表格 / 圖說 / 公式 / 掃描頁，各附人工確認的閱讀順序與區塊分類 | `tools/tests/fixtures/` 涵蓋 7 類；差異報告可自動產生 |
| 3C-2 | `pdfLayout.ts` 的 magic number 全部提為具名常數（`> 30`、`* 0.65`、`< 1200`、`* 1.45`、`top < 220` 等） | 無裸數字於判斷式中 |
| 3C-3 | 移除領域硬編碼：`isNonLinguisticText` 的 `char-BERT|CNN|LSTM…` 詞表、`isArtifactText` 的 IEEE 版權句，改為字母比例 + 符號密度 + 長度的統計特徵 | 非英文 / 非 IEEE 文件不再誤判 |
| 3C-4 | 欄位偵測改用間隙分群（與 Phase 2-2 的 Python 版同演算法），取代 `pageWidth / 2` | 三欄與不對稱欄寬 PDF 不再誤合併 |
| 3C-5 | 字級來源統一：刪 `docling_worker.py#estimate_font_size` 與 `TranslationPage` 的 `bodyFontSize` 中位數補救，字級一律取自 PDF.js text item | Docling 模式下同頁字級不再跳動 |

> 3C-1 是 3C-2 ~ 3C-5 的前提。沒有回歸測試，`pdfLayout.ts` 那 526 行不敢動。

#### 3D 其他清理

| # | 任務 |
|---|---|
| 3D-1 | 語言選項（en / ja / zh-TW）目前寫死在 JSX 三處，提成常數陣列（`App.tsx:1555-1557`） |
| 3D-2 | `ExportDialog` 明確標示「匯出採重排排版，與畫面預覽不同」 |
| 3D-3 | README 標示本 App 目前僅支援 macOS（keyring、`/bin/kill`、`libc::kill`、PingFang 路徑、`titleBarStyle: Overlay` 皆為 macOS 專屬） |
| 3D-4 | 驗證 `Abortable` 是否已真正取消 reqwest 連線；若成立，劃掉 README roadmap TODO #5 的該項 |

### 刻意不在本計畫內：`App.tsx` 拆分

`App.tsx` 1,603 行、~40 個 `useRef`、6 條互相纏繞的狀態機（translationJobs / batchJob / analysisRun / autoTranslate / zoomAnchor / scrollLock）確實應該拆成 hooks，但**本計畫刻意不動它**：

- Phase 0 ~ 2 對 `App.tsx` 的改動集中在 `exportPdf()`（1103-1162）與少數 state 宣告，與那 6 條狀態機無交集
- 拆分是純結構重構、blast radius 極大，若與渲染管線改造並行，出問題時無法區分是哪一邊造成
- 建議在 Phase 2 完成、匯出路徑穩定後單獨進行，屆時 `exportPdf` 已縮成呼叫 `buildRenderPlan()` 的幾行，拆分更容易

---

## 六、螢幕 vs 匯出：刻意保留落差

**不要**讓螢幕 overlay 也做 reflow。理由：

- 螢幕端的價值是**與原文逐塊對照**，原位覆蓋正是它的功能，不是缺陷
- WKWebView 內做 obstacle-aware reflow 需要重寫整個 `TranslationPage` 三層絕對定位結構，成本遠高於收益
- 兩端量測引擎不同（瀏覽器 layout vs PyMuPDF），永遠無法真正 WYSIWYG

**定位語言**：螢幕 = 閱讀視圖（原位、可展開）；匯出 = 文件視圖（重排、可列印）。在 `ExportDialog` 用一行文案講清楚即可。

---

## 七、驗證結果

初版列出 6 項待驗證，其中 4 項已在開發機（PyMuPDF 1.28.0 / MuPDF 1.29.0）實測完成，**完整數據見執行方案第 5 節**。

| 項目 | 結果 |
|---|---|
| `apply_redactions` 參數 | ✅ **已驗證，且比預期嚴重**：`images=2, graphics=1, text=0`。`graphics=1` 會清掉表格線，必須同時傳 `graphics=PDF_REDACT_LINE_ART_NONE`。已回頭修正 B-4 |
| `china-t` 字型代碼 | ✅ **已驗證，且推翻原假設**：四種 CJK 代碼解析到同一 fallback 字型，`china-s` 不會導致簡體字形。原本的 B-5 說法不成立，已修正 |
| `PingFang.ttc` face index | ✅ **已驗證，問題不同**：該檔在本機根本不存在，`fontfile` 分支形同虛設。結論是**移除 `fontfile`，統一用內建 `china-t`** |
| 文字量測公式 | ✅ **新增發現**：CJK 實測 1.0 em / Latin 0.542 em。現行 `width / (fontSize * 0.55)` 對中文低估 **1.82 倍**行數 —— 這是譯文溢位的直接數學原因 |
| Docling table cell 的 `readingOrder` | ⏳ 未驗證：`docling_worker.py` 中同一表格所有 cell 共用同一個 `page_reading_order`，排序需為穩定排序 |
| Abortable 是否已真正取消 HTTP | ⏳ 未驗證：`llm.rs:529` 的 `Abortable` 被 abort 時 future 被 drop，reqwest 連線應一併取消 —— 若實測成立，README roadmap TODO #5 該項可直接劃掉 |

---

## 八、與初次審核「建議的優先順序」的對照

初次審核提出 6 項優先序，全數落點如下：

| 初次審核的優先項 | 本計畫落點 |
|---|---|
| ① 修正明確 bug（bilingual 路由、`settings.renderMode` 不生效、`apply_redactions` 迴圈內） | **Phase 0**（0-1 / 0-8 / 0-4）。細讀後另補 3 項更嚴重的：adaptive crash（0-1）、fast 模式匯出空洞（0-3）、redaction 挖掉圖表（0-4） |
| ② 效能（IPC 不傳 `Array.from`、cache 連線重用） | **3B-1 / 3B-2**，另補 3B-3 runtime 探測快取、3B-4 RAF thrash |
| ③ 清理（`unifiedIR` 去留、`python_runtime` 抽取、死指令、測試 PDF、CI） | `unifiedIR` → **1-1**；`python_runtime` → **1-5**；死指令 → **1-6**；測試 PDF → **3A-3**；CI → **3A-1**，另補 ESLint（3A-2）、CSP（3A-5）、`MAX_PDF_BYTES` 統一（3A-4） |
| ④ golden fixture 測試集 | **3C-1**，且明訂為 3C-2 ~ 3C-5 的前置 |
| ⑤（Opus）定案 Unified IR + adaptive + `App.tsx` 拆分 | 前兩者即本文件第一 ~ 四節；`App.tsx` 拆分**刻意排除**，理由見 Phase 3 末段 |
| ⑥ 翻譯分批 + 缺 id 補譯、prompt 版本進 cache key | **Phase 2.5**。定位由「平行工作」上調為 **Phase 2 的前置依賴** —— 重排模式下缺譯文會導致內容靜默遺失（見 2.5 節開頭） |

### 建議執行順序

```
Phase 0（修好匯出）
   └─→ 3A（工程基礎：CI / lint / 常數統一）   ← 越早越好，之後每一步都受惠
        └─→ Phase 1（單一契約，刪 unifiedIR / babeldoc）
             └─→ Phase 2.5（翻譯穩健性）      ← Phase 2 的硬依賴
                  └─→ Phase 2（Flow Planner；先 bilingual 後 adaptive）

3B（效能）、3C（版面品質）、3D（清理）可在上述任一階段之間穿插，彼此無依賴。
3C-1 必須先於 3C-2 ~ 3C-5。
App.tsx 拆分留到 Phase 2 完成後單獨進行。
```
