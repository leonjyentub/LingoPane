# LingoPane 開發計畫：從「文字覆蓋」到「語意重排」

> 最後更新：2026-08-06
> 狀態：**待開始 Phase 1**

---

## 一、專案現狀分析

### 技術棧
- **前端**：React 19 + TypeScript + Vite + pdfjs-dist
- **後端**：Tauri 2 (Rust) + reqwest + rusqlite + keyring
- **Python**：Docling worker (docling[ocrmac]==2.113.0) + uv 環境管理
- **翻譯**：oMLX / Ollama / OpenAI-compatible (含 TranslateGemma 特殊處理)

### 現有雙模式分析管線
1. **Fast 模式 (pdf.js)**：文字物件分組 → 欄位偵測 → 區塊合併
2. **Docling 增強模式**：Python worker 子進程 → Layout + TableFormer → Document 合約

### 目前的不足
- pdf.js Fast 模式僅用頁面中點分割欄位，對跨欄標題、表格、圖片偵測較弱
- Docling 預設使用 Heron layout model，未提供模型選擇
- 翻譯輸出為「原位置覆蓋」，中文行數/字級改變時容易溢出
- 無 Unified IR，pdf.js 與 Docling 輸出格式不統一
- 無自適應重排能力

---

## 二、改造目標

### 核心架構變更
```
現有：PDF → pdf.js/Docling → LLM 翻譯 → 翻譯覆蓋在原 bbox
目標：PDF → Docling + PyMuPDF 版面解析 → Unified IR → LLM 翻譯 → 自適應排版 → PDF 輸出
```

### 三種輸出模式
| 模式 | 目標 | 適用場景 |
|------|------|----------|
| **忠實版 (Faithful)** | 維持原頁數、原座標，必要時縮字（最小 85%） | 短文章、摘要 |
| **自適應版 (Adaptive)** — 預設 | 維持雙欄、圖表、公式位置，段落在欄內流動，允許新增頁面 | 長篇論文 |
| **雙語版 (Bilingual)** | 原文頁 + 翻譯頁交錯 | 對照閱讀 |

---

## 三、開發計畫

### Phase 1：擴展 Docling Layout Model 選擇
**工期預估**：1-2 週
**目標**：讓 Docling 支援更好的雙欄學術論文偵測

#### 改動檔案
| 檔案 | 改動內容 |
|------|----------|
| `tools/docling_worker.py` | `create_converter()` 增加 `layout_model` 參數，支援 Heron/Egret-Large/Egret-XLarge |
| `tools/docling_worker.py` | CLI 增加 `--layout-model` 參數 |
| `src-tauri/src/docling.rs` | Rust 側傳遞 layout model 參數給 Python worker |
| `src/App.tsx` | Settings 增加 `layoutModel` 選項 |
| `src/lib/docling.ts` | 前端類型更新，傳遞 layoutModel 設定 |

#### 具體實作

**1. `tools/docling_worker.py` — `create_converter()`**
```python
def create_converter(do_ocr: bool, layout_model: str = "heron") -> Any:
    from docling.datamodel.pipeline_options import LayoutOptions
    from docling.datamodel.layout_model_specs import (
        DOCLING_LAYOUT_HERON,
        DOCLING_LAYOUT_EGRET_LARGE,
        DOCLING_LAYOUT_EGRET_XLARGE,
    )
    
    options = PdfPipelineOptions()
    options.do_ocr = do_ocr
    options.do_table_structure = True
    
    if layout_model == "egret-large":
        options.layout_options = LayoutOptions(model_spec=DOCLING_LAYOUT_EGRET_LARGE)
    elif layout_model == "egret-xlarge":
        options.layout_options = LayoutOptions(model_spec=DOCLING_LAYOUT_EGRET_XLARGE)
    else:
        options.layout_options = LayoutOptions(model_spec=DOCLING_LAYOUT_HERON)
    
    return DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}
    )
```

