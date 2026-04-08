import { api } from '../api.js';
import { renderGuidancePanel } from '../components/context-help.js';
import { createTabs } from '../components/tabs.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TAB_IDS = ['today', 'calendar', 'tasks', 'notes', 'people', 'library', 'briefs', 'routines'];

let currentContainer = null;
let flashTimer = null;
const boundContainers = new WeakSet();
const dirtyTabs = new Set();
const state = {
  activeTab: 'today',
  data: null,
  calendarCursor: startOfDay(Date.now()),
  calendarView: 'month',
  selectedCalendarDate: dayKey(new Date()),
  selectedCalendarEventId: null,
  creatingCalendarEvent: false,
  selectedTaskId: null,
  creatingTask: false,
  selectedNoteId: null,
  creatingNote: false,
  noteQuery: '',
  selectedPersonId: null,
  creatingPerson: false,
  selectedLinkId: null,
  creatingLink: false,
  selectedBriefId: null,
  selectedRoutineId: null,
  selectedRoutineTemplateId: null,
  creatingRoutine: false,
  todayCaptureKind: 'note',
  personQuery: '',
  personRelationship: 'all',
  linkQuery: '',
  linkKind: 'all',
  briefKind: 'all',
  routineQuery: '',
  routineStatus: 'all',
  routineCategory: 'all',
  flash: null,
};

export async function renderSecondBrain(container, options = {}) {
  currentContainer = container;
  state.activeTab = normalizeTab(options?.tab || state.activeTab);

  const shouldRefresh = options?.refresh !== false || !state.data;
  if (shouldRefresh) {
    container.innerHTML = '<div class="loading">Loading your day...</div>';
    try {
      state.data = await loadSecondBrainData();
      dirtyTabs.clear();
    } catch (error) {
      container.innerHTML = `<div class="loading">Error: ${esc(error instanceof Error ? error.message : String(error))}</div>`;
      return;
    }
  }

  synchronizeStateWithData();
  paint(container);
}

export function updateSecondBrain(_container, options = {}) {
  if (!currentContainer) return;
  const invalidations = Array.isArray(options?.invalidations)
    ? options.invalidations.filter((payload) => Array.isArray(payload?.topics) && payload.topics.includes('second-brain'))
    : [];
  if (invalidations.length === 0) {
    void renderSecondBrain(currentContainer, { tab: state.activeTab, refresh: true });
    return;
  }
  const impactedTabs = collectDirtySecondBrainTabs(invalidations);
  for (const tabId of impactedTabs) {
    dirtyTabs.add(tabId);
  }
  if (!dirtyTabs.has(state.activeTab)) {
    return;
  }
  void refreshSecondBrainTabs([state.activeTab]);
}

function paint(container) {
  if (!state.data) {
    container.innerHTML = '<div class="loading">Loading your day...</div>';
    return;
  }

  container.innerHTML = state.flash
    ? `
      <section class="sb-shell sb-shell--compact" data-sb-flash-shell>
        ${renderFlash(state.flash)}
      </section>
    `
    : '';

  const tabsContainer = document.createElement('div');
  tabsContainer.className = 'sb-tabs';
  container.appendChild(tabsContainer);

  const tabs = createTabs(tabsContainer, [
    { id: 'today', label: 'Today', render: (panel) => renderToday(panel, state.data) },
    { id: 'calendar', label: 'Calendar', render: (panel) => renderCalendar(panel, state.data) },
    { id: 'tasks', label: 'Tasks', render: (panel) => renderTasks(panel, state.data) },
    { id: 'notes', label: 'Notes', render: (panel) => renderNotes(panel, state.data) },
    { id: 'people', label: 'Contacts', render: (panel) => renderPeople(panel, state.data) },
    { id: 'library', label: 'Library', render: (panel) => renderLibrary(panel, state.data) },
    { id: 'briefs', label: 'Briefs', render: (panel) => renderBriefs(panel, state.data) },
    { id: 'routines', label: 'Routines', render: (panel) => renderRoutines(panel, state.data) },
  ], state.activeTab);

  tabsContainer.querySelector('.tab-bar')?.addEventListener('click', (event) => {
    const button = event.target.closest('.tab-btn');
    if (!button?.dataset.tabId) return;
    state.activeTab = normalizeTab(button.dataset.tabId);
    if (dirtyTabs.has(state.activeTab)) {
      void refreshSecondBrainTabs([state.activeTab]);
    }
  });
  tabs.switchTo(state.activeTab);

  bindInteractions(container);
}

function syncFlashBanner() {
  if (!currentContainer) return;
  const existing = currentContainer.querySelector('[data-sb-flash-shell]');
  if (!state.flash) {
    existing?.remove();
    return;
  }
  const markup = `
    <section class="sb-shell sb-shell--compact" data-sb-flash-shell>
      ${renderFlash(state.flash)}
    </section>
  `;
  if (existing) {
    existing.outerHTML = markup;
    return;
  }
  currentContainer.insertAdjacentHTML('afterbegin', markup);
}

async function loadSecondBrainData() {
  const now = Date.now();
  const { focusWindowStart, focusWindowEnd } = getSecondBrainFocusWindow(now);
  const calendarRange = getCalendarViewRange(state.calendarCursor, state.calendarView);

  const [overview, focusEvents, calendarEvents, tasks, notes, people, links, routineCatalog, routines, briefs] = await Promise.all([
    api.secondBrainOverview(),
    api.secondBrainCalendar({
      fromTime: focusWindowStart.getTime(),
      toTime: focusWindowEnd.getTime(),
      limit: 200,
    }),
    api.secondBrainCalendar({
      fromTime: calendarRange.start.getTime(),
      toTime: calendarRange.end.getTime(),
      limit: calendarRange.limit,
    }),
    api.secondBrainTasks({ limit: 200 }),
    api.secondBrainNotes({ limit: 200, includeArchived: true }),
    api.secondBrainPeople({ limit: 200 }),
    api.secondBrainLinks({ limit: 200 }),
    api.secondBrainRoutineCatalog(),
    api.secondBrainRoutines(),
    api.secondBrainBriefs({ limit: 100 }),
  ]);

  return {
    now,
    overview,
    focusEvents,
    calendarEvents,
    tasks,
    notes,
    people,
    links,
    routineCatalog,
    routines,
    briefs,
    calendarRange,
  };
}

function getSecondBrainFocusWindow(now = Date.now()) {
  return {
    focusWindowStart: startOfDay(new Date(now - (7 * DAY_MS))),
    focusWindowEnd: endOfDay(new Date(now + (7 * DAY_MS))),
  };
}

async function loadSecondBrainTabData(tabId) {
  const now = Date.now();
  const { focusWindowStart, focusWindowEnd } = getSecondBrainFocusWindow(now);
  const calendarRange = getCalendarViewRange(state.calendarCursor, state.calendarView);

  switch (tabId) {
    case 'today': {
      const [overview, focusEvents, tasks, notes, people, briefs] = await Promise.all([
        api.secondBrainOverview(),
        api.secondBrainCalendar({
          fromTime: focusWindowStart.getTime(),
          toTime: focusWindowEnd.getTime(),
          limit: 200,
        }),
        api.secondBrainTasks({ limit: 200 }),
        api.secondBrainNotes({ limit: 200, includeArchived: true }),
        api.secondBrainPeople({ limit: 200 }),
        api.secondBrainBriefs({ limit: 100 }),
      ]);
      return { now, overview, focusEvents, tasks, notes, people, briefs };
    }
    case 'calendar': {
      const [focusEvents, calendarEvents] = await Promise.all([
        api.secondBrainCalendar({
          fromTime: focusWindowStart.getTime(),
          toTime: focusWindowEnd.getTime(),
          limit: 200,
        }),
        api.secondBrainCalendar({
          fromTime: calendarRange.start.getTime(),
          toTime: calendarRange.end.getTime(),
          limit: calendarRange.limit,
        }),
      ]);
      return { now, focusEvents, calendarEvents, calendarRange };
    }
    case 'tasks':
      return {
        now,
        tasks: await api.secondBrainTasks({ limit: 200 }),
      };
    case 'notes':
      return {
        now,
        notes: await api.secondBrainNotes({ limit: 200, includeArchived: true }),
      };
    case 'people':
      return {
        now,
        people: await api.secondBrainPeople({ limit: 200 }),
      };
    case 'library':
      return {
        now,
        links: await api.secondBrainLinks({ limit: 200 }),
      };
    case 'briefs': {
      const [briefs, focusEvents, calendarEvents] = await Promise.all([
        api.secondBrainBriefs({ limit: 100 }),
        api.secondBrainCalendar({
          fromTime: focusWindowStart.getTime(),
          toTime: focusWindowEnd.getTime(),
          limit: 200,
        }),
        api.secondBrainCalendar({
          fromTime: calendarRange.start.getTime(),
          toTime: calendarRange.end.getTime(),
          limit: calendarRange.limit,
        }),
      ]);
      return { now, briefs, focusEvents, calendarEvents, calendarRange };
    }
    case 'routines': {
      const [routineCatalog, routines] = await Promise.all([
        api.secondBrainRoutineCatalog(),
        api.secondBrainRoutines(),
      ]);
      return { now, routineCatalog, routines };
    }
    default:
      return loadSecondBrainData();
  }
}

async function refreshSecondBrainTabs(tabIds) {
  if (!currentContainer || !state.data) return;
  const uniqueTabs = [...new Set((tabIds || []).map((tabId) => normalizeTab(tabId)).filter(Boolean))];
  if (uniqueTabs.length === 0) return;

  const partialResults = await Promise.all(uniqueTabs.map((tabId) => loadSecondBrainTabData(tabId)));
  state.data = partialResults.reduce((nextData, partial) => ({
    ...nextData,
    ...partial,
  }), { ...state.data });
  for (const tabId of uniqueTabs) {
    dirtyTabs.delete(tabId);
  }
  synchronizeStateWithData();
  paint(currentContainer);
}

function collectDirtySecondBrainTabs(invalidations) {
  const impactedTabs = new Set();
  for (const payload of invalidations || []) {
    for (const tabId of tabsForSecondBrainInvalidation(payload)) {
      impactedTabs.add(tabId);
    }
  }
  return impactedTabs;
}

function tabsForSecondBrainInvalidation(payload) {
  const signature = `${String(payload?.reason || '')} ${String(payload?.path || '')}`.toLowerCase();
  if (!signature.trim()) {
    return TAB_IDS;
  }
  if (signature.includes('calendar')) {
    return ['calendar', 'today'];
  }
  if (signature.includes('task')) {
    return ['tasks', 'today'];
  }
  if (signature.includes('note')) {
    return ['notes', 'today'];
  }
  if (signature.includes('person') || signature.includes('people')) {
    return ['people', 'today'];
  }
  if (signature.includes('link') || signature.includes('library')) {
    return ['library'];
  }
  if (signature.includes('brief')) {
    return ['briefs', 'today'];
  }
  if (signature.includes('routine')) {
    return ['routines', 'today'];
  }
  if (signature.includes('overview') || signature.includes('usage')) {
    return ['today'];
  }
  return TAB_IDS;
}

function synchronizeStateWithData() {
  if (!state.data) return;

  const visibleRange = getCalendarViewRange(state.calendarCursor, state.calendarView);
  const selectedDate = parseDayKey(state.selectedCalendarDate);
  if (selectedDate < visibleRange.start || selectedDate > visibleRange.end) {
    state.selectedCalendarDate = dayKey(state.calendarCursor);
  }

  if (!state.creatingCalendarEvent) {
    state.selectedCalendarEventId = preserveSelection(
      state.selectedCalendarEventId,
      [...state.data.calendarEvents, ...state.data.focusEvents],
    );
  }
  if (!state.creatingTask) {
    state.selectedTaskId = preserveSelection(state.selectedTaskId, state.data.tasks);
  }
  if (!state.creatingNote) {
    state.selectedNoteId = preserveSelection(state.selectedNoteId, state.data.notes);
  }
  if (!state.creatingPerson) {
    state.selectedPersonId = preserveSelection(state.selectedPersonId, state.data.people);
  }
  if (!state.creatingLink) {
    state.selectedLinkId = preserveSelection(state.selectedLinkId, state.data.links);
  }
  state.selectedBriefId = preserveSelection(state.selectedBriefId, filteredBriefs(state.data));
  if (!state.creatingRoutine) {
    state.selectedRoutineId = preserveSelection(state.selectedRoutineId, state.data.routines);
    const selectedRoutine = findRecord(state.data.routines, state.selectedRoutineId);
    state.selectedRoutineTemplateId = selectedRoutine?.templateId
      || selectedRoutine?.id
      || preserveRoutineTemplateSelection(state.selectedRoutineTemplateId, state.data);
  } else {
    state.selectedRoutineTemplateId = preserveRoutineTemplateSelection(state.selectedRoutineTemplateId, state.data);
  }
}

function preserveSelection(currentId, records) {
  if (!Array.isArray(records) || records.length === 0) return null;
  if (currentId && records.some((record) => record.id === currentId)) {
    return currentId;
  }
  return records[0]?.id ?? null;
}

function preserveRoutineTemplateSelection(currentId, data) {
  const catalog = availableRoutineCatalog(data);
  if (!catalog.length) return null;
  if (currentId && catalog.some((entry) => entry.templateId === currentId)) {
    return currentId;
  }
  return catalog[0]?.templateId ?? null;
}

