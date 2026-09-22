import {
  agentModelSchema,
  workflowModelsSchema,
  defaultWorkflowModels,
  type AgentModelSelection,
  type WorkflowModels,
  type WorkflowDefaults,
} from '@rocky/daemon';
import { createConsolePrompter, type Prompter } from './setup/prompter.js';

export interface ModelFlags {
  harness?: string;
  model?: string;
  variant?: string;
  fastHarness?: string;
  fastModel?: string;
  fastVariant?: string;
}

export async function askAgentModel(
  prompter: Prompter,
  label: string,
  suggested: Partial<AgentModelSelection>,
): Promise<AgentModelSelection> {
  const values = {
    harness: suggested.harness,
    model: suggested.model,
    effort: suggested.effort,
  };
  for (const key of ['harness', 'model', 'effort'] as const) {
    const title =
      key === 'harness'
        ? 'harness (opencode / claude-code / codex)'
        : key === 'model'
          ? 'model identifier'
          : 'variant / effort (explicit value, e.g. high)';
    for (;;) {
      const answer =
        (
          await prompter.ask(
            `${label} ${title}${values[key] ? ` [${values[key]}]` : ''}:`,
          )
        ).trim() || values[key];
      const checked = agentModelSchema.shape[key].safeParse(answer);
      if (checked.success) {
        if (key === 'harness' && values.harness !== checked.data) {
          delete values.model;
          delete values.effort;
        }
        Object.assign(values, { [key]: checked.data });
        break;
      }
      prompter.say(
        `Enter a valid ${key === 'effort' ? 'variant or effort supported by this model' : title}; harness defaults are not used.`,
      );
    }
  }
  return agentModelSchema.parse(values);
}

export async function chooseWorkflowModels(
  flags: ModelFlags,
  defaults: WorkflowDefaults,
  createPrompter?: typeof createConsolePrompter,
): Promise<WorkflowModels> {
  const main = {
    harness: flags.harness,
    model: flags.model,
    effort: flags.variant,
  };
  const fast = {
    harness: flags.fastHarness,
    model: flags.fastModel,
    effort: flags.fastVariant,
  };
  const hasFlags = Object.values({
    ...main,
    fastHarness: fast.harness,
    fastModel: fast.model,
    fastEffort: fast.effort,
  }).some((value) => value !== undefined);
  if (hasFlags) {
    const parsed = workflowModelsSchema.safeParse({
      agent: main,
      fastAgent: Object.values(fast).some((v) => v !== undefined) ? fast : main,
    });
    if (!parsed.success)
      throw new Error(
        'Provide --harness, --model and --variant together. Optional helper overrides require --fast-harness, --fast-model and --fast-variant together.',
      );
    return defaultWorkflowModels(parsed.data);
  }
  if (!createPrompter && !process.stdin.isTTY)
    throw new Error(
      'Model selection requires an interactive terminal. Pass --harness, --model and --variant explicitly; helper agents use the same selection unless all --fast-* options are provided.',
    );
  const prompter = (createPrompter ?? createConsolePrompter)();
  try {
    prompter.say(
      'Choose the models saved in this profile. Review and implementation share the main choice initially; you can configure each slot separately in the web UI. Later harness default changes will not replace these choices. Use a full model identifier to avoid moving aliases.',
    );
    const agent = await askAgentModel(
      prompter,
      'Review and implementation',
      defaults,
    );
    let same: string;
    do {
      same = (
        await prompter.ask(
          'Use the same model and variant/effort for planning? [Y/n]:',
        )
      )
        .trim()
        .toLowerCase();
    } while (!['', 'y', 'yes', 'n', 'no'].includes(same));
    const fastAgent = ['', 'y', 'yes'].includes(same)
      ? { ...agent }
      : await askAgentModel(prompter, 'Planner', agent);
    return defaultWorkflowModels({ agent, fastAgent });
  } finally {
    prompter.close();
  }
}
