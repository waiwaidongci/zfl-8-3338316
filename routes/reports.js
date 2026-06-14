import { send } from "../store/common.js";
import { loadCylinders } from "../store/cylinders.js";
import { getDashboard } from "../store/dashboard.js";
import { loadTasks, findActiveTaskByCylinderId } from "../store/inspectionTasks.js";
import { checkQueryAuth } from "./auth.js";

const MS_PER_DAY = 86400000;

function daysUntil(dateText) {
  return Math.ceil((new Date(dateText).getTime() - Date.now()) / MS_PER_DAY);
}

export async function handleReports(req, res, url) {
  if (req.method === "GET" && url.pathname === "/reports/dashboard") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const options = {
      inspectionDays: Number(url.searchParams.get("inspectionDays") || 45),
      longRentDays: Number(url.searchParams.get("longRentDays") || 30)
    };
    const dashboard = await getDashboard(options);
    return send(res, 200, dashboard);
  }

  if (req.method === "GET" && url.pathname === "/reports/alerts") {
    const auth = await checkQueryAuth(req, res);
    if (!auth.authorized) return true;
    const inspectionDays = Number(url.searchParams.get("inspectionDays") || 45);
    const longRentDays = Number(url.searchParams.get("longRentDays") || 30);
    const cylinders = await loadCylinders();
    const tasks = await loadTasks();
    const alerts = cylinders.flatMap((cylinder) => {
      const items = [];
      if (daysUntil(cylinder.inspectionDue) <= inspectionDays) {
        const activeTask = findActiveTaskByCylinderId(tasks, cylinder.id);
        items.push({
          type: "inspection_due",
          cylinderId: cylinder.id,
          due: cylinder.inspectionDue,
          daysLeft: daysUntil(cylinder.inspectionDue),
          taskStatus: activeTask ? activeTask.status : null,
          taskId: activeTask ? activeTask.id : null
        });
      }
      const lastOutbound = [...cylinder.events].reverse().find((evt) => evt.type === "outbound");
      if (
        cylinder.status === "rented" &&
        lastOutbound &&
        (Date.now() - new Date(lastOutbound.at).getTime()) / MS_PER_DAY >= longRentDays
      ) {
        items.push({
          type: "long_rent",
          cylinderId: cylinder.id,
          customer: cylinder.customer,
          since: lastOutbound.at
        });
      }
      return items;
    });
    return send(res, 200, alerts);
  }

  return null;
}