function renderToday(panel, data) {
  const nowDate = new Date(data.now);
  const todayEvents = getEventsForDay(data.focusEvents, nowDate);
  const focusTasks = data.tasks
    .filter((task) => task.status !== 'done')
    .sort((left, right) => {
      const leftDue = left.dueAt ?? Number.MAX_SAFE_INTEGER;
      const rightDue = right.dueAt ?? Number.MAX_SAFE_INTEGER;
      return leftDue - rightDue || taskPriorityRank(left.priority) - taskPriorityRank(right.priority);
    })
    .slice(0, 6);
  const recentNotes = data.notes.filter((note) => !note.archivedAt).slice(0, 4);
  const latestMorningBrief = data.briefs.find((brief) => brief.kind === 'morning') ?? null;
  const stalePeople = data.people.filter((person) => isPersonStale(person, data.now)).slice(0, 4);

  panel.innerHTML = `
    <section class="sb-layout sb-layout--today">
      <article class="sb-card sb-card--feature">
        <div class="sb-card__eyebrow">Today</div>
        <h3>${esc(getDayGreeting(nowDate))}</h3>
        <p>${esc(data.overview.nextEvent
          ? `${data.overview.nextEvent.title} is the next committed event. ${data.overview.topTasks[0] ? `Your highest-priority task is ${data.overview.topTasks[0].title}.` : 'Your queue is clear enough to schedule deliberately.'}`
          : 'Your calendar is open. Use the day intentionally before drift fills it in.')}</p>
        <div class="sb-readout-grid">
          ${renderReadoutCard('Date', formatLongDate(nowDate.getTime()))}
          ${renderReadoutCard('Next event', data.overview.nextEvent ? `${data.overview.nextEvent.title} at ${formatTime(data.overview.nextEvent.startsAt)}` : 'No upcoming event queued')}
          ${renderReadoutCard('Cloud AI budget', formatUsageSummary(data.overview.usage))}
        </div>
      </article>

      <article class="sb-card">
        <div class="sb-card__header">
          <div>
            <div class="sb-card__eyebrow">Agenda</div>
            <h3>Today on the clock</h3>
          </div>
        </div>
        ${renderAgenda(todayEvents, 'No events on the books for today.')}
      </article>

      <article class="sb-card">
        <div class="sb-card__header">
          <div>
            <div class="sb-card__eyebrow">Capture</div>
            <h3>Quick add</h3>
          </div>
        </div>
        <div class="sb-segmented">
          ${renderSegmentButton('note', 'Note', state.todayCaptureKind === 'note', 'data-capture-kind')}
          ${renderSegmentButton('task', 'Task', state.todayCaptureKind === 'task', 'data-capture-kind')}
          ${renderSegmentButton('event', 'Event', state.todayCaptureKind === 'event', 'data-capture-kind')}
        </div>
        ${renderTodayCaptureForm(nowDate)}
      </article>

      <article class="sb-card">
        <div class="sb-card__header">
          <div>
            <div class="sb-card__eyebrow">Tasks</div>
            <h3>Priority tasks</h3>
          </div>
        </div>
        ${renderTaskCompactList(focusTasks, 'No open tasks right now.')}
      </article>

      <article class="sb-card">
        <div class="sb-card__header">
          <div>
            <div class="sb-card__eyebrow">Briefs</div>
            <h3>Meeting prep and follow-up</h3>
          </div>
        </div>
        <div class="sb-brief-actions">
          <button class="btn btn-primary btn-sm" type="button" data-generate-brief="morning">Generate morning brief</button>
          ${data.overview.nextEvent ? `<button class="btn btn-secondary btn-sm" type="button" data-generate-brief="pre_meeting" data-event-id="${escAttr(data.overview.nextEvent.id)}">Prepare for next meeting</button>` : ''}
        </div>
        ${latestMorningBrief
          ? `
            <div class="sb-brief-preview">
              <strong>${esc(latestMorningBrief.title)}</strong>
              <p>${esc(summarize(latestMorningBrief.content, 260))}</p>
            </div>
          `
          : '<div class="sb-empty">No morning brief generated yet for this window.</div>'}
      </article>

      <article class="sb-card">
        <div class="sb-card__header">
          <div>
            <div class="sb-card__eyebrow">People</div>
            <h3>Follow up soon</h3>
          </div>
        </div>
        ${renderPeopleCompactList(stalePeople, 'No stale relationships surfaced right now.')}
      </article>

      <article class="sb-card">
        <div class="sb-card__header">
          <div>
            <div class="sb-card__eyebrow">Notes</div>
            <h3>Recent notes</h3>
          </div>
        </div>
        ${renderNoteCompactList(recentNotes, 'No fresh notes captured yet.')}
      </article>

      <article class="sb-card">
        <div class="sb-card__header">
          <div>
            <div class="sb-card__eyebrow">Routines</div>
            <h3>Scheduled help</h3>
          </div>
        </div>
        ${renderRoutineCompactList(data.routines.slice(0, 4))}
      </article>
    </section>
  `;
}

function renderTodayCaptureForm(nowDate) {
  if (state.todayCaptureKind === 'task') {
    return `
      <form class="sb-form" data-today-capture-form="task">
        <label class="sb-form__label" for="today-task-title">Task title</label>
        <input id="today-task-title" name="title" type="text" placeholder="Task title" required>
        <div class="sb-form__row">
          <div class="sb-form__group">
            <label class="sb-form__label" for="today-task-priority">Priority</label>
            <select id="today-task-priority" name="priority">
              <option value="medium">Medium priority</option>
              <option value="high">High priority</option>
              <option value="low">Low priority</option>
            </select>
          </div>
          <div class="sb-form__group">
            <label class="sb-form__label" for="today-task-due-at">Due date</label>
            <input id="today-task-due-at" name="dueAt" type="datetime-local" value="${escAttr(toDateTimeLocal(defaultTaskDueAt(nowDate).getTime()))}">
          </div>
        </div>
        <button class="btn btn-primary" type="submit">Add task</button>
      </form>
    `;
  }

  if (state.todayCaptureKind === 'event') {
    return `
      <form class="sb-form" data-today-capture-form="event">
        <label class="sb-form__label" for="today-event-title">Event title</label>
        <input id="today-event-title" name="title" type="text" placeholder="Block time or add an event" required>
        <div class="sb-form__row">
          <div class="sb-form__group">
            <label class="sb-form__label" for="today-event-starts-at">Start time</label>
            <input id="today-event-starts-at" name="startsAt" type="datetime-local" value="${escAttr(toDateTimeLocal(defaultEventStart(nowDate).getTime()))}" required>
          </div>
          <div class="sb-form__group">
            <label class="sb-form__label" for="today-event-ends-at">End time</label>
            <input id="today-event-ends-at" name="endsAt" type="datetime-local" value="${escAttr(toDateTimeLocal(defaultEventEnd(nowDate).getTime()))}">
          </div>
        </div>
        <button class="btn btn-primary" type="submit">Add event</button>
      </form>
    `;
  }

  return `
    <form class="sb-form" data-today-capture-form="note">
      <label class="sb-form__label" for="today-note-title">Note title</label>
      <input id="today-note-title" name="title" type="text" placeholder="Optional note title">
      <label class="sb-form__label" for="today-note-content">Note body</label>
      <textarea id="today-note-content" name="content" rows="5" placeholder="Capture a promise, idea, detail, or follow-up." required></textarea>
      <button class="btn btn-primary" type="submit">Save note</button>
    </form>
  `;
}

function renderCalendar(panel, data) {
  const selectedDate = parseDayKey(state.selectedCalendarDate);
  const selectedEvent = state.creatingCalendarEvent
    ? null
    : (findRecord(data.calendarEvents, state.selectedCalendarEventId) ?? findRecord(data.focusEvents, state.selectedCalendarEventId));
  const dayEventMap = buildDayEventMap(data.calendarEvents);
  const dayEvents = getDayEvents(dayEventMap, selectedDate);

  panel.innerHTML = `
    <section class="sb-section">
      <div class="sb-section__header">
        <div>
          <div class="sb-card__eyebrow">Calendar</div>
          <h3>${esc(formatCalendarHeading(state.calendarCursor, state.calendarView))}</h3>
          <p class="sb-section__copy">${esc(calendarViewCopy(state.calendarView))}</p>
        </div>
        <div class="sb-toolbar">
          <div class="sb-segmented">
            ${renderSegmentButton('week', 'Week', state.calendarView === 'week', 'data-calendar-view')}
            ${renderSegmentButton('month', 'Month', state.calendarView === 'month', 'data-calendar-view')}
            ${renderSegmentButton('year', 'Year', state.calendarView === 'year', 'data-calendar-view')}
          </div>
          <button class="btn btn-secondary btn-sm" type="button" data-calendar-nav="prev">Previous</button>
          <button class="btn btn-secondary btn-sm" type="button" data-calendar-nav="today">Today</button>
          <button class="btn btn-secondary btn-sm" type="button" data-calendar-nav="next">Next</button>
          <button class="btn btn-primary btn-sm" type="button" data-calendar-new="true" data-date-key="${escAttr(state.selectedCalendarDate)}">New event</button>
        </div>
      </div>
      <div class="sb-split sb-split--calendar">
        <aside class="sb-card sb-card--sidebar">
          <div class="sb-card__header">
            <div>
              <div class="sb-card__eyebrow">Day details</div>
              <h3>${esc(formatLongDate(selectedDate.getTime()))}</h3>
            </div>
          </div>
          <div class="sb-agenda-pane">
            ${renderAgenda(dayEvents, 'No events on this day.')}
          </div>
          <div class="sb-divider"></div>
          ${renderCalendarEditor(selectedEvent, selectedDate)}
        </aside>
        <article class="sb-card sb-card--calendar-main">
          ${renderCalendarSurface(state.calendarView, state.calendarCursor, dayEventMap)}
        </article>
      </div>
    </section>
  `;
}

function renderCalendarSurface(view, cursor, dayEventMap) {
  switch (view) {
    case 'week':
      return renderCalendarWeekView(cursor, dayEventMap);
    case 'year':
      return renderCalendarYearView(cursor, dayEventMap);
    default:
      return renderCalendarMonthView(cursor, dayEventMap);
  }
}

function renderCalendarMonthView(cursor, dayEventMap) {
  const monthStart = startOfMonthDate(cursor.getTime());
  const gridStart = startOfWeek(monthStart);
  const days = [];
  const dayCursor = new Date(gridStart.getTime());
  for (let index = 0; index < 42; index += 1) {
    days.push(new Date(dayCursor.getTime()));
    dayCursor.setDate(dayCursor.getDate() + 1);
  }

  return `
    <div class="sb-calendar">
      <div class="sb-calendar__weekdays">
        ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label) => `<span>${esc(label)}</span>`).join('')}
      </div>
      <div class="sb-calendar__grid">
        ${days.map((day) => renderCalendarMonthDay(day, monthStart, dayEventMap)).join('')}
      </div>
    </div>
  `;
}

function renderCalendarMonthDay(day, monthStart, dayEventMap) {
  const key = dayKey(day);
  const dayEvents = getDayEvents(dayEventMap, day);
  const isOutside = !isSameMonth(day, monthStart);
  const isSelected = key === state.selectedCalendarDate;
  const isToday = key === dayKey(new Date());

  return `
    <article class="sb-calendar-day${isOutside ? ' is-outside' : ''}${isSelected ? ' is-selected' : ''}${isToday ? ' is-today' : ''}">
      <button
        class="sb-calendar-day__hit"
        type="button"
        data-calendar-select-date="${escAttr(key)}"
        aria-label="${escAttr(`Select ${formatLongDate(day.getTime())}`)}"
      ></button>
      <div class="sb-calendar-day__label" aria-hidden="true">
        <span>${esc(String(day.getDate()))}</span>
      </div>
      <div class="sb-calendar-day__events">
        ${renderCalendarEventChips(dayEvents, key, day, 3)}
      </div>
    </article>
  `;
}

function renderCalendarWeekView(cursor, dayEventMap) {
  const weekStart = startOfWeek(cursor);
  const days = [];
  const dayCursor = new Date(weekStart.getTime());
  for (let index = 0; index < 7; index += 1) {
    days.push(new Date(dayCursor.getTime()));
    dayCursor.setDate(dayCursor.getDate() + 1);
  }

  return `
    <div class="sb-calendar sb-calendar--week">
      <div class="sb-calendar-week">
        ${days.map((day) => renderCalendarWeekDay(day, dayEventMap)).join('')}
      </div>
    </div>
  `;
}

function renderCalendarWeekDay(day, dayEventMap) {
  const key = dayKey(day);
  const dayEvents = getDayEvents(dayEventMap, day);
  const isSelected = key === state.selectedCalendarDate;
  const isToday = key === dayKey(new Date());

  return `
    <article class="sb-calendar-day sb-calendar-day--week${isSelected ? ' is-selected' : ''}${isToday ? ' is-today' : ''}">
      <button
        class="sb-calendar-day__hit"
        type="button"
        data-calendar-select-date="${escAttr(key)}"
        aria-label="${escAttr(`Select ${formatLongDate(day.getTime())}`)}"
      ></button>
      <div class="sb-calendar-day__header" aria-hidden="true">
        <span class="sb-calendar-day__weekday">${esc(formatWeekdayLabel(day))}</span>
        <strong>${esc(formatMonthDayLabel(day))}</strong>
      </div>
      <div class="sb-calendar-day__events">
        ${dayEvents.length > 0
          ? renderCalendarEventChips(dayEvents, key, day, 6)
          : '<div class="sb-calendar-day__empty">No events scheduled.</div>'}
      </div>
    </article>
  `;
}

function renderCalendarYearView(cursor, dayEventMap) {
  const yearStart = startOfYear(cursor);
  const months = [];
  for (let index = 0; index < 12; index += 1) {
    const month = new Date(yearStart.getTime());
    month.setMonth(index);
    months.push(month);
  }

  return `
    <div class="sb-calendar sb-calendar--year">
      <div class="sb-calendar-year">
        ${months.map((monthStart) => renderCalendarMiniMonth(monthStart, dayEventMap)).join('')}
      </div>
    </div>
  `;
}

function renderCalendarMiniMonth(monthStart, dayEventMap) {
  const gridStart = startOfWeek(monthStart);
  const days = [];
  const dayCursor = new Date(gridStart.getTime());
  for (let index = 0; index < 42; index += 1) {
    days.push(new Date(dayCursor.getTime()));
    dayCursor.setDate(dayCursor.getDate() + 1);
  }

  return `
    <article class="sb-calendar-mini-month">
      <div class="sb-calendar-mini-month__header">${esc(new Date(monthStart).toLocaleDateString([], { month: 'long' }))}</div>
      <div class="sb-calendar-mini-month__weekdays">
        ${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((label) => `<span>${esc(label)}</span>`).join('')}
      </div>
      <div class="sb-calendar-mini-month__grid">
        ${days.map((day) => renderCalendarMiniDay(day, monthStart, dayEventMap)).join('')}
      </div>
    </article>
  `;
}

function renderCalendarMiniDay(day, monthStart, dayEventMap) {
  if (!isSameMonth(day, monthStart)) {
    return '<span class="sb-calendar-mini-day sb-calendar-mini-day--blank" aria-hidden="true"></span>';
  }

  const key = dayKey(day);
  const eventCount = getDayEvents(dayEventMap, day).length;
  const isSelected = key === state.selectedCalendarDate;
  const isToday = key === dayKey(new Date());

  return `
    <button
      class="sb-calendar-mini-day${isSelected ? ' is-selected' : ''}${isToday ? ' is-today' : ''}${eventCount > 0 ? ' has-events' : ''}"
      type="button"
      data-calendar-select-date="${escAttr(key)}"
      title="${escAttr(`${formatLongDate(day.getTime())}${eventCount > 0 ? ` · ${eventCount} event${eventCount === 1 ? '' : 's'}` : ''}`)}"
    >
      <span class="sb-calendar-mini-day__number">${esc(String(day.getDate()))}</span>
      ${eventCount > 0 ? `<span class="sb-calendar-mini-day__count">${esc(String(eventCount))}</span>` : ''}
    </button>
  `;
}

function renderCalendarEventChips(events, dateKey, day, limit) {
  const visibleEvents = events.slice(0, limit);
  return `
    ${visibleEvents.map((event) => `
      <button class="sb-event-chip" type="button" data-calendar-select-event="${escAttr(event.id)}" data-calendar-select-date="${escAttr(dateKey)}">
        <span class="sb-event-chip__time">${esc(formatEventChipTime(event, day))}</span>
        <span class="sb-event-chip__title">${esc(event.title)}</span>
      </button>
    `).join('')}
    ${events.length > limit ? `<div class="sb-event-chip sb-event-chip--overflow">+${esc(String(events.length - limit))} more</div>` : ''}
  `;
}

