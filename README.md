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

目前 `src-tauri/icons/` 不會出現在全新 clone 的專案中，第一次打包前需從專案內的主圖產生 Tauri 需要的 `.icns`、`.ico` 與 PNG 圖示：

```bash
npm run tauri icon assets/app-icon-master-padded.png
```

產生結果位於 `src-tauri/icons/`。如果缺少這些檔案，Tauri 打包時會因找不到 `icon.icns` 等圖示而失敗。

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
  npm run tauri build -- --bundles app,dmg
```

專案的 `src-tauri/tauri.conf.json` 已設定 `bundle.targets` 為 `all`，所以也可以簡寫為：

```bash
APPLE_SIGNING_IDENTITY="-" npm run tauri build
```

release 產物位於：

```text
src-tauri/target/release/bundle/macos/LingoPane — Local PDF Translator.app
src-tauri/target/release/bundle/dmg/LingoPane — Local PDF Translator_0.1.0_aarch64.dmg
```

### 只建立 App

```bash
APPLE_SIGNING_IDENTITY="-" \
  npm run tauri build -- --bundles app
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
APP="src-tauri/target/release/bundle/macos/LingoPane — Local PDF Translator.app"

codesign --verify --deep --strict --verbose=2 "$APP"
```

如果本機版本顯示 bundle 簽章不完整，可重新套用 ad-hoc 簽章後再驗證：

```bash
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
```

直接安裝到 `/Applications`：

```bash
sudo ditto "$APP" "/Applications/LingoPane — Local PDF Translator.app"
open "/Applications/LingoPane — Local PDF Translator.app"
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
