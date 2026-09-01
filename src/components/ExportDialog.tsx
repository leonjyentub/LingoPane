import type { MessageKey, Translator } from "../i18n";
import type { RenderMode } from "../lib/renderPlan";

export type { RenderMode };

type ExportDialogProps = {
  renderMode: RenderMode;
  onModeChange: (mode: RenderMode) => void;
  onExport: () => void;
  onCancel: () => void;
  exporting: boolean;
  hasTranslations: boolean;
  t: Translator;
};

const RENDER_MODES: Array<{ value: RenderMode; labelKey: MessageKey; helpKey: MessageKey }> = [
  { value: "faithful", labelKey: "renderFaithful", helpKey: "renderFaithfulHelp" },
  { value: "adaptive", labelKey: "renderAdaptive", helpKey: "renderAdaptiveHelp" },
];

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
          {RENDER_MODES.map(({ value, labelKey, helpKey }) => (
            <label key={value} className={`export-option ${renderMode === value ? "is-selected" : ""}`}>
              <input
                type="radio"
                name="renderMode"
                value={value}
                checked={renderMode === value}
                disabled={exporting}
                onChange={() => onModeChange(value)}
              />
              <div className="export-option-content">
                <strong>{t(labelKey)}</strong>
                <span className="export-option-desc">{t(helpKey)}</span>
              </div>
            </label>
          ))}
        </div>

        <p className="export-preview-note">{t("exportLayoutDiffers")}</p>

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
