import { api } from '../api.js';
import { createTabs } from '../components/tabs.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TAB_IDS = ['today', 'calendar', 'tasks', 'notes', 'people', 'library', 'briefs', 'routines'];

let currentContainer = null;
let flashTimer = null;
const boundContainers = new WeakSet();
const state = {
  activeTab: 'today',
  data: null,
  calendarCursor: startOfMonthDate(Date.now()),
  selectedCalendarDate: dayKey(new Date()),
  selectedCalendarEventId: null,
  selectedTaskId: null,
  selectedNoteId: null,
  selectedPersonId: null,
  selectedLinkId: null,
  selectedBriefId: null,
  selectedRoutineId: null,
  todayCaptureKind: 'note',
  personQuery: '',
  personRelationship: 'all',
  linkQuery: '',
  linkKind: 'all',
  briefKind: 'all',
  flash: null,
};

export async function renderSecondBrain(container, options = {}) {
  currentContainer = container;
  state.activeTab = normalizeTab(options?.tab || state.activeTab);

  const shouldRefresh = options?.refresh !== false || !state.data;
  if (shouldRefresh) {
    container.innerHTML = '<h2 class="page-title">Second Brain</h2><div class="loading">Loading your day...</div>';
    try {
      state.data = await loadSecondBrainData();
    } catch (error) {
      container.innerHTML = `<h2 class="page-title">Second Brain</h2><div class="loading">Error: ${esc(error instanceof Error ? error.message : String(error))}</div>`;
      return;
    }
  }

  synchronizeStateWithData();
  paint(container);
}

export function updateSecondBrain() {
  if (currentContainer) {
    void renderSecondBrain(currentContainer, { tab: state.activeTab, refresh: true });
  }
}

function paint(container) {
  if (!state.data) {
    container.innerHTML = '<h2 class="page-title">Second Brain</h2><div class="loading">Loading your day...</div>';
    return;
  }

  const { overview, focusEvents, tasks, notes, people, links, briefs, routines, now } = state.data;
  const todayEvents = getEventsForDay(focusEvents, parseDayKey(dayKey(new Date(now))));
  const openTasks = tasks.filter((task) => task.status !== 'done');
  const pendingBriefs = briefs.filter((brief) => brief.kind !== 'morning');
  const stalePeople = people.filter((person) => isPersonStale(person, now));

  container.innerHTML = `
    <section class="sb-shell">
      <div class="sb-hero">
        <div class="sb-hero__copy">
          <div class="sb-kicker">Today</div>
          <h2 class="page-title sb-title">Second Brain</h2>
          <p class="sb-subtitle">Your calendar, tasks, notes, contacts, saved links, and meeting prep in one place.</p>
          <div class="sb-hero__meta">
            <span>${esc(formatLongDate(now))}</span>
            <span>${esc(overview.nextEvent ? `Next up: ${overview.nextEvent.title}` : 'No upcoming event queued')}</span>
          </div>
        </div>
        <div class="sb-hero__rail">
          ${renderUsageCard(overview.usage)}
        </div>
      </div>
      ${state.flash ? renderFlash(state.flash) : ''}
      <div class="sb-metric-row">
        ${renderMetricCard('Today', `${todayEvents.length} events`, todayEvents[0] ? formatTimeRange(todayEvents[0]) : 'No agenda yet')}
        ${renderMetricCard('Tasks', `${openTasks.length} open`, openTasks[0] ? openTasks[0].title : 'Inbox clear')}
        ${renderMetricCard('Briefs', `${briefs.length} saved`, pendingBriefs[0] ? pendingBriefs[0].title : 'No queued follow-up')}
        ${renderMetricCard('People', `${people.length} contacts`, stalePeople[0] ? `${stalePeople.length} need follow-up` : 'Relationships current')}
      </div>
    </section>
  `;

  const tabsContainer = document.createElement('div');
  tabsContainer.className = 'sb-tabs';
  container.appendChild(tabsContainer);

  const tabs = createTabs(tabsContainer, [
    { id: 'today', label: 'Today', render: (panel) => renderToday(panel, state.data) },
    { id: 'calendar', label: 'Calendar', render: (panel) => renderCalendar(panel, state.data) },
    { id: 'tasks', label: 'Tasks', render: (panel) => renderTasks(panel, state.data) },
    { id: 'notes', label: 'Notes', render: (panel) => renderNotes(panel, state.data) },
    { id: 'people', label: 'People', render: (panel) => renderPeople(panel, state.data) },
    { id: 'library', label: 'Library', render: (panel) => renderLibrary(panel, state.data) },
    { id: 'briefs', label: 'Briefs', render: (panel) => renderBriefs(panel, state.data) },
    { id: 'routines', label: 'Routines', render: (panel) => renderRoutines(panel, state.data) },
  ], state.activeTab);

  tabsContainer.querySelector('.tab-bar')?.addEventListener('click', (event) => {
    const button = event.target.closest('.tab-btn');
    if (!button?.dataset.tabId) return;
    state.activeTab = normalizeTab(button.dataset.tabId);
  });
  tabs.switchTo(state.activeTab);

  bindInteractions(container);
}