**2. `tools/docling_worker.py` — CLI 參數**
```python
parser.add_argument("--layout-model", choices=["heron", "egret-large", "egret-xlarge"], default="heron")
```

**3. `src-tauri/src/docling.rs` — Rust 側**
在啟動 Python worker 時傳遞 `--layout-model` 參數。

**4. `src/App.tsx` — Settings**
```typescript
layoutModel: "heron" | "egret-large" | "egret-xlarge";
```

#### 驗證方式
- 用 `docling-two-column-table.pdf` fixture 測試不同模型的偵測結果
- 比較 Heron vs Egret 在雙欄表格上的 mAP 表現
- 執行 `tools/tests/test_docling_worker.py` 確保不破壞現有功能

---

### Phase 2：建立 Unified Document IR
**工期預估**：2-3 週
**目標**：建立統一的中間表示層，將 Docling 與 pdf.js 輸出統一

#### 新增檔案
| 檔案 | 用途 |
|------|------|
| `src/lib/unifiedIR.ts` | IR 類型定義與轉換邏輯 |

#### IR 類型定義
```typescript
interface LayoutBlock {
  id: string;
  page: number;
  type: "title" | "heading" | "paragraph" | "equation" 
      | "figure" | "table" | "caption" | "footnote" | "reference";
  
  sourceBBox: { x: number; y: number; width: number; height: number };
  columnId: string;        // "left" | "right" | "spanning"
  readingOrder: number;
  
  sourceText?: string;
  translatedText?: string;
  
  sourceStyle: {
    fontFamily?: string;
    fontSize: number;
    fontWeight: number;
    italic: boolean;
    alignment: "left" | "center" | "right" | "justify";
    lineHeight: number;
  };
  
  layoutPolicy: {
    allowReflow: boolean;
    allowFontShrink: boolean;
    allowPageExpansion: boolean;
    preservePosition: boolean;
  };
  
  anchors: {
    before?: string;
    after?: string;
    captionOf?: string;
    continuationOf?: string;
  };
  
  isObstacle: boolean;     // figure, table image, equation, header/footer
}

interface DocumentIR {
  documentHash: string;
  pageCount: number;
  analyzer: {
    name: string;
    version: string;
    modelVersions: Record<string, string>;
  };
  pages: PageIR[];
}

interface PageIR {
  pageNumber: number;
  width: number;
  height: number;
  blocks: LayoutBlock[];
  flowRegions: FlowRegion[];
}

interface FlowRegion {
  id: string;
  type: "header" | "left-column" | "right-column" | "full-width" 
      | "footnote" | "footer" | "figure-exclusion";
  bbox: { x: number; y: number; width: number; height: number };
  blockIds: string[];
}
```

#### 改動檔案
| 檔案 | 改動內容 |
|------|----------|
| `src/lib/docling.ts` | `mergeDoclingPage()` 輸出 `DocumentIR` 而非直接用於渲染 |
| `src/lib/pdfLayout.ts` | Fast 模式也輸出 `DocumentIR`，統一格式 |
| `src/App.tsx` | 翻譯流程改為使用 IR |

#### 關鍵設計
- 每個區塊記錄 `columnId`，解決雙欄問題
- `anchors` 欄位支援段落流動時的相對定位
- `isObstacle` 標記圖表/公式，排版時不被覆蓋
- `flowRegions` 定義每頁的可流動區域

#### 驗證方式
- 將現有 Docling 分析結果轉為 IR，比對 bbox 座標
- 將 pdf.js Fast 模式結果轉為 IR，驗證欄位分類
- 單元測試覆蓋 IR 轉換邏輯

---

### Phase 3a：PyMuPDF 覆蓋模式（快速上線）
**工期預估**：2 週
**目標**：先提供基本的 PDF 翻譯輸出功能

