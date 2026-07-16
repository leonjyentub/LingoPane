import { useState } from "react";

export type PdfOutlineItem = {
  title: string;
  bold: boolean;
  italic: boolean;
  dest: string | unknown[] | null;
  url: string | null;
  items: PdfOutlineItem[];
};

type OutlineSidebarProps = {
  items: PdfOutlineItem[];
  loading: boolean;
  onClose: () => void;
  onSelect: (item: PdfOutlineItem) => void;
};

function OutlineBranch({ item, depth, onSelect }: { item: PdfOutlineItem; depth: number; onSelect: (item: PdfOutlineItem) => void }) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = item.items.length > 0;

  return (
    <li>
      <div className="outline-row" style={{ paddingLeft: 10 + depth * 16 }}>
        {hasChildren ? (
          <button
            className="outline-disclosure"
            onClick={() => setExpanded((current) => !current)}
            aria-label={expanded ? `收合 ${item.title}` : `展開 ${item.title}`}
            aria-expanded={expanded}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : <span className="outline-leaf" aria-hidden="true">•</span>}
        <button
          className="outline-link"
          style={{ fontWeight: item.bold ? 700 : undefined, fontStyle: item.italic ? "italic" : undefined }}
          onClick={() => onSelect(item)}
          disabled={!item.dest && !item.url}
          title={item.title}
        >
          {item.title || "未命名項目"}
        </button>
      </div>
      {hasChildren && expanded && (
        <ul>{item.items.map((child, index) => <OutlineBranch key={`${child.title}-${index}`} item={child} depth={depth + 1} onSelect={onSelect} />)}</ul>
      )}
    </li>
  );
}

export function OutlineSidebar({ items, loading, onClose, onSelect }: OutlineSidebarProps) {
  return (
    <aside className="outline-sidebar" aria-label="文件目錄">
      <header>
        <div>
          <strong>目錄</strong>
          <span>PDF 內建目錄</span>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="關閉目錄">×</button>
      </header>
      <nav aria-label="PDF 內建目錄">
        {loading ? <p className="outline-empty">正在讀取目錄…</p> : items.length ? (
          <ul>{items.map((item, index) => <OutlineBranch key={`${item.title}-${index}`} item={item} depth={0} onSelect={onSelect} />)}</ul>
        ) : (
          <p className="outline-empty">這份 PDF 沒有內建目錄。<br />目前不會混用 AI 推測標題。</p>
        )}
      </nav>
    </aside>
  );
}
