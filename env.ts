// ── Environment config with defaults ──

import { type EnvReader, readEnvVar, systemEnv } from '@spy4x/server/config/env';
import { ipInRanges } from '@spy4x/net/ip';
import { isValidTimeZone } from '@spy4x/time/tz';
import { DEFAULT_OAUTH_KV_PATH, type OAuthConfig } from './oauth.ts';
import { TOOL_MODES, type ToolMode } from './tools/index.ts';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export interface Env {
  caldavUrl: string;
  caldavUsername: string;
  caldavPassword: string;
  /** Interface the HTTP transport binds to. Loopback unless `HOST` says otherwise. */
  host: string;
  port: number;
  mcpBearerToken?: string;
  /**
   * Whether `/mcp` accepts `mcpBearerToken` while OAuth is on. Off unless
   * `ALLOW_BEARER_TOKEN_WITH_OAUTH=true`, so a public OAuth deploy never takes the static token by
   * accident. Without OAuth the static token is the only way in and this has no effect.
   */
  allowBearerTokenWithOAuth: boolean;
  logLevel: typeof LOG_LEVELS[number];
  /**
   * CIDR ranges of the reverse proxies in front of the HTTP transport. The rate limiter reads
   * `X-Forwarded-For` only from a peer inside one of them; empty trusts no one, since any client
   * could forge that header.
   */
  trustedProxies: string[];
  /** Which tools the server offers, from `CALDAV_MCP_TOOLS`; `all` unless set. */
  tools: ToolMode;
  /**
   * The owner's IANA time zone, from `CALDAV_MCP_TIME_ZONE`. Whole days and times written without
   * a zone are read in it; unset, they are read in the zone of the machine the server runs on.
   */
  timeZone?: string;
  /** Set when `PUBLIC_URL`, `OWNER_PASSWORD_HASH` and `AUTH_PEPPER` are all set; see `oauth.ts`. */
  oauth?: OAuthConfig;
}

/**
 * The variables that switch OAuth on. Set all three or none. `OAUTH_KV_PATH` is optional and
 * defaults to {@link DEFAULT_OAUTH_KV_PATH}.
 */
export const OAUTH_ENV_VARS = ['PUBLIC_URL', 'OWNER_PASSWORD_HASH', 'AUTH_PEPPER'] as const;

/** The format `createPasswordHasher().hash()` returns. */
const PASSWORD_HASH = /^pbkdf2-sha256\$[1-9][0-9]{5,7}\$[0-9a-f]{32}\$[0-9a-f]{64}$/;

/** The shortest pepper `createPasswordHasher` accepts. */
const MIN_PEPPER_LENGTH = 32;

/**
 * Read the configuration once at startup. Blank values count as unset. Throws on a missing
 * required value or on a `PORT`, `LOG_LEVEL`, `TRUSTED_PROXIES`, `ALLOW_BEARER_TOKEN_WITH_OAUTH`,
 * `CALDAV_MCP_TOOLS` or `CALDAV_MCP_TIME_ZONE` it cannot use, naming the variable but never echoing its value.
 */
export function loadEnv(env: EnvReader = systemEnv): Env {
  // Support both CALDAV_URL and CALDAV_SERVER_URL (homelab convention)
  const caldavUrl = env.get('CALDAV_URL') ?? env.get('CALDAV_SERVER_URL');
  if (!caldavUrl) {
    throw new Error('CALDAV_URL or CALDAV_SERVER_URL env var is required');
  }

  const optional = (name: string) => readEnvVar(env, name, { optional: true });

  return {
    caldavUrl: caldavUrl.replace(/\/+$/, ''), // strip trailing slash
    caldavUsername: readEnvVar(env, 'CALDAV_USERNAME'),
    caldavPassword: readEnvVar(env, 'CALDAV_PASSWORD'),
    host: optional('HOST') || '127.0.0.1',
    port: parsePort(optional('PORT') || '3000'),
    mcpBearerToken: optional('MCP_BEARER_TOKEN') || undefined,
    allowBearerTokenWithOAuth: parseBoolean(
      'ALLOW_BEARER_TOKEN_WITH_OAUTH',
      optional('ALLOW_BEARER_TOKEN_WITH_OAUTH'),
    ),
    logLevel: parseLogLevel(optional('LOG_LEVEL') || 'info'),
    trustedProxies: parseCidrList('TRUSTED_PROXIES', optional('TRUSTED_PROXIES')),
    tools: parseToolMode(optional('CALDAV_MCP_TOOLS') || 'all'),
    timeZone: parseTimeZone(optional('CALDAV_MCP_TIME_ZONE')),
    oauth: parseOAuth(optional),
  };
}

