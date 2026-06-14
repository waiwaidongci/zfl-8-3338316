import { send } from "../store/common.js";
import { queryEvents, getCylinderTimeline, getEventTypes } from "../store/eventAudit.js";
import { queryOperationLogs, getOperationLog, OPERATION_TYPES, TARGET_TYPES } from "../store/operationLog.js";
import { checkQueryAuth } from "./auth.js";

export async function handleEventAudit(req, res, url) {
  if (req.method === "GET" && url.pathname === "/events") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;

    const filters = {
      cylinderId: url.searchParams.get("cylinderId") || "",
      type: url.searchParams.get("type") || "",
      startAt: url.searchParams.get("startAt") || "",
      endAt: url.searchParams.get("endAt") || "",
      customer: url.searchParams.get("customer") || "",
      note: url.searchParams.get("note") || "",
      sortBy: url.searchParams.get("sortBy") || "at",
      order: url.searchParams.get("order") || "desc",
      page: url.searchParams.get("page") || "1",
      pageSize: url.searchParams.get("pageSize") || "20"
    };

    const result = await queryEvents(filters);
    return send(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/events/types") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const types = await getEventTypes();
    return send(res, 200, { types });
  }

  const match = url.pathname.match(/^\/cylinders\/([^/]+)\/timeline$/);
  if (match && req.method === "GET") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const cylinderId = match[1];
    const filters = {
      type: url.searchParams.get("type") || "",
      startAt: url.searchParams.get("startAt") || "",
      endAt: url.searchParams.get("endAt") || "",
      note: url.searchParams.get("note") || ""
    };
    const timeline = await getCylinderTimeline(cylinderId, filters);
    if (!timeline) {
      return send(res, 404, { error: "cylinder_not_found" });
    }
    return send(res, 200, timeline);
  }

  if (req.method === "GET" && url.pathname === "/operation-logs") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;

    const filters = {
      operationType: url.searchParams.get("operationType") || "",
      targetType: url.searchParams.get("targetType") || "",
      targetId: url.searchParams.get("targetId") || "",
      idempotencyKey: url.searchParams.get("idempotencyKey") || "",
      operator: url.searchParams.get("operator") || "",
      status: url.searchParams.get("status") || "",
      startAt: url.searchParams.get("startAt") || "",
      endAt: url.searchParams.get("endAt") || "",
      page: url.searchParams.get("page") || "1",
      pageSize: url.searchParams.get("pageSize") || "20"
    };

    const result = await queryOperationLogs(filters);
    return send(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/operation-logs/types") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    return send(res, 200, {
      operationTypes: Object.values(OPERATION_TYPES),
      targetTypes: Object.values(TARGET_TYPES)
    });
  }

  const opLogMatch = url.pathname.match(/^\/operation-logs\/([^/]+)$/);
  if (opLogMatch && req.method === "GET") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const logId = opLogMatch[1];
    const log = await getOperationLog(logId);
    if (!log) {
      return send(res, 404, { error: "operation_log_not_found" });
    }
    return send(res, 200, log);
  }

  return null;
}