#### 改動檔案
| 檔案 | 改動內容 |
|------|----------|
| `tools/pdf_renderer.py` | 新增 Python renderer，使用 PyMuPDF 操作 PDF |
| `src-tauri/src/docling.rs` | 新增 `render_translated_pdf` command |
| `src/App.tsx` | 新增「匯出翻譯 PDF」按鈕 |

#### PyMuPDF 渲染邏輯
```python
import fitz  # PyMuPDF

def render_faithful_mode(pdf_bytes, ir: DocumentIR, translations):
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    
    for page_ir in ir.pages:
        page = doc[page_ir.pageNumber - 1]
        
        for block in page_ir.blocks:
            if block.type in ("figure", "table", "equation"):
                continue  # 保留原始圖形
            
            if block.translatedText:
                # 1. 紅標記移除原文
                rect = fitz.Rect(block.sourceBBox)
                page.add_redact_annot(rect)
                page.apply_redactions()
                
                # 2. 寫入翻譯
                font_path = get_cjk_font(block.sourceStyle.fontFamily)
                page.insert_textbox(
                    rect,
                    block.translatedText,
                    fontfile=font_path,
                    fontsize=block.sourceStyle.fontSize * 0.9,  # 輸入翻譯
                    align=fitz.TEXT_ALIGN_LEFT,
                )
    
    return doc.tobytes()
```

#### 中文字體策略
| 原文字型類型 | 中文替代 |
|-------------|---------|
| Serif 正文 | Noto Serif CJK TC |
| Sans-serif | Noto Sans CJK TC |
| Monospace | Noto Sans Mono CJK TC |

#### 驗證方式
- 輸出翻譯 PDF，用 pdf.js 開啟驗證
- 確認圖表、公式、頁首頁尾保留完整
- 確認中文文字不溢出 bbox

---

### Phase 3b：BabelDOC 自適應排版整合
**工期預估**：3-4 週
**目標**：實現自適應重排，段落在欄內流動

#### 整合方式
```text
Docling IR → BabelDOC format → BabelDOC 排版 → PDF 輸出
```

#### 改動檔案
| 檔案 | 改動內容 |
|------|----------|
| `tools/babeldoc_worker.py` | 新增 BabelDOC worker，類似 docling_worker.py 的架構 |
| `src-tauri/src/docling.rs` | 擴展 orchestrator 支援 BabelDOC 渲染 |
| `src-tauri/src/lib.rs` | 新增 `render_adaptive_pdf` command |

#### BabelDOC Worker 架構
```python
def create_babeldoc_renderer():
    from babeldoc.docvision.doclayout import DocLayoutModel
    from babeldoc.translation import TranslationConfig
    
    # 使用 DocLayout-YOLO 作為額外的版面偵測
    model = DocLayoutModel.from_pretrained("juliozhao/DocLayout-YOLO-DocLayNet")
    
    return BabelDOCRenderer(model=model)
```

#### 排版策略
1. **固定區塊**（不移動）：Figure, Table image, Display equation, 頁首頁尾
2. **可流動區塊**：正文段落, 標題, 清單, 圖說, 參考文獻
3. **文字回填四層策略**：
   - 第 1 層：維持原字級與文字框
   - 第 2 層：調整行距與字距（行距最多降 10%，字距最多降 3%）
   - 第 3 層：小幅縮小字級（正文最小 85%，圖說最小 80%）
   - 第 4 層：啟動段落 reflow

#### 驗證方式
- 與 Phase 3a 的覆蓋模式比較排版品質
- 測試雙欄論文的段落流動效果
- 確認圖表、公式位置不變

---

### Phase 4：多模式渲染
**工期預估**：2 週
**目標**：提供三種輸出模式的 UI 切換

#### 改動檔案
| 檔案 | 改動內容 |
|------|----------|
| `src/App.tsx` | Settings 增加 `renderMode` 選項 |
| `src/components/ExportDialog.tsx` | 新增匯出對話框，選擇模式 |
| `src/i18n.ts` | 新增模式相關的 i18n 字串 |