function renderCalendarEditor(selectedEvent, selectedDate) {
  if (selectedEvent && selectedEvent.source !== 'local') {
    return `
      <div class="sb-readonly">
        <div class="sb-card__eyebrow">Synced event</div>
        <h3>${esc(selectedEvent.title)}</h3>
        <p>${esc(`${formatTimeRange(selectedEvent)}${selectedEvent.location ? ` · ${selectedEvent.location}` : ''}`)}</p>
        ${selectedEvent.description ? `<p>${esc(selectedEvent.description)}</p>` : ''}
        <div class="sb-badge-row">
          <span class="badge badge-muted">${esc(selectedEvent.source)}</span>
          <button class="btn btn-secondary btn-sm" type="button" data-generate-brief="pre_meeting" data-event-id="${escAttr(selectedEvent.id)}">Create meeting brief</button>
        </div>
        <p class="sb-readonly__note">This event is synced from your connected calendar. You can review it here, but to change it you need to edit it in Google Calendar or Microsoft 365. Use the main New event button if you want to add something else on this day.</p>
      </div>
    `;
  }

  const startsAt = selectedEvent?.startsAt ?? defaultEventStart(selectedDate).getTime();
  const endsAt = selectedEvent?.endsAt ?? defaultEventEnd(selectedDate).getTime();
  return `
    <form class="sb-form" data-calendar-form>
      <input type="hidden" name="id" value="${escAttr(selectedEvent?.id ?? '')}">
      <div class="sb-card__eyebrow">${selectedEvent ? 'Edit event' : 'New event'}</div>
      <label class="sb-form__label" for="calendar-title">Event title</label>
      <input id="calendar-title" name="title" type="text" placeholder="Event title" value="${escAttr(selectedEvent?.title ?? '')}" required>
      <div class="sb-form__row">
        <div class="sb-form__group">
          <label class="sb-form__label" for="calendar-starts-at">Start time</label>
          <input id="calendar-starts-at" name="startsAt" type="datetime-local" value="${escAttr(toDateTimeLocal(startsAt))}" required>
        </div>
        <div class="sb-form__group">
          <label class="sb-form__label" for="calendar-ends-at">End time</label>
          <input id="calendar-ends-at" name="endsAt" type="datetime-local" value="${escAttr(toDateTimeLocal(endsAt))}">
        </div>
      </div>
      <label class="sb-form__label" for="calendar-location">Location or link</label>
      <input id="calendar-location" name="location" type="text" placeholder="Location or call link" value="${escAttr(selectedEvent?.location ?? '')}">
      <label class="sb-form__label" for="calendar-description">Description</label>
      <textarea id="calendar-description" name="description" rows="6" placeholder="Description, agenda, prep notes, or anything you want attached to this event">${esc(selectedEvent?.description ?? '')}</textarea>
      ${renderFormActions(
        selectedEvent ? 'Save event' : 'Create event',
        selectedEvent
          ? `<button class="btn btn-danger" type="button" data-calendar-delete="${escAttr(selectedEvent.id)}" data-label="${escAttr(selectedEvent.title)}">Delete event</button>`
          : '',
      )}
    </form>
  `;
}

function renderTasks(panel, data) {
  const selectedTask = state.creatingTask ? null : findRecord(data.tasks, state.selectedTaskId);
  const columns = {
    todo: data.tasks.filter((task) => task.status === 'todo'),
    in_progress: data.tasks.filter((task) => task.status === 'in_progress'),
    done: data.tasks.filter((task) => task.status === 'done'),
  };

  panel.innerHTML = `
    <section class="sb-section">
      <div class="sb-section__header">
        <button class="btn btn-primary btn-sm" type="button" data-task-new="true">New task</button>
      </div>
      <div class="sb-split sb-split--board">
        <aside class="sb-card sb-card--sidebar">
          <div class="sb-card__header">
            <div>
              <div class="sb-card__eyebrow">${selectedTask ? 'Edit task' : 'New task'}</div>
              <h3>${esc(selectedTask?.title ?? 'Task editor')}</h3>
            </div>
          </div>
          ${renderTaskEditor(selectedTask)}
        </aside>
        <div class="sb-board">
          ${renderTaskColumn('Todo', 'todo', columns.todo)}
          ${renderTaskColumn('In Progress', 'in_progress', columns.in_progress)}
          ${renderTaskColumn('Done', 'done', columns.done)}
        </div>
      </div>
    </section>
  `;
}

function renderTaskColumn(title, status, tasks) {
  return `
    <article class="sb-card sb-board__column">
      <div class="sb-board__header">
        <h4>${esc(title)}</h4>
        <span>${esc(String(tasks.length))}</span>
      </div>
      <div class="sb-board__body">
        ${tasks.length > 0
          ? tasks.map((task) => renderTaskBoardCard(task, status)).join('')
          : '<div class="sb-empty">Nothing in this lane.</div>'}
      </div>
    </article>
  `;
}

function renderTaskBoardCard(task, lane) {
  return `
    <div class="sb-task-card${task.id === state.selectedTaskId ? ' is-selected' : ''}">
      <button class="sb-task-card__main" type="button" data-task-select="${escAttr(task.id)}">
        <strong>${esc(task.title)}</strong>
        <span>${esc(task.details ? summarize(task.details, 120) : (task.dueAt ? `Due ${formatShortDateTime(task.dueAt)}` : 'No extra detail'))}</span>
      </button>
      <div class="sb-badge-row">
        <span class="badge ${priorityBadgeClass(task.priority)}">${esc(task.priority)}</span>
        ${task.dueAt ? `<span class="badge badge-muted">${esc(formatShortDateTime(task.dueAt))}</span>` : ''}
      </div>
      <div class="sb-task-card__actions">
        ${lane !== 'todo' ? '<button class="btn btn-secondary btn-sm" type="button" data-task-status="todo" data-task-id="' + escAttr(task.id) + '">To do</button>' : ''}
        ${lane !== 'in_progress' ? '<button class="btn btn-secondary btn-sm" type="button" data-task-status="in_progress" data-task-id="' + escAttr(task.id) + '">In progress</button>' : ''}
        ${lane !== 'done' ? '<button class="btn btn-secondary btn-sm" type="button" data-task-status="done" data-task-id="' + escAttr(task.id) + '">Done</button>' : ''}
      </div>
    </div>
  `;
}

function renderTaskEditor(task) {
  return `
    <form class="sb-form" data-task-form>
      <input type="hidden" name="id" value="${escAttr(task?.id ?? '')}">
      <label class="sb-form__label" for="task-title">Task title</label>
      <input id="task-title" name="title" type="text" placeholder="Task title" value="${escAttr(task?.title ?? '')}" required>
      <label class="sb-form__label" for="task-details">Details</label>
      <textarea id="task-details" name="details" rows="6" placeholder="Context, checklist, blockers, or acceptance criteria">${esc(task?.details ?? '')}</textarea>
      <div class="sb-form__row">
        <div class="sb-form__group">
          <label class="sb-form__label" for="task-priority">Priority</label>
          <select id="task-priority" name="priority">
            ${renderSelectOptions([
              { value: 'high', label: 'High priority' },
              { value: 'medium', label: 'Medium priority' },
              { value: 'low', label: 'Low priority' },
            ], task?.priority ?? 'medium')}
          </select>
        </div>
        <div class="sb-form__group">
          <label class="sb-form__label" for="task-status">Status</label>
          <select id="task-status" name="status">
            ${renderSelectOptions([
              { value: 'todo', label: 'To do' },
              { value: 'in_progress', label: 'In progress' },
              { value: 'done', label: 'Done' },
            ], task?.status ?? 'todo')}
          </select>
        </div>
      </div>
      <label class="sb-form__label" for="task-due-at">Due date</label>
      <input id="task-due-at" name="dueAt" type="datetime-local" value="${escAttr(toDateTimeLocal(task?.dueAt ?? null))}">
      ${renderFormActions(
        task ? 'Save task' : 'Create task',
        task
          ? `<button class="btn btn-danger" type="button" data-task-delete="${escAttr(task.id)}" data-label="${escAttr(task.title)}">Delete task</button>`
          : '',
      )}
    </form>
  `;
}

function renderNotes(panel, data) {
  const filtered = data.notes.filter((note) => matchesNoteQuery(note, state.noteQuery));
  const selectedNote = state.creatingNote
    ? null
    : (findRecord(filtered, state.selectedNoteId) ?? findRecord(data.notes, state.selectedNoteId));

  panel.innerHTML = `
    <section class="sb-section">
      <div class="sb-section__header">
        <div>
          <div class="sb-card__eyebrow">Notes</div>
          <h3>Notes and ideas</h3>
          <p class="sb-section__copy">Search, pin, archive, and edit full notes in one place.</p>
        </div>
      </div>
      <div class="sb-section__header">
        <button class="btn btn-primary btn-sm" type="button" data-note-new="true">New note</button>
      </div>
      <div class="sb-split">
        <article class="sb-card sb-card--editor">
          <div class="sb-card__header">
            <div>
              <div class="sb-card__eyebrow">${selectedNote ? 'Edit note' : 'New note'}</div>
              <h3>${esc(selectedNote?.title ?? 'Note editor')}</h3>
            </div>
          </div>
          ${renderNoteEditor(selectedNote)}
        </article>
        <article class="sb-card sb-card--rail">
          <form class="sb-toolbar sb-toolbar--search" data-note-search-form>
            <input name="query" type="search" placeholder="Search title, body, or tags" value="${escAttr(state.noteQuery)}">
            <button class="btn btn-secondary btn-sm" type="submit">Search</button>
          </form>
          <div class="sb-stack">
            ${filtered.length > 0 ? filtered.map((note) => renderNoteListItem(note)).join('') : '<div class="sb-empty">No notes match this search.</div>'}
          </div>
        </article>
      </div>
    </section>
  `;
}

function renderNoteListItem(note) {
  return `
    <button class="sb-list-card${note.id === state.selectedNoteId ? ' is-selected' : ''}" type="button" data-note-select="${escAttr(note.id)}">
      <span class="sb-list-card__meta">
        ${note.pinned ? '<span class="badge badge-info">Pinned</span>' : ''}
        ${note.archivedAt ? '<span class="badge badge-muted">Archived</span>' : ''}
        <span>${esc(formatShortDateTime(note.updatedAt))}</span>
      </span>
      <strong>${esc(note.title)}</strong>
      <span>${esc(summarize(note.content, 160))}</span>
      ${note.tags.length > 0 ? `<span class="sb-tag-row">${note.tags.map((tag) => `<span class="sb-tag">${esc(tag)}</span>`).join('')}</span>` : ''}
    </button>
  `;
}

function renderNoteEditor(note) {
  return `
    <form class="sb-form" data-note-form>
      <input type="hidden" name="id" value="${escAttr(note?.id ?? '')}">
      <label class="sb-form__label" for="note-title">Note title</label>
      <input id="note-title" name="title" type="text" placeholder="Note title" value="${escAttr(note?.title ?? '')}">
      <label class="sb-form__label" for="note-tags">Tags</label>
      <input id="note-tags" name="tags" type="text" placeholder="comma, separated, tags" value="${escAttr((note?.tags ?? []).join(', '))}">
      <div class="sb-form__label">Note options</div>
      <div class="sb-check-grid sb-check-grid--options">
        <label class="sb-check sb-check--surface">
          <input name="pinned" type="checkbox" ${note?.pinned ? 'checked' : ''}>
          <span class="sb-check__copy">
            <strong>Pin note</strong>
            <small>Keep it near the top of the note list.</small>
          </span>
        </label>
        <label class="sb-check sb-check--surface">
          <input name="archived" type="checkbox" ${note?.archivedAt ? 'checked' : ''}>
          <span class="sb-check__copy">
            <strong>Archive note</strong>
            <small>Hide it from active work without deleting it.</small>
          </span>
        </label>
      </div>
      <label class="sb-form__label" for="note-content">Note body</label>
      <textarea id="note-content" name="content" rows="14" placeholder="Write the note body" required>${esc(note?.content ?? '')}</textarea>
      ${renderFormActions(
        note ? 'Save note' : 'Create note',
        note
          ? `<button class="btn btn-danger" type="button" data-note-delete="${escAttr(note.id)}" data-label="${escAttr(note.title)}">Delete note</button>`
          : '',
      )}
    </form>
  `;
}

function renderPeople(panel, data) {
  const filtered = data.people.filter((person) => matchesPersonFilter(person));
  const selectedPerson = state.creatingPerson
    ? null
    : (findRecord(filtered, state.selectedPersonId) ?? findRecord(data.people, state.selectedPersonId));
  const staleCount = data.people.filter((person) => isPersonStale(person, data.now)).length;

  panel.innerHTML = `
    <section class="sb-section">
      <div class="sb-section__header">
        <button class="btn btn-primary btn-sm" type="button" data-person-new="true">New contact</button>
      </div>
      <div class="sb-split">
        <article class="sb-card sb-card--editor">
          <div class="sb-card__header">
            <div>
              <div class="sb-card__eyebrow">${selectedPerson ? 'Edit contact' : 'New contact'}</div>
              <h3>${esc(selectedPerson?.name ?? 'Contact editor')}</h3>
            </div>
            ${selectedPerson ? `<button class="btn btn-secondary btn-sm" type="button" data-person-touch="${escAttr(selectedPerson.id)}">Mark contacted today</button>` : ''}
          </div>
          ${renderPersonEditor(selectedPerson)}
        </article>
        <article class="sb-card sb-card--rail">
          <form class="sb-toolbar sb-toolbar--search" data-person-search-form>
            <input name="query" type="search" placeholder="Search contacts" value="${escAttr(state.personQuery)}">
            <button class="btn btn-secondary btn-sm" type="submit">Search</button>
          </form>
          <div class="sb-segmented">
            ${renderSegmentButton('all', 'All', state.personRelationship === 'all', 'data-person-relationship')}
            ${renderSegmentButton('work', 'Work', state.personRelationship === 'work', 'data-person-relationship')}
            ${renderSegmentButton('personal', 'Personal', state.personRelationship === 'personal', 'data-person-relationship')}
            ${renderSegmentButton('family', 'Family', state.personRelationship === 'family', 'data-person-relationship')}
            ${renderSegmentButton('vendor', 'Vendor', state.personRelationship === 'vendor', 'data-person-relationship')}
          </div>
          <div class="sb-stack">
            ${filtered.length > 0 ? filtered.map((person) => renderPersonListItem(person, data.now)).join('') : '<div class="sb-empty">No contacts match this filter.</div>'}
          </div>
        </article>
      </div>
    </section>
  `;
}

function renderPersonListItem(person, now) {
  return `
    <button class="sb-list-card${person.id === state.selectedPersonId ? ' is-selected' : ''}" type="button" data-person-select="${escAttr(person.id)}">
      <span class="sb-list-card__meta">
        <span class="badge badge-muted">${esc(person.relationship)}</span>
        <span>${esc(person.lastContactAt ? `Last ${formatRelativeDate(person.lastContactAt, now)}` : 'No contact date')}</span>
      </span>
      <strong>${esc(person.name)}</strong>
      <span>${esc(renderPersonLine(person))}</span>
    </button>
  `;
}

