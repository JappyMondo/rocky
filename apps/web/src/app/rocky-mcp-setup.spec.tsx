import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RockyMcpSetup } from './rocky-mcp-setup.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('copies the selected MCP grants and offers manual copy when clipboard access fails', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  render(<RockyMcpSetup />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Copy MCP configuration' }),
  );
  await screen.findByText('Configuration copied.');
  expect(JSON.parse(writeText.mock.calls[0][0]).mcpServers.rocky.args).toEqual([
    'mcp',
    'serve',
  ]);
  fireEvent.click(screen.getByLabelText('Read-only access'));
  expect(screen.getByRole('status').textContent).toBe('');
  fireEvent.click(
    screen.getByRole('button', { name: 'Copy MCP configuration' }),
  );
  await screen.findByText('Configuration copied.');
  expect(JSON.parse(writeText.mock.calls[1][0]).mcpServers.rocky.args).toEqual([
    'mcp',
    'serve',
    '--read-only',
  ]);
  writeText.mockRejectedValueOnce(new Error('Clipboard denied'));
  fireEvent.click(
    screen.getByRole('button', { name: 'Copy MCP configuration' }),
  );
  await screen.findByText(/Could not copy automatically/);
  expect(
    screen.getByLabelText('Rocky MCP configuration').textContent,
  ).toContain('--read-only');
});
