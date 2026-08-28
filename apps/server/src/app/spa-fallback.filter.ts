import { Catch, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
// Side-effect import: @fastify/static augments FastifyReply with sendFile().
import '@fastify/static';

/**
 * Hands unmatched GETs to the SPA, which owns client-side routing: a deep link
 * like /repos/42 is a real URL React knows and Fastify does not.
 *
 * Anything under the API prefix keeps its honest 404 — answering an unknown
 * endpoint with a page of HTML would turn a typo in a client into a parse
 * error somewhere far away from the cause.
 */
@Catch(NotFoundException)
export class SpaFallbackFilter extends BaseExceptionFilter {
  constructor(
    private readonly apiPrefix: string,
    ...baseArgs: ConstructorParameters<typeof BaseExceptionFilter>
  ) {
    super(...baseArgs);
  }

  override catch(exception: NotFoundException, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();

    if (request.method !== 'GET' || this.isApiRequest(request.url)) {
      super.catch(exception, host);
      return;
    }

    http.getResponse<FastifyReply>().type('text/html').sendFile('index.html');
  }

  private isApiRequest(url: string): boolean {
    const prefix = `/${this.apiPrefix}`;
    return url === prefix || url.startsWith(`${prefix}/`);
  }
}
