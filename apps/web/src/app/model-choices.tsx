import { useState } from 'react';
import type {
  AgentModelSelection,
  RepositoryProfileDefaults,
  WorkflowModels,
} from '@rocky/local-contracts';
import styles from './app.module.css';

export function suggestedModels(
  defaults?: RepositoryProfileDefaults,
): WorkflowModels {
  const empty: AgentModelSelection = {
    harness: defaults?.grants.harness ?? 'opencode',
    model: '',
    effort: '',
  };
  return {
    agent: { ...empty, ...defaults?.modelSuggestions?.agent },
    fastAgent: { ...empty, ...defaults?.modelSuggestions?.fastAgent },
  };
}
export function modelsComplete(models: WorkflowModels | null): boolean {
  return (
    !!models &&
    [models.agent, models.fastAgent].every((agent) =>
      [agent.model, agent.effort].every(
        (value) =>
          !!value.trim() &&
          !/\s/.test(value.trim()) &&
          !/^(auto|default)$/i.test(value.trim()),
      ),
    )
  );
}

export function ModelChoices({
  value,
  onChange,
}: {
  value: WorkflowModels;
  onChange: (value: WorkflowModels) => void;
}) {
  const [same, setSame] = useState(
    JSON.stringify(value.agent) === JSON.stringify(value.fastAgent),
  );
  const fields = (name: 'agent' | 'fastAgent', title: string) => {
    const selected = value[name];
    const update = (change: Partial<AgentModelSelection>) => {
      const next = { ...selected, ...change };
      onChange({
        ...value,
        [name]: next,
        ...(name === 'agent' && same ? { fastAgent: { ...next } } : {}),
      });
    };
    return (
      <div className={styles.fieldGrid}>
        <label>
          {title} harness
          <select
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
          {title} model
          <input
            required
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
          {title} {selected.harness === 'opencode' ? 'variant' : 'effort'}
          <input
            required
            value={selected.effort}
            placeholder="e.g. high"
            onChange={(e) => update({ effort: e.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>
    );
  };
  return (
    <section className={styles.modelChoices} aria-label="Workflow models">
      <h3>Choose the models for this workflow</h3>
      <p>
        These choices are saved with the workflow and copied into each run. Use
        full model IDs and a variant or effort supported by the model.
      </p>
      {fields('agent', 'Main agent')}
      <label className={styles.modelReuse}>
        <input
          type="checkbox"
          checked={same}
          onChange={(e) => {
            setSame(e.target.checked);
            if (e.target.checked)
              onChange({ ...value, fastAgent: { ...value.agent } });
          }}
        />
        Use the same model and variant/effort for helper agents
      </label>
      {!same && fields('fastAgent', 'Helper agent')}
      <p className={styles.muted}>
        OpenCode model IDs are listed by <code>opencode models</code>. Blank
        values never fall back to harness defaults.
      </p>
    </section>
  );
}
