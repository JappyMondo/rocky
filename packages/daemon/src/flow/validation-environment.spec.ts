import { afterEach, expect, it, vi } from 'vitest';
import { defaultFlowSettings } from '@rocky/local-contracts';
import type { WorkflowContext } from '@rocky/sdk';
import { createDeliveryOperations } from './delivery.js';
import { WorkspaceExecution } from './workspace-execution.js';
import { ensureEnvironment } from '../environment/ensure.js';
import type { DeliveryAgents } from './agents.js';

vi.mock('../environment/ensure.js', async (original) => ({
  ...(await original<typeof import('../environment/ensure.js')>()),
  ensureEnvironment: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

it.each([
  { enabled: true, blocked: false },
  { enabled: false, blocked: false },
  { enabled: true, blocked: true },
])(
  'starts selected validation endpoint dependencies only after the migration boundary (%s)',
  async ({ enabled, blocked }) => {
    const order: string[] = [];
    const settings = defaultFlowSettings();
    settings.pullRequests = undefined;
    settings.validationEnvironmentVersion = enabled ? 1 : undefined;
    settings.execution = [
      {
        id: 'project',
        name: 'project',
        url: 'https://example.test/project.git',
        baseBranch: 'main',
        commands: [
          {
            cwd: '.',
            description: '',
            timeoutMs: 1000,
            env: {},
            id: 'check',
            name: 'Integration check',
            purpose: 'test',
            policy: 'required',
            dependsOn: ['project/seed'],
            command: 'check',
            endpointEnv: {
              BASE_URL: { service: 'project/server', endpoint: 'http' },
            },
          },
          {
            cwd: '.',
            description: '',
            timeoutMs: 1000,
            env: {},
            id: 'seed',
            name: 'Seed',
            purpose: 'test',
            policy: 'manual',
            dependsOn: [],
            command: 'seed',
            endpointEnv: {
              API_URL: { service: 'project/api', endpoint: 'http' },
            },
          },
          {
            cwd: '.',
            description: '',
            timeoutMs: 1000,
            env: {},
            id: 'unused',
            name: 'Unused',
            purpose: 'test',
            policy: 'manual',
            dependsOn: [],
            command: 'unused',
            endpointEnv: {
              URL: { service: 'project/unused', endpoint: 'http' },
            },
          },
        ],
      },
    ];
    vi.mocked(ensureEnvironment).mockImplementation(
      async (_ctx, _execution, request) => {
        order.push('start');
        expect(request.services).toEqual(['project/api', 'project/server']);
        expect(request.requiredKinds).toBeUndefined();
        if (blocked)
          return {
            status: 'blocked',
            blocker: {
              kind: 'environment',
              code: 'configuration',
              capability: 'server',
              action: 'Repair server startup.',
            },
          };
        return {
          status: 'ready',
          context: {
            version: 1,
            endpoints: {},
            capabilities: [],
            limitations: [],
          },
        };
      },
    );
    vi.spyOn(WorkspaceExecution.prototype, 'command').mockImplementation(
      async (id) => {
        order.push(id);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    );
    vi.spyOn(WorkspaceExecution.prototype, 'stop').mockImplementation(
      async () => {
        order.push('stop');
      },
    );
    const ctx = {
      issue: {},
      stage: vi.fn(),
      post: vi.fn(),
      comment: vi.fn(),
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
      scm: {
        openPr: vi.fn().mockResolvedValue({ repo: 'project', headSha: 'abc' }),
      },
      step: async (_label: string, work: () => Promise<unknown>) => work(),
    } as unknown as WorkflowContext;
    const run = createDeliveryOperations(
      ctx,
      { members: [] },
      settings,
      '/tmp/validation/snapshot',
    );
    const refiner = {
      call: vi.fn().mockResolvedValue({
        status: 'clear',
        scope: 'Test',
        decisions: [],
        acceptanceCriteria: [],
        outOfScope: [],
        delivery: { kind: 'pull-request', stateChanges: false },
      }),
    } as unknown as DeliveryAgents;
    await run('clarify', refiner);
    const implementer = {
      call: vi.fn().mockResolvedValue({ steps: [], summary: 'Ready' }),
    } as unknown as DeliveryAgents;
    await run('plan', implementer);
    await run('implement', implementer);
    order.length = 0;
    const call = vi.fn().mockResolvedValue({
      action: 'blocked',
      commands: [],
      summary: 'Server cannot start.',
    });
    expect(await run('validate', { call } as unknown as DeliveryAgents)).toBe(
      blocked ? 'exhausted' : 'next',
    );
    if (blocked) {
      expect(call).toHaveBeenCalledWith(
        'fixer',
        expect.objectContaining({
          label: 'Environment diagnosis and repair 1/2',
        }),
      );
      expect(order).toEqual(['start', 'stop', 'stop']);
      return;
    }
    expect(order).toEqual(
      enabled
        ? ['start', 'project/seed', 'project/check', 'stop']
        : ['project/seed', 'project/check'],
    );
  },
);
