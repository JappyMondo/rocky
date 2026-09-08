import { expect } from 'vitest';

export const githubOptions = {
  repo: { id: 'lead', project: 'team/repo', baseBranch: 'main' },
  branch: 'ng-524',
  token: 'fixture-token',
  apiUrl: 'https://github.test',
};
export const githubPull = {
  node_id: 'PR_one',
  number: 7,
  html_url: 'https://github.test/team/repo/pull/7',
  head: { ref: 'ng-524', sha: 'abc', repo: { full_name: 'team/repo' } },
  base: { ref: 'main', repo: { full_name: 'team/repo' } },
  state: 'open',
  merged_at: null,
  draft: true,
};

export function scriptedFetch(
  script: {
    path: string;
    method?: string;
    body?: unknown;
    value?: unknown;
    status?: number;
    headers?: Record<string, string>;
    text?: string;
  }[],
) {
  const calls: {
    path: string;
    method: string;
    body: {
      query?: string;
      variables?: { input?: unknown };
      [key: string]: unknown;
    };
    headers: Headers;
  }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body, headers: new Headers(init?.headers) });
    const next = script[calls.length - 1];
    expect(next, `${method} ${path}`).toBeDefined();
    expect(path).toBe(next.path);
    expect(method).toBe(next.method ?? 'GET');
    if (next.body !== undefined) expect(body).toEqual(next.body);
    return new Response(
      next.status === 204 || next.status === 304
        ? null
        : (next.text ?? JSON.stringify(next.value)),
      { status: next.status ?? 200, headers: next.headers },
    );
  };
  return {
    fetch: transport,
    calls,
    done: () => expect(calls).toHaveLength(script.length),
  };
}
