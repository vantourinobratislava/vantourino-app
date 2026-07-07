/*
 * Podium — celebratory top-3 display for the final results screen.
 *
 * Pure presentation: takes the already-ranked results (objects with rank,
 * teamName/name, totalPoints/points) and renders a podium with 1st place
 * emphasized in the center, 2nd to the left, 3rd to the right. Gracefully
 * handles 1 or 2 teams (missing places are simply not rendered) and ties
 * (entries share a rank number from the backend; we still place them in list
 * order). No scoring logic here — it only reads what it's given.
 *
 * `highlightTeamId` (optional) marks "your team" on the team screen.
 */

const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

function place(results, rank) {
  // First entry with this rank (ties: the earliest in the ranked list).
  return results.find((r) => r.rank === rank) || null;
}

function teamLabel(r) {
  return r.teamName != null ? r.teamName : r.name;
}
function teamPoints(r) {
  return r.totalPoints != null ? r.totalPoints : r.points;
}

export function Podium({ results, highlightTeamId = null }) {
  if (!results || results.length === 0) return null;

  const first = place(results, 1);
  const second = place(results, 2);
  const third = place(results, 3);
  if (!first) return null;

  const Step = ({ entry, position }) => {
    if (!entry) return <div className={`podium__col podium__col--${position} podium__col--empty`} aria-hidden="true" />;
    const mine = highlightTeamId != null && entry.teamId === highlightTeamId;
    return (
      <div className={`podium__col podium__col--${position}${mine ? ' podium__col--me' : ''}`}>
        <div className="podium__medal" aria-hidden="true">{MEDALS[position]}</div>
        <div className="podium__name" title={teamLabel(entry)}>{teamLabel(entry)}</div>
        <div className="podium__points">{teamPoints(entry)} pts</div>
        <div className={`podium__block podium__block--${position}`}>
          <span className="podium__rank">{position}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="podium-wrap">
      <div className="podium__confetti" aria-hidden="true">
        {Array.from({ length: 14 }).map((_, i) => (
          <span key={i} className={`confetti confetti--${i % 7}`} style={{ left: `${(i * 7 + 3) % 100}%`, animationDelay: `${(i % 5) * 0.25}s` }} />
        ))}
      </div>

      <div className="podium" role="img" aria-label={`Winner: ${teamLabel(first)} with ${teamPoints(first)} points`}>
        <Step entry={second} position={2} />
        <Step entry={first} position={1} />
        <Step entry={third} position={3} />
      </div>
    </div>
  );
}
