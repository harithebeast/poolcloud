import {
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth.guard.js';
import { AlertsService } from './alerts.service.js';

@ApiTags('alerts')
@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  async list(@Req() req: AuthedRequest, @Query('all') all?: string) {
    const rows = await this.alerts.list(req.auth!.user.id, all !== 'true');
    return {
      items: rows.map((a) => ({
        id: a.id,
        kind: a.kind,
        message: a.message,
        accountId: a.accountId,
        createdAt: a.createdAt,
        resolvedAt: a.resolvedAt,
      })),
    };
  }

  @Delete(':id')
  @HttpCode(204)
  async dismiss(@Req() req: AuthedRequest, @Param('id') id: string) {
    if (!(await this.alerts.dismiss(req.auth!.user.id, id))) throw new NotFoundException();
  }
}