async function loadSecondBrainData() {
  const now = Date.now();
  const focusWindowStart = startOfDay(new Date(now - (7 * DAY_MS)));
  const focusWindowEnd = endOfDay(new Date(now + (7 * DAY_MS)));
  const monthStart = startOfMonthDate(state.calendarCursor.getTime());
  const monthGridStart = startOfWeek(monthStart);
  const monthGridEnd = endOfWeek(endOfMonth(monthStart));

  const [overview, focusEvents, calendarEvents, tasks, notes, people, links, routines, briefs] = await Promise.all([
    api.secondBrainOverview(),
    api.secondBrainCalendar({
      fromTime: focusWindowStart.getTime(),
      toTime: focusWindowEnd.getTime(),
      limit: 200,
    }),
    api.secondBrainCalendar({
      fromTime: monthGridStart.getTime(),
      toTime: monthGridEnd.getTime(),
      limit: 300,
    }),
    api.secondBrainTasks({ limit: 200 }),
    api.secondBrainNotes({ limit: 200, includeArchived: true }),
    api.secondBrainPeople({ limit: 200 }),
    api.secondBrainLinks({ limit: 200 }),
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
    routines,
    briefs,
    monthGridStart,
    monthGridEnd,
  };
}

function synchronizeStateWithData() {
  if (!state.data) return;

  const visibleMonth = state.calendarCursor;
  if (!isSameMonth(parseDayKey(state.selectedCalendarDate), visibleMonth)) {
    state.selectedCalendarDate = dayKey(startOfMonthDate(visibleMonth.getTime()));
  }

  state.selectedCalendarEventId = preserveSelection(
    state.selectedCalendarEventId,
    [...state.data.calendarEvents, ...state.data.focusEvents],
  );
  state.selectedTaskId = preserveSelection(state.selectedTaskId, state.data.tasks);
  state.selectedNoteId = preserveSelection(state.selectedNoteId, state.data.notes);
  state.selectedPersonId = preserveSelection(state.selectedPersonId, state.data.people);
  state.selectedLinkId = preserveSelection(state.selectedLinkId, state.data.links);
  state.selectedBriefId = preserveSelection(state.selectedBriefId, filteredBriefs(state.data));
  state.selectedRoutineId = preserveSelection(state.selectedRoutineId, state.data.routines);
}

function preserveSelection(currentId, records) {
  if (!Array.isArray(records) || records.length === 0) return null;
  if (currentId && records.some((record) => record.id === currentId)) {
    return currentId;
  }
  return records[0]?.id ?? null;
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
        <div class="sb-inline-stats">
          ${renderInlineStat('Open tasks', String(data.tasks.filter((task) => task.status !== 'done').length))}
          ${renderInlineStat('Recent notes', String(recentNotes.length))}
          ${renderInlineStat('Enabled routines', String(data.overview.enabledRoutineCount))}
          ${renderInlineStat('Follow-up drafts', String(data.overview.followUpCount))}
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
        <input name="title" type="text" placeholder="Task title" required>
        <div class="sb-form__row">
          <select name="priority">
            <option value="medium">Medium priority</option>
            <option value="high">High priority</option>
            <option value="low">Low priority</option>
          </select>
          <input name="dueAt" type="datetime-local" value="${escAttr(toDateTimeLocal(defaultTaskDueAt(nowDate).getTime()))}">
        </div>
        <button class="btn btn-primary" type="submit">Add task</button>
      </form>
    `;
  }

  if (state.todayCaptureKind === 'event') {
    return `
      <form class="sb-form" data-today-capture-form="event">
        <input name="title" type="text" placeholder="Block time or add an event" required>
        <div class="sb-form__row">
          <input name="startsAt" type="datetime-local" value="${escAttr(toDateTimeLocal(defaultEventStart(nowDate).getTime()))}" required>
          <input name="endsAt" type="datetime-local" value="${escAttr(toDateTimeLocal(defaultEventEnd(nowDate).getTime()))}">
        </div>
        <button class="btn btn-primary" type="submit">Add event</button>
      </form>
    `;
  }

  return `
    <form class="sb-form" data-today-capture-form="note">
      <input name="title" type="text" placeholder="Optional note title">
      <textarea name="content" rows="5" placeholder="Capture a promise, idea, detail, or follow-up." required></textarea>
      <button class="btn btn-primary" type="submit">Save note</button>
    </form>
  `;
}

function renderCalendar(panel, data) {
  const monthStart = startOfMonthDate(state.calendarCursor.getTime());
  const gridStart = startOfWeek(monthStart);
  const selectedDate = parseDayKey(state.selectedCalendarDate);
  const selectedEvent = findRecord(data.calendarEvents, state.selectedCalendarEventId);
  const dayEvents = getEventsForDay(data.calendarEvents, selectedDate);
  const days = [];
  const cursor = new Date(gridStart.getTime());
  for (let index = 0; index < 42; index += 1) {
    days.push(new Date(cursor.getTime()));
    cursor.setDate(cursor.getDate() + 1);
  }

  panel.innerHTML = `
    <section class="sb-section">
      <div class="sb-section__header">
        <div>
          <div class="sb-card__eyebrow">Calendar</div>
          <h3>${esc(formatMonthLabel(monthStart))}</h3>
          <p class="sb-section__copy">Choose a day to review events and add your own event or time block.</p>
        </div>
        <div class="sb-toolbar">
          <button class="btn btn-secondary btn-sm" type="button" data-calendar-nav="prev">Previous</button>
          <button class="btn btn-secondary btn-sm" type="button" data-calendar-nav="today">Today</button>
          <button class="btn btn-secondary btn-sm" type="button" data-calendar-nav="next">Next</button>
          <button class="btn btn-primary btn-sm" type="button" data-calendar-new="true" data-date-key="${escAttr(state.selectedCalendarDate)}">New event</button>
        </div>
      </div>
      <div class="sb-split sb-split--calendar">
        <article class="sb-card">
          <div class="sb-calendar">
            <div class="sb-calendar__weekdays">
              ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label) => `<span>${esc(label)}</span>`).join('')}
            </div>
            <div class="sb-calendar__grid">
              ${days.map((day) => renderCalendarDay(day, monthStart, data.calendarEvents)).join('')}
            </div>
          </div>
        </article>
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
      </div>
    </section>
  `;
}

function renderCalendarDay(day, monthStart, events) {
  const key = dayKey(day);
  const dayEvents = getEventsForDay(events, day).slice(0, 3);
  const isOutside = !isSameMonth(day, monthStart);
  const isSelected = key === state.selectedCalendarDate;
  const isToday = key === dayKey(new Date());

  return `
    <article class="sb-calendar-day${isOutside ? ' is-outside' : ''}${isSelected ? ' is-selected' : ''}${isToday ? ' is-today' : ''}">
      <button class="sb-calendar-day__label" type="button" data-calendar-select-date="${escAttr(key)}">
        <span>${esc(String(day.getDate()))}</span>
      </button>
      <div class="sb-calendar-day__events">
        ${dayEvents.map((event) => `
          <button class="sb-event-chip" type="button" data-calendar-select-event="${escAttr(event.id)}" data-calendar-select-date="${escAttr(key)}">
            <span class="sb-event-chip__time">${esc(formatEventChipTime(event, day))}</span>
            <span class="sb-event-chip__title">${esc(event.title)}</span>
          </button>
        `).join('')}
        ${getEventsForDay(events, day).length > 3 ? `<div class="sb-event-chip sb-event-chip--overflow">+${esc(String(getEventsForDay(events, day).length - 3))} more</div>` : ''}
      </div>
    </article>
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
      <input name="title" type="text" placeholder="Event title" value="${escAttr(selectedEvent?.title ?? '')}" required>
      <div class="sb-form__row">
        <input name="startsAt" type="datetime-local" value="${escAttr(toDateTimeLocal(startsAt))}" required>
        <input name="endsAt" type="datetime-local" value="${escAttr(toDateTimeLocal(endsAt))}">
      </div>
      <input name="location" type="text" placeholder="Location or call link" value="${escAttr(selectedEvent?.location ?? '')}">
      <textarea name="description" rows="6" placeholder="Description, agenda, prep notes, or anything you want attached to this event">${esc(selectedEvent?.description ?? '')}</textarea>
      <button class="btn btn-primary" type="submit">${selectedEvent ? 'Save event' : 'Create event'}</button>
    </form>
  `;
}

function renderTasks(panel, data) {
  const selectedTask = findRecord(data.tasks, state.selectedTaskId);
  const columns = {
    todo: data.tasks.filter((task) => task.status === 'todo'),
    in_progress: data.tasks.filter((task) => task.status === 'in_progress'),
    done: data.tasks.filter((task) => task.status === 'done'),
  };

  panel.innerHTML = `
    <section class="sb-section">
      <div class="sb-section__header">
        <div>
          <div class="sb-card__eyebrow">Tasks</div>
          <h3>Task board</h3>
          <p class="sb-section__copy">Move tasks between columns and edit the full details on the right.</p>
        </div>
        <button class="btn btn-primary btn-sm" type="button" data-task-new="true">New task</button>
      </div>
      <div class="sb-task-stats">
        ${renderMetricCard('Todo', String(columns.todo.length), 'Queued for action')}
        ${renderMetricCard('In progress', String(columns.in_progress.length), 'Active work')}
        ${renderMetricCard('Done', String(columns.done.length), 'Closed out')}
      </div>
      <div class="sb-split sb-split--board">
        <div class="sb-board">
          ${renderTaskColumn('Todo', 'todo', columns.todo)}
          ${renderTaskColumn('In Progress', 'in_progress', columns.in_progress)}
          ${renderTaskColumn('Done', 'done', columns.done)}
        </div>
        <aside class="sb-card sb-card--sidebar">
          <div class="sb-card__header">
            <div>
              <div class="sb-card__eyebrow">${selectedTask ? 'Edit task' : 'New task'}</div>
              <h3>${esc(selectedTask?.title ?? 'Task editor')}</h3>
            </div>
          </div>
          ${renderTaskEditor(selectedTask)}
        </aside>
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
        ${lane !== 'todo' ? '<button class="btn btn-secondary btn-sm" type="button" data-task-status="todo" data-task-id="' + escAttr(task.id) + '">Todo</button>' : ''}
        ${lane !== 'in_progress' ? '<button class="btn btn-secondary btn-sm" type="button" data-task-status="in_progress" data-task-id="' + escAttr(task.id) + '">Start</button>' : ''}
        ${lane !== 'done' ? '<button class="btn btn-secondary btn-sm" type="button" data-task-status="done" data-task-id="' + escAttr(task.id) + '">Done</button>' : ''}
      </div>
    </div>
  `;
}

function renderTaskEditor(task) {
  return `
    <form class="sb-form" data-task-form>
      <input type="hidden" name="id" value="${escAttr(task?.id ?? '')}">
      <input name="title" type="text" placeholder="Task title" value="${escAttr(task?.title ?? '')}" required>
      <textarea name="details" rows="6" placeholder="Context, checklist, blockers, or acceptance criteria">${esc(task?.details ?? '')}</textarea>
      <div class="sb-form__row">
        <select name="priority">
          ${renderSelectOptions([
            { value: 'high', label: 'High priority' },
            { value: 'medium', label: 'Medium priority' },
            { value: 'low', label: 'Low priority' },
          ], task?.priority ?? 'medium')}
        </select>
        <select name="status">
          ${renderSelectOptions([
            { value: 'todo', label: 'Todo' },
            { value: 'in_progress', label: 'In progress' },
            { value: 'done', label: 'Done' },
          ], task?.status ?? 'todo')}
        </select>
      </div>
      <input name="dueAt" type="datetime-local" value="${escAttr(toDateTimeLocal(task?.dueAt ?? null))}">
      <button class="btn btn-primary" type="submit">${task ? 'Save task' : 'Create task'}</button>
    </form>
  `;
}

function renderNotes(panel, data) {
  const filtered = data.notes.filter((note) => matchesNoteQuery(note, state.noteQuery));
  const selectedNote = findRecord(filtered, state.selectedNoteId) ?? findRecord(data.notes, state.selectedNoteId);

  panel.innerHTML = `
    <section class="sb-section">
      <div class="sb-section__header">
        <div>
          <div class="sb-card__eyebrow">Notes</div>
          <h3>Notes and ideas</h3>
          <p class="sb-section__copy">Search, pin, archive, and edit full notes in one place.</p>
        </div>
        <button class="btn btn-primary btn-sm" type="button" data-note-new="true">New note</button>
      </div>
      <div class="sb-split">
        <article class="sb-card sb-card--rail">
          <form class="sb-toolbar sb-toolbar--search" data-note-search-form>
            <input name="query" type="search" placeholder="Search title, body, or tags" value="${escAttr(state.noteQuery)}">
            <button class="btn btn-secondary btn-sm" type="submit">Search</button>
          </form>
          <div class="sb-stack">
            ${filtered.length > 0 ? filtered.map((note) => renderNoteListItem(note)).join('') : '<div class="sb-empty">No notes match this search.</div>'}
          </div>
        </article>
        <article class="sb-card sb-card--editor">
          <div class="sb-card__header">
            <div>
              <div class="sb-card__eyebrow">${selectedNote ? 'Edit note' : 'New note'}</div>
              <h3>${esc(selectedNote?.title ?? 'Note editor')}</h3>
            </div>
          </div>
          ${renderNoteEditor(selectedNote)}
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
      <input name="title" type="text" placeholder="Note title" value="${escAttr(note?.title ?? '')}">
      <input name="tags" type="text" placeholder="comma, separated, tags" value="${escAttr((note?.tags ?? []).join(', '))}">
      <label class="sb-check">
        <input name="pinned" type="checkbox" ${note?.pinned ? 'checked' : ''}>
        <span>Pin note</span>
      </label>
      <label class="sb-check">
        <input name="archived" type="checkbox" ${note?.archivedAt ? 'checked' : ''}>
        <span>Archive note</span>
      </label>
      <textarea name="content" rows="14" placeholder="Write the note body" required>${esc(note?.content ?? '')}</textarea>
      <button class="btn btn-primary" type="submit">${note ? 'Save note' : 'Create note'}</button>
    </form>
  `;
}

function renderPeople(panel, data) {
  const filtered = data.people.filter((person) => matchesPersonFilter(person));
  const selectedPerson = findRecord(filtered, state.selectedPersonId) ?? findRecord(data.people, state.selectedPersonId);
  const staleCount = data.people.filter((person) => isPersonStale(person, data.now)).length;

  panel.innerHTML = `
    <section class="sb-section">
      <div class="sb-section__header">
        <div>
          <div class="sb-card__eyebrow">People</div>
          <h3>Contacts</h3>
          <p class="sb-section__copy">Keep contact details, notes, and last-contact dates here.</p>
        </div>
        <button class="btn btn-primary btn-sm" type="button" data-person-new="true">New person</button>
      </div>
      <div class="sb-metric-row">
        ${renderMetricCard('All contacts', String(data.people.length), 'Shared store')}
        ${renderMetricCard('Need follow-up', String(staleCount), 'No recent contact')}
      </div>
      <div class="sb-split">
        <article class="sb-card sb-card--rail">
          <form class="sb-toolbar sb-toolbar--search" data-person-search-form>
            <input name="query" type="search" placeholder="Search people" value="${escAttr(state.personQuery)}">
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
            ${filtered.length > 0 ? filtered.map((person) => renderPersonListItem(person, data.now)).join('') : '<div class="sb-empty">No people match this filter.</div>'}
          </div>
        </article>
        <article class="sb-card sb-card--editor">
          <div class="sb-card__header">
            <div>
              <div class="sb-card__eyebrow">${selectedPerson ? 'Edit person' : 'New person'}</div>
              <h3>${esc(selectedPerson?.name ?? 'Person editor')}</h3>
            </div>
            ${selectedPerson ? `<button class="btn btn-secondary btn-sm" type="button" data-person-touch="${escAttr(selectedPerson.id)}">Mark contacted today</button>` : ''}
          </div>
          ${renderPersonEditor(selectedPerson)}
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
        <input name="name" type="text" placeholder="Name" value="${escAttr(person?.name ?? '')}">
        <input name="email" type="email" placeholder="Email" value="${escAttr(person?.email ?? '')}">
      </div>
      <div class="sb-form__row">
        <input name="title" type="text" placeholder="Title" value="${escAttr(person?.title ?? '')}">
        <input name="company" type="text" placeholder="Company" value="${escAttr(person?.company ?? '')}">
      </div>
      <div class="sb-form__row">
        <select name="relationship">
          ${renderSelectOptions([
            { value: 'work', label: 'Work' },
            { value: 'personal', label: 'Personal' },
            { value: 'family', label: 'Family' },
            { value: 'vendor', label: 'Vendor' },
            { value: 'other', label: 'Other' },
          ], person?.relationship ?? 'work')}
        </select>
        <input name="lastContactAt" type="datetime-local" value="${escAttr(toDateTimeLocal(person?.lastContactAt ?? null))}">
      </div>
      <textarea name="notes" rows="10" placeholder="Relationship notes, context, promises, or follow-up cues">${esc(person?.notes ?? '')}</textarea>
      <button class="btn btn-primary" type="submit">${person ? 'Save person' : 'Create person'}</button>
    </form>
  `;
}

function renderLibrary(panel, data) {
  const filtered = data.links.filter((link) => matchesLinkFilter(link));
  const selectedLink = findRecord(filtered, state.selectedLinkId) ?? findRecord(data.links, state.selectedLinkId);

  panel.innerHTML = `
    <section class="sb-section">
      <div class="sb-section__header">
        <div>
          <div class="sb-card__eyebrow">Library</div>
          <h3>Saved links and files</h3>
          <p class="sb-section__copy">Save links, documents, repos, and files you may want to come back to later.</p>
        </div>
        <button class="btn btn-primary btn-sm" type="button" data-link-new="true">Add item</button>
      </div>
      <div class="sb-split">
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
        <article class="sb-card sb-card--editor">
          <div class="sb-card__header">
            <div>
              <div class="sb-card__eyebrow">${selectedLink ? 'Edit item' : 'Add item'}</div>
              <h3>${esc(selectedLink?.title ?? 'Library editor')}</h3>
            </div>
            ${selectedLink ? `<a class="btn btn-secondary btn-sm" href="${escAttr(selectedLink.url)}" target="_blank" rel="noreferrer">Open link</a>` : ''}
          </div>
          ${renderLinkEditor(selectedLink)}
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
      <input name="title" type="text" placeholder="Title" value="${escAttr(link?.title ?? '')}">
      <input name="url" type="url" placeholder="https://..." value="${escAttr(link?.url ?? '')}" required>
      <div class="sb-form__row">
        <select name="kind">
          ${renderSelectOptions([
            { value: 'reference', label: 'Reference' },
            { value: 'document', label: 'Document' },
            { value: 'article', label: 'Article' },
            { value: 'repo', label: 'Repository' },
            { value: 'file', label: 'File' },
            { value: 'other', label: 'Other' },
          ], link?.kind ?? 'reference')}
        </select>
        <input name="tags" type="text" placeholder="comma, separated, tags" value="${escAttr((link?.tags ?? []).join(', '))}">
      </div>
      <textarea name="summary" rows="10" placeholder="Why this matters later">${esc(link?.summary ?? '')}</textarea>
      <button class="btn btn-primary" type="submit">${link ? 'Save item' : 'Add item'}</button>
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
          <h3>Meeting and daily briefs</h3>
          <p class="sb-section__copy">Create a morning summary, prepare for a meeting, or draft follow-up notes and review them here.</p>
        </div>
      </div>
      <div class="sb-card sb-card--action-strip">
        <button class="btn btn-primary" type="button" data-generate-brief="morning">Generate morning brief</button>
        ${nextEvent ? `<button class="btn btn-secondary" type="button" data-generate-brief="pre_meeting" data-event-id="${escAttr(nextEvent.id)}">Prepare for next meeting</button>` : ''}
        ${followUpCandidate ? `<button class="btn btn-secondary" type="button" data-generate-brief="follow_up" data-event-id="${escAttr(followUpCandidate.id)}">Draft follow-up</button>` : ''}
      </div>
      <div class="sb-split">
        <article class="sb-card sb-card--rail">
          <div class="sb-segmented">
            ${renderSegmentButton('all', 'All', state.briefKind === 'all', 'data-brief-kind')}
            ${renderSegmentButton('morning', 'Morning', state.briefKind === 'morning', 'data-brief-kind')}
            ${renderSegmentButton('pre_meeting', 'Meeting', state.briefKind === 'pre_meeting', 'data-brief-kind')}
            ${renderSegmentButton('follow_up', 'Follow-up', state.briefKind === 'follow_up', 'data-brief-kind')}
          </div>
          <div class="sb-stack">
            ${filtered.length > 0 ? filtered.map((brief) => renderBriefListItem(brief)).join('') : '<div class="sb-empty">No briefs match this filter.</div>'}
          </div>
        </article>
        <article class="sb-card sb-card--editor">
          ${selectedBrief ? renderBriefViewer(selectedBrief, data) : '<div class="sb-empty">Pick a brief to read it here.</div>'}
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

