import { drive as createDrive } from '@googleapis/drive';
import { OAuth2Client } from 'google-auth-library';
import { DRIVE_SCOPES } from '../storage/google-drive-provider.js';

export interface LinkedIdentity {
  /** Stable Google account id. */
  sub: string;
  email: string;
  refreshToken: string;
}

export class LinkError extends Error {}

/** The Google-facing half of account linking, behind an interface so tests and fake mode need no Google. */
export interface LinkBackend {
  authUrl(state: string, loginHint?: string): string;
  exchange(code: string): Promise<LinkedIdentity>;
  /** Creates the folder that holds all PoolDrive blobs in the account; returns its id. */
  createAppFolder(refreshToken: string): Promise<string>;
}

export class GoogleLinkBackend implements LinkBackend {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  private client(): OAuth2Client {
    return new OAuth2Client(this.clientId, this.clientSecret, this.redirectUri);
  }

  authUrl(state: string, loginHint?: string): string {
    return this.client().generateAuthUrl({
      access_type: 'offline', // ask for a refresh token
      prompt: 'consent', // Google only returns one on the first consent otherwise
      scope: DRIVE_SCOPES,
      include_granted_scopes: false,
      state,
      login_hint: loginHint,
    });
  }

  async exchange(code: string): Promise<LinkedIdentity> {
    const client = this.client();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new LinkError(
        'Google did not return a refresh token. Remove PoolDrive at https://myaccount.google.com/permissions and try again.',
      );
    }
    if (!tokens.id_token) throw new LinkError('Google did not return an identity token');
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: this.clientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email)
      throw new LinkError('Google did not return the account email');
    return { sub: payload.sub, email: payload.email, refreshToken: tokens.refresh_token };
  }

  async createAppFolder(refreshToken: string): Promise<string> {
    const auth = this.client();
    auth.setCredentials({ refresh_token: refreshToken });
    const drive = createDrive({ version: 'v3', auth });
    const res = await drive.files.create({
      requestBody: {
        name: 'PoolDrive (do not edit)',
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id',
    });
    if (!res.data.id) throw new LinkError('Could not create the PoolDrive folder in Google Drive');
    return res.data.id;
  }
}

/** Development/test backend: "authorises" instantly with synthetic accounts. Never used with Google. */
export class FakeLinkBackend implements LinkBackend {
  private accounts = 0;
  private folders = 0;
  constructor(private readonly callbackUrl: string) {}

  authUrl(state: string, loginHint?: string): string {
    const email = loginHint ?? `fake-${++this.accounts}@pool.local`;
    const url = new URL(this.callbackUrl);
    url.searchParams.set('code', `fake:${email}`);
    url.searchParams.set('state', state);
    return url.toString();
  }

  exchange(code: string): Promise<LinkedIdentity> {
    const email = code.startsWith('fake:') ? code.slice(5) : '';
    if (!email) throw new LinkError('Invalid authorisation code');
    return Promise.resolve({
      sub: `fake-sub:${email}`,
      email,
      refreshToken: `fake-refresh:${email}`,
    });
  }

  createAppFolder(): Promise<string> {
    return Promise.resolve(`fake-folder-${++this.folders}`);
  }
}
