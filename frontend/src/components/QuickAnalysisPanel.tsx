interface QuickAnalysisCard {
  id: string;
  title: string;
  description: string;
  cta: string;
  action: "quick" | "layers" | "analytics";
  icon: JSX.Element;
}

const ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const CARDS: QuickAnalysisCard[] = [
  {
    id: "drain-encroachment",
    title: "Drain Encroachment Check",
    description: "Shows every surveyed closed-drain segment directly on the cadastral map with a red cross marker.",
    cta: "View on map",
    action: "quick",
    icon: <svg {...ICON_PROPS}><path d="M3 12h18M3 12c2-4 5-4 7 0s5 4 7 0" /><path d="M3 17h18" /></svg>,
  },
  {
    id: "utility-tracker",
    title: "Utility Asset Tracker",
    description: "Every pole, manhole, and lighting fixture in the survey, grouped by category with live counts.",
    cta: "View on map",
    action: "quick",
    icon: <svg {...ICON_PROPS}><path d="M14.7 6.3 17.7 9.3 9 18l-4 1 1-4Z" /><path d="M13 8l3 3" /></svg>,
  },
  {
    id: "asset-catalog",
    title: "Full Asset Catalog",
    description: "Every mapped feature with its type, location, and recorded condition — pick an asset to drill in.",
    cta: "View catalog",
    action: "quick",
    icon: <svg {...ICON_PROPS}><rect x="4" y="4" width="16" height="4.5" rx="1" /><rect x="4" y="10.2" width="16" height="4.5" rx="1" /><rect x="4" y="16.4" width="16" height="4.5" rx="1" /></svg>,
  },
  {
    id: "survey-kpis",
    title: "Survey KPIs",
    description: "Headline metrics for this survey — inspection completeness, response time, and dataset coverage.",
    cta: "View dashboard",
    action: "quick",
    icon: <svg {...ICON_PROPS}><path d="M4 20V10m6.5 10V4m6.5 16v-7" /></svg>,
  },
  {
    id: "manhole-detail",
    title: "Manhole Detail View",
    description: "Per-manhole location, condition, depth, and pipe attributes for maintenance planning.",
    cta: "View on map",
    action: "quick",
    icon: <svg {...ICON_PROPS}><circle cx="12" cy="12" r="8.5" /><path d="M8.3 9.7h7.4M8.3 12h7.4M8.3 14.3h7.4" /></svg>,
  },
  {
    id: "road-width",
    title: "Road Width Check",
    description: "Every road segment where the carriageway narrows below the local average, drawn on the cadastral map.",
    cta: "View on map",
    action: "quick",
    icon: <svg {...ICON_PROPS}><path d="M4 9h16M4 15h16" /><path d="M8 9V6m8 3V6M8 18v-3m8 3v-3" /></svg>,
  },
  {
    id: "pothole-check",
    title: "Pothole Surface Check",
    description: "Pothole and road-depression records with depth, elevation, surface type, and repair context.",
    cta: "View on map",
    action: "quick",
    icon: <svg {...ICON_PROPS}><path d="M4 12c2.2-2.5 4.4-2.5 6.6 0s4.6 2.5 9.4-.2" /><path d="M8.5 15.5c.7 1.6 2 2.5 3.6 2.5s3-.9 3.8-2.6" /><path d="M10 9.5h.01M14.5 10.5h.01" /></svg>,
  },
  {
    id: "standing-water",
    title: "Standing Water Check",
    description: "Waterlogging and ponding records with water depth, level/elevation evidence, and road-surface details.",
    cta: "View on map",
    action: "quick",
    icon: <svg {...ICON_PROPS}><path d="M4 15c1.8-1.6 3.6-1.6 5.4 0s3.7 1.6 5.6 0 3.4-1.6 5 0" /><path d="M8 10c1.3-1.2 2.7-1.2 4 0s2.7 1.2 4 0" /><path d="M12 4c1.8 2.2 2.7 3.8 2.7 5a2.7 2.7 0 1 1-5.4 0c0-1.2.9-2.8 2.7-5Z" /></svg>,
  },
];

interface QuickAnalysisPanelProps {
  selectedCardId: string | null;
  onSelectCard: (cardId: string) => void;
}

export function QuickAnalysisPanel({ selectedCardId, onSelectCard }: QuickAnalysisPanelProps) {
  const handleClick = (card: QuickAnalysisCard) => {
    onSelectCard(card.id);
  };

  return (
    <div className="quick-analysis-panel" data-testid="quick-analysis-panel">
      <div className="quick-analysis-panel__head">
        <h2>Quick Analysis</h2>
        <p>Jump straight to a survey check or dashboard without leaving the map.</p>
      </div>
      <div className="quick-analysis-panel__grid">
        {CARDS.map((card) => (
          <button
            key={card.id}
            type="button"
            className={`quick-analysis-card${selectedCardId === card.id ? " quick-analysis-card--active" : ""}`}
            onClick={() => handleClick(card)}
            data-testid={`quick-analysis-card-${card.id}`}
          >
            <span className="quick-analysis-card__icon">{card.icon}</span>
            <span className="quick-analysis-card__title">{card.title}</span>
            <p className="quick-analysis-card__desc">{card.description}</p>
            <span className="quick-analysis-card__cta">
              {card.cta}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
