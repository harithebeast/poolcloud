import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseBody } from '../auth/auth.controller.js';
import { AdminOnly, type AuthedRequest } from '../auth/auth.guard.js';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { Inject } from '@nestjs/common';
import { AccountsService, InvalidLinkStateError } from './accounts.service.js';
import { LinkError } from './link-backend.js';
import { RemovalService } from './removal.service.js';

const OAUTH_COOKIE = 'pd_oauth';
const COOKIE_PATH = '/api/v1/accounts/google';
const startBody = z.object({ accountId: z.uuid().optional() });
const uuid = (raw: string) => {
  const r = z.uuid().safeParse(raw);
  if (!r.success) throw new BadRequestException('Invalid id');
  return r.data;
};

/** Linking and inspecting storage accounts. Only admins manage the pool. */
@ApiTags('accounts')
@AdminOnly()
@Controller('accounts')
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly removal: RemovalService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    const accounts = await this.accounts.list(req.auth!.user.id);
    // Accounts being removed report how much is left to move.
    return Promise.all(
      accounts.map(async (a) =>
        a.status === 'DRAINING' ? { ...a, remaining: await this.removal.progress(a.id) } : a,
      ),
    );
  }

  /** Start removing an account: its files are moved to the others first, then it is disconnected. */
  @Delete(':id')
  @HttpCode(202)
  async remove(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.removal.start(req.auth!.user.id, uuid(id));
    return { status: 'DRAINING' };
  }

  @Post(':id/cancel-removal')
  @HttpCode(200)
  async cancelRemoval(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.removal.cancel(req.auth!.user.id, uuid(id));
    return { status: 'HEALTHY' };
  }

  /** Returns the Google consent URL; the web app navigates the browser to it. */
  @Post('google/start')
  async start(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { accountId } = parseBody(startBody, body ?? {});
    const { url, nonce } = await this.accounts.start(req.auth!.user.id, accountId);
    void reply.setCookie(OAUTH_COOKIE, nonce, {
      httpOnly: true,
      secure: this.cfg.NODE_ENV === 'production',
      sameSite: 'lax',
      path: COOKIE_PATH,
      maxAge: 600,
    });
    return { url };
  }

  /** Google redirects the browser here. We always send it back to the web app with the outcome. */
  @Get('google/callback')
  async callback(
    @Query() query: Record<string, string | undefined>,
    @Req() req: AuthedRequest & FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const back = (params: Record<string, string>) => {
      const url = new URL('/storage', this.cfg.WEB_ORIGIN);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      void reply.clearCookie(OAUTH_COOKIE, { path: COOKIE_PATH });
      return reply.redirect(url.toString(), 302);
    };

    if (query.error) return back({ linkError: 'Google authorisation was cancelled or denied.' });
    if (!query.code || !query.state) return back({ linkError: 'Missing authorisation response.' });
    try {
      const done = await this.accounts.complete(
        req.auth!.user.id,
        query.code,
        query.state,
        req.cookies?.[OAUTH_COOKIE],
      );
      return back({ linked: done.email });
    } catch (err) {
      if (err instanceof InvalidLinkStateError || err instanceof LinkError) {
        return back({ linkError: err.message });
      }
      // Anything else is unexpected: log it, show a generic message (never raw provider errors).
      req.log.error({ err }, 'account linking failed');
      return back({ linkError: 'Linking failed. Check the API logs and try again.' });
    }
  }
}
