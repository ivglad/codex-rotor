import fs from 'node:fs/promises';
import path from 'node:path';

const AUTH_CLAIM_KEY = 'https://api.openai.com/auth';
const PROFILE_CLAIM_KEY = 'https://api.openai.com/profile';

function decodeBase64UrlJson(segment) {
  try {
    const normalized = String(segment || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function decodeJwtPayload(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length < 2) return null;
  return decodeBase64UrlJson(parts[1]);
}

function parseIso(value) {
  if (!value) return null;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function extractAuthClaim(payload) {
  const auth = payload?.[AUTH_CLAIM_KEY];
  return auth && typeof auth === 'object' ? auth : null;
}

function pickWorkspaceFromAuthClaim(authClaim) {
  const organizations = Array.isArray(authClaim?.organizations) ? authClaim.organizations : [];
  const orgCandidate = organizations.find((org) => org?.is_default) || organizations[0] || null;
  if (orgCandidate && typeof orgCandidate === 'object') {
    return {
      workspace_id: orgCandidate.id ? String(orgCandidate.id) : null,
      workspace_title: orgCandidate.title ? String(orgCandidate.title) : null
    };
  }

  const groups = Array.isArray(authClaim?.groups) ? authClaim.groups : [];
  const groupCandidate = groups[0] || null;
  if (groupCandidate && typeof groupCandidate === 'object') {
    return {
      workspace_id: groupCandidate.id ? String(groupCandidate.id) : null,
      workspace_title: groupCandidate.title ? String(groupCandidate.title) : null
    };
  }
  if (typeof groupCandidate === 'string') {
    return {
      workspace_id: groupCandidate,
      workspace_title: null
    };
  }

  return {
    workspace_id: null,
    workspace_title: null
  };
}

function compact(value, maxLen = 64) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

function normalizeIdentity({ authClaim, idPayload, accessPayload, authJson, authFileMtimeIso }) {
  const accountId = compact(
    authClaim?.chatgpt_account_id
    || authClaim?.chatgpt_account_user_id
    || null
  );
  const userId = compact(authClaim?.chatgpt_user_id || authClaim?.user_id || null);
  const planType = compact(authClaim?.chatgpt_plan_type || null);
  const workspace = pickWorkspaceFromAuthClaim(authClaim || {});

  const email = compact(
    idPayload?.email
    || accessPayload?.email
    || accessPayload?.[PROFILE_CLAIM_KEY]?.email
    || null
  );

  const lastRefresh = parseIso(authJson?.last_refresh) || parseIso(authFileMtimeIso);

  const hasAccount = Boolean(accountId);
  const hasWorkspace = Boolean(workspace.workspace_id);
  const fingerprint = hasAccount
    ? `${accountId}::${hasWorkspace ? workspace.workspace_id : 'no-workspace'}`
    : null;

  return {
    fingerprint,
    account_id: accountId,
    user_id: userId,
    workspace_id: workspace.workspace_id,
    workspace_title: workspace.workspace_title,
    email,
    plan_type: planType,
    last_refresh: lastRefresh
  };
}

export async function readSlotAuthIdentity(codexHome) {
  const home = String(codexHome || '').trim();
  if (!home) return null;

  const authPath = path.join(home, 'auth.json');
  let raw;
  let authFileStats = null;
  try {
    authFileStats = await fs.stat(authPath);
    raw = await fs.readFile(authPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    return null;
  }

  let authJson;
  try {
    authJson = JSON.parse(raw);
  } catch {
    return null;
  }

  const tokens = authJson?.tokens || {};
  const idPayload = decodeJwtPayload(tokens.id_token);
  const accessPayload = decodeJwtPayload(tokens.access_token);
  const authClaim = extractAuthClaim(idPayload) || extractAuthClaim(accessPayload);
  if (!authClaim) {
    return null;
  }

  return normalizeIdentity({
    authClaim,
    idPayload,
    accessPayload,
    authJson,
    authFileMtimeIso: authFileStats?.mtime?.toISOString?.() || null
  });
}

function short(text, max = 18) {
  if (!text) return '-';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function formatIdentityCompact(identity) {
  if (!identity) return 'identity=unknown';
  const acct = identity.email || identity.user_id || identity.account_id || 'unknown-account';
  const ws = identity.workspace_title || identity.workspace_id || 'unknown-workspace';
  return `acct=${short(acct, 30)} ws=${short(ws, 24)}`;
}

export function isSameAccountWorkspace(a, b) {
  return Boolean(a?.fingerprint) && Boolean(b?.fingerprint) && a.fingerprint === b.fingerprint;
}
