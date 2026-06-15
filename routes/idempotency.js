import { send } from "../store/common.js";
import { queryIdempotencyRecords } from "../store/idempotency.js";
import { getOperationLog } from "../store/operationLog.js";
import { checkActionAuth } from "./auth.js";
import { PERMISSIONS } from "../auth/users.js";

const SENSITIVE_KEYS = new Set([
  "password",
  "token",
  "secret",
  "authorization",
  "creditcard",
  "credit_card",
  "apikey",
  "api_key",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token"
]);

function maskSensitiveFields(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(maskSensitiveFields);
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      result[k] = "******";
    } else if (typeof v === "object" && v !== null) {
      result[k] = maskSensitiveFields(v);
    } else {
      result[k] = v;
    }
  }
  return result;
}

async function enrichWithOperationLog(item) {
  if (!item.operationLogId) return item;
  const opLog = await getOperationLog(item.operationLogId);
  if (!opLog) return item;
  return {
    ...item,
    operationLogId: opLog.id,
    operationLog: {
      id: opLog.id,
      operationType: opLog.operationType,
      targetType: opLog.targetType,
      targetId: opLog.targetId,
      status: opLog.status,
      error: opLog.error,
      requestBody: opLog.requestBody ? maskSensitiveFields(opLog.requestBody) : null,
      createdAt: opLog.createdAt
    }
  };
}

export async function handleIdempotency(req, res, url) {
  if (req.method === "GET" && url.pathname === "/idempotency-records") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.IDEMPOTENCY_QUERY);
    if (!auth.authorized) return true;

    const filters = {
      key: url.searchParams.get("key") || "",
      operator: url.searchParams.get("operator") || "",
      status: url.searchParams.get("status") || "",
      path: url.searchParams.get("path") || "",
      startAt: url.searchParams.get("startAt") || "",
      endAt: url.searchParams.get("endAt") || "",
      page: url.searchParams.get("page") || "1",
      pageSize: url.searchParams.get("pageSize") || "20"
    };

    if (filters.status && !["processing", "completed"].includes(filters.status)) {
      return send(res, 400, {
        error: "invalid_status",
        message: `无效状态: ${filters.status}，有效值: processing, completed`
      });
    }

    const result = await queryIdempotencyRecords(filters);
    const enriched = [];
    for (const item of result.items) {
      const enrichedItem = await enrichWithOperationLog(item);
      if (enrichedItem.response && enrichedItem.response.body) {
        enrichedItem.response = {
          ...enrichedItem.response,
          body: maskSensitiveFields(enrichedItem.response.body)
        };
      }
      enriched.push(enrichedItem);
    }

    return send(res, 200, {
      items: enriched,
      pagination: result.pagination
    });
  }

  return null;
}
