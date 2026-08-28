import { Global, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { BaseUrlService } from './base-url.service';
import { DEPLOY_CONFIG } from './deploy-config.tokens';
import type { DeployConfig } from './deploy-config';

/**
 * Publishes the Deploy config that was read and validated once at boot. It is
 * global because the base URL is needed wherever Rocky builds a link, and
 * threading an import through every module would buy nothing.
 */
@Global()
@Module({})
export class DeployConfigModule {
  static forRoot(config: DeployConfig): DynamicModule {
    return {
      module: DeployConfigModule,
      providers: [{ provide: DEPLOY_CONFIG, useValue: config }, BaseUrlService],
      exports: [DEPLOY_CONFIG, BaseUrlService],
    };
  }
}
