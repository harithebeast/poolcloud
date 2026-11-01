import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { AuthService, type SessionInfo } from './auth.service.js';
import { safeEqual } from './tokens.js';

export const SESSION_COOKIE = 'pd_sid';
export const CSRF_HEADER = 'x-csrf-token';

const PUBLIC = 'isPublic';
const ADMIN = 'adminOnly';
/** Opt a route out of authentication (login, setup, health, public share links). */
export const Public = () => SetMetadata(PUBLIC, true);
export const AdminOnly = () => SetMetadata(ADMIN, true);

export type AuthedRequest = FastifyRequest & { auth?: SessionInfo };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Authenticates every route by default (secure by default). State-changing requests additionally
 * need the per-session CSRF token and an Origin that matches the web app.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const targets = [ctx.getHandler(), ctx.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC, targets);
    const adminOnly = this.reflector.getAllAndOverride<boolean>(ADMIN, targets);
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();

    const token = req.cookies?.[SESSION_COOKIE];
    const session = token ? await this.auth.resolve(token) : null;
    if (session) req.auth = session;
    if (isPublic) return true;
    if (!session) throw new UnauthorizedException();

    if (!SAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== this.cfg.WEB_ORIGIN) throw new ForbiddenException('Bad origin');
      const header = req.headers[CSRF_HEADER];
      if (typeof header !== 'string' || !safeEqual(header, session.csrfToken)) {
        throw new ForbiddenException('Missing or invalid CSRF token');
      }
    }
    if (adminOnly && session.user.role !== 'admin') throw new ForbiddenException();
    return true;
  }
}
