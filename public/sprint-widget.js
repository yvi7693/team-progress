// Виджет текущего спринта на главном экране: круговая диаграмма с прогрессом
// спринта по Say/Do (SP, закрытые из плана ÷ SP плана) и номером спринта. Ведёт на /sprint.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function sprintStatHtml(t) {
  const c = t?.current;
  if (!c) return '';
  const p = Math.max(0, Math.min(100, c.percent));
  // Окружность длиной 100 (pathLength): заливка — первые p единиц, отсчёт с 12 часов.
  return `<a class="stat sprintw${p === 100 ? ' full' : ''}" href="/sprint" title="Say/Do: закрыто ${esc(c.doneSP)} из ${esc(c.totalSP)} SP плана">
    <span class="gauge" role="img" aria-label="Спринт ${esc(c.id)}: Say/Do ${p}%">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle class="trk" cx="32" cy="32" r="27" pathLength="100"/>
        <circle class="val" cx="32" cy="32" r="27" pathLength="100" style="stroke-dasharray:${p} 100"/>
      </svg>
      <b>${p}<small>%</small></b>
    </span>
    <span class="lbl">Спринт ${esc(c.id)}</span></a>`;
}
