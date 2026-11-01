import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { AdminOnly, Public, SESSION_COOKIE, type AuthedRequest } from './auth.guard.js';
import { AuthService, EmailTakenError, SetupClosedError } from './auth.service.js';
import { LoginThrottle } from './throttle.js';

const credentials = z.object({
  email: z.string().trim().max(254).toLowerCase().pipe(z.email()),
  password: z.string().min(12, 'Use at least 12 characters').max(256),
});
const loginBody = z.object({ email: z.string().trim().max(254), password: z.string().max(256) });

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new BadRequestException({
      message: 'Validation failed',
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly throttle: LoginThrottle,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Tells the web app whether to show the first-run admin setup screen. */
  @Public()
  @Get('status')
  async status() {
    return { setupRequired: await this.auth.setupRequired() };
  }

  @Public()
  @Post('setup')
  async setup(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { email, password } = parseBody(credentials, body);
    await this.guardRate(req.ip, email);
    try {
      await this.auth.setup(email, password);
    } catch (e) {
      if (e instanceof SetupClosedError) throw new ConflictException('Setup is already complete');
      throw e;
    }
    return this.startSession(email, password, reply);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { email, password } = parseBody(loginBody, body);
    await this.guardRate(req.ip, email);
    const info = await this.startSession(email, password, reply);
    await this.throttle.succeeded(email);
    return info;
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(req.auth!.sessionId);
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Get('me')
  me(@Req() req: AuthedRequest) {
    const { user, csrfToken } = req.auth!;
    return { user, csrfToken };
  }

  /** Admin creates additional users; there is no public sign-up. */
  @AdminOnly()
  @Post('users')
  async createUser(@Body() body: unknown) {
    const { email, password } = parseBody(credentials, body);
    try {
      return await this.auth.createUser(email, password);
    } catch (e) {
      if (e instanceof EmailTakenError) throw new ConflictException('Email already registered');
      throw e;
    }
  }

  private async guardRate(ip: string, email: string): Promise<void> {
    if (!(await this.throttle.allow(ip, email))) {
      throw new HttpException('Too many attempts, try again later', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private async startSession(email: string, password: string, reply: FastifyReply) {
    const session = await this.auth.login(email, password);
    if (!session) throw new UnauthorizedException('Invalid email or password');
    void reply.setCookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: this.cfg.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return { user: session.info.user, csrfToken: session.info.csrfToken };
  }
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
