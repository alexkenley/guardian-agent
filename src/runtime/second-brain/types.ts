export type SecondBrainEntityKind =
  | 'overview'
  | 'note'
  | 'task'
  | 'calendar'
  | 'person'
  | 'library'
  | 'routine'
  | 'brief'
  | 'unknown';

export type SecondBrainTaskStatus = 'todo' | 'in_progress' | 'done';
export type SecondBrainTaskPriority = 'low' | 'medium' | 'high';
export type SecondBrainPersonRelationship = 'work' | 'personal' | 'family' | 'vendor' | 'other';
export type SecondBrainBriefKind = 'manual' | 'morning' | 'weekly_review' | 'pre_meeting' | 'follow_up';
export type SecondBrainGeneratedBriefKind = 'morning' | 'weekly_review' | 'pre_meeting' | 'follow_up';
export type SecondBrainLinkKind = 'document' | 'article' | 'reference' | 'repo' | 'file' | 'other';
export type SecondBrainRoutineCategory = 'scheduled' | 'one_off';
export type SecondBrainRoutineCatalogCategory = 'daily' | 'weekly' | 'meeting' | 'follow_up' | 'maintenance' | 'watch';
export type SecondBrainDeliveryChannel = 'web' | 'cli' | 'telegram';
export type SecondBrainRoutingBias = 'local_first' | 'balanced' | 'quality_first';
export type SecondBrainWorkloadClass = 'A' | 'B' | 'C' | 'D';
export type SecondBrainRoutineTriggerMode = 'cron' | 'event' | 'horizon' | 'manual';
export type SecondBrainRoutineEventType = 'upcoming_event' | 'event_ended' | 'task_due' | 'task_overdue';
export type SecondBrainRoutineTimingKind = 'manual' | 'scheduled' | 'before_meetings' | 'after_meetings' | 'background';
export type SecondBrainRoutineScheduleCadence = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'fortnightly' | 'monthly';
export type SecondBrainRoutineWeekday =
  | 'sunday'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday';
export type SecondBrainRoutineTemplateId =
  | 'morning-brief'
  | 'weekly-review'
  | 'one-off-sync'
  | 'next-24-hours-radar'
  | 'pre-meeting-brief'
  | 'follow-up-watch'
  | 'topic-watch'
  | 'deadline-watch';
export type SecondBrainRoutineCapability =
  | 'morning_brief'
  | 'weekly_review'
  | 'manual_sync'
  | 'daily_agenda_check'
  | 'pre_meeting_brief'
  | 'follow_up_draft'
  | 'topic_watch'
  | 'deadline_watch';
export type SecondBrainExternalCommMode =
  | 'none'
  | 'draft_only'
  | 'send_with_approval'
  | 'post_with_approval';

export interface SecondBrainRoutineConfig {
  topicQuery?: string;
  dueWithinHours?: number;
  includeOverdue?: boolean;
}

export interface SecondBrainRoutineSchedule {
  cadence: SecondBrainRoutineScheduleCadence;
  time?: string;
  dayOfWeek?: SecondBrainRoutineWeekday;
  dayOfMonth?: number;
  minute?: number;
}

export interface SecondBrainRoutineTrigger {
  mode: SecondBrainRoutineTriggerMode;
  cron?: string;
  eventType?: SecondBrainRoutineEventType;
  lookaheadMinutes?: number;
  schedule?: SecondBrainRoutineSchedule;
  anchorAt?: number;
}

export interface SecondBrainRoutineTimingInput {
  kind: SecondBrainRoutineTimingKind;
  schedule?: SecondBrainRoutineSchedule;
  minutes?: number;
}

export interface SecondBrainRoutineTimingView extends SecondBrainRoutineTimingInput {
  label: string;
  editable: boolean;
}

export interface SecondBrainNoteRecord {
  id: string;
  title: string;
  content: string;
  tags: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number | null;
}

