import type { FidelityFeature, FidelityWarning } from "@/engine/contract";

// Spanish wording for the fidelity banner shown after opening a file
// (`DocumentInfo.warnings`) and after saving (`SaveResult.lost`).

const FEATURE_LABELS: Record<FidelityFeature, readonly [singular: string, plural: string]> = {
  charts: ["gráfico", "gráficos"],
  images: ["imagen", "imágenes"],
  shapes: ["forma", "formas"],
  comments: ["comentario", "comentarios"],
  dataValidation: ["validación de datos", "validaciones de datos"],
  autoFilter: ["autofiltro", "autofiltros"],
  conditionalFormatting: ["formato condicional", "formatos condicionales"],
  pivotTables: ["tabla dinámica", "tablas dinámicas"],
  tables: ["tabla", "tablas"],
  macros: ["macros", "macros"],
  externalLinks: ["vínculo externo", "vínculos externos"],
  sparklines: ["minigráfico", "minigráficos"],
  slicers: ["segmentación", "segmentaciones"],
  other: ["otro elemento", "otros elementos"],
};

export function featureLabel(feature: FidelityFeature, count = 1): string {
  const [singular, plural] = FEATURE_LABELS[feature];
  return count === 1 ? singular : plural;
}

/** "3 gráficos", "1 comentario", "macros". */
export function describeWarning(warning: FidelityWarning): string {
  const label = featureLabel(warning.feature, warning.count);
  return warning.feature === "macros" ? label : `${warning.count} ${label}`;
}

export interface FidelitySummary {
  /** Kept unchanged on save. */
  readonly preserved: ReadonlyArray<string>;
  /** Understood and editable in Sheetlight. */
  readonly editable: ReadonlyArray<string>;
  /** Dropped when saving as .xlsx. */
  readonly lost: ReadonlyArray<string>;
  /** Banner text, or null when nothing will be lost. */
  readonly message: string | null;
}

function joinEs(items: ReadonlyArray<string>): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

export function summarizeFidelity(warnings: ReadonlyArray<FidelityWarning>): FidelitySummary {
  const pick = (onSave: FidelityWarning["onSave"]) =>
    warnings.filter((w) => w.onSave === onSave && w.count > 0).map(describeWarning);
  const lost = pick("lost");
  return {
    preserved: pick("preserved"),
    editable: pick("editable"),
    lost,
    message:
      lost.length === 0
        ? null
        : `Este archivo contiene ${joinEs(lost)} que Sheetlight no admite: se perderán al guardarlo.`,
  };
}

/** Message after a save that dropped features (`SaveResult.lost`). */
export function lostOnSaveMessage(lost: ReadonlyArray<FidelityFeature>): string | null {
  if (lost.length === 0) return null;
  const labels = lost.map((f) => featureLabel(f, 2));
  return `Se guardó el archivo sin ${joinEs(labels)}.`;
}
