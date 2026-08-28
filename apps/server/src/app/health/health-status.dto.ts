import { ApiProperty } from '@nestjs/swagger';

export class HealthStatusDto {
  @ApiProperty({
    example: 'ok',
    description: 'Always "ok" — the process answered, so it is alive.',
  })
  status!: string;
}