function renderPersonEditor(person) {
  return `
    <form class="sb-form" data-person-form>
      <input type="hidden" name="id" value="${escAttr(person?.id ?? '')}">
      <div class="sb-form__row">
        <div class="sb-form__group">
          <label class="sb-form__label" for="person-name">Name</label>
          <input id="person-name" name="name" type="text" placeholder="Name" value="${escAttr(person?.name ?? '')}">
        </div>
        <div class="sb-form__group">
          <label class="sb-form__label" for="person-email">Email</label>
          <input id="person-email" name="email" type="email" placeholder="Email" value="${escAttr(person?.email ?? '')}">
        </div>
      </div>
      <div class="sb-form__row">
        <div class="sb-form__group">
          <label class="sb-form__label" for="person-title">Title</label>
          <input id="person-title" name="title" type="text" placeholder="Title" value="${escAttr(person?.title ?? '')}">
        </div>
        <div class="sb-form__group">
          <label class="sb-form__label" for="person-company">Company</label>
          <input id="person-company" name="company" type="text" placeholder="Company" value="${escAttr(person?.company ?? '')}">
        </div>
      </div>
      <div class="sb-form__row">
        <div class="sb-form__group">
          <label class="sb-form__label" for="person-relationship">Relationship</label>
          <select id="person-relationship" name="relationship">
            ${renderSelectOptions([
              { value: 'work', label: 'Work' },
              { value: 'personal', label: 'Personal' },
              { value: 'family', label: 'Family' },
              { value: 'vendor', label: 'Vendor' },
              { value: 'other', label: 'Other' },
            ], person?.relationship ?? 'work')}
          </select>
        </div>
        <div class="sb-form__group">
          <label class="sb-form__label" for="person-last-contact-at">Last contacted</label>
          <input id="person-last-contact-at" name="lastContactAt" type="datetime-local" value="${escAttr(toDateTimeLocal(person?.lastContactAt ?? null))}">
        </div>
      </div>
      <label class="sb-form__label" for="person-notes">Notes</label>
      <textarea id="person-notes" name="notes" rows="10" placeholder="Relationship notes, context, promises, or follow-up cues">${esc(person?.notes ?? '')}</textarea>
      ${renderFormActions(
        person ? 'Save contact' : 'Create contact',
        person
          ? `<button class="btn btn-danger" type="button" data-person-delete="${escAttr(person.id)}" data-label="${escAttr(person.name)}">Delete contact</button>`
          : '',
      )}
    </form>
  `;
}

function renderLibrary(panel, data) {
  const filtered = data.links.filter((link) => matchesLinkFilter(link));
  const selectedLink = state.creatingLink
    ? null
    : (findRecord(filtered, state.selectedLinkId) ?? findRecord(data.links, state.selectedLinkId));

  panel.innerHTML = `
    <section class="sb-section">
      <div class="sb-section__header">
        <button class="btn btn-primary btn-sm" type="button" data-link-new="true">Add item</button>
      </div>
      <div class="sb-split">
        <article class="sb-card sb-card--editor">
          <div class="sb-card__header">
            <div>
              <div class="sb-card__eyebrow">${selectedLink ? 'Edit item' : 'Add item'}</div>
              <h3>${esc(selectedLink?.title ?? 'Library editor')}</h3>
            </div>
            ${selectedLink ? `<a class="btn btn-secondary btn-sm" href="${escAttr(formatLinkHref(selectedLink.url))}" target="_blank" rel="noreferrer">Open link</a>` : ''}
          </div>
          ${renderLinkEditor(selectedLink)}
        </article>
        <article class="sb-card sb-card--rail">
          <form class="sb-toolbar sb-toolbar--search" data-link-search-form>
            <input name="query" type="search" placeholder="Search library" value="${escAttr(state.linkQuery)}">
            <button class="btn btn-secondary btn-sm" type="submit">Search</button>
          </form>
          <div class="sb-segmented">
            ${renderSegmentButton('all', 'All', state.linkKind === 'all', 'data-link-kind')}
            ${renderSegmentButton('reference', 'Reference', state.linkKind === 'reference', 'data-link-kind')}
            ${renderSegmentButton('document', 'Document', state.linkKind === 'document', 'data-link-kind')}
            ${renderSegmentButton('repo', 'Repo', state.linkKind === 'repo', 'data-link-kind')}
            ${renderSegmentButton('file', 'File', state.linkKind === 'file', 'data-link-kind')}
          </div>
          <div class="sb-stack">
            ${filtered.length > 0 ? filtered.map((link) => renderLinkListItem(link)).join('') : '<div class="sb-empty">No library items match this filter.</div>'}
          </div>
        </article>
      </div>
    </section>
  `;
}

function renderLinkListItem(link) {
  return `
    <button class="sb-list-card${link.id === state.selectedLinkId ? ' is-selected' : ''}" type="button" data-link-select="${escAttr(link.id)}">
      <span class="sb-list-card__meta">
        <span class="badge badge-muted">${esc(link.kind)}</span>
        <span>${esc(formatShortDateTime(link.updatedAt))}</span>
      </span>
      <strong>${esc(link.title)}</strong>
      <span>${esc(link.summary ? summarize(link.summary, 140) : link.url)}</span>
      ${link.tags.length > 0 ? `<span class="sb-tag-row">${link.tags.map((tag) => `<span class="sb-tag">${esc(tag)}</span>`).join('')}</span>` : ''}
    </button>
  `;
}

function renderLinkEditor(link) {
  return `
    <form class="sb-form" data-link-form>
      <input type="hidden" name="id" value="${escAttr(link?.id ?? '')}">
      <label class="sb-form__label" for="link-title">Title</label>
      <input id="link-title" name="title" type="text" placeholder="Title" value="${escAttr(link?.title ?? '')}">
      <label class="sb-form__label" for="link-url">URL or Path</label>
      <div style="display:flex;gap:0.5rem">
        <input id="link-url" name="url" type="text" placeholder="https://... or file path" value="${escAttr(link?.url ?? '')}" required style="flex-grow:1">
        <button class="btn btn-secondary" type="button" data-link-pick-file="true">File...</button>
      </div>
      <div class="sb-form__row">
        <div class="sb-form__group">
          <label class="sb-form__label" for="link-kind">Kind</label>
          <select id="link-kind" name="kind">
            ${renderSelectOptions([
              { value: 'reference', label: 'Reference' },
              { value: 'document', label: 'Document' },
              { value: 'article', label: 'Article' },
              { value: 'repo', label: 'Repository' },
              { value: 'file', label: 'File' },
              { value: 'other', label: 'Other' },
            ], link?.kind ?? 'reference')}
          </select>
        </div>
        <div class="sb-form__group">
          <label class="sb-form__label" for="link-tags">Tags</label>
          <input id="link-tags" name="tags" type="text" placeholder="comma, separated, tags" value="${escAttr((link?.tags ?? []).join(', '))}">
        </div>
      </div>
      <label class="sb-form__label" for="link-summary">Why this matters</label>
      <textarea id="link-summary" name="summary" rows="10" placeholder="Why this matters later">${esc(link?.summary ?? '')}</textarea>
      ${renderFormActions(
        'Save item',
        link
          ? `<button class="btn btn-danger" type="button" data-link-delete="${escAttr(link.id)}" data-label="${escAttr(link.title)}">Delete item</button>`
          : '',
      )}
    </form>
  `;
}

function renderBriefs(panel, data) {
  const filtered = filteredBriefs(data);
  const selectedBrief = findRecord(filtered, state.selectedBriefId) ?? findRecord(data.briefs, state.selectedBriefId);
  const nextEvent = data.overview.nextEvent;
  const followUpCandidate = [...data.focusEvents]
    .filter((event) => (event.endsAt ?? event.startsAt) < data.now)
    .sort((left, right) => (right.endsAt ?? right.startsAt) - (left.endsAt ?? left.startsAt))[0] ?? null;

  panel.innerHTML = `
    <section class="sb-section">
      <div class="sb-section__header">
        <div>
          <div class="sb-card__eyebrow">Briefs</div>
          <h3>Meeting, daily, and weekly briefs</h3>
          <p class="sb-section__copy">Create a morning summary, a weekly review, a meeting brief, or a follow-up draft and review them here.</p>
        </div>
      </div>
      <div class="sb-card sb-card--action-strip">
        <button class="btn btn-primary" type="button" data-generate-brief="morning">Generate morning brief</button>
        <button class="btn btn-secondary" type="button" data-generate-brief="weekly_review">Generate weekly review</button>
        ${nextEvent ? `<button class="btn btn-secondary" type="button" data-generate-brief="pre_meeting" data-event-id="${escAttr(nextEvent.id)}">Prepare for next meeting</button>` : ''}
        ${followUpCandidate ? `<button class="btn btn-secondary" type="button" data-generate-brief="follow_up" data-event-id="${escAttr(followUpCandidate.id)}">Draft follow-up</button>` : ''}
      </div>
      <div class="sb-split">
        <article class="sb-card sb-card--rail">
          <div class="sb-segmented">
            ${renderSegmentButton('all', 'All', state.briefKind === 'all', 'data-brief-kind')}
            ${renderSegmentButton('morning', 'Morning', state.briefKind === 'morning', 'data-brief-kind')}
            ${renderSegmentButton('weekly_review', 'Weekly', state.briefKind === 'weekly_review', 'data-brief-kind')}
            ${renderSegmentButton('pre_meeting', 'Meeting', state.briefKind === 'pre_meeting', 'data-brief-kind')}
            ${renderSegmentButton('follow_up', 'Follow-up', state.briefKind === 'follow_up', 'data-brief-kind')}
          </div>
          <div class="sb-stack">
            ${filtered.length > 0 ? filtered.map((brief) => renderBriefListItem(brief)).join('') : '<div class="sb-empty">No briefs match this filter.</div>'}
          </div>
        </article>
        <article class="sb-card sb-card--editor">
          ${selectedBrief ? renderBriefEditor(selectedBrief, data) : '<div class="sb-empty">Pick a brief to read it here.</div>'}
        </article>
      </div>
    </section>
  `;
}

function filteredBriefs(data) {
  return data.briefs.filter((brief) => state.briefKind === 'all' || brief.kind === state.briefKind);
}

function renderBriefListItem(brief) {
  return `
    <button class="sb-list-card${brief.id === state.selectedBriefId ? ' is-selected' : ''}" type="button" data-brief-select="${escAttr(brief.id)}">
      <span class="sb-list-card__meta">
        <span class="badge badge-muted">${esc(brief.kind.replaceAll('_', ' '))}</span>
        <span>${esc(formatShortDateTime(brief.generatedAt))}</span>
      </span>
      <strong>${esc(brief.title)}</strong>
      <span>${esc(summarize(brief.content, 160))}</span>
    </button>
  `;
}

function renderBriefEditor(brief, data) {
  const sourceEvent = brief.eventId ? findRecord([...data.focusEvents, ...data.calendarEvents], brief.eventId) : null;
  const regenerateButton = brief.kind === 'morning' || brief.kind === 'weekly_review'
    ? `<button class="btn btn-secondary" type="button" data-generate-brief="${escAttr(brief.kind)}">Regenerate brief</button>`
    : brief.eventId
      ? `<button class="btn btn-secondary" type="button" data-generate-brief="${escAttr(brief.kind)}" data-event-id="${escAttr(brief.eventId)}">Regenerate brief</button>`
      : '';
  return `
    <form class="sb-form" data-brief-form>
      <input type="hidden" name="id" value="${escAttr(brief.id)}">
      <div class="sb-card__header">
        <div>
          <div class="sb-card__eyebrow">${esc(brief.kind.replaceAll('_', ' '))}</div>
          <h3>${esc(brief.title)}</h3>
        </div>
        <span class="badge badge-muted">${esc(formatLongDate(brief.generatedAt))}</span>
      </div>
      ${sourceEvent ? `<p class="sb-brief-source">Source event: ${esc(sourceEvent.title)} · ${esc(formatTimeRange(sourceEvent))}</p>` : ''}
      <label class="sb-form__label" for="brief-title">Brief title</label>
      <input id="brief-title" name="title" type="text" value="${escAttr(brief.title)}" required>
      <label class="sb-form__label" for="brief-content">Brief content</label>
      <textarea id="brief-content" name="content" rows="18" required>${esc(brief.content)}</textarea>
      <div class="sb-readout">
        <strong>Stored brief behavior</strong>
        <span>Edits update the saved brief record. Regenerating it later will replace the stored content with a fresh deterministic version.</span>
      </div>
      ${renderFormActions(
        'Save brief',
        `<button class="btn btn-danger" type="button" data-brief-delete="${escAttr(brief.id)}" data-label="${escAttr(brief.title)}">Delete brief</button>`,
        regenerateButton,
      )}
    </form>
  `;
}

function renderRoutines(panel, data) {
  const routines = filteredRoutineList(data);
  const selectedRoutine = state.creatingRoutine
    ? null
    : (findRecord(routines, state.selectedRoutineId) ?? routines[0] ?? null);
  const selectedEntry = findRoutineCatalogEntry(
    data,
    state.creatingRoutine
      ? state.selectedRoutineTemplateId
      : (selectedRoutine?.templateId || state.selectedRoutineTemplateId),
  );
  const selectedCreateEntry = state.creatingRoutine
    ? resolveRoutineCreateEntry(selectedEntry, data)
    : null;
  const actionPanel = state.creatingRoutine
    ? renderRoutineCreateForm(selectedCreateEntry, data)
    : selectedRoutine
      ? renderRoutineEditor(selectedRoutine, selectedEntry)
      : '<div class="sb-empty">Select a routine to edit it, or create a new one from the left-hand panel.</div>';

  panel.innerHTML = `
    <section class="sb-section">
      <div class="sb-split sb-split--board sb-routines-layout">
        <aside class="sb-card sb-card--sidebar">
          <div class="sb-card__header">
            <div>
              <div class="sb-card__eyebrow">${state.creatingRoutine ? 'Routine Builder' : 'Routine Editor'}</div>
              <h3>${esc(state.creatingRoutine ? (selectedCreateEntry?.name ?? 'Choose a routine type') : (selectedRoutine?.name ?? 'Select a routine'))}</h3>
            </div>
            <div style="display:flex;gap:0.5rem;align-items:center;">
              <button class="btn btn-primary" type="button" data-routine-create-toggle="true">${state.creatingRoutine ? 'Close creator' : 'Create routine'}</button>
              <button class="btn btn-secondary" type="button" data-second-brain-sync-now="true">Sync now</button>
              <button class="btn btn-secondary" type="button" data-routine-refresh="true">Refresh</button>
            </div>
          </div>
          ${actionPanel}
        </aside>

        <section class="table-container sb-routine-catalog">
          <div class="table-header">
            <h3>Configured Routines</h3>
            <div class="sb-table-copy">${esc(`${data.routines.length} configured`)}</div>
          </div>

          <div class="wf-category-bar">
            ${renderRoutineFilterChip('all', 'All', state.routineStatus === 'all', 'data-routine-status', data.routines.length)}
            ${renderRoutineFilterChip('enabled', 'Enabled', state.routineStatus === 'enabled', 'data-routine-status', data.routines.filter((routine) => routine.enabled).length)}
            ${renderRoutineFilterChip('paused', 'Paused', state.routineStatus === 'paused', 'data-routine-status', data.routines.filter((routine) => !routine.enabled).length)}
            <span class="sb-filter-divider" aria-hidden="true"></span>
            ${renderRoutineFilterChip('all', 'Any Category', state.routineCategory === 'all', 'data-routine-category')}
            ${renderRoutineCategoryFilters(data)}
          </div>

          <div style="padding:0.5rem 1rem;">
            <input
              type="text"
              id="sb-routine-search"
              placeholder="Search routines, topics, timing, or delivery..."
              value="${escAttr(state.routineQuery)}"
              style="width:100%;padding:0.4rem 0.6rem;background:var(--bg-input);border:1px solid var(--border);border-radius:0;color:var(--text-primary);font-size:0.8rem;"
            >
          </div>

          <table id="sb-routine-catalog-table">
            <thead>
              <tr>
                <th>Routine</th>
                <th>When</th>
                <th>Delivery</th>
                <th>Status</th>
                <th>Last Run</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${routines.length
                ? routines.map((routine) => renderRoutineListRow(routine, data)).join('')
                : '<tr><td colspan="6"><div class="sb-empty">No configured routines match the current filters.</div></td></tr>'}
            </tbody>
          </table>
        </section>
      </div>
    </section>
  `;
}