function renderBriefViewer(brief, data) {
  const sourceEvent = brief.eventId ? findRecord([...data.focusEvents, ...data.calendarEvents], brief.eventId) : null;
  return `
    <div class="sb-card__header">
      <div>
        <div class="sb-card__eyebrow">${esc(brief.kind.replaceAll('_', ' '))}</div>
        <h3>${esc(brief.title)}</h3>
      </div>
      <span class="badge badge-muted">${esc(formatLongDate(brief.generatedAt))}</span>
    </div>
    ${sourceEvent ? `<p class="sb-brief-source">Source event: ${esc(sourceEvent.title)} · ${esc(formatTimeRange(sourceEvent))}</p>` : ''}
    <pre class="sb-brief-body">${esc(brief.content)}</pre>
  `;
}

function renderRoutines(panel, data) {
  const selectedRoutine = findRecord(data.routines, state.selectedRoutineId);

  panel.innerHTML = `
    <section class="sb-section">
      <div class="sb-section__header">
        <div>
          <div class="sb-card__eyebrow">Routines</div>
          <h3>Routines</h3>
          <p class="sb-section__copy">Turn routines on or off, see when they run, and choose where their updates appear.</p>
        </div>
      </div>
      <div class="sb-split sb-split--board">
        <div class="sb-board">
          ${groupRoutines(data.routines).map(([category, routines]) => `
            <article class="sb-card sb-board__column">
              <div class="sb-board__header">
                <h4>${esc(categoryLabel(category))}</h4>
                <span>${esc(String(routines.length))}</span>
              </div>
              <div class="sb-board__body">
                ${routines.map((routine) => renderRoutineCard(routine)).join('')}
              </div>
            </article>
          `).join('')}
        </div>
        <aside class="sb-card sb-card--sidebar">
          <div class="sb-card__header">
            <div>
              <div class="sb-card__eyebrow">${selectedRoutine ? 'Edit routine' : 'Routine details'}</div>
              <h3>${esc(selectedRoutine?.name ?? 'Select a routine')}</h3>
            </div>
          </div>
          ${selectedRoutine ? renderRoutineEditor(selectedRoutine) : '<div class="sb-empty">Select a routine card to edit its settings.</div>'}
        </aside>
      </div>
    </section>
  `;
}

