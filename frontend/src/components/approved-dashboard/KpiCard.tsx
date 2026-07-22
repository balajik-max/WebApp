type KpiCardProps = {
  icon: string;
  label: string;
  value: number | string;
  helper: string;
  tone?: "default" | "success" | "warning" | "danger";
};

export function KpiCard({
  icon,
  label,
  value,
  helper,
  tone = "default",
}: KpiCardProps) {
  return (
    <article className={`approved-kpi-card approved-kpi-card--${tone}`}>
      <div className="approved-kpi-card__top">
        <span className="approved-kpi-card__icon" aria-hidden="true">
          {icon}
        </span>
        <span className="approved-kpi-card__label">{label}</span>
      </div>

      <strong className="approved-kpi-card__value">
        {typeof value === "number" ? value.toLocaleString("en-IN") : value}
      </strong>

      <p className="approved-kpi-card__helper">{helper}</p>
    </article>
  );
}
