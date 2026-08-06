import type { Translator } from "../i18n";

export type RenderMode = "faithful" | "adaptive" | "bilingual";

type ExportDialogProps = {
  renderMode: RenderMode;
  onModeChange: (mode: RenderMode) => void;
  onExport: () => void;
  onCancel: () => void;
  exporting: boolean;
  hasTranslations: boolean;
  t: Translator;
};

export function ExportDialog({
  renderMode,
  onModeChange,
  onExport,
  onCancel,
  exporting,
  hasTranslations,
  t,
}: ExportDialogProps) {
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <section className="export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-title">
          <div>
            <span id="export-title">{t("exportPdf")}</span>
            <small>{t("renderMode")}</small>
          </div>
          <button className="icon-button" onClick={onCancel} aria-label={t("close")}>×</button>
        </div>

        <div className="export-options">
          <label className={`export-option ${renderMode === "faithful" ? "is-selected" : ""}`}>
            <input
              type="radio"
              name="renderMode"
              value="faithful"
              checked={renderMode === "faithful"}
              onChange={() => onModeChange("faithful")}
            />
            <div className="export-option-content">
              <strong>{t("renderFaithful")}</strong>
              <span className="export-option-desc">{t("renderModeHelp").split(".")[0]}.</span>
            </div>
          </label>

          <label className={`export-option ${renderMode === "adaptive" ? "is-selected" : ""}`}>
            <input
              type="radio"
              name="renderMode"
              value="adaptive"
              checked={renderMode === "adaptive"}
              onChange={() => onModeChange("adaptive")}
            />
            <div className="export-option-content">
              <strong>{t("renderAdaptive")}</strong>
              <span className="export-option-desc">{t("renderModeHelp").split(".")[1]?.trim()}.</span>
            </div>
          </label>

          <label className={`export-option ${renderMode === "bilingual" ? "is-selected" : ""}`}>
            <input
              type="radio"
              name="renderMode"
              value="bilingual"
              checked={renderMode === "bilingual"}
              onChange={() => onModeChange("bilingual")}
            />
            <div className="export-option-content">
              <strong>{t("renderBilingual")}</strong>
              <span className="export-option-desc">{t("renderModeHelp").split(".")[2]?.trim()}.</span>
            </div>
          </label>
        </div>

        <div className="modal-actions">
          <button className="secondary-button" onClick={onCancel} disabled={exporting}>{t("close")}</button>
          <button className="primary-button" onClick={onExport} disabled={exporting || !hasTranslations}>
            {exporting ? t("exportingPdf") : t("exportPdf")}
          </button>
        </div>
      </section>
    </div>
  );
}
