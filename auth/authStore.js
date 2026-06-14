import { loadJson, saveJson } from "../store/common.js";
import { DEFAULT_USERS, hashPassword, generateToken, hasPermission, ROLE_LABELS } from "./users.js";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

async function loadUsers() {
  const users = await loadJson("users.json", DEFAULT_USERS);
  if (!users || users.length === 0) {
    await saveJson("users.json", DEFAULT_USERS);
    return DEFAULT_USERS;
  }
  return users;
}

async function saveUsers(users) {
  await saveJson("users.json", users);
}

async function loadTokens() {
  return await loadJson("tokens.json", []);
}

async function saveTokens(tokens) {
  await saveJson("tokens.json", tokens);
}

export async function findUserByUsername(username) {
  const users = await loadUsers();
  return users.find((u) => u.username === username) || null;
}

export async function findUserById(id) {
  const users = await loadUsers();
  return users.find((u) => u.id === id) || null;
}

export async function verifyUser(username, password) {
  const user = await findUserByUsername(username);
  if (!user) return null;
  const hashed = hashPassword(password);
  if (user.password !== hashed) return null;
  return user;
}

export async function createTokenForUser(userId) {
  const tokens = await loadTokens();
  const now = Date.now();
  const validTokens = tokens.filter((t) => t.expiresAt > now);
  const existing = validTokens.find((t) => t.userId === userId);
  if (existing) {
    existing.expiresAt = now + TOKEN_TTL_MS;
    await saveTokens([...validTokens.filter((t) => t.token !== existing.token), existing]);
    return existing;
  }
  const token = generateToken();
  const tokenRecord = {
    token,
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: now + TOKEN_TTL_MS
  };
  await saveTokens([...validTokens, tokenRecord]);
  return tokenRecord;
}

export async function revokeToken(token) {
  const tokens = await loadTokens();
  const filtered = tokens.filter((t) => t.token !== token);
  await saveTokens(filtered);
}

export async function getUserByToken(token) {
  if (!token) return { user: null, error: "unauthorized" };
  const tokens = await loadTokens();
  const now = Date.now();
  const record = tokens.find((t) => t.token === token);
  if (!record) return { user: null, error: "token_invalid" };
  if (record.expiresAt <= now) {
    const filtered = tokens.filter((t) => t.token !== token);
    await saveTokens(filtered);
    return { user: null, error: "token_expired" };
  }
  const user = await findUserById(record.userId);
  if (!user) return { user: null, error: "token_invalid" };
  return { user, error: null, tokenRecord: { ...record, expiresAt: new Date(record.expiresAt).toISOString() } };
}

export function extractTokenFromRequest(req) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return null;
  const parts = authHeader.split(" ");
  if (parts.length === 2 && parts[0] === "Bearer") {
    return parts[1];
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return null;
}

export function requirePermission(permission) {
  return async (req, res) => {
    const token = extractTokenFromRequest(req);
    if (!token) {
      return { authorized: false, error: "unauthorized", status: 401, message: "未提供认证Token" };
    }
    const { user, error } = await getUserByToken(token);
    if (error === "token_invalid") {
      return { authorized: false, error: "token_invalid", status: 401, message: "Token无效" };
    }
    if (error === "token_expired") {
      return { authorized: false, error: "token_expired", status: 401, message: "Token已过期" };
    }
    if (error === "unauthorized") {
      return { authorized: false, error: "unauthorized", status: 401, message: "未认证" };
    }
    if (permission && !hasPermission(user.role, permission)) {
      return {
        authorized: false,
        error: "permission_denied",
        status: 403,
        message: `权限不足，需要${ROLE_LABELS[user.role]}角色不具备该操作权限`
      };
    }
    return { authorized: true, user };
  };
}
