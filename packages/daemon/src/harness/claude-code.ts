import type { Capability } from './types.js';

export const claudeCode = {
  allowedTools(capabilities: readonly Capability[]): string[] {
    return capabilities.flatMap((capability) => {
      if (capability === 'read') return ['Read', 'Glob', 'Grep'];
      if (capability === 'edit') return ['Edit', 'Write'];
      return ['Bash'];
    });
  },
};
