import type {
  AgentModelSelection,
  RepositoryProfileDefaults,
  WorkflowModels,
  WorkflowModelSlots,
} from '@rocky/local-contracts';
import styles from './app.module.css';

export function modelsForSlots(
  slots: WorkflowModelSlots,
  previous: WorkflowModels = {},
  defaults?: RepositoryProfileDefaults,
): WorkflowModels {
  return Object.fromEntries(
    Object.keys(slots).map((key) => [
      key,
      previous[key] ?? {
        harness: defaults?.grants.harness ?? 'opencode',
        model: '',
        effort: '',
        ...defaults?.modelSuggestions?.[key],
      },
    ]),
  );
}

export function suggestedModels(
  defaults: RepositoryProfileDefaults,
): WorkflowModels {
  return modelsForSlots(defaults.modelSlots ?? {}, {}, defaults);
}

export function modelsComplete(
  models: WorkflowModels | null | undefined,
  slots?: WorkflowModelSlots,
): boolean {
  return (
    !!models &&
    Object.keys(slots ?? models).every((key) => {
      const agent = models[key];
      return (
        !!agent &&
        [agent.model, agent.effort].every(
          (value) =>
            !!value.trim() &&
            !/\s/.test(value.trim()) &&
            !/^(auto|default)$/i.test(value.trim()),
        )
      );
    })
  );
}

export function ModelChoices({
  slots,
  value,
  onChange,
  disabled = false,
}: {
  slots: WorkflowModelSlots;
  value: WorkflowModels;
  onChange: (value: WorkflowModels) => void;
  disabled?: boolean;
}) {
  return (
    <section className={styles.modelChoices} aria-label="Workflow models">
      <h3>Workflow models</h3>
      <p>
        Choose a harness, model and variant/effort for each role. Saved
        selections apply to new runs. Existing runs and retries keep their
        captured settings.
      </p>
      {Object.entries(slots).map(([key, slot]) => {
        const selected = value[key] ?? {
          harness: 'opencode',
          model: '',
          effort: '',
        };
        const update = (change: Partial<AgentModelSelection>) =>
          onChange({ ...value, [key]: { ...selected, ...change } });
        return (
          <section key={key} aria-label={slot.name}>
            <h4>
              {slot.name} <code>{key}</code>
            </h4>
            {slot.description && (
              <p className={styles.muted}>{slot.description}</p>
            )}
            <div className={styles.fieldGrid}>
              <label>
                {slot.name} harness
                <select
                  disabled={disabled}
                  value={selected.harness}
                  onChange={(e) =>
                    update({
                      harness: e.target.value as AgentModelSelection['harness'],
                      model: '',
                      effort: '',
                    })
                  }
                >
                  <option value="opencode">OpenCode</option>
                  <option value="claude-code">Claude Code</option>
                </select>
              </label>
              <label>
                {slot.name} model
                <input
                  required
                  disabled={disabled}
                  value={selected.model}
                  placeholder={
                    selected.harness === 'opencode'
                      ? 'provider/model-id'
                      : 'Full Claude model ID'
                  }
                  onChange={(e) => update({ model: e.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label>
                {slot.name}{' '}
                {selected.harness === 'opencode' ? 'variant' : 'effort'}
                <input
                  required
                  disabled={disabled}
                  value={selected.effort}
                  placeholder="e.g. high"
                  onChange={(e) => update({ effort: e.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            </div>
          </section>
        );
      })}
      {Object.keys(slots).length === 0 ? (
        <p>This workflow declares no model slots.</p>
      ) : (
        <p className={styles.muted}>
          Use full model IDs and a variant or effort supported by that model.
          OpenCode lists IDs with <code>opencode models</code>. Choices are
          stored in the profile; saving them leaves the workflow unchanged.
        </p>
      )}
    </section>
  );
}
