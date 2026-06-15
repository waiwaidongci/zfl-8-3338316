import { send, body } from "../store/common.js";
import {
  verifyUser,
  createTokenForUser,
  getUserByToken,
  revokeToken,
  extractTokenFromRequest,
  findUserByUsername
} from "../auth/authStore.js";
import { ROLES, ROLE_LABELS, ROLE_PERMISSIONS, PERMISSIONS, buildPermissionMatrix } from "../auth/users.js";

export async function handleAuth(req, res, url) {
  if (req.method === "POST" && url.pathname === "/auth/login") {
    const input = await body(req);
    const { username, password } = input;
    if (!username || !password) {
      return send(res, 400, { error: "username_and_password_required" });
    }
    const user = await verifyUser(username, password);
    if (!user) {
      return send(res, 401, { error: "invalid_credentials", message: "用户名或密码错误" });
    }
    const tokenRecord = await createTokenForUser(user.id);
    return send(res, 200, {
      token: tokenRecord.token,
      tokenType: "Bearer",
      expiresAt: new Date(tokenRecord.expiresAt).toISOString(),
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        roleLabel: ROLE_LABELS[user.role]
      }
    });
  }

  if (req.method === "POST" && url.pathname === "/auth/logout") {
    const token = extractTokenFromRequest(req);
    if (token) {
      await revokeToken(token);
    }
    return send(res, 200, { success: true });
  }

  if (req.method === "GET" && url.pathname === "/auth/me") {
    const token = extractTokenFromRequest(req);
    if (!token) {
      return send(res, 401, { error: "unauthorized", message: "未提供认证Token" });
    }
    const { user, error, tokenRecord } = await getUserByToken(token);
    if (error === "token_invalid") {
      return send(res, 401, { error: "token_invalid", message: "Token无效" });
    }
    if (error === "token_expired") {
      return send(res, 401, { error: "token_expired", message: "Token已过期" });
    }
    if (!user) {
      return send(res, 401, { error: "unauthorized", message: "未认证" });
    }
    return send(res, 200, {
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        roleLabel: ROLE_LABELS[user.role]
      },
      permissions: ROLE_PERMISSIONS[user.role] || [],
      tokenExpiresAt: tokenRecord ? tokenRecord.expiresAt : null
    });
  }

  if (req.method === "GET" && url.pathname === "/auth/roles") {
    const token = extractTokenFromRequest(req);
    if (!token) {
      return send(res, 401, { error: "unauthorized", message: "未提供认证Token" });
    }
    const { user, error } = await getUserByToken(token);
    if (error || !user) {
      return send(res, 401, { error: error || "unauthorized", message: "认证失败" });
    }
    const roles = Object.entries(ROLE_LABELS).map(([key, label]) => ({
      role: key,
      label,
      permissions: ROLE_PERMISSIONS[key] || []
    }));
    return send(res, 200, { roles, allPermissions: Object.values(PERMISSIONS) });
  }

  if (req.method === "GET" && url.pathname === "/auth/permissions") {
    const token = extractTokenFromRequest(req);
    if (!token) {
      return send(res, 401, { error: "unauthorized", message: "未提供认证Token" });
    }
    const { user, error } = await getUserByToken(token);
    if (error || !user) {
      return send(res, 401, { error: error || "unauthorized", message: "认证失败" });
    }
    const roleFilter = url.searchParams.get("role");
    if (roleFilter && !ROLE_LABELS[roleFilter]) {
      return send(res, 400, { error: "invalid_role", message: `无效角色: ${roleFilter}，有效值: ${Object.keys(ROLE_LABELS).join(", ")}` });
    }
    const matrix = buildPermissionMatrix(roleFilter);
    const roleInfo = Object.entries(ROLE_LABELS)
      .filter(([key]) => !roleFilter || key === roleFilter)
      .map(([key, label]) => ({ role: key, label }));
    return send(res, 200, {
      permissions: matrix,
      roleInfo,
      totalPermissions: matrix.length,
      note: "所有已认证用户均可访问 GET 查询类接口（无需特定权限），此处仅列出写操作权限"
    });
  }

  return null;
}

export async function checkQueryAuth(req, res) {
  const token = extractTokenFromRequest(req);
  if (!token) {
    send(res, 401, { error: "unauthorized", message: "未提供认证Token" });
    return { authorized: false };
  }
  const { user, error } = await getUserByToken(token);
  if (error === "token_invalid") {
    send(res, 401, { error: "token_invalid", message: "Token无效" });
    return { authorized: false };
  }
  if (error === "token_expired") {
    send(res, 401, { error: "token_expired", message: "Token已过期" });
    return { authorized: false };
  }
  if (!user) {
    send(res, 401, { error: "unauthorized", message: "未认证" });
    return { authorized: false };
  }
  return { authorized: true, user };
}

export async function checkActionAuth(req, res, permission) {
  const result = await checkQueryAuth(req, res);
  if (!result.authorized) {
    return result;
  }
  const userRole = result.user.role;
  const perms = ROLE_PERMISSIONS[userRole] || [];
  if (!perms.includes(permission)) {
    send(res, 403, {
      error: "permission_denied",
      message: `权限不足：${ROLE_LABELS[userRole]}角色不具备该操作权限`
    });
    return { authorized: false };
  }
  return { authorized: true, user: result.user };
}