/**
 * OAuth is on when all of {@link OAUTH_ENV_VARS} are set and off when none is. Anything in between
 * throws, naming the missing variables, so a half-configured server never starts.
 */
function parseOAuth(optional: (name: string) => string): OAuthConfig | undefined {
  const values = OAUTH_ENV_VARS.map((name) => [name, optional(name)] as const);
  const missing = values.filter(([, value]) => value === '').map(([name]) => name);
  if (missing.length === OAUTH_ENV_VARS.length) return undefined;
  if (missing.length > 0) {
    throw new Error(
      `OAuth needs ${OAUTH_ENV_VARS.join(', ')} together; missing: ${missing.join(', ')}`,
    );
  }
  const [publicUrl, ownerPasswordHash, authPepper] = values.map(([, value]) => value) as [
    string,
    string,
    string,
  ];
  return {
    publicUrl: parsePublicUrl(publicUrl),
    ownerPasswordHash: parsePasswordHash(ownerPasswordHash),
    authPepper: parsePepper(authPepper),
    kvPath: optional('OAUTH_KV_PATH') || DEFAULT_OAUTH_KV_PATH,
  };
}

function parsePublicUrl(raw: string): string {
  const message =
    'PUBLIC_URL must be the bare https origin of the server, like https://mcp.example.com';
  let url: URL;
  try {
    url = new URL(raw.replace(/\/+$/, ''));
  } catch {
    throw new Error(message);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const scheme = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
  if (!scheme || url.origin + '/' !== url.href) throw new Error(message);
  return url.origin;
}

function parsePasswordHash(raw: string): string {
  if (!PASSWORD_HASH.test(raw)) {
    throw new Error('OWNER_PASSWORD_HASH must be a pbkdf2-sha256 hash; see the README');
  }
  return raw;
}

function parsePepper(raw: string): string {
  if (raw.length < MIN_PEPPER_LENGTH) {
    throw new Error(`AUTH_PEPPER must be at least ${MIN_PEPPER_LENGTH} characters`);
  }
  return raw;
}

/** `true` or `false`; blank counts as `false`. Anything else throws, so a typo never opens a door. */
function parseBoolean(name: string, raw: string): boolean {
  if (raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`${name} must be true or false`);
}

function parsePort(raw: string): number {
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  return port;
}

function parseLogLevel(raw: string): Env['logLevel'] {
  const level = LOG_LEVELS.find((l) => l === raw);
  if (!level) throw new Error(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}`);
  return level;
}

/** An unknown mode throws, so a typo never starts a server with the delete tools on. */
function parseToolMode(raw: string): ToolMode {
  const mode = TOOL_MODES.find((m) => m === raw);
  if (!mode) throw new Error(`CALDAV_MCP_TOOLS must be one of: ${TOOL_MODES.join(', ')}`);
  return mode;
}

function parseTimeZone(raw: string): string | undefined {
  if (raw === '') return undefined;
  if (!isValidTimeZone(raw)) {
    throw new Error('CALDAV_MCP_TIME_ZONE must be an IANA time zone name, like Europe/Berlin');
  }
  return raw;
}

function parseCidrList(name: string, raw: string): string[] {
  const ranges = raw.split(',').map((r) => r.trim()).filter((r) => r !== '');
  try {
    // Throws a RangeError on a malformed range; fail at startup, not on every request.
    ipInRanges('127.0.0.1', ranges);
  } catch {
    throw new Error(`${name} must be a comma-separated list of CIDR ranges, like 172.16.0.0/12`);
  }
  return ranges;
}
