import {
  CLIENT_VERSION_HEADER,
  DEFAULT_HOST,
  DEFAULT_PORT,
  VERSION_HEADER,
} from '@rocky/daemon';

import { CLI_VERSION } from './version.js';
import { versionMismatchHint } from './version-handshake.js';

export interface DaemonAddress {
  host?: string;
  port?: number;
}

export interface ClientOptions extends DaemonAddress {
  cliVersion?: string;
  /** Where a version-mismatch hint goes. Defaults to stderr. */
  warn?: (message: string) => void;
  fetch?: typeof fetch;
}

export class DaemonUnreachableError extends Error {
  constructor(readonly url: string) {
    super(`no daemon answering at ${url} — \`rocky start\` to launch one`);
    this.name = 'DaemonUnreachableError';
  }
}

/**
 * The thin client the CLI talks to the daemon through. Every call carries the
 * CLI's version up and checks the daemon's version on the way back, so the
 * handshake is a property of the transport rather than of any one command.
 */
export class DaemonClient {
  private readonly baseUrl: string;
  private readonly cliVersion: string;
  private readonly warn: (message: string) => void;
  private readonly doFetch: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = `http://${options.host ?? DEFAULT_HOST}:${options.port ?? DEFAULT_PORT}`;
    this.cliVersion = options.cliVersion ?? CLI_VERSION;
    this.warn = options.warn ?? ((message) => console.error(message));
    this.doFetch = options.fetch ?? fetch;
  }

  get url(): string {
    return this.baseUrl;
  }

  async health(): Promise<{ status: string; version: string; web: boolean }> {
    return this.request('/api/health');
  }

  private async request<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        headers: { [CLIENT_VERSION_HEADER]: this.cliVersion },
      });
    } catch {
      throw new DaemonUnreachableError(this.baseUrl);
    }

    const daemonVersion = response.headers.get(VERSION_HEADER);
    if (daemonVersion) {
      const hint = versionMismatchHint(daemonVersion, this.cliVersion);
      if (hint) {
        this.warn(hint);
      }
    }

    if (!response.ok) {
      throw new Error(`${path} answered ${response.status}`);
    }

    return (await response.json()) as T;
  }
}
