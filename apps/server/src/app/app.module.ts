import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { DeployConfigModule } from '../config/deploy-config.module';
import type { DeployConfig } from '../config/deploy-config';
import { HealthController } from './health/health.controller';

@Module({
  controllers: [HealthController],
})
export class AppModule {
  static forRoot(config: DeployConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [DeployConfigModule.forRoot(config)],
    };
  }
}