function renderRoutineCard(routine) {
  return `
    <div class="sb-routine-card${routine.id === state.selectedRoutineId ? ' is-selected' : ''}">
      <button class="sb-routine-card__main" type="button" data-routine-select="${escAttr(routine.id)}">
        <strong>${esc(routine.name)}</strong>
        <span>${esc(describeRoutineTrigger(routine.trigger))}</span>
      </button>
      <div class="sb-routine-card__footer">
        <span class="badge ${routine.enabled ? 'badge-ok' : 'badge-muted'}">${esc(routine.enabled ? 'Enabled' : 'Paused')}</span>
        <label class="sb-toggle">
          <input type="checkbox" data-routine-quick-toggle="${escAttr(routine.id)}" ${routine.enabled ? 'checked' : ''}>
          <span>Live</span>
        </label>
      </div>
    </div>
  `;
}

function renderRoutineEditor(routine) {
  return `
    <form class="sb-form" data-routine-form>
      <input type="hidden" name="id" value="${escAttr(routine.id)}">
      <label class="sb-check">
        <input name="enabled" type="checkbox" ${routine.enabled ? 'checked' : ''}>
        <span>Enabled</span>
      </label>
      <div class="sb-readout">
        <strong>Trigger</strong>
        <span>${esc(describeRoutineTrigger(routine.trigger))}</span>
      </div>
      <div class="sb-readout">
        <strong>Workload</strong>
        <span>${esc(`${routine.workloadClass} · ${routine.externalCommMode.replaceAll('_', ' ')}`)}</span>
      </div>
      <label class="sb-form__label" for="routine-routing-bias">Answer quality</label>
      <select id="routine-routing-bias" name="defaultRoutingBias">
        ${renderSelectOptions([
          { value: 'local_first', label: 'Prefer faster local answers' },
          { value: 'balanced', label: 'Balance speed and quality' },
          { value: 'quality_first', label: 'Prefer higher-quality answers' },
        ], routine.defaultRoutingBias)}
      </select>
      <label class="sb-form__label" for="routine-budget-profile">Budget profile ID</label>
      <input id="routine-budget-profile" name="budgetProfileId" type="text" placeholder="Budget profile ID" value="${escAttr(routine.budgetProfileId)}">
      <div class="sb-form__label">Show routine updates in</div>
      <div class="sb-check-grid">
        ${['web', 'cli', 'telegram'].map((channel) => `
          <label class="sb-check">
            <input name="deliveryDefaults" type="checkbox" value="${escAttr(channel)}" ${routine.deliveryDefaults.includes(channel) ? 'checked' : ''}>
            <span>${esc(channel)}</span>
          </label>
        `).join('')}
      </div>
      <button class="btn btn-primary" type="submit">Save routine</button>
    </form>
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
        state.calendarCursor = addMonths(state.calendarCursor, -1);
      } else if (calendarNav.dataset.calendarNav === 'next') {
        state.calendarCursor = addMonths(state.calendarCursor, 1);
      } else {
        state.calendarCursor = startOfMonthDate(Date.now());
        state.selectedCalendarDate = dayKey(new Date());
      }
      state.selectedCalendarEventId = null;
      void renderSecondBrain(container, { tab: state.activeTab, refresh: true });
      return;
    }

    const selectDate = target.closest('[data-calendar-select-date]');
    if (selectDate?.dataset.calendarSelectDate) {
      state.selectedCalendarDate = selectDate.dataset.calendarSelectDate;
      if (selectDate.dataset.calendarSelectEvent) {
        state.selectedCalendarEventId = selectDate.dataset.calendarSelectEvent;
      }
      void rerenderLocal();
      return;
    }

    const selectEvent = target.closest('[data-calendar-select-event]');
    if (selectEvent?.dataset.calendarSelectEvent) {
      state.selectedCalendarEventId = selectEvent.dataset.calendarSelectEvent;
      if (selectEvent.dataset.calendarSelectDate) {
        state.selectedCalendarDate = selectEvent.dataset.calendarSelectDate;
      }
      void rerenderLocal();
      return;
    }

    const newEvent = target.closest('[data-calendar-new]');
    if (newEvent?.dataset.calendarNew) {
      state.selectedCalendarEventId = null;
      if (newEvent.dataset.dateKey) {
        state.selectedCalendarDate = newEvent.dataset.dateKey;
      }
      void rerenderLocal();
      return;
    }

    const taskSelect = target.closest('[data-task-select]');
    if (taskSelect?.dataset.taskSelect) {
      state.selectedTaskId = taskSelect.dataset.taskSelect;
      void rerenderLocal();
      return;
    }

    const taskNew = target.closest('[data-task-new]');
    if (taskNew?.dataset.taskNew) {
      state.selectedTaskId = null;
      void rerenderLocal();
      return;
    }

    const taskStatus = target.closest('[data-task-status]');
    if (taskStatus?.dataset.taskStatus && taskStatus.dataset.taskId) {
      await updateTaskStatus(taskStatus.dataset.taskId, taskStatus.dataset.taskStatus);
      return;
    }

    const noteSelect = target.closest('[data-note-select]');
    if (noteSelect?.dataset.noteSelect) {
      state.selectedNoteId = noteSelect.dataset.noteSelect;
      void rerenderLocal();
      return;
    }

    const noteNew = target.closest('[data-note-new]');
    if (noteNew?.dataset.noteNew) {
      state.selectedNoteId = null;
      void rerenderLocal();
      return;
    }

    const personSelect = target.closest('[data-person-select]');
    if (personSelect?.dataset.personSelect) {
      state.selectedPersonId = personSelect.dataset.personSelect;
      void rerenderLocal();
      return;
    }

    const personNew = target.closest('[data-person-new]');
    if (personNew?.dataset.personNew) {
      state.selectedPersonId = null;
      void rerenderLocal();
      return;
    }

    const personRelationship = target.closest('[data-person-relationship]');
    if (personRelationship?.dataset.personRelationship) {
      state.personRelationship = personRelationship.dataset.personRelationship;
      state.selectedPersonId = preserveSelection(null, state.data?.people.filter((person) => matchesPersonFilter(person)) ?? []);
      void rerenderLocal();
      return;
    }

    const personTouch = target.closest('[data-person-touch]');
    if (personTouch?.dataset.personTouch) {
      await updatePersonLastContact(personTouch.dataset.personTouch);
      return;
    }

    const linkSelect = target.closest('[data-link-select]');
    if (linkSelect?.dataset.linkSelect) {
      state.selectedLinkId = linkSelect.dataset.linkSelect;
      void rerenderLocal();
      return;
    }

    const linkNew = target.closest('[data-link-new]');
    if (linkNew?.dataset.linkNew) {
      state.selectedLinkId = null;
      void rerenderLocal();
      return;
    }

    const linkKind = target.closest('[data-link-kind]');
    if (linkKind?.dataset.linkKind) {
      state.linkKind = linkKind.dataset.linkKind;
      state.selectedLinkId = preserveSelection(null, state.data?.links.filter((link) => matchesLinkFilter(link)) ?? []);
      void rerenderLocal();
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

    const routineSelect = target.closest('[data-routine-select]');
    if (routineSelect?.dataset.routineSelect) {
      state.selectedRoutineId = routineSelect.dataset.routineSelect;
      void rerenderLocal();
      return;
    }
  });

  container.addEventListener('change', async (event) => {
    const target = event.target instanceof HTMLInputElement ? event.target : null;
    if (!target) return;
    if (!target.dataset.routineQuickToggle) return;
    await saveMutation(() => api.secondBrainRoutineUpdate({
      id: target.dataset.routineQuickToggle,
      enabled: target.checked,
    }), (result) => {
      state.selectedRoutineId = String(result?.details?.id ?? target.dataset.routineQuickToggle);
    });
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
        }
      });
      return;
    }

    if (target.matches('[data-routine-form]')) {
      event.preventDefault();
      await saveMutation(() => api.secondBrainRoutineUpdate({
        id: readString(target, 'id'),
        enabled: readCheckbox(target, 'enabled'),
        defaultRoutingBias: readString(target, 'defaultRoutingBias') || 'local_first',
        budgetProfileId: readString(target, 'budgetProfileId') || undefined,
        deliveryDefaults: readCheckboxValues(target, 'deliveryDefaults'),
      }), (result) => {
        if (result?.details?.id) {
          state.selectedRoutineId = String(result.details.id);
        }
      });
      return;
    }

    if (target.matches('[data-note-search-form]')) {
      event.preventDefault();
      state.noteQuery = readString(target, 'query');
      state.selectedNoteId = preserveSelection(null, state.data?.notes.filter((note) => matchesNoteQuery(note, state.noteQuery)) ?? []);
      void rerenderLocal();
      return;
    }

    if (target.matches('[data-person-search-form]')) {
      event.preventDefault();
      state.personQuery = readString(target, 'query');
      state.selectedPersonId = preserveSelection(null, state.data?.people.filter((person) => matchesPersonFilter(person)) ?? []);
      void rerenderLocal();
      return;
    }

    if (target.matches('[data-link-search-form]')) {
      event.preventDefault();
      state.linkQuery = readString(target, 'query');
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
      if (result?.details?.id) state.selectedTaskId = String(result.details.id);
    });
    return;
  }

  if (form.dataset.todayCaptureForm === 'event') {
    await saveMutation(() => api.secondBrainCalendarUpsert({
      title: readString(form, 'title'),
      startsAt: new Date(readString(form, 'startsAt')).getTime(),
      endsAt: readString(form, 'endsAt') ? new Date(readString(form, 'endsAt')).getTime() : undefined,
      source: 'local',
    }), (result) => {
      if (result?.details?.id) state.selectedCalendarEventId = String(result.details.id);
    });
    return;
  }

  await saveMutation(() => api.secondBrainNoteUpsert({
    title: readString(form, 'title') || undefined,
    content: readString(form, 'content'),
  }), (result) => {
    if (result?.details?.id) state.selectedNoteId = String(result.details.id);
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

async function rerenderLocal() {
  if (!currentContainer) return;
  await renderSecondBrain(currentContainer, { tab: state.activeTab, refresh: false });
}

function setFlash(kind, message, sticky = false) {
  state.flash = { kind, message };
  if (flashTimer) {
    window.clearTimeout(flashTimer);
    flashTimer = null;
  }
  if (sticky) return;
  flashTimer = window.setTimeout(() => {
    state.flash = null;
    if (currentContainer) {
      void rerenderLocal();
    }
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

function renderInlineStat(label, value) {
  return `
    <div class="sb-inline-stat">
      <span>${esc(label)}</span>
      <strong>${esc(value)}</strong>
    </div>
  `;
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

function groupRoutines(routines) {
  const groups = new Map();
  for (const routine of routines) {
    const entries = groups.get(routine.category) ?? [];
    entries.push(routine);
    groups.set(routine.category, entries);
  }
  return [...groups.entries()];
}

function categoryLabel(category) {
  return String(category || '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function describeRoutineTrigger(trigger) {
  if (!trigger || typeof trigger !== 'object') return 'Manual trigger';
  if (trigger.mode === 'cron' && trigger.cron) {
    return `Cron ${trigger.cron}`;
  }
  if (trigger.mode === 'event' && trigger.eventType) {
    return `${trigger.eventType}${trigger.lookaheadMinutes ? ` · ${trigger.lookaheadMinutes}m lookahead` : ''}`;
  }
  if (trigger.mode === 'horizon' && trigger.lookaheadMinutes) {
    return `${trigger.lookaheadMinutes}m horizon scan`;
  }
  return String(trigger.mode || 'manual');
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

function addMonths(value, amount) {
  const date = startOfMonthDate(value);
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