function renderRoutineFilterChip(value, label, active, dataAttribute, count = null) {
  const attr = dataAttribute.replace('data-', '');
  return `
    <button class="wf-category-chip${active ? ' active' : ''}" type="button" data-${attr}="${escAttr(value)}">
      ${esc(label)}
      ${count == null ? '' : `<span class="wf-category-count">${esc(String(count))}</span>`}
    </button>
  `;
}

function renderRoutineCategoryFilters(data) {
  const counts = new Map();
  for (const routine of Array.isArray(data?.routines) ? data.routines : []) {
    const entry = findRoutineCatalogEntry(data, routine.templateId || routine.id);
    const category = entry?.category || 'maintenance';
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
    .map(([category, count]) => renderRoutineFilterChip(category, categoryLabel(category), state.routineCategory === category, 'data-routine-category', count))
    .join('');
}

function renderRoutineListRow(routine, data) {
  const entry = findRoutineCatalogEntry(data, routine.templateId || routine.id);
  const typeLabel = entry?.name || routine.name;
  const description = routine.templateId === 'topic-watch' && routine.config?.topicQuery
    ? `Watching "${routine.config.topicQuery}".`
    : routine.templateId === 'deadline-watch' && routine.config?.dueWithinHours
      ? `Watching tasks due within ${routine.config.dueWithinHours} hour${routine.config.dueWithinHours === 1 ? '' : 's'}${routine.config?.includeOverdue === false ? '' : ', including overdue work'}.`
    : (entry?.description || '');
  const isSelected = state.selectedRoutineId === routine.id;

  return `
    <tr class="auto-catalog-row sb-routine-row${isSelected ? ' is-selected' : ''}" data-routine-row="${escAttr(routine.id)}">
      <td>
        <div class="ops-task-title">
          <strong>${esc(routine.name)}</strong>
          <div class="wf-category-tag">${esc(typeLabel)}</div>
        </div>
        ${description ? `<div class="sb-table-copy">${esc(description)}</div>` : ''}
      </td>
      <td>${esc(describeRoutineTrigger(routine.trigger))}</td>
      <td>${esc(routine.deliveryDefaults.join(', ') || 'None')}</td>
      <td>
        <span class="badge ${routine.enabled ? 'badge-ok' : 'badge-muted'}">${esc(routine.enabled ? 'Enabled' : 'Paused')}</span>
      </td>
      <td>${esc(routine.lastRunAt ? formatRelativeDate(routine.lastRunAt, Date.now()) : 'Never')}</td>
      <td>
        <div class="sb-task-card__actions">
          <button class="btn btn-secondary btn-sm" type="button" data-routine-edit="${escAttr(routine.id)}">Edit</button>
          <button class="btn btn-danger btn-sm" type="button" data-routine-delete="${escAttr(routine.id)}" data-label="${escAttr(routine.name)}">Delete</button>
          <label class="sb-toggle">
            <input type="checkbox" data-routine-quick-toggle="${escAttr(routine.id)}" ${routine.enabled ? 'checked' : ''}>
            <span>Live</span>
          </label>
        </div>
      </td>
    </tr>
  `;
}

function renderRoutineCreateForm(entry, data) {
  const available = availableRoutineCatalog(data);
  if (!available.length) {
    return '<div class="sb-empty">All routine types are already configured. Select a routine on the right to edit it.</div>';
  }

  const selectedEntry = entry && (entry.allowMultiple || !entry.configured)
    ? entry
    : available[0];
  const preview = {
    ...selectedEntry.manifest,
    templateId: selectedEntry.templateId,
    enabled: selectedEntry.manifest.enabledByDefault,
    config: selectedEntry.templateId === 'topic-watch'
      ? { topicQuery: '' }
      : selectedEntry.templateId === 'deadline-watch'
        ? { dueWithinHours: 24, includeOverdue: true }
        : undefined,
    lastRunAt: null,
  };

  return `
    <div class="sb-stack">
      <p class="sb-section__copy">Choose what Guardian should do, set the timing, and pick where updates should be delivered. Telegram is the default assistant channel.</p>
      <form class="sb-form" data-routine-create-form>
        <label class="sb-form__label" for="routine-template-id">Routine type</label>
        <select id="routine-template-id" name="templateId">
          ${available.map((option) => `<option value="${escAttr(option.templateId)}" ${option.templateId === selectedEntry.templateId ? 'selected' : ''}>${esc(option.name)}</option>`).join('')}
        </select>
        <div class="sb-readout">
          <strong>What it does</strong>
          <span>${esc(selectedEntry.description)}</span>
        </div>
        ${renderRoutineFormFields(preview, { submitLabel: 'Create routine', entry: selectedEntry })}
      </form>
    </div>
  `;
}

function renderRoutineEditor(routine, entry) {
  return `
    <div class="sb-stack">
      ${entry?.description ? `<p class="sb-section__copy">${esc(entry.description)}</p>` : ''}
      <form class="sb-form" data-routine-form>
        <input type="hidden" name="id" value="${escAttr(routine.id)}">
        <input type="hidden" name="templateId" value="${escAttr(routine.templateId || routine.id)}">
        ${renderRoutineFormFields(routine, {
          submitLabel: 'Save routine',
          entry,
          extraActions: `<button class="btn btn-danger" type="button" data-routine-delete="${escAttr(routine.id)}" data-label="${escAttr(routine.name)}">Delete routine</button>`,
        })}
      </form>
    </div>
  `;
}

function renderRoutineFormFields(routine, options = {}) {
  const submitLabel = options.submitLabel || 'Save routine';
  const extraActions = options.extraActions || '';
  const entry = options.entry || null;
  const templateId = entry?.templateId || routine.templateId || routine.id;
  const editableCron = routine.category !== 'one_off' && (routine.trigger?.mode === 'cron' || routine.trigger?.mode === 'manual');
  const supportsLookahead = routine.trigger?.mode === 'event' || routine.trigger?.mode === 'horizon';
  const lookaheadLabel = routine.trigger?.eventType === 'upcoming_event'
    ? 'Generate this long before the meeting (minutes)'
    : routine.trigger?.eventType === 'event_ended'
      ? 'Include meetings that ended within the last (minutes)'
      : 'Look this far ahead (minutes)';
  const cronPreview = routine.trigger?.cron?.trim()
    ? cronSummary(routine.trigger.cron)
    : 'Enter a five-field cron schedule to preview it in plain English.';

  return `
    <label class="sb-form__label" for="routine-name">Routine name</label>
    <input id="routine-name" name="name" type="text" placeholder="Routine name" value="${escAttr(routine.name || '')}">
    <label class="sb-check">
      <input name="enabled" type="checkbox" ${routine.enabled ? 'checked' : ''}>
      <span>Enabled</span>
    </label>

    ${templateId === 'topic-watch' ? `
      <label class="sb-form__label" for="routine-topic-query">What should Guardian watch for?</label>
      <input
        id="routine-topic-query"
        name="topicQuery"
        type="text"
        placeholder="Harbor launch review"
        value="${escAttr(routine.config?.topicQuery || '')}"
      >
      <div class="sb-table-copy">Guardian will scan matching tasks, notes, people, library items, briefs, and events, then message you when new matching context appears.</div>
    ` : templateId === 'deadline-watch' ? `
      <label class="sb-form__label" for="routine-due-within-hours">Alert me about tasks due within (hours)</label>
      <input
        id="routine-due-within-hours"
        name="dueWithinHours"
        type="number"
        min="1"
        step="1"
        value="${escAttr(String(routine.config?.dueWithinHours ?? 24))}"
      >
      <label class="sb-check">
        <input name="includeOverdue" type="checkbox" ${routine.config?.includeOverdue !== false ? 'checked' : ''}>
        <span>Include overdue tasks too</span>
      </label>
      <div class="sb-table-copy">Guardian will watch open tasks entering the due-soon window and can also include newly overdue tasks in the alert.</div>
    ` : ''}

    ${editableCron ? `
      <label class="sb-form__label" for="routine-trigger-mode">When should Guardian run this?</label>
      <select id="routine-trigger-mode" name="triggerMode" data-routine-trigger-mode>
        ${renderSelectOptions([
          { value: 'cron', label: 'Scheduled' },
          { value: 'manual', label: 'Manual only' },
        ], routine.trigger?.mode || 'manual')}
      </select>
      <div data-routine-cron-group style="display: ${routine.trigger?.mode === 'cron' ? 'block' : 'none'}">
        <label class="sb-form__label" for="routine-cron">Schedule</label>
        <input id="routine-cron" name="cron" type="text" placeholder="0 7 * * *" value="${escAttr(routine.trigger?.cron || '')}">
        <div class="sb-readout">
          <strong>Plain-English preview</strong>
          <span data-routine-cron-preview>${esc(cronPreview)}</span>
        </div>
        <div class="sb-table-copy">Examples: 0 7 * * * runs daily at 7 a.m.; 0 18 * * * runs daily at 6 p.m.; 0 9 * * 1 runs every Monday at 9 a.m.</div>
      </div>
    ` : `
      <input type="hidden" name="triggerMode" value="${escAttr(routine.trigger?.mode || 'manual')}">
      ${routine.trigger?.eventType ? `<input type="hidden" name="eventType" value="${escAttr(routine.trigger.eventType)}">` : ''}
      <div class="sb-readout">
        <strong>When it runs</strong>
        <span>${esc(routineTimingLabel(routine.trigger))}</span>
      </div>
    `}

    ${supportsLookahead ? `
      <label class="sb-form__label" for="routine-lookahead-minutes">${esc(lookaheadLabel)}</label>
      <input
        id="routine-lookahead-minutes"
        name="lookaheadMinutes"
        type="number"
        min="5"
        step="5"
        value="${escAttr(String(routine.trigger?.lookaheadMinutes ?? ''))}"
      >
      <div class="sb-table-copy">${esc(describeRoutineTrigger(routine.trigger))}</div>
    ` : ''}

    <div class="sb-form__label">Send updates through</div>
    <div class="sb-check-grid">
      ${['web', 'cli', 'telegram'].map((channel) => `
        <label class="sb-check">
          <input name="deliveryDefaults" type="checkbox" value="${escAttr(channel)}" ${routine.deliveryDefaults.includes(channel) ? 'checked' : ''}>
          <span>${esc(channel)}</span>
        </label>
      `).join('')}
    </div>
    <div class="sb-table-copy">Telegram is the default assistant channel. Add web or CLI when you also want operator visibility.</div>

    ${renderFormActions(esc(submitLabel), extraActions)}
  `;
}

function bindInteractions(container) {
  if (boundContainers.has(container)) return;
  boundContainers.add(container);

  container.addEventListener('click', async (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const captureKind = target.closest('[data-capture-kind]');
    if (captureKind?.dataset.captureKind) {
      state.todayCaptureKind = captureKind.dataset.captureKind;
      void rerenderLocal();
      return;
    }

    const calendarNav = target.closest('[data-calendar-nav]');
    if (calendarNav?.dataset.calendarNav) {
      if (calendarNav.dataset.calendarNav === 'prev') {
        state.calendarCursor = shiftCalendarCursor(state.calendarCursor, state.calendarView, -1);
      } else if (calendarNav.dataset.calendarNav === 'next') {
        state.calendarCursor = shiftCalendarCursor(state.calendarCursor, state.calendarView, 1);
      } else {
        state.calendarCursor = startOfDay(Date.now());
        state.selectedCalendarDate = dayKey(new Date());
      }
      state.selectedCalendarEventId = null;
      state.creatingCalendarEvent = true;
      void renderSecondBrain(container, { tab: state.activeTab, refresh: true });
      return;
    }

    const calendarView = target.closest('[data-calendar-view]');
    if (calendarView?.dataset.calendarView) {
      state.calendarView = normalizeCalendarView(calendarView.dataset.calendarView);
      state.calendarCursor = parseDayKey(state.selectedCalendarDate);
      state.selectedCalendarEventId = null;
      state.creatingCalendarEvent = true;
      void renderSecondBrain(container, { tab: state.activeTab, refresh: true });
      return;
    }

    const selectDate = target.closest('[data-calendar-select-date]');
    if (selectDate?.dataset.calendarSelectDate) {
      state.selectedCalendarDate = selectDate.dataset.calendarSelectDate;
      state.calendarCursor = parseDayKey(state.selectedCalendarDate);
      if (selectDate.dataset.calendarSelectEvent) {
        state.selectedCalendarEventId = selectDate.dataset.calendarSelectEvent;
        state.creatingCalendarEvent = false;
      } else {
        state.selectedCalendarEventId = null;
        state.creatingCalendarEvent = true;
      }
      void rerenderLocal();
      return;
    }

    const selectEvent = target.closest('[data-calendar-select-event]');
    if (selectEvent?.dataset.calendarSelectEvent) {
      state.selectedCalendarEventId = selectEvent.dataset.calendarSelectEvent;
      state.creatingCalendarEvent = false;
      if (selectEvent.dataset.calendarSelectDate) {
        state.selectedCalendarDate = selectEvent.dataset.calendarSelectDate;
      }
      void rerenderLocal();
      return;
    }

    const newEvent = target.closest('[data-calendar-new]');
    if (newEvent?.dataset.calendarNew) {
      state.selectedCalendarEventId = null;
      state.creatingCalendarEvent = true;
      if (newEvent.dataset.dateKey) {
        state.selectedCalendarDate = newEvent.dataset.dateKey;
        state.calendarCursor = parseDayKey(state.selectedCalendarDate);
      }
      void rerenderLocal();
      return;
    }

    const calendarDelete = target.closest('[data-calendar-delete]');
    if (calendarDelete?.dataset.calendarDelete) {
      await deleteMutation({
        noun: 'event',
        id: calendarDelete.dataset.calendarDelete,
        label: calendarDelete.dataset.label || 'this event',
        runMutation: () => api.secondBrainCalendarDelete(calendarDelete.dataset.calendarDelete),
        onSuccess: () => {
          state.selectedCalendarEventId = null;
          state.creatingCalendarEvent = true;
        },
      });
      return;
    }

    const taskSelect = target.closest('[data-task-select]');
    if (taskSelect?.dataset.taskSelect) {
      state.selectedTaskId = taskSelect.dataset.taskSelect;
      state.creatingTask = false;
      void rerenderLocal();
      return;
    }

    const taskNew = target.closest('[data-task-new]');
    if (taskNew?.dataset.taskNew) {
      state.selectedTaskId = null;
      state.creatingTask = true;
      void rerenderLocal();
      return;
    }

    const taskStatus = target.closest('[data-task-status]');
    if (taskStatus?.dataset.taskStatus && taskStatus.dataset.taskId) {
      await updateTaskStatus(taskStatus.dataset.taskId, taskStatus.dataset.taskStatus);
      return;
    }

    const taskDelete = target.closest('[data-task-delete]');
    if (taskDelete?.dataset.taskDelete) {
      await deleteMutation({
        noun: 'task',
        id: taskDelete.dataset.taskDelete,
        label: taskDelete.dataset.label || 'this task',
        runMutation: () => api.secondBrainTaskDelete(taskDelete.dataset.taskDelete),
        onSuccess: () => {
          state.selectedTaskId = null;
          state.creatingTask = true;
        },
      });
      return;
    }

    const noteSelect = target.closest('[data-note-select]');
    if (noteSelect?.dataset.noteSelect) {
      state.selectedNoteId = noteSelect.dataset.noteSelect;
      state.creatingNote = false;
      void rerenderLocal();
      return;
    }

    const noteNew = target.closest('[data-note-new]');
    if (noteNew?.dataset.noteNew) {
      state.selectedNoteId = null;
      state.creatingNote = true;
      void rerenderLocal();
      return;
    }

    const noteDelete = target.closest('[data-note-delete]');
    if (noteDelete?.dataset.noteDelete) {
      await deleteMutation({
        noun: 'note',
        id: noteDelete.dataset.noteDelete,
        label: noteDelete.dataset.label || 'this note',
        runMutation: () => api.secondBrainNoteDelete(noteDelete.dataset.noteDelete),
        onSuccess: () => {
          state.selectedNoteId = null;
          state.creatingNote = true;
        },
      });
      return;
    }

    const personSelect = target.closest('[data-person-select]');
    if (personSelect?.dataset.personSelect) {
      state.selectedPersonId = personSelect.dataset.personSelect;
      state.creatingPerson = false;
      void rerenderLocal();
      return;
    }

    const personNew = target.closest('[data-person-new]');
    if (personNew?.dataset.personNew) {
      state.selectedPersonId = null;
      state.creatingPerson = true;
      void rerenderLocal();
      return;
    }

    const personRelationship = target.closest('[data-person-relationship]');
    if (personRelationship?.dataset.personRelationship) {
      state.personRelationship = personRelationship.dataset.personRelationship;
      state.creatingPerson = false;
      state.selectedPersonId = preserveSelection(null, state.data?.people.filter((person) => matchesPersonFilter(person)) ?? []);
      void rerenderLocal();
      return;
    }

    const personTouch = target.closest('[data-person-touch]');
    if (personTouch?.dataset.personTouch) {
      await updatePersonLastContact(personTouch.dataset.personTouch);
      return;
    }

    const personDelete = target.closest('[data-person-delete]');
    if (personDelete?.dataset.personDelete) {
      await deleteMutation({
        noun: 'contact',
        id: personDelete.dataset.personDelete,
        label: personDelete.dataset.label || 'this contact',
        runMutation: () => api.secondBrainPersonDelete(personDelete.dataset.personDelete),
        onSuccess: () => {
          state.selectedPersonId = null;
          state.creatingPerson = true;
        },
      });
      return;
    }

    const linkSelect = target.closest('[data-link-select]');
    if (linkSelect?.dataset.linkSelect) {
      state.selectedLinkId = linkSelect.dataset.linkSelect;
      state.creatingLink = false;
      void rerenderLocal();
      return;
    }

    const linkNew = target.closest('[data-link-new]');
    if (linkNew?.dataset.linkNew) {
      state.selectedLinkId = null;
      state.creatingLink = true;
      void rerenderLocal();
      return;
    }

    const linkKind = target.closest('[data-link-kind]');
    if (linkKind?.dataset.linkKind) {
      state.linkKind = linkKind.dataset.linkKind;
      state.creatingLink = false;
      state.selectedLinkId = preserveSelection(null, state.data?.links.filter((link) => matchesLinkFilter(link)) ?? []);
      void rerenderLocal();
      return;
    }

    const linkPickFile = target.closest('[data-link-pick-file]');
    if (linkPickFile?.dataset.linkPickFile) {
      event.preventDefault();
      event.stopPropagation();
      try {
        const result = await api.pickSearchPath('file');
        if (result?.canceled) {
          setFlash('error', result.message || 'File selection cancelled.');
          return;
        }
        if (!result?.success || !result?.path) {
          setFlash('error', result?.message || 'Failed to pick file.');
          return;
        }
        const urlInput = currentContainer.querySelector('#link-url');
        if (urlInput) urlInput.value = result.path;
        setFlash('success', result.message || 'File selected.');
      } catch (err) {
        setFlash('error', 'Failed to pick file: ' + (err instanceof Error ? err.message : String(err)));
      }
      return;
    }

    const linkDelete = target.closest('[data-link-delete]');
    if (linkDelete?.dataset.linkDelete) {
      await deleteMutation({
        noun: 'library item',
        id: linkDelete.dataset.linkDelete,
        label: linkDelete.dataset.label || 'this item',
        runMutation: () => api.secondBrainLinkDelete(linkDelete.dataset.linkDelete),
        onSuccess: () => {
          state.selectedLinkId = null;
          state.creatingLink = true;
        },
      });
      return;
    }

    const briefSelect = target.closest('[data-brief-select]');
    if (briefSelect?.dataset.briefSelect) {
      state.selectedBriefId = briefSelect.dataset.briefSelect;
      void rerenderLocal();
      return;
    }

    const briefKind = target.closest('[data-brief-kind]');
    if (briefKind?.dataset.briefKind) {
      state.briefKind = briefKind.dataset.briefKind;
      state.selectedBriefId = preserveSelection(null, filteredBriefs(state.data ?? { briefs: [] }));
      void rerenderLocal();
      return;
    }

    const generateBrief = target.closest('[data-generate-brief]');
    if (generateBrief?.dataset.generateBrief) {
      await generateBriefAction(generateBrief.dataset.generateBrief, generateBrief.dataset.eventId);
      return;
    }

    const briefDelete = target.closest('[data-brief-delete]');
    if (briefDelete?.dataset.briefDelete) {
      await deleteMutation({
        noun: 'brief',
        id: briefDelete.dataset.briefDelete,
        label: briefDelete.dataset.label || 'this brief',
        runMutation: () => api.secondBrainBriefDelete(briefDelete.dataset.briefDelete),
        onSuccess: () => {
          state.selectedBriefId = null;
        },
      });
      return;
    }

    const routineRow = target.closest('[data-routine-row]');
    if (
      routineRow?.dataset.routineRow
      && !(target instanceof HTMLButtonElement)
      && !(target instanceof HTMLInputElement)
      && !(target.closest('button'))
      && !(target.closest('label'))
    ) {
      const routine = findRecord(state.data?.routines || [], routineRow.dataset.routineRow);
      state.selectedRoutineId = routineRow.dataset.routineRow;
      state.selectedRoutineTemplateId = routine?.templateId || routine?.id || null;
      state.creatingRoutine = false;
      void rerenderLocal();
      return;
    }

    const routineRefresh = target.closest('[data-routine-refresh]');
    if (routineRefresh?.dataset.routineRefresh) {
      await renderSecondBrain(container, { tab: state.activeTab, refresh: true });
      return;
    }

    const routineCreateToggle = target.closest('[data-routine-create-toggle]');
    if (routineCreateToggle?.dataset.routineCreateToggle) {
      state.creatingRoutine = !state.creatingRoutine;
      if (state.creatingRoutine) {
        const firstAvailable = availableRoutineCatalog(state.data ?? { routineCatalog: [] })[0];
        state.selectedRoutineTemplateId = firstAvailable?.templateId ?? null;
      }
      void rerenderLocal();
      return;
    }

    const routineEdit = target.closest('[data-routine-edit]');
    if (routineEdit?.dataset.routineEdit) {
      const routine = findRecord(state.data?.routines || [], routineEdit.dataset.routineEdit);
      state.selectedRoutineId = routineEdit.dataset.routineEdit;
      state.selectedRoutineTemplateId = routine?.templateId || routine?.id || null;
      state.creatingRoutine = false;
      void rerenderLocal();
      return;
    }

    const routineCreateSelect = target.closest('[data-routine-create-select]');
    if (routineCreateSelect?.dataset.routineCreateSelect) {
      state.selectedRoutineTemplateId = routineCreateSelect.dataset.routineCreateSelect;
      state.creatingRoutine = true;
      void rerenderLocal();
      return;
    }

    const routineDelete = target.closest('[data-routine-delete]');
    if (routineDelete?.dataset.routineDelete) {
      await deleteMutation({
        noun: 'routine',
        id: routineDelete.dataset.routineDelete,
        label: routineDelete.dataset.label || 'this routine',
        runMutation: () => api.secondBrainRoutineDelete(routineDelete.dataset.routineDelete),
        onSuccess: () => {
          state.selectedRoutineId = null;
          state.selectedRoutineTemplateId = null;
          state.creatingRoutine = false;
        },
      });
      return;
    }

    if (target.closest('[data-second-brain-sync-now]')) {
      await saveMutation(() => api.secondBrainSyncNow());
      return;
    }

    const routineStatus = target.closest('[data-routine-status]');
    if (routineStatus?.dataset.routineStatus) {
      state.routineStatus = routineStatus.dataset.routineStatus;
      state.selectedRoutineId = preserveSelection(state.selectedRoutineId, filteredRoutineList(state.data ?? { routines: [], routineCatalog: [] }));
      void rerenderLocal();
      return;
    }

    const routineCategory = target.closest('[data-routine-category]');
    if (routineCategory?.dataset.routineCategory) {
      state.routineCategory = routineCategory.dataset.routineCategory;
      state.selectedRoutineId = preserveSelection(state.selectedRoutineId, filteredRoutineList(state.data ?? { routines: [], routineCatalog: [] }));
      void rerenderLocal();
      return;
    }
  });

  container.addEventListener('change', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target instanceof HTMLSelectElement && target.matches('[data-routine-trigger-mode]')) {
      const form = target.closest('form');
      const group = form?.querySelector('[data-routine-cron-group]');
      if (group instanceof HTMLElement) {
        group.style.display = target.value === 'cron' ? 'block' : 'none';
      }
      return;
    }

    if (target.id === 'routine-template-id' && target instanceof HTMLSelectElement) {
      state.selectedRoutineTemplateId = target.value;
      state.creatingRoutine = true;
      void rerenderLocal();
      return;
    }

    if (target instanceof HTMLInputElement && target.dataset.routineQuickToggle) {
      await saveMutation(() => api.secondBrainRoutineUpdate({
        id: target.dataset.routineQuickToggle,
        enabled: target.checked,
      }), (result) => {
        state.selectedRoutineId = String(result?.details?.id ?? target.dataset.routineQuickToggle);
      });
      return;
    }
  });

  container.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.name === 'cron') {
      const form = target.closest('form');
      const preview = form?.querySelector('[data-routine-cron-preview]');
      if (preview instanceof HTMLElement) {
        preview.textContent = target.value.trim()
          ? cronSummary(target.value)
          : 'Enter a five-field cron schedule to preview it in plain English.';
      }
      return;
    }
    if (target.id === 'sb-routine-search') {
      state.routineQuery = target.value;
      state.selectedRoutineId = preserveSelection(state.selectedRoutineId, filteredRoutineList(state.data ?? { routines: [], routineCatalog: [] }));
      void rerenderLocal();
    }
  });

  container.addEventListener('submit', async (event) => {
    const target = event.target instanceof HTMLFormElement ? event.target : null;
    if (!target) return;

    if (target.matches('[data-today-capture-form]')) {
      event.preventDefault();
      await submitTodayCapture(target);
      return;
    }

    if (target.matches('[data-calendar-form]')) {
      event.preventDefault();
      await saveMutation(() => api.secondBrainCalendarUpsert({
        id: readString(target, 'id') || undefined,
        title: readString(target, 'title'),
        description: readString(target, 'description'),
        startsAt: new Date(readString(target, 'startsAt')).getTime(),
        endsAt: readString(target, 'endsAt') ? new Date(readString(target, 'endsAt')).getTime() : undefined,
        location: readString(target, 'location'),
      }), (result) => {
        if (result?.details?.id) {
          state.selectedCalendarEventId = String(result.details.id);
          state.creatingCalendarEvent = false;
        }
      });
      return;
    }

    if (target.matches('[data-brief-form]')) {
      event.preventDefault();
      await saveMutation(() => api.secondBrainBriefUpdate({
        id: readString(target, 'id'),
        title: readString(target, 'title'),
        content: readString(target, 'content'),
      }), (result) => {
        if (result?.details?.id) {
          state.selectedBriefId = String(result.details.id);
        }
      });
      return;
    }

    if (target.matches('[data-task-form]')) {
      event.preventDefault();
      await saveMutation(() => api.secondBrainTaskUpsert({
        id: readString(target, 'id') || undefined,
        title: readString(target, 'title'),
        details: readString(target, 'details') || undefined,
        priority: readString(target, 'priority') || 'medium',
        status: readString(target, 'status') || 'todo',
        dueAt: readString(target, 'dueAt') ? new Date(readString(target, 'dueAt')).getTime() : undefined,
      }), (result) => {
        if (result?.details?.id) {
          state.selectedTaskId = String(result.details.id);
          state.creatingTask = false;
        }
      });
      return;
    }

    if (target.matches('[data-note-form]')) {
      event.preventDefault();
      await saveMutation(() => api.secondBrainNoteUpsert({
        id: readString(target, 'id') || undefined,
        title: readString(target, 'title') || undefined,
        tags: parseTags(readString(target, 'tags')),
        pinned: readCheckbox(target, 'pinned'),
        archived: readCheckbox(target, 'archived'),
        content: readString(target, 'content'),
      }), (result) => {
        if (result?.details?.id) {
          state.selectedNoteId = String(result.details.id);
          state.creatingNote = false;
        }
      });
      return;
    }

    if (target.matches('[data-person-form]')) {
      event.preventDefault();
      await saveMutation(() => api.secondBrainPersonUpsert({
        id: readString(target, 'id') || undefined,
        name: readString(target, 'name') || undefined,
        email: readString(target, 'email') || undefined,
        title: readString(target, 'title') || undefined,
        company: readString(target, 'company') || undefined,
        relationship: readString(target, 'relationship') || 'work',
        lastContactAt: readString(target, 'lastContactAt') ? new Date(readString(target, 'lastContactAt')).getTime() : undefined,
        notes: readString(target, 'notes') || undefined,
      }), (result) => {
        if (result?.details?.id) {
          state.selectedPersonId = String(result.details.id);
          state.creatingPerson = false;
        }
      });
      return;
    }

    if (target.matches('[data-link-form]')) {
      event.preventDefault();
      await saveMutation(() => api.secondBrainLinkUpsert({
        id: readString(target, 'id') || undefined,
        title: readString(target, 'title') || undefined,
        url: readString(target, 'url'),
        kind: readString(target, 'kind') || 'reference',
        tags: parseTags(readString(target, 'tags')),
        summary: readString(target, 'summary') || undefined,
      }), (result) => {
        if (result?.details?.id) {
          state.selectedLinkId = String(result.details.id);
          state.creatingLink = false;
        }
      });
      return;
    }

    if (target.matches('[data-routine-create-form]')) {
      event.preventDefault();
      await saveMutation(() => api.secondBrainRoutineCreate({
        templateId: readString(target, 'templateId'),
        name: readString(target, 'name') || undefined,
        enabled: readCheckbox(target, 'enabled'),
        trigger: readRoutineTriggerForm(target),
        config: readRoutineConfigForm(target),
        deliveryDefaults: readCheckboxValues(target, 'deliveryDefaults'),
      }), (result) => {
        if (result?.details?.id) {
          state.selectedRoutineId = String(result.details.id);
          const routine = findRecord(state.data?.routines || [], String(result.details.id));
          state.selectedRoutineTemplateId = routine?.templateId || readString(target, 'templateId');
          state.creatingRoutine = false;
        }
      });
      return;
    }

    if (target.matches('[data-routine-form]')) {
      event.preventDefault();
      await saveMutation(() => api.secondBrainRoutineUpdate({
        id: readString(target, 'id'),
        name: readString(target, 'name') || undefined,
        enabled: readCheckbox(target, 'enabled'),
        trigger: readRoutineTriggerForm(target),
        config: readRoutineConfigForm(target),
        deliveryDefaults: readCheckboxValues(target, 'deliveryDefaults'),
      }), (result) => {
        if (result?.details?.id) {
          state.selectedRoutineId = String(result.details.id);
          state.selectedRoutineTemplateId = readString(target, 'templateId') || state.selectedRoutineTemplateId;
        }
      });
      return;
    }

    if (target.matches('[data-note-search-form]')) {
      event.preventDefault();
      state.noteQuery = readString(target, 'query');
      state.creatingNote = false;
      state.selectedNoteId = preserveSelection(null, state.data?.notes.filter((note) => matchesNoteQuery(note, state.noteQuery)) ?? []);
      void rerenderLocal();
      return;
    }

    if (target.matches('[data-person-search-form]')) {
      event.preventDefault();
      state.personQuery = readString(target, 'query');
      state.creatingPerson = false;
      state.selectedPersonId = preserveSelection(null, state.data?.people.filter((person) => matchesPersonFilter(person)) ?? []);
      void rerenderLocal();
      return;
    }

    if (target.matches('[data-link-search-form]')) {
      event.preventDefault();
      state.linkQuery = readString(target, 'query');
      state.creatingLink = false;
      state.selectedLinkId = preserveSelection(null, state.data?.links.filter((link) => matchesLinkFilter(link)) ?? []);
      void rerenderLocal();
    }
  });
}

