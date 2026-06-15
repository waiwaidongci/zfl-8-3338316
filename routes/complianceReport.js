import { send, body } from "../store/common.js";
import {
  createReportTask,
  getReport,
  listReports,
  retryReport
} from "../store/complianceReport.js";
import { checkQueryAuth, checkActionAuth } from "./auth.js";
import { PERMISSIONS } from "../auth/users.js";
import { executeWithIdempotency } from "../store/idempotencyExecutor.js";
import { OPERATION_TYPES, TARGET_TYPES } from "../store/operationLog.js";

const COMPLIANCE_REPORT_QUERY = "compliance:report";

export async function handleComplianceReport(req, res, url) {
  if (req.method === "POST" && url.pathname === "/compliance-reports") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.QUERY);
    if (!auth.authorized) return true;
    await body(req);
    return executeWithIdempotency(req, res, url, {
      auth,
      operationType: "compliance.report.create",
      targetType: "compliance_report",
      operation: async (ctx) => {
        const input = await body(req);
        if (!input.startAt && !input.endAt) {
          return { statusCode: 400, body: { error: "startAt_or_endAt_required" } };
        }
        const operator = auth.user?.username || null;
        const report = await createReportTask(input, operator);
        return { statusCode: 202, body: report };
      }
    });
  }

  if (req.method === "GET" && url.pathname === "/compliance-reports") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const filters = {
      status: url.searchParams.get("status") || "",
      requestedBy: url.searchParams.get("requestedBy") || "",
      periodFrom: url.searchParams.get("periodFrom") || "",
      periodTo: url.searchParams.get("periodTo") || "",
      hasHighRisk: url.searchParams.get("hasHighRisk") || "",
      hasDiscrepancy: url.searchParams.get("hasDiscrepancy") || "",
      page: url.searchParams.get("page") || "1",
      pageSize: url.searchParams.get("pageSize") || "20"
    };
    const result = await listReports(filters);
    return send(res, 200, result);
  }

  const detailMatch = url.pathname.match(/^\/compliance-reports\/([^/]+)$/);
  if (detailMatch && req.method === "GET") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const [, id] = detailMatch;
    const report = await getReport(id);
    if (!report) return send(res, 404, { error: "report_not_found" });
    return send(res, 200, report);
  }

  const retryMatch = url.pathname.match(/^\/compliance-reports\/([^/]+)\/retry$/);
  if (retryMatch && req.method === "POST") {
    const auth = await checkActionAuth(req, res, PERMISSIONS.QUERY);
    if (!auth.authorized) return true;
    const [, id] = retryMatch;
    await body(req);
    return executeWithIdempotency(req, res, url, {
      auth,
      operationType: "compliance.report.retry",
      targetType: "compliance_report",
      targetIdExtractor: () => id,
      operation: async (ctx) => {
        try {
          const report = await retryReport(id, auth.user?.username || null);
          return { statusCode: 202, body: report };
        } catch (err) {
          if (err.statusCode) {
            return { statusCode: err.statusCode, body: { error: err.message } };
          }
          throw err;
        }
      }
    });
  }

  return null;
}
