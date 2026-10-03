// Loaded on every page: local time zone, copy buttons and confirmation prompts.
import { copyText, shareBase } from './util';

const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const compact = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const currentYear = new Date().getFullYear();

for (const time of document.querySelectorAll<HTMLTimeElement>('time[datetime]')) {
  const date = new Date(time.dateTime);
  if (Number.isNaN(date.getTime())) continue;
  time.title = time.textContent ?? '';
  // tables are narrow: drop the year for dates in the current year
  const inTable = time.closest('td') !== null && date.getFullYear() === currentYear;
  time.textContent = (inTable ? compact : full).format(date);
}

document.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-copy-path]');
  if (target?.dataset.copyPath) {
    event.preventDefault();
    void copyText(shareBase() + target.dataset.copyPath, target);
  }
});

document.addEventListener('submit', (event) => {
  const message = (event.target as HTMLElement | null)?.getAttribute('data-confirm');
  if (message && !confirm(message)) event.preventDefault();
});
