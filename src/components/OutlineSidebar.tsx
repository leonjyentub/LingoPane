import { useState } from "react";
import type { Translator } from "../i18n";

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
  t: Translator;
};

function OutlineBranch({ item, depth, onSelect, t }: { item: PdfOutlineItem; depth: number; onSelect: (item: PdfOutlineItem) => void; t: Translator }) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = item.items.length > 0;

  return (
    <li>
      <div className="outline-row" style={{ paddingLeft: 10 + depth * 16 }}>
        {hasChildren ? (
          <button
            className="outline-disclosure"
            onClick={() => setExpanded((current) => !current)}
            aria-label={t(expanded ? "collapseItem" : "expandItem", { title: item.title })}
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
          {item.title || t("unnamedOutline")}
        </button>
      </div>
      {hasChildren && expanded && (
        <ul>{item.items.map((child, index) => <OutlineBranch key={`${child.title}-${index}`} item={child} depth={depth + 1} onSelect={onSelect} t={t} />)}</ul>
      )}
    </li>
  );
}

export function OutlineSidebar({ items, loading, onClose, onSelect, t }: OutlineSidebarProps) {
  return (
    <aside className="outline-sidebar" aria-label={t("outline")}>
      <header>
        <div>
          <strong>{t("outline")}</strong>
          <span>{t("builtInOutline")}</span>
        </div>
        <button className="icon-button" onClick={onClose} aria-label={t("closeOutline")}>×</button>
      </header>
      <nav aria-label={t("builtInOutline")}>
        {loading ? <p className="outline-empty">{t("readingOutline")}</p> : items.length ? (
          <ul>{items.map((item, index) => <OutlineBranch key={`${item.title}-${index}`} item={item} depth={0} onSelect={onSelect} t={t} />)}</ul>
        ) : (
          <p className="outline-empty">{t("noOutline")}<br />{t("noAiOutline")}</p>
        )}
      </nav>
    </aside>
  );
}
