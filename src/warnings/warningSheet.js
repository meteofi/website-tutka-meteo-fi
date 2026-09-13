import { LEVELS, WARNING_TYPES } from './warningData';

export const warningTime = (ms) => new Date(ms).toLocaleString('fi-FI', {
  day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
});

function element(tag, className, content) {
  const el = document.createElement(tag);
  el.className = className;
  if (content) el.textContent = content;
  return el;
}

// Meteoalarm uses pipes to delimit bullet items; keep the original wording.
function originalText(content) {
  if (!content.includes('|')) return element('p', '', content);
  const list = element('ul', '');
  content.split('|').filter((item) => item.trim()).forEach((item) => list.append(element('li', '', item)));
  return list;
}

function textSection(title, content, className = '') {
  const section = element('section', `warning-text-section ${className}`.trim());
  const heading = element('h4', '', `${title}:`);
  heading.lang = 'fi';
  section.append(heading, content);
  return section;
}

export default function createWarningSheet({
  onWindow, onScope, onLocate, onRetry,
}) {
  const summary = element('button', 'warning-summary');
  summary.type = 'button';
  summary.hidden = true;
  summary.setAttribute('aria-haspopup', 'dialog');
  summary.innerHTML = '<span class="material-icons" aria-hidden="true">warning_amber</span><span class="warning-summary-copy"><strong>Säävaroitukset</strong><span class="warning-summary-status" aria-live="polite"></span></span><span aria-hidden="true">⌃</span>';
  const dialog = element('dialog', 'warning-sheet');
  dialog.setAttribute('aria-labelledby', 'warning-title');
  dialog.innerHTML = `
    <header class="warning-sheet-head">
      <div><div class="warning-eyebrow">METEOALARM · EUROOPPA</div><h2 id="warning-title">Säävaroitukset</h2></div>
      <button type="button" class="warning-close" aria-label="Sulje säävaroitukset">✕</button>
    </header>
    <div class="warning-controls">
      <div class="warning-segments" role="group" aria-label="Varoitusten ajanjakso">
        <button type="button" data-window="now" aria-pressed="true">Voimassa nyt</button>
        <button type="button" data-window="day" aria-pressed="false">Seuraavat 24 h</button>
      </div>
      <p class="warning-clock-note">Nykyhetkestä eteenpäin · ei seuraa tutkan aikajanaa</p>
      <div class="warning-legend" role="group" aria-label="Varoitusvärien merkitys"></div>
      <p class="warning-clock-note">Katkoviiva kartalla = varoitus alkaa myöhemmin</p>
      <div class="warning-scope"><label><input type="checkbox"> Kaikki alueet kartan ulkopuoleltakin</label></div>
      <p class="warning-feed-status" role="status"></p>
      <button type="button" class="warning-retry" hidden>Yritä uudelleen</button>
    </div>
    <div class="warning-list"></div>
    <footer>Varoitukset: Meteoalarm ja kansalliset sääpalvelut. Aineiston puuttuminen ei tarkoita vaaratonta säätä.</footer>`;
  const legend = dialog.querySelector('.warning-legend');
  Object.entries(LEVELS).forEach(([code, level]) => {
    const item = element('span', '', `${level.marks} ${level.legendLabel}`);
    item.dataset.level = code;
    item.setAttribute('aria-label', `${level.colorLabel}: ${level.legendLabel}`);
    legend.append(item);
  });
  document.body.append(summary, dialog);
  const list = dialog.querySelector('.warning-list');
  const status = dialog.querySelector('.warning-feed-status');
  const retry = dialog.querySelector('.warning-retry');
  let lastListKey = '';
  let returnFocus = null;

  function open() {
    if (dialog.open) return;
    returnFocus = document.activeElement;
    dialog.showModal();
    dialog.querySelector('.warning-close').focus();
  }
  summary.addEventListener('click', open);
  dialog.querySelector('.warning-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    if (returnFocus?.isConnected && !returnFocus.hidden) returnFocus.focus();
  });
  // Keep app/map keyboard shortcuts from firing while reading a warning.
  dialog.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button:not([disabled]), input, a[href]')]
      .filter((el) => el.getClientRects().length);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  dialog.addEventListener('keyup', (event) => event.stopPropagation());
  dialog.querySelectorAll('[data-window]').forEach((button) => {
    button.addEventListener('click', () => {
      dialog.querySelectorAll('[data-window]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      onWindow(button.dataset.window === 'day');
    });
  });
  dialog.querySelector('input').addEventListener('change', (event) => onScope(event.target.checked));
  retry.addEventListener('click', onRetry);

  function update({
    enabled, enabledTypes, warnings, count, highestLevel, now, loading, failed, lastSuccess, upcoming, allAreas, selectedIds,
  }) {
    summary.hidden = !enabled;
    if (!enabled) { if (dialog.open) dialog.close(); return; }
    const title = enabledTypes.size === 1 ? WARNING_TYPES[[...enabledTypes][0]].label : 'Säävaroitukset';
    summary.querySelector('strong').textContent = title;
    dialog.querySelector('h2').textContent = title;
    const stale = failed || (lastSuccess && now - lastSuccess > 10 * 60 * 1000);
    const range = upcoming ? '24 h' : 'nyt';
    let message = `${count} ${count === 1 ? 'varoitus' : 'varoitusta'} kartalla · ${range}`;
    if (!count) message = `Ei varoituksia kartalla · ${range}`;
    if (!lastSuccess) message = loading ? 'Haetaan varoituksia…' : 'Varoituksia ei voitu ladata';
    else if (stale) message = 'Tiedot voivat olla vanhentuneita';
    summary.querySelector('.warning-summary-status').textContent = message;
    summary.dataset.level = highestLevel || '';
    summary.classList.toggle('is-stale', !!stale);
    status.textContent = !lastSuccess ? message : `${stale ? 'Päivitys epäonnistui. ' : ''}Päivitetty ${warningTime(lastSuccess)} · ajat laitteen aikavyöhykkeellä`;
    const hideRetry = loading || (!stale && !!lastSuccess);
    if (hideRetry && document.activeElement === retry) dialog.querySelector('.warning-close').focus();
    retry.hidden = hideRetry;
    retry.disabled = loading;
    const key = JSON.stringify([lastSuccess, loading, !!stale, warnings.map((w) => [w.id, w.start > now]), selectedIds, allAreas]);
    if (key === lastListKey) return;
    lastListKey = key;
    list.replaceChildren();
    if (!warnings.length) {
      const empty = element('div', 'warning-empty');
      empty.append(element('strong', '', stale ? 'Ajantasaisia varoitustietoja ei ole saatavilla'
        : lastSuccess ? 'Ei varoituksia tässä näkymässä' : loading ? 'Haetaan varoituksia…' : 'Varoitustietoja ei ole saatavilla'));
      empty.append(element('p', '', stale ? 'Tarkista yhteys ja yritä uudelleen. Viimeisimmät tiedot voivat olla puutteellisia.' : lastSuccess
        ? 'Vaihda ajanjaksoa tai näytä kaikki alueet. Varoitukset kuvaavat alueellista säävaaraa.'
        : loading ? 'Haetaan viimeisimmät viranomaisten julkaisemat varoitukset.' : 'Tarkista yhteys ja yritä uudelleen.'));
      list.append(empty);
    }
    warnings.forEach((warning) => {
      const level = LEVELS[warning.level];
      const type = WARNING_TYPES[warning.type];
      const card = element('article', 'warning-card');
      card.dataset.level = warning.level;
      card.dataset.warningId = warning.id;
      const future = warning.start > now;
      card.append(element('div', 'warning-badge', `${type.symbol} ${level.marks} · ${future ? 'Alkaa myöhemmin' : 'Voimassa nyt'}`));
      card.append(element('h3', '', `${level.colorLabel} ${type.singular}`));
      card.append(element('p', 'warning-area', warning.area));
      card.append(element('p', 'warning-validity', `${warningTime(warning.start)} – ${warningTime(warning.expires)}`));
      if (warning.end < warning.expires) {
        card.append(element('p', 'warning-clock-note', `Aineiston mukainen päättyminen: ${warningTime(warning.end)}`));
      }
      const original = element('div', 'warning-original');
      if (warning.language) original.lang = warning.language;
      const description = warning.description.trim() ? warning.description : warning.headline;
      if (description) original.append(textSection('Varoitusteksti', originalText(description)));
      if (warning.impacts.length) {
        const impacts = element('ul', 'warning-impacts');
        warning.impacts.forEach((impact) => impacts.append(element('li', '', impact)));
        original.append(textSection('Vaikutukset', impacts));
      }
      if (warning.instruction.trim()) {
        original.append(textSection('Toimintaohje', originalText(warning.instruction), 'warning-instruction'));
      }
      card.append(original);
      const attribution = element('div', 'warning-attribution');
      attribution.append(element('p', 'warning-issuer', `Lähde: ${warning.sender || 'Meteoalarm'}`));
      if (warning.language) attribution.append(element('p', 'warning-issuer', `Alkuperäinen tiedote · ${warning.language}`));
      if (warning.sent) attribution.append(element('p', 'warning-issuer', `Julkaistu ${warningTime(warning.sent)}`));
      if (warning.web) {
        const link = element('a', 'warning-source-link', 'Lue viranomaisen tiedote ↗');
        link.href = warning.web;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        attribution.append(link);
      }
      card.append(attribution);
      const locate = element('button', 'warning-locate', 'Näytä alue kartalla');
      locate.type = 'button';
      locate.addEventListener('click', () => { dialog.close(); onLocate(warning.id); });
      card.append(locate);
      list.append(card);
    });
    if (selectedIds?.length && dialog.open) {
      const selectedCard = [...list.children].find((card) => selectedIds.includes(card.dataset.warningId));
      selectedCard?.scrollIntoView({ block: 'start' });
    }
  }
  return { update, open };
}