#### UI 設計
```typescript
type RenderMode = "faithful" | "adaptive" | "bilingual";

// Settings 中新增
renderMode: RenderMode;

// ExportDialog 中
<ExportDialog>
  <RadioGroup value={settings.renderMode}>
    <Radio value="faithful">忠實版 - 維持原頁數</Radio>
    <Radio value="adaptive">自適應版 - 維持欄位（推薦）</Radio>
    <Radio value="bilingual">雙語版 - 原文+翻譯</Radio>
  </RadioGroup>
</ExportDialog>
```

#### 驗證方式
- 三種模式各生成一份 PDF，人工檢查排版品質
- 確認模式切換正確觸發對應渲染管線

---

### Phase 5：品質檢查與人工調整
**工期預估**：2-3 週
**目標**：自動品質檢查 + 人工微調 UI

#### 自動品質檢查
```typescript
interface QualityCheck {
  textOverlap: boolean;        // 文字超出 bbox 或互相重疊
  figureIntact: boolean;       // 圖表保留完整
  formulaIntact: boolean;      // 公式保留完整
  fontSizeReadable: boolean;   // 字級不低於門檻
  readingOrderCorrect: boolean;// 閱讀順序正確
  columnConsistent: boolean;   // 欄位一致性
}

function checkLayoutQuality(ir: DocumentIR): QualityCheck {
  // 實作檢查邏輯
}
```

#### 人工調整 UI
- `TranslationPage.tsx` 增加 overflow 警示
- 新增 `LayoutEditor.tsx` 元件：
  - 拖動段落位置
  - 調整文字框高度
  - 調整字級
  - 合併/拆分段落
  - 修改閱讀順序

#### 驗證方式
- 用複雜排版的期刊論文測試品質檢查
- 人工調整後重新匯出，確認修改生效

---

## 四、Phase 順序與里程碑

```
Phase 1 (1-2 週)
  ├─ Docling layout model 選擇
  ├─ Egret 模型測試雙欄效果
  └─ 里程碑：可切換 layout model 並獲得更好的偵測結果

Phase 2 (2-3 週)
  ├─ Unified IR 定義
  ├─ Docling → IR 轉換
  ├─ pdf.js Fast 模式 → IR 轉換
  └─ 里程碑：統一的 IR 輸出格式

Phase 3a (2 週)
  ├─ PyMuPDF 覆蓋模式
  ├─ 基本中文字體嵌入
  └─ 里程碑：可匯出基本翻譯 PDF

Phase 3b (3-4 週)
  ├─ BabelDOC 整合
  ├─ 自適應排版管線
  └─ 里程碑：可匯出自適應重排 PDF

Phase 4 (2 週)
  ├─ 三種模式切換
  ├─ UI 控制項
  └─ 里程碑：使用者可選擇輸出模式

Phase 5 (2-3 週)
  ├─ 品質檢查
  ├─ 人工調整 UI
  └─ 里程碑：完整的排版品質保證
```

---

## 五、當前狀態

- [x] 專案分析完成
- [ ] Phase 1：Docling layout model 選擇 — **待開始**
- [ ] Phase 2：Unified IR — 待開始
- [ ] Phase 3a：PyMuPDF 覆蓋模式 — 待開始
- [ ] Phase 3b：BabelDOC 自適應排版 — 待開始
- [ ] Phase 4：多模式渲染 — 待開始
- [ ] Phase 5：品質檢查與人工調整 — 待開始

---

## 六、相關參考

- [Docling Model Catalog](https://docling-project.github.io/docling/usage/model_catalog/)
- [Docling Layout Models](https://arxiv.org/abs/2509.11720)
- [BabelDOC](https://github.com/funstory-ai/BabelDOC)
- [PDFMathTranslate](https://github.com/PDFMathTranslate/PDFMathTranslate)
- [PP-DocLayout](https://arxiv.org/abs/2503.17213)
- [DocLayout-YOLO](https://github.com/opendatalab/DocLayout-YOLO)