async function submitTodayCapture(form) {
  if (form.dataset.todayCaptureForm === 'task') {
    await saveMutation(() => api.secondBrainTaskUpsert({
      title: readString(form, 'title'),
      priority: readString(form, 'priority') || 'medium',
      dueAt: readString(form, 'dueAt') ? new Date(readString(form, 'dueAt')).getTime() : undefined,
    }), (result) => {
      if (result?.details?.id) {
        state.selectedTaskId = String(result.details.id);
        state.creatingTask = false;
      }
    });
    return;
  }

  if (form.dataset.todayCaptureForm === 'event') {
    await saveMutation(() => api.secondBrainCalendarUpsert({
      title: readString(form, 'title'),
      startsAt: new Date(readString(form, 'startsAt')).getTime(),
      endsAt: readString(form, 'endsAt') ? new Date(readString(form, 'endsAt')).getTime() : undefined,
    }), (result) => {
      if (result?.details?.id) {
        state.selectedCalendarEventId = String(result.details.id);
        state.creatingCalendarEvent = false;
      }
    });
    return;
  }

  await saveMutation(() => api.secondBrainNoteUpsert({
    title: readString(form, 'title') || undefined,
    content: readString(form, 'content'),
  }), (result) => {
    if (result?.details?.id) {
      state.selectedNoteId = String(result.details.id);
      state.creatingNote = false;
    }
  });
}

