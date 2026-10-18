/* global SESSIONS, Director, director */
// Renders the page for the director's values. Everything a reviewer can see is
// reachable from the bar: data states, the detail sheet, the compose dialog.
const $ = (id) => document.getElementById(id);

function rows(list) {
  return list
    .map(
      (s, i) => `<button class="row" type="button" data-i="${i}">
  <span class="face" aria-hidden="true">${s.agent[0]}</span>
  <span><span class="row-title">${s.title}</span><span class="row-meta">${s.agent} · ${s.when}</span></span>
  <span class="status ${s.status}">${s.status}</span>
</button>`
    )
    .join('');
}

function renderList(data) {
  const list = $('list');
  if (data === 'empty') {
    list.innerHTML = `<div class="empty"><h2>No sessions yet</h2><p>Start one and it shows up here.</p><button class="retry" type="button">New session</button></div>`;
  } else if (data === 'error') {
    list.innerHTML = `<div class="problem" role="alert"><h2>Couldn’t load sessions</h2><p>The server answered with an error.</p><button class="retry" type="button">Try again</button></div>`;
  } else if (data === 'offline') {
    list.innerHTML = `<div class="problem" role="status"><h2>You’re offline</h2><p>Sessions will appear when you’re back.</p></div>`;
  } else list.innerHTML = rows(data === 'one' ? SESSIONS.slice(0, 1) : SESSIONS);
  const n = data === 'one' ? 1 : data === 'many' ? SESSIONS.length : 0;
  $('sub').textContent =
    data === 'error' || data === 'offline' ? 'Something’s wrong' : n ? `${n} today` : 'Nothing yet';
}

function renderSheet(open) {
  const sheet = $('sheet');
  sheet.hidden = !open;
  if (open)
    sheet.innerHTML = `<h2>${SESSIONS[0].title}</h2><p>${SESSIONS[0].agent} · running</p><ol class="steps"><li>Read the spring tests</li><li>Try damping 40</li><li>Record both themes</li></ol>`;
}

Director.create({
  name: 'Example · Sessions',
  scenarios: [{ key: 'data', label: 'Data', options: Director.DATA, default: 'many' }],
  lenses: [
    {
      key: 'theme',
      label: 'Theme',
      options: [
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ],
      default: 'light',
    },
    { key: 'motion', label: 'Reduce motion', type: 'toggle' },
  ],
  states: [
    { key: 'detail', label: 'Session detail' },
    { key: 'compose', label: 'New session dialog' },
  ],
  play: {
    label: 'Play the morning',
    steps: [
      { label: 'First light', state: { data: 'empty' } },
      { label: 'One running', state: { data: 'one' } },
      { label: 'Busy', state: { data: 'many', state: 'detail' } },
      { label: 'Dropped offline', state: { data: 'offline' } },
    ],
  },
  apply(v) {
    renderList(v.data);
    renderSheet(v.state === 'detail');
    $('compose').hidden = $('scrim').hidden = v.state !== 'compose';
  },
});

document.addEventListener('click', (e) => {
  if (e.target.closest('#newBtn, .retry')) director.set('state', 'compose');
  else if (e.target.closest('#cancel, #scrim')) director.set('state', null);
  else if (e.target.closest('.row')) director.set('state', 'detail');
});
