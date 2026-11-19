import type { PlexiaSlide } from "@plexia/shared";

interface FrequencyWord {
  word: string;
  count: number;
}

interface IdeaNode {
  idea: string;
  nickname: string;
}

interface Props {
  slide: PlexiaSlide;
  responseCount: number;
  frequencyWords: FrequencyWord[];
  ideas: IdeaNode[];
}

function uniqueIdeas(ideas: IdeaNode[]): IdeaNode[] {
  const seen = new Set<string>();
  return ideas.filter(({ idea }) => {
    const key = idea.trim().toLocaleLowerCase("de");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function safeLabel(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : fallback;
}

export function LiveSlideOverlay({ slide, responseCount, frequencyWords, ideas }: Props) {
  if (slide.type !== "wordcloud" && slide.type !== "mindmap") return null;

  const title = slide.type === "wordcloud" ? "Live-Wortwolke" : "Gemeinsame Mindmap";
  const nodes = uniqueIdeas(ideas);
  const centre = safeLabel(slide.content.prompt || slide.title, "Unser Thema");

  return (
    <div className={`live-slide-response-overlay live-slide-response-${slide.type}`} aria-live="polite">
      <div className="live-slide-response-badge"><i /> {title} · {responseCount} {responseCount === 1 ? "Antwort" : "Antworten"}</div>
      {slide.type === "wordcloud" ? (
        frequencyWords.length ? (
          <div className="live-wordcloud-canvas">
            {frequencyWords.slice(0, 28).map(({ word, count }, index) => (
              <span
                className={`live-wordcloud-word word-size-${Math.min(5, Math.max(1, count))}`}
                key={word}
                style={{ transform: `rotate(${((index * 17) % 9) - 4}deg)` }}
                title={`${count}× genannt`}
              >
                {word}
              </span>
            ))}
          </div>
        ) : (
          <div className="live-slide-response-empty">Die ersten Begriffe erscheinen hier live.</div>
        )
      ) : (
        <div className="live-mindmap-canvas">
          {nodes.map(({ idea }, index) => {
            const angle = (index / Math.max(nodes.length, 1)) * Math.PI * 2 - Math.PI / 2;
            const radius = nodes.length > 8 ? 35 : 38;
            const x = 50 + Math.cos(angle) * radius;
            const y = 50 + Math.sin(angle) * radius;
            const rotation = (Math.atan2(y - 50, x - 50) * 180) / Math.PI;
            const length = Math.sqrt((x - 50) ** 2 + (y - 50) ** 2);
            return (
              <span key={`${idea}-${index}`}>
                <i className="live-mindmap-branch" style={{ left: "50%", top: "50%", width: `${length}%`, transform: `rotate(${rotation}deg)` }} />
                <strong className={`live-mindmap-node branch-${index % 4}`} style={{ left: `${x}%`, top: `${y}%` }}>{idea}</strong>
              </span>
            );
          })}
          <strong className="live-mindmap-centre">{centre}</strong>
          {!nodes.length && <div className="live-slide-response-empty">Die ersten Ideen erscheinen hier live.</div>}
        </div>
      )}
    </div>
  );
}