async function updateTaskStatus(taskId, status) {
  const task = findRecord(state.data?.tasks ?? [], taskId);
  if (!task) return;
  await saveMutation(() => api.secondBrainTaskUpsert({
    id: task.id,
    title: task.title,
    details: task.details,
    priority: task.priority,
    dueAt: task.dueAt ?? undefined,
    status,
  }), (result) => {
    if (result?.details?.id) {
      state.selectedTaskId = String(result.details.id);
      state.creatingTask = false;
    }
  });
}

async function updatePersonLastContact(personId) {
  const person = findRecord(state.data?.people ?? [], personId);
  if (!person) return;
  await saveMutation(() => api.secondBrainPersonUpsert({
    id: person.id,
    name: person.name,
    email: person.email,
    title: person.title,
    company: person.company,
    relationship: person.relationship,
    notes: person.notes,
    lastContactAt: Date.now(),
  }), (result) => {
    if (result?.details?.id) {
      state.selectedPersonId = String(result.details.id);
    }
  });
}

async function generateBriefAction(kind, eventId) {
  try {
    const brief = await api.secondBrainGenerateBrief({
      kind,
      eventId: eventId || undefined,
    });
    state.selectedBriefId = brief.id;
    setFlash('success', `Generated '${brief.title}'.`);
    await renderSecondBrain(currentContainer, { tab: 'briefs', refresh: true });
  } catch (error) {
    setFlash('error', error instanceof Error ? error.message : String(error), true);
    await rerenderLocal();
  }
}

async function saveMutation(runMutation, onSuccess) {
  try {
    const result = await runMutation();
    if (!result?.success) {
      throw new Error(result?.message || 'The save did not complete.');
    }
    if (typeof onSuccess === 'function') {
      onSuccess(result);
    }
    setFlash('success', result.message || 'Saved.');
    await renderSecondBrain(currentContainer, { tab: state.activeTab, refresh: true });
    return result;
  } catch (error) {
    setFlash('error', error instanceof Error ? error.message : String(error), true);
    await rerenderLocal();
    return null;
  }
}

async function deleteMutation({ noun, id, label, runMutation, onSuccess }) {
  if (!id) return null;
  if (!window.confirm(`Delete ${noun} '${label}'?`)) {
    return null;
  }
  return saveMutation(runMutation, onSuccess);
}

async function rerenderLocal() {
  if (!currentContainer) return;
  await renderSecondBrain(currentContainer, { tab: state.activeTab, refresh: false });
}

function setFlash(kind, message, sticky = false) {
  state.flash = { kind, message };
  syncFlashBanner();
  if (flashTimer) {
    window.clearTimeout(flashTimer);
    flashTimer = null;
  }
  if (sticky) return;
  flashTimer = window.setTimeout(() => {
    state.flash = null;
    syncFlashBanner();
  }, 4500);
}

