import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthStatusDto } from './health-status.dto';

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({
    summary: 'Liveness check',
    description:
      'Answers as soon as the HTTP surface is up. It reports nothing about ' +
      'the database or the providers, so a container orchestrator can tell ' +
      '"the process is alive" apart from "the instance is healthy".',
  })
  @ApiOkResponse({ type: HealthStatusDto })
  check(): HealthStatusDto {
    return { status: 'ok' };
  }
}