export interface SecondBrainTaskRecord {
  id: string;
  title: string;
  details?: string;
  status: SecondBrainTaskStatus;
  priority: SecondBrainTaskPriority;
  dueAt?: number | null;
  source: 'manual' | 'routine';
  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
}

export interface SecondBrainEventRecord {
  id: string;
  title: string;
  description?: string;
  startsAt: number;
  endsAt?: number | null;
  source: 'local' | 'google' | 'microsoft';
  location?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SecondBrainPersonRecord {
  id: string;
  name: string;
  email?: string;
  title?: string;
  company?: string;
  notes?: string;
  relationship: SecondBrainPersonRelationship;
  lastContactAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SecondBrainLinkRecord {
  id: string;
  title: string;
  url: string;
  summary?: string;
  tags: string[];
  kind: SecondBrainLinkKind;
  createdAt: number;
  updatedAt: number;
}

export interface SecondBrainBriefRecord {
  id: string;
  kind: SecondBrainBriefKind;
  title: string;
  content: string;
  generatedAt: number;
  routineId?: string;
  eventId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SecondBrainBriefUpdateInput {
  id: string;
  title?: string;
  content?: string;
}

export interface SecondBrainBriefUpsertInput {
  id?: string;
  kind?: SecondBrainBriefKind;
  title: string;
  content: string;
  generatedAt?: number;
  routineId?: string;
  eventId?: string;
}

export interface SecondBrainRoutineManifest {
  id: string;
  name: string;
  category: SecondBrainRoutineCategory;
  enabledByDefault: boolean;
  trigger: SecondBrainRoutineTrigger;
  workloadClass: SecondBrainWorkloadClass;
  externalCommMode: SecondBrainExternalCommMode;
  budgetProfileId: string;
  deliveryDefaults: SecondBrainDeliveryChannel[];
  defaultRoutingBias: SecondBrainRoutingBias;
}

export interface SecondBrainRoutineCatalogEntry {
  templateId: string;
  capability: SecondBrainRoutineCapability;
  name: string;
  description: string;
  category: SecondBrainRoutineCatalogCategory;
  seedByDefault: boolean;
  allowMultiple: boolean;
  manifest: SecondBrainRoutineManifest;
  configured: boolean;
  configuredRoutineId?: string;
}

export interface SecondBrainRoutineRecord extends SecondBrainRoutineManifest {
  templateId?: SecondBrainRoutineTemplateId;
  config?: SecondBrainRoutineConfig;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number | null;
}

export interface SecondBrainRoutineTypeView {
  templateId: string;
  capability: SecondBrainRoutineCapability;
  name: string;
  description: string;
  category: SecondBrainRoutineCatalogCategory;
  seedByDefault: boolean;
  allowMultiple: boolean;
  configured: boolean;
  configuredRoutineId?: string;
  defaultTiming: SecondBrainRoutineTimingView;
  supportedTiming: SecondBrainRoutineTimingKind[];
  defaultDelivery: SecondBrainDeliveryChannel[];
  supportsTopicQuery: boolean;
  supportsDeadlineWindow: boolean;
}

export interface SecondBrainRoutineView {
  id: string;
  templateId?: SecondBrainRoutineTemplateId;
  capability: SecondBrainRoutineCapability;
  name: string;
  description: string;
  category: SecondBrainRoutineCatalogCategory;
  enabled: boolean;
  timing: SecondBrainRoutineTimingView;
  delivery: SecondBrainDeliveryChannel[];
  topicQuery?: string;
  dueWithinHours?: number;
  includeOverdue?: boolean;
  lastRunAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SecondBrainUsageRecord {
  timestamp: number;
  route: 'personal_assistant_task';
  featureArea: 'routine' | 'brief' | 'search' | 'draft' | 'maintenance';
  featureId?: string;
  provider?: string;
  locality: 'local' | 'external';
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  connectorCalls?: number;
  outboundAction?: 'email_send' | 'email_draft' | 'calendar_update' | 'social_post' | 'social_draft';
}

export interface SecondBrainUsageSummary {
  totalRecords: number;
  localTokens: number;
  externalTokens: number;
  totalConnectorCalls: number;
  monthlyBudget: number;
  dailyBudget: number;
  quietBudgetMode: boolean;
  pauseOnOverage: boolean;
}

export interface SecondBrainOverview {
  generatedAt: number;
  nextEvent: SecondBrainEventRecord | null;
  topTasks: SecondBrainTaskRecord[];
  recentNotes: SecondBrainNoteRecord[];
  enabledRoutineCount: number;
  reminderCount: number;
  followUpCount: number;
  briefCount: number;
  counts: {
    tasks: number;
    notes: number;
    routines: number;
  };
  usage: SecondBrainUsageSummary;
}

export interface SecondBrainSyncCursorRecord {
  id: string;
  provider: 'google' | 'microsoft';
  entity: 'calendar' | 'contacts';
  cursor?: string | null;
  lastSyncAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface SecondBrainNoteUpsertInput {
  id?: string;
  title?: string;
  content: string;
  tags?: string[];
  pinned?: boolean;
  archived?: boolean;
}

export interface SecondBrainTaskUpsertInput {
  id?: string;
  title: string;
  details?: string;
  status?: SecondBrainTaskStatus;
  priority?: SecondBrainTaskPriority;
  dueAt?: number | null;
}

export interface SecondBrainEventUpsertInput {
  id?: string;
  title: string;
  description?: string;
  startsAt: number;
  endsAt?: number | null;
  source?: SecondBrainEventRecord['source'];
  location?: string;
}

export interface SecondBrainPersonUpsertInput {
  id?: string;
  name?: string;
  email?: string;
  title?: string;
  company?: string;
  notes?: string;
  relationship?: SecondBrainPersonRelationship;
  lastContactAt?: number | null;
}

export interface SecondBrainRoutineUpdateInput {
  id: string;
  name?: string;
  enabled?: boolean;
  timing?: SecondBrainRoutineTimingInput;
  delivery?: SecondBrainDeliveryChannel[];
  trigger?: SecondBrainRoutineTrigger;
  config?: SecondBrainRoutineConfig;
  deliveryDefaults?: SecondBrainDeliveryChannel[];
  defaultRoutingBias?: SecondBrainRoutingBias;
  budgetProfileId?: string;
}

export interface SecondBrainRoutineCreateInput {
  templateId: string;
  name?: string;
  enabled?: boolean;
  timing?: SecondBrainRoutineTimingInput;
  delivery?: SecondBrainDeliveryChannel[];
  trigger?: SecondBrainRoutineTrigger;
  config?: SecondBrainRoutineConfig;
  deliveryDefaults?: SecondBrainDeliveryChannel[];
  defaultRoutingBias?: SecondBrainRoutingBias;
  budgetProfileId?: string;
}

export interface SecondBrainGenerateBriefInput {
  kind: SecondBrainGeneratedBriefKind;
  eventId?: string;
}

export interface SecondBrainTaskFilter {
  status?: SecondBrainTaskStatus | 'open';
  limit?: number;
}

export interface SecondBrainEventFilter {
  limit?: number;
  fromTime?: number;
  toTime?: number;
  includePast?: boolean;
}

export interface SecondBrainNoteFilter {
  includeArchived?: boolean;
  limit?: number;
}

export interface SecondBrainPersonFilter {
  query?: string;
  limit?: number;
}

export interface SecondBrainLinkUpsertInput {
  id?: string;
  title?: string;
  url: string;
  summary?: string;
  tags?: string[];
  kind?: SecondBrainLinkKind;
}

export interface SecondBrainLinkFilter {
  query?: string;
  kind?: SecondBrainLinkKind;
  limit?: number;
}

export interface SecondBrainBriefFilter {
  kind?: SecondBrainBriefKind;
  eventId?: string;
  limit?: number;
}