function renderAgenda(events, emptyText) {
  if (!events.length) {
    return `<div class="sb-empty">${esc(emptyText)}</div>`;
  }
  return `
    <div class="sb-agenda">
      ${events.map((event) => `
        <div class="sb-agenda__item">
          <div class="sb-agenda__time">${esc(formatEventChipTime(event))}</div>
          <div class="sb-agenda__content">
            <strong>${esc(event.title)}</strong>
            <span>${esc(`${formatTimeRange(event)}${event.location ? ` · ${event.location}` : ''}`)}</span>
            ${event.description ? `<span>${esc(summarize(event.description, 140))}</span>` : ''}
          </div>
          <span class="badge badge-muted">${esc(event.source)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderTaskCompactList(tasks, emptyText) {
  if (!tasks.length) return `<div class="sb-empty">${esc(emptyText)}</div>`;
  return `
    <div class="sb-stack">
      ${tasks.map((task) => `
        <div class="sb-compact-row">
          <div>
            <strong>${esc(task.title)}</strong>
            <span>${esc(task.details ? summarize(task.details, 120) : (task.dueAt ? `Due ${formatShortDateTime(task.dueAt)}` : 'No due date'))}</span>
          </div>
          <span class="badge ${priorityBadgeClass(task.priority)}">${esc(task.priority)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderNoteCompactList(notes, emptyText) {
  if (!notes.length) return `<div class="sb-empty">${esc(emptyText)}</div>`;
  return `
    <div class="sb-stack">
      ${notes.map((note) => `
        <div class="sb-compact-row">
          <div>
            <strong>${esc(note.title)}</strong>
            <span>${esc(summarize(note.content, 120))}</span>
          </div>
          <span class="badge badge-muted">${esc(formatShortDateTime(note.updatedAt))}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderPeopleCompactList(people, emptyText) {
  if (!people.length) return `<div class="sb-empty">${esc(emptyText)}</div>`;
  return `
    <div class="sb-stack">
      ${people.map((person) => `
        <div class="sb-compact-row">
          <div>
            <strong>${esc(person.name)}</strong>
            <span>${esc(renderPersonLine(person))}</span>
          </div>
          <span class="badge badge-warning">${esc(person.lastContactAt ? `Last ${formatRelativeDate(person.lastContactAt, Date.now())}` : 'Needs follow-up')}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderRoutineCompactList(routines) {
  if (!routines.length) return '<div class="sb-empty">No routines configured.</div>';
  return `
    <div class="sb-stack">
      ${routines.map((routine) => `
        <div class="sb-compact-row">
          <div>
            <strong>${esc(routine.name)}</strong>
            <span>${esc(describeRoutineTrigger(routine.trigger))}</span>
          </div>
          <span class="badge ${routine.enabled ? 'badge-ok' : 'badge-muted'}">${esc(routine.enabled ? 'Enabled' : 'Paused')}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderMetricCard(label, value, caption) {
  return `
    <article class="sb-metric-card">
      <span>${esc(label)}</span>
      <strong>${esc(value)}</strong>
      <small>${esc(caption)}</small>
    </article>
  `;
}

function renderUsageCard(usage) {
  const consumed = formatCount(usage.externalTokens);
  const budget = formatCount(usage.monthlyBudget);
  const caption = usage.externalTokens > 0
    ? 'Cloud AI tokens used by Second Brain this month. Local-only work does not count here.'
    : 'No cloud AI tokens used by Second Brain this month. Local-only work does not count here.';
  return `
    <div class="sb-usage-card">
      <div class="sb-usage-card__label">Cloud AI budget</div>
      <strong>${esc(`${consumed} / ${budget}`)}</strong>
      <span>${esc(caption)}</span>
    </div>
  `;
}

function renderReadoutCard(label, value) {
  return `
    <div class="sb-inline-stat">
      <span>${esc(label)}</span>
      <strong>${esc(value)}</strong>
    </div>
  `;
}

function formatUsageSummary(usage) {
  return `${formatCount(usage.externalTokens)} / ${formatCount(usage.monthlyBudget)}`;
}

function renderFlash(flash) {
  return `<div class="sb-flash sb-flash--${escAttr(flash.kind)}">${esc(flash.message)}</div>`;
}

function renderSegmentButton(value, label, active, dataAttribute) {
  const attr = dataAttribute.replace('data-', '');
  return `<button class="sb-segmented__btn${active ? ' is-active' : ''}" type="button" data-${attr}="${escAttr(value)}">${esc(label)}</button>`;
}

function renderSelectOptions(options, selectedValue) {
  return options.map((option) => `
    <option value="${escAttr(option.value)}" ${option.value === selectedValue ? 'selected' : ''}>${esc(option.label)}</option>
  `).join('');
}

function renderFormActions(submitLabel, deleteButton = '', secondaryAction = '') {
  return `
    <div class="sb-form__actions">
      <button class="btn btn-primary" type="submit">${submitLabel}</button>
      ${secondaryAction}
      ${deleteButton}
    </div>
  `;
}

function filteredRoutineList(data) {
  const routines = Array.isArray(data?.routines) ? data.routines : [];
  const query = state.routineQuery.trim().toLowerCase();
  return routines
    .filter((routine) => {
      const entry = findRoutineCatalogEntry(data, routine.templateId || routine.id);
      const category = entry?.category || 'maintenance';
      if (state.routineStatus === 'enabled' && !routine.enabled) return false;
      if (state.routineStatus === 'paused' && routine.enabled) return false;
      if (state.routineCategory !== 'all' && category !== state.routineCategory) return false;
      if (!query) return true;
      const haystack = [
        routine.name,
        entry?.name || '',
        entry?.description || '',
        category,
        describeRoutineTrigger(routine.trigger),
        routineTimingLabel(routine.trigger),
        routine.config?.topicQuery || '',
        Number.isFinite(routine.config?.dueWithinHours) ? `due within ${routine.config.dueWithinHours} hours` : '',
        typeof routine.config?.includeOverdue === 'boolean' ? (routine.config.includeOverdue ? 'overdue tasks' : 'upcoming tasks only') : '',
        routine.deliveryDefaults.join(' '),
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function availableRoutineCatalog(data) {
  const catalog = Array.isArray(data?.routineCatalog) ? data.routineCatalog : [];
  return catalog.filter((entry) => entry.allowMultiple || !entry.configured);
}

function resolveRoutineCreateEntry(entry, data) {
  if (entry && (entry.allowMultiple || !entry.configured)) return entry;
  return availableRoutineCatalog(data)[0] ?? null;
}

function findRoutineCatalogEntry(data, templateId) {
  if (!templateId) return null;
  return (Array.isArray(data?.routineCatalog) ? data.routineCatalog : []).find((entry) => entry.templateId === templateId) ?? null;
}

function categoryLabel(category) {
  return String(category || '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function describeRoutineTrigger(trigger) {
  if (!trigger || typeof trigger !== 'object') return 'Manual trigger';
  if (trigger.mode === 'cron' && trigger.cron) {
    return cronSummary(trigger.cron);
  }
  if (trigger.mode === 'event' && trigger.eventType) {
    const eventLabel = trigger.eventType === 'upcoming_event'
      ? 'Upcoming meetings'
      : trigger.eventType === 'event_ended'
        ? 'Recently ended meetings'
        : categoryLabel(trigger.eventType);
    return `${eventLabel}${trigger.lookaheadMinutes ? ` · ${formatLookahead(trigger.lookaheadMinutes)}` : ''}`;
  }
  if (trigger.mode === 'horizon' && trigger.lookaheadMinutes) {
    return `${formatLookahead(trigger.lookaheadMinutes)} horizon scan`;
  }
  return trigger.mode === 'manual'
    ? 'Run on demand'
    : String(trigger.mode || 'manual');
}

function routineTimingLabel(trigger) {
  if (!trigger || typeof trigger !== 'object') return 'Manual';
  if (trigger.mode === 'cron') return 'Scheduled';
  if (trigger.mode === 'event' && trigger.eventType === 'upcoming_event') return 'Before meetings';
  if (trigger.mode === 'event' && trigger.eventType === 'event_ended') return 'After meetings';
  if (trigger.mode === 'horizon') return 'Horizon check';
  return 'Manual';
}

const CRON_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function cronSummary(cron) {
  const parsed = parseCronSummary(cron);
  if (!parsed) {
    return 'Custom schedule';
  }
  const { minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField } = parsed;
  if (minuteField.match(/^\*\/\d+$/) && hourField === '*' && dayOfMonthField === '*' && monthField === '*' && dayOfWeekField === '*') {
    const interval = Number(minuteField.slice(2));
    return interval === 1 ? 'Every minute' : `Every ${interval} minutes`;
  }

  const minute = parseCronNumber(minuteField, 0, 59);
  if (minute == null) return 'Custom schedule';

  if (hourField === '*' && dayOfMonthField === '*' && monthField === '*' && dayOfWeekField === '*') {
    return minute === 0 ? 'Hourly' : `Hourly at ${formatMinuteOnly(minute)}`;
  }

  if (hourField.match(/^\*\/\d+$/) && dayOfMonthField === '*' && monthField === '*' && dayOfWeekField === '*') {
    const interval = Number(hourField.slice(2));
    if (interval === 1) {
      return minute === 0 ? 'Hourly' : `Hourly at ${formatMinuteOnly(minute)}`;
    }
    return minute === 0
      ? `Every ${interval} hours on the hour`
      : `Every ${interval} hours at ${formatMinuteOnly(minute)}`;
  }

  const hour = parseCronNumber(hourField, 0, 23);
  if (hour == null) return 'Custom schedule';
  const time = formatTimeOfDay(hour, minute);

  if (dayOfMonthField === '*' && monthField === '*' && dayOfWeekField === '*') {
    return `Daily at ${time}`;
  }

  if (dayOfMonthField === '*' && monthField === '*') {
    const dayList = parseCronDayList(dayOfWeekField);
    if (dayList) {
      if (sameDayList(dayList, [1, 2, 3, 4, 5])) {
        return `Weekdays at ${time}`;
      }
      if (sameDayList(dayList, [0, 6])) {
        return `Weekends at ${time}`;
      }
      if (dayList.length === 1) {
        return `Every ${CRON_DAY_NAMES[dayList[0]]} at ${time}`;
      }
      return `Every ${joinWithCommas(dayList.map((day) => CRON_DAY_NAMES[day]))} at ${time}`;
    }
  }

  const dayOfMonth = parseCronNumber(dayOfMonthField, 1, 31);
  if (dayOfMonth != null && monthField === '*' && dayOfWeekField === '*') {
    return `Monthly on the ${ordinal(dayOfMonth)} at ${time}`;
  }

  return 'Custom schedule';
}

function parseCronSummary(cron) {
  const parts = String(cron || '').trim().split(/\s+/g);
  if (parts.length !== 5) return null;
  return {
    minuteField: parts[0],
    hourField: parts[1],
    dayOfMonthField: parts[2],
    monthField: parts[3],
    dayOfWeekField: parts[4],
  };
}

function parseCronNumber(field, min, max) {
  if (!/^\d+$/.test(field)) return null;
  const value = Number(field);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function parseCronDayList(field) {
  if (field === '*') return [];
  const values = new Set();
  for (const part of String(field || '').split(',')) {
    const trimmed = part.trim();
    if (!trimmed) return null;
    const rangeMatch = trimmed.match(/^(\d)-(\d)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 7 || start > end) {
        return null;
      }
      for (let day = start; day <= end; day += 1) {
        values.add(day === 7 ? 0 : day);
      }
      continue;
    }
    const value = parseCronNumber(trimmed, 0, 7);
    if (value == null) return null;
    values.add(value === 7 ? 0 : value);
  }
  return [...values].sort((left, right) => left - right);
}

function sameDayList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatMinuteOnly(minute) {
  return minute === 0 ? 'on the hour' : `:${String(minute).padStart(2, '0')}`;
}

function formatTimeOfDay(hour, minute) {
  if (hour === 12 && minute === 0) return 'noon';
  if (hour === 0 && minute === 0) return 'midnight';
  const meridiem = hour >= 12 ? 'p.m.' : 'a.m.';
  const normalizedHour = hour % 12 || 12;
  return minute === 0
    ? `${normalizedHour} ${meridiem}`
    : `${normalizedHour}:${String(minute).padStart(2, '0')} ${meridiem}`;
}

function ordinal(value) {
  const modulo100 = value % 100;
  if (modulo100 >= 11 && modulo100 <= 13) {
    return `${value}th`;
  }
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

function joinWithCommas(values) {
  if (values.length <= 1) return values[0] || '';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function formatLookahead(minutes) {
  if (!Number.isFinite(minutes)) return '';
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minutes`;
}

function formatLinkHref(url) {
  if (!url) return '';
  if (url.match(/^[a-zA-Z]:[\\/]/)) {
    return new URL(`file:///${url.replace(/\\/g, '/')}`).toString();
  }
  if (url.startsWith('/')) {
    return new URL(`file://${url}`).toString();
  }
  if (url.startsWith('\\\\')) {
    return new URL(`file:${url.replace(/\\/g, '/')}`).toString();
  }
  return url;
}

function matchesNoteQuery(note, query) {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) return true;
  const haystack = [note.title, note.content, ...(note.tags || [])].join(' ').toLowerCase();
  return haystack.includes(normalized);
}

function matchesPersonFilter(person) {
  if (state.personRelationship !== 'all' && person.relationship !== state.personRelationship) {
    return false;
  }
  const query = state.personQuery.trim().toLowerCase();
  if (!query) return true;
  const haystack = [
    person.name,
    person.email,
    person.title,
    person.company,
    person.notes,
    person.relationship,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

function matchesLinkFilter(link) {
  if (state.linkKind !== 'all' && link.kind !== state.linkKind) {
    return false;
  }
  const query = state.linkQuery.trim().toLowerCase();
  if (!query) return true;
  const haystack = [link.title, link.url, link.summary, ...(link.tags || []), link.kind]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

function buildDayEventMap(events) {
  const dayEventMap = new Map();
  for (const event of events || []) {
    const rangeStart = startOfDay(event.startsAt);
    const rangeEnd = startOfDay(event.endsAt ?? event.startsAt);
    const cursor = new Date(rangeStart.getTime());
    while (cursor <= rangeEnd) {
      const key = dayKey(cursor);
      const bucket = dayEventMap.get(key) ?? [];
      bucket.push(event);
      dayEventMap.set(key, bucket);
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  for (const bucket of dayEventMap.values()) {
    bucket.sort((left, right) => left.startsAt - right.startsAt);
  }

  return dayEventMap;
}

function getDayEvents(dayEventMap, date) {
  return dayEventMap.get(dayKey(date)) ?? [];
}

function getEventsForDay(events, date) {
  const dayStart = startOfDay(date).getTime();
  const dayEnd = endOfDay(date).getTime();
  return (events || [])
    .filter((event) => (event.endsAt ?? event.startsAt) >= dayStart && event.startsAt <= dayEnd)
    .sort((left, right) => left.startsAt - right.startsAt);
}

function formatEventChipTime(event, day) {
  const start = new Date(event.startsAt);
  if (day && !sameDay(start, day)) return 'All day';
  return formatTime(start.getTime());
}

function formatTimeRange(event) {
  const start = formatShortDateTime(event.startsAt);
  if (!event.endsAt) return start;
  return `${start} to ${formatShortDateTime(event.endsAt)}`;
}

function isPersonStale(person, now) {
  if (!person.lastContactAt) return true;
  return (now - person.lastContactAt) > (30 * DAY_MS);
}

function renderPersonLine(person) {
  const parts = [
    person.email,
    person.title,
    person.company,
    person.notes ? summarize(person.notes, 90) : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'No extra context yet.';
}

function findRecord(records, id) {
  return (records || []).find((record) => record.id === id) ?? null;
}

function readString(form, name) {
  const field = form.querySelector(`[name="${name}"]`);
  return field && 'value' in field ? String(field.value || '').trim() : '';
}

function readCheckbox(form, name) {
  const field = form.querySelector(`[name="${name}"]`);
  return !!field?.checked;
}

function readCheckboxValues(form, name) {
  return [...form.querySelectorAll(`[name="${name}"]`)]
    .filter((field) => field instanceof HTMLInputElement && field.checked)
    .map((field) => field.value);
}

function readRoutineTriggerForm(form) {
  const mode = readString(form, 'triggerMode') || 'manual';
  if (mode === 'cron') {
    return {
      mode,
      cron: readString(form, 'cron'),
    };
  }
  if (mode === 'event') {
    const lookaheadMinutes = Number(readString(form, 'lookaheadMinutes'));
    return {
      mode,
      eventType: readString(form, 'eventType') || undefined,
      ...(Number.isFinite(lookaheadMinutes) && lookaheadMinutes > 0 ? { lookaheadMinutes } : {}),
    };
  }
  if (mode === 'horizon') {
    const lookaheadMinutes = Number(readString(form, 'lookaheadMinutes'));
    return {
      mode,
      ...(Number.isFinite(lookaheadMinutes) && lookaheadMinutes > 0 ? { lookaheadMinutes } : {}),
    };
  }
  return { mode: 'manual' };
}

function readRoutineConfigForm(form) {
  const topicQuery = readString(form, 'topicQuery');
  const dueWithinHours = Number(readString(form, 'dueWithinHours'));
  const includeOverdueField = form.querySelector('[name="includeOverdue"]');
  const includeOverdue = includeOverdueField instanceof HTMLInputElement
    ? includeOverdueField.checked
    : undefined;
  if (!topicQuery && !Number.isFinite(dueWithinHours) && includeOverdue == null) {
    return undefined;
  }
  return {
    ...(topicQuery ? { topicQuery } : {}),
    ...(Number.isFinite(dueWithinHours) && dueWithinHours > 0 ? { dueWithinHours } : {}),
    ...(includeOverdue != null ? { includeOverdue } : {}),
  };
}

function parseTags(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function defaultTaskDueAt(nowDate) {
  const next = new Date(nowDate.getTime());
  next.setHours(Math.max(nowDate.getHours() + 2, 17), 0, 0, 0);
  return next;
}

function defaultEventStart(date) {
  const next = new Date(date.getTime());
  next.setHours(9, 0, 0, 0);
  return next;
}

function defaultEventEnd(date) {
  const next = new Date(date.getTime());
  next.setHours(10, 0, 0, 0);
  return next;
}

function priorityBadgeClass(priority) {
  switch (priority) {
    case 'high':
      return 'badge-warning';
    case 'low':
      return 'badge-muted';
    default:
      return 'badge-info';
  }
}

function taskPriorityRank(priority) {
  switch (priority) {
    case 'high':
      return 0;
    case 'medium':
      return 1;
    default:
      return 2;
  }
}

function getDayGreeting(date) {
  const hour = date.getHours();
  if (hour < 12) return 'Set the day before it sets itself.';
  if (hour < 17) return 'Re-center the day around the work that matters.';
  return 'Close loops before the day leaks into tomorrow.';
}

function normalizeTab(value) {
  return TAB_IDS.includes(value) ? value : 'today';
}

function normalizeCalendarView(value) {
  return ['week', 'month', 'year'].includes(value) ? value : 'month';
}

function summarize(value, maxChars) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxChars ? `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...` : normalized;
}

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfDay(value) {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

function startOfMonthDate(value) {
  const date = new Date(value);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfMonth(value) {
  const date = startOfMonthDate(value);
  date.setMonth(date.getMonth() + 1);
  date.setDate(0);
  date.setHours(23, 59, 59, 999);
  return date;
}

function startOfWeek(value) {
  const date = startOfDay(value);
  date.setDate(date.getDate() - date.getDay());
  return date;
}

function endOfWeek(value) {
  const date = startOfWeek(value);
  date.setDate(date.getDate() + 6);
  date.setHours(23, 59, 59, 999);
  return date;
}

function startOfYear(value) {
  const date = startOfDay(value);
  date.setMonth(0, 1);
  return date;
}

function endOfYear(value) {
  const date = startOfYear(value);
  date.setFullYear(date.getFullYear() + 1);
  date.setMilliseconds(-1);
  return date;
}

function addMonths(value, amount) {
  const date = startOfMonthDate(value);
  date.setMonth(date.getMonth() + amount);
  return date;
}

function shiftCalendarCursor(value, view, amount) {
  const date = startOfDay(value);
  if (view === 'week') {
    date.setDate(date.getDate() + (amount * 7));
    return date;
  }
  if (view === 'year') {
    date.setFullYear(date.getFullYear() + amount);
    return date;
  }
  date.setMonth(date.getMonth() + amount);
  return date;
}

function sameDay(left, right) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function isSameMonth(left, right) {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth();
}

function dayKey(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDayKey(value) {
  return new Date(`${value}T00:00:00`);
}

function getCalendarViewRange(value, view) {
  if (view === 'week') {
    return {
      start: startOfWeek(value),
      end: endOfWeek(value),
      limit: 400,
    };
  }
  if (view === 'year') {
    return {
      start: startOfYear(value),
      end: endOfYear(value),
      limit: 5000,
    };
  }
  const monthStart = startOfMonthDate(value);
  return {
    start: startOfWeek(monthStart),
    end: endOfWeek(endOfMonth(monthStart)),
    limit: 900,
  };
}

function toDateTimeLocal(value) {
  if (!value && value !== 0) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function formatMonthLabel(value) {
  return new Date(value).toLocaleDateString([], { month: 'long', year: 'numeric' });
}

function formatCalendarHeading(value, view) {
  if (view === 'week') {
    return formatWeekLabel(value);
  }
  if (view === 'year') {
    return String(new Date(value).getFullYear());
  }
  return formatMonthLabel(value);
}

function formatWeekLabel(value) {
  const weekStart = startOfWeek(value);
  const weekEnd = endOfWeek(value);
  const startLabel = weekStart.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const endOptions = weekStart.getFullYear() === weekEnd.getFullYear()
    ? { month: 'short', day: 'numeric', year: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' };
  const endLabel = weekEnd.toLocaleDateString([], endOptions);
  return `${startLabel} - ${endLabel}`;
}

function formatWeekdayLabel(value) {
  return new Date(value).toLocaleDateString([], { weekday: 'short' });
}

function formatMonthDayLabel(value) {
  return new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function calendarViewCopy(view) {
  if (view === 'week') {
    return 'Review one week at a time, click any day to load it, and open an event directly from the schedule.';
  }
  if (view === 'year') {
    return 'Scan the full year for busy patches, then click any day to review its agenda and add or edit events.';
  }
  return 'Choose a day to review events and add your own event or time block. Click anywhere in an open day square to load it.';
}

function formatCount(value) {
  if (!Number.isFinite(value)) return '0';
  return Math.round(value).toLocaleString();
}

function formatLongDate(value) {
  return new Date(value).toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatShortDateTime(value) {
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRelativeDate(value, now) {
  const diffDays = Math.round((startOfDay(now).getTime() - startOfDay(value).getTime()) / DAY_MS);
  if (diffDays <= 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.round(diffDays / 7)} weeks ago`;
  return `${Math.round(diffDays / 30)} months ago`;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(value) {
  return esc(value).replace(/'/g, '&#39;');
}
