import { Inject, Injectable } from '@nestjs/common';
import { DEPLOY_CONFIG } from './deploy-config.tokens';
import type { DeployConfig } from './deploy-config';

/**
 * The single source of every absolute URL Rocky generates: webhook targets,
 * OAuth redirect URIs and Public report links.
 *
 * It is built from `ROCKY_BASE_URL` and from nothing else. In particular it
 * never reads `Host` or any `X-Forwarded-*` header: Rocky generates most of
 * these URLs server-side with no request in flight at all, and behind a reverse
 * proxy those headers are a guess that a caller can set to whatever it likes.
 * A Public report link posted into a pull request never expires, so a link
 * built from a spoofed header would be wrong forever.
 */
@Injectable()
export class BaseUrlService {
  private readonly baseUrl: string;

  constructor(@Inject(DEPLOY_CONFIG) config: DeployConfig) {
    this.baseUrl = config.baseUrl;
  }

  /** The configured public origin, without a trailing slash. */
  get(): string {
    return this.baseUrl;
  }

  /** Absolute URL for a path, with or without a leading slash. */
  absoluteUrl(path: string): string {
    const relative = path.replace(/^\/+/, '');
    return relative === '' ? this.baseUrl : `${this.baseUrl}/${relative}`;
  }
}
