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

// Only `faithful` is wired end-to-end today; `adaptive` and `bilingual` land
// with the flow planner (see docs/render-execution-plan.md PR-5/PR-6).
const RENDER_MODES: Array<{ value: RenderMode; available: boolean; labelKey: MessageKey; helpKey: MessageKey }> = [
  { value: "faithful", available: true, labelKey: "renderFaithful", helpKey: "renderFaithfulHelp" },
  { value: "adaptive", available: false, labelKey: "renderAdaptive", helpKey: "renderAdaptiveHelp" },
  { value: "bilingual", available: false, labelKey: "renderBilingual", helpKey: "renderBilingualHelp" },
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
          {RENDER_MODES.map(({ value, available, labelKey, helpKey }) => (
            <label
              key={value}
              className={`export-option ${renderMode === value ? "is-selected" : ""}${available ? "" : " is-unavailable"}`}
            >
              <input
                type="radio"
                name="renderMode"
                value={value}
                checked={renderMode === value}
                disabled={!available || exporting}
                onChange={() => onModeChange(value)}
              />
              <div className="export-option-content">
                <strong>{t(labelKey)}{available ? "" : ` ${t("comingSoon")}`}</strong>
                <span className="export-option-desc">{t(helpKey)}</span>
              </div>
            </label>
          ))}
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
