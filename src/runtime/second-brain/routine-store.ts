import type { SecondBrainRoutineRecord } from './types.js';
import { clone } from './utils.js';
import type { SecondBrainStoreContext } from './second-brain-store.js';

export class RoutineStore {
  constructor(private readonly ctx: SecondBrainStoreContext) {}

  listRoutines(): SecondBrainRoutineRecord[] {
    if (this.ctx.mode === 'memory') {
      return [...this.ctx.memory.routines.values()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(clone);
    }

    const rows = this.ctx.db!.prepare(`
      SELECT id, name, category, enabled_by_default, enabled, trigger_json, workload_class,
             external_comm_mode, budget_profile_id, delivery_defaults_json, default_routing_bias,
             last_run_at, created_at, updated_at
      FROM sb_routines
      ORDER BY name ASC
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      category: row.category as SecondBrainRoutineRecord['category'],
      enabledByDefault: Number(row.enabled_by_default) === 1,
      enabled: Number(row.enabled) === 1,
      trigger: JSON.parse(String(row.trigger_json)),
      workloadClass: row.workload_class as SecondBrainRoutineRecord['workloadClass'],
      externalCommMode: row.external_comm_mode as SecondBrainRoutineRecord['externalCommMode'],
      budgetProfileId: String(row.budget_profile_id),
      deliveryDefaults: JSON.parse(String(row.delivery_defaults_json)) as SecondBrainRoutineRecord['deliveryDefaults'],
      defaultRoutingBias: row.default_routing_bias as SecondBrainRoutineRecord['defaultRoutingBias'],
      lastRunAt: row.last_run_at == null ? null : Number(row.last_run_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  upsertRoutine(routine: SecondBrainRoutineRecord): SecondBrainRoutineRecord {
    if (this.ctx.mode === 'memory') {
      this.ctx.memory.routines.set(routine.id, clone(routine));
      return routine;
    }

    this.ctx.db!.prepare(`
      INSERT INTO sb_routines (
        id, name, category, enabled_by_default, enabled, trigger_json, workload_class,
        external_comm_mode, budget_profile_id, delivery_defaults_json, default_routing_bias,
        last_run_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        category = excluded.category,
        enabled_by_default = excluded.enabled_by_default,
        enabled = excluded.enabled,
        trigger_json = excluded.trigger_json,
        workload_class = excluded.workload_class,
        external_comm_mode = excluded.external_comm_mode,
        budget_profile_id = excluded.budget_profile_id,
        delivery_defaults_json = excluded.delivery_defaults_json,
        default_routing_bias = excluded.default_routing_bias,
        last_run_at = excluded.last_run_at,
        updated_at = excluded.updated_at
    `).run(
      routine.id,
      routine.name,
      routine.category,
      routine.enabledByDefault ? 1 : 0,
      routine.enabled ? 1 : 0,
      JSON.stringify(routine.trigger),
      routine.workloadClass,
      routine.externalCommMode,
      routine.budgetProfileId,
      JSON.stringify(routine.deliveryDefaults),
      routine.defaultRoutingBias,
      routine.lastRunAt ?? null,
      routine.createdAt,
      routine.updatedAt,
    );
    return routine;
  }
}
