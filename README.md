# my_obsidian

本地 Markdown 知識庫 App(類 Obsidian):編輯、即時預覽、`[[雙向連結]]`,並支援 **MD → HTML 匯出**,方便離線閱讀與分享。

以 Electron 打造,所有筆記都是你磁碟上的純 `.md` 檔案,沒有任何鎖定格式。

## 快速開始

```bash
npm install
npm start
```

啟動後點「📂 開啟 Vault」選擇任一資料夾(可先選專案內附的 `SampleVault` 體驗)。

## 功能

### 編輯與閱讀
- 檔案樹側邊欄:瀏覽、搜尋、新增 / 重新命名 / 刪除筆記與資料夾(右鍵選單;刪除會移到垃圾桶)
- 三種模式:**編輯**(⌘1)/ **分割**(⌘2)/ **預覽**(⌘3)
- 自動儲存(停止輸入 0.7 秒後),⌘S 立即儲存,⌘N 新筆記
- GFM 支援:表格、任務清單、刪除線;程式碼區塊由 highlight.js 上色
- YAML frontmatter 自動隱藏(不會出現在預覽與匯出中)

### 雙向連結(Obsidian 風格)
- `[[筆記名稱]]`、`[[筆記名稱|別名]]`、`[[資料夾/筆記]]`
- 不存在的連結顯示為虛線,點擊即可建立該筆記
- `![[圖片.png]]` 嵌入圖片

### Claude Code 記憶同步
- 工具列「🧠 Claude 記憶」:把本機 `~/.claude` 的記憶(全域 CLAUDE.md + 各專案 memory 的 MEMORY.md 重點索引)彙整成 Vault 裡的**一份筆記**:`Claude 記憶/Claude Code 記憶(主機名).md`
- 之後每次開啟 Vault 都會自動更新這份筆記(僅在它已存在時,首次需手動點按鈕)
- 跨裝置同步 Vault 時,只需要這一份筆記就能帶著 Claude 記憶重點走;檔名含主機名,多台裝置各自一份不互相衝突
- 內容相同的專案索引會自動去重,筆記保持精簡

### MD → HTML 匯出
- **匯出 HTML(單篇)**:產生一個完全自包含的 `.html` — CSS 內嵌、本地圖片轉 base64 內嵌、自動跟隨系統淺色 / 深色主題,單檔即可離線閱讀或傳給別人
- **匯出 Vault(整庫)**:把所有筆記轉成靜態 HTML 網站 — 保留資料夾結構、`[[wikilink]]` 與 `.md` 連結自動改寫成 `.html`、附件一併複製、自動產生 `index.html` 總覽頁

## 專案結構

```
main.js            Electron 主程序(視窗與系統對話框)
lib/markdown.js    Markdown 渲染核心(App 預覽與匯出共用)
lib/exporter.js    HTML 匯出(單檔自包含 / 整個 Vault)
src/               App 介面(index.html / styles.css / renderer.js)
test/              渲染與匯出測試(npm test)
SampleVault/       範例筆記庫
```

## 測試

```bash
npm test
```
