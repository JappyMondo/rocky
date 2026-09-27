import { parse } from "parse5";
import { randomBytes } from "node:crypto";
export interface Account {
  username: string;
  email: string;
  password: string;
  id?: number;
}
export function account(prefix: string): Account {
  const suffix = randomBytes(6).toString("hex");
  return {
    username: prefix + "-" + suffix,
    email: prefix + "-" + suffix + "@fixture.invalid",
    password: randomBytes(24).toString("base64url"),
  };
}
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /password|secret|token|cookie|qr|authorization|otpauth/i.test(k)
          ? "[PRIVATE]"
          : redact(v),
      ]),
    );
  return value;
}
export function localOrigin(base: string) {
  const url = new URL(base);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.origin !== base
  )
    throw new Error("owned-loopback-origin-required");
  return url.origin;
}
export class ApiSession {
  #cookie = "";
  constructor(
    readonly base: string,
    readonly timeoutMs = 15000,
    readonly execute: <T>(
      request: { method: string; path: string },
      start: () => Promise<T>,
    ) => Promise<T> = async () => {
      throw new Error("lease-guard-required");
    },
  ) {
    localOrigin(base);
  }
  async request(path: string, init: RequestInit = {}) {
    if (!path.startsWith("/api/") || path.includes("://"))
      throw new Error("local-api-path-required");
    return this.execute({ method: init.method ?? "GET", path }, async () => {
      const response = await fetch(this.base + path, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          ...(this.#cookie ? { cookie: this.#cookie } : {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length)
        this.#cookie = cookies.map((c) => c.split(";")[0]).join("; ");
      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = text.slice(0, 4096);
      }
      return { status: response.status, body };
    });
  }
  json(path: string, method: string, body: unknown) {
    return this.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async login(user: Account) {
    return this.json("/api/auth/session/local", "POST", {
      username: user.username,
      password: user.password,
      tokenLocation: "cookie",
    });
  }
}

export async function mailboxMessages(mailpit: string) {
  localOrigin(mailpit);
  const messages: { ID: string; To: { Address: string }[] }[] = [];
  for (let start = 0; start < 1000; start += 100) {
    const result = await fetch(
      mailpit + "/api/v1/messages?start=" + start + "&limit=100",
      { signal: AbortSignal.timeout(5000), redirect: "error" },
    );
    if (!result.ok) throw new Error("fixture-mailbox-unavailable");
    const page = (await result.json()) as {
      messages?: { ID: string; To: { Address: string }[] }[];
    };
    for (const message of page.messages ?? []) messages.push(message);
    if ((page.messages?.length ?? 0) < 100) return messages;
  }
  throw new Error("fixture-mailbox-bound-exceeded");
}
export async function mailboxIds(mailpit: string) {
  return (await mailboxMessages(mailpit)).map((m) => m.ID);
}
export function verificationLink(html: string, origin: string, email: string) {
  const links: string[] = [];
  type Node = {
    tagName?: string;
    attrs?: { name: string; value: string }[];
    childNodes?: Node[];
  };
  const walk = (node: Node) => {
    if (node.tagName === "a") {
      const href = node.attrs?.find((a) => a.name === "href")?.value;
      if (href) links.push(href);
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(parse(html) as Node);
  const candidates = links.flatMap((raw) => {
    try {
      const url = new URL(raw);
      const token = url.searchParams.get("token");
      return url.origin === origin &&
        url.pathname === "/verify-email" &&
        url.searchParams.get("email") === email &&
        token
        ? [token]
        : [];
    } catch {
      return [];
    }
  });
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) throw new Error("fixture-email-link-ambiguous");
  return unique[0]!;
}
export async function verifyMail(
  mailpit: string,
  user: Account,
  api: ApiSession,
  origin: string,
  before: readonly string[],
  privateMessage?: (message: unknown) => void,
) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const ids = (await mailboxMessages(mailpit))
      .filter(
        (m) =>
          !before.includes(m.ID) &&
          m.To.some(
            (t) => t.Address.toLowerCase() === user.email.toLowerCase(),
          ),
      )
      .map((m) => m.ID);
    const matches: { id: string; token: string }[] = [];
    for (const id of ids) {
      const response = await fetch(
        mailpit + "/api/v1/message/" + encodeURIComponent(id),
        {
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        },
      );
      if (!response.ok) throw new Error("fixture-mail-detail-unavailable");
      const content = (await response.json()) as {
        To: { Address: string }[];
        HTML: string;
      };
      if (
        !content.To.some(
          (t) => t.Address.toLowerCase() === user.email.toLowerCase(),
        )
      )
        continue;
      privateMessage?.({ id, message: content });
      matches.push({
        id,
        token: verificationLink(content.HTML, origin, user.email),
      });
    }
    if (matches.length > 1) throw new Error("fixture-email-message-ambiguous");
    if (matches.length === 1) {
      const message = matches[0]!;
      const result = await api.json("/api/users/verify-email", "POST", {
        email: user.email,
        token: message.token,
      });
      return { messageId: message.id, ...result };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("fixture-email-timeout");
}
